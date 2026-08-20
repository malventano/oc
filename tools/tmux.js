import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import z from "zod"

// Plugin tool port of tmux-pane MCP server.
// No stderr writes (leak to TUI), no JSON-RPC, no progress notifications
// (plugin tools have no execution timeout - poll loops survive up to 3600s).
// Abort via ctx.abort (AbortSignal) instead of MCP cancelled notification.

// Pane guard: never pipe a pane command's output to tail/head - the pane is
// where output is meant to be seen (full output stays visible); the run/poll/
// capture `lines` parameter limits what the agent receives without hiding
// anything in the pane. Appends a reminder to the run result when detected.
const PANE_GUARD_PIPE = /\|\s*(?:tail|head)\b/

function paneGuardReminder(command) {
  return PANE_GUARD_PIPE.test(command)
    ? "\n\n<system-reminder>tmux pane guard: this command pipes its output to tail/head - the pane is where the full output is meant to be seen. Use the run/poll/capture `lines` parameter (10-200) to limit what the agent receives; the pane keeps everything.</system-reminder>"
    : ""
}

function runTmux(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { env: process.env })
    let stdout = "", stderr = ""
    child.stdout.on("data", d => stdout += d)
    child.stderr.on("data", d => stderr += d)
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `tmux exited with code ${code}`))
      else resolve(stdout.trim())
    })
    child.on("error", reject)
  })
}

function uniqueSuffix() {
  return Math.random().toString(36).substring(2, 10)
}

let opencodeWindowId = null
async function getOpencodeWindowId() {
  if (opencodeWindowId) return opencodeWindowId
  const pane = process.env.TMUX_PANE
  if (!pane) throw new Error("Not running inside tmux (TMUX_PANE not set)")
  try {
    const out = await runTmux(["display-message", "-t", pane, "-p", "#{window_id}"])
    opencodeWindowId = out.trim()
    return opencodeWindowId
  } catch (err) {
    throw new Error(`TMUX_PANE=${pane} is stale or invalid. Restart opencode to refresh it. Original error: ${err.message}`)
  }
}

const pendingPanes = new Map()
const freshPanes = new Set()
// Panes spawned with an explicit layout: the realign's width-equalization
// would wreck vertical layouts (e.g. even-vertical 50/50), so those panes
// are skipped there.
const layoutPanes = new Map()

async function checkPaneIdle(paneId) {
  try {
    const out = await runTmux(["capture-pane", "-t", paneId, "-p", "-S", "-10"])
    const lines = out.split("\n")
    let lastLine = ""
    let lastLineIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) { lastLine = lines[i]; lastLineIdx = i; break }
    }
    if (!lastLine) return { idle: false, lastLine: "" }

    // DD-WRT BusyBox ash fancy prompt: bare "└─" line, cursor right after it. Must be checked
    // before hasDialogBox - "└" is in the dialog-box class and would classify the ash prompt as busy.
    const isAshPrompt = /^\s*└─\s*$/.test(lastLine)
    if (isAshPrompt) return { idle: true, lastLine, promptType: "shell" }
    const hasDialogBox = /[│┌┐└┘║═╗╝╚╔╣╠╦╬╧╩]/.test(lastLine)
    if (hasDialogBox) return { idle: false, lastLine }

    const hasProgressBar = /\[\s*\d+%?\s*\]/.test(lastLine)
    if (hasProgressBar) {
      for (let i = lastLineIdx - 1; i >= Math.max(0, lastLineIdx - 10); i--) {
        if (/\?$/.test(lines[i].trim())) return { idle: false, lastLine: lines[i], promptType: "confirm" }
      }
      return { idle: false, lastLine, promptType: "busy" }
    }

    const isContinuationPrompt = /^\s*>\s*$/.test(lastLine)
    if (isContinuationPrompt) return { idle: false, lastLine, promptType: "continuation" }

    const isPasswordPrompt = /password:|\bpassphrase:\b|enter password/i.test(lastLine)
    if (isPasswordPrompt) return { idle: false, lastLine, promptType: "password" }

    const isConfirmPrompt = /\[y\/[nN]\]|\[Y\/n\]|\[y\/N\]|\(y\/n\)|are you sure.*\?|proceed\?|continue\?|\(yes\/no/i.test(lastLine)
    if (isConfirmPrompt) return { idle: false, lastLine, promptType: "confirm" }

    const isInputPrompt = /[^$#]:\s*$/.test(lastLine)
      && !/^\s*=>\s/.test(lastLine)
      && !/^(Uninstalling|Installing|Downloading|Collecting|Processing|Building|Setting up|Preparing|Removing|Upgrading)\b/i.test(lastLine)
      && !/^\s*>\s*$/.test(lastLine)
    if (isInputPrompt) return { idle: false, lastLine, promptType: "input" }

    const isBarePrompt = /(^|[~\/\w:.-\]])[\$#]\s*$/.test(lastLine)
    const isYesNoPrompt = /yes|no|confirm|proceed/i.test(lastLine) && /\?$/.test(lastLine)
    if (isYesNoPrompt) return { idle: false, lastLine, promptType: "confirm" }
    return { idle: isBarePrompt, lastLine, promptType: isBarePrompt ? "shell" : "busy" }
  } catch {
    return { idle: false, lastLine: "(capture failed)" }
  }
}

async function realignPanes() {
  try {
    const wid = await getOpencodeWindowId()
    const opencodePane = process.env.TMUX_PANE
    const out = await runTmux(["list-panes", "-t", wid, "-F", "#{pane_id}"])
    const panes = out.split("\n").filter(Boolean).filter(p => p !== opencodePane)
    if (panes.length <= 1) return
    const winWidth = parseInt((await runTmux(["display-message", "-t", wid, "-p", "#{window_width}"])).trim())
    const paneWidth = Math.floor(winWidth / panes.length)
    for (const p of panes) {
      if (layoutPanes.has(p)) continue
      await runTmux(["resize-pane", "-t", p, "-x", String(paneWidth)]).catch(() => {})
    }
  } catch {}
}

const SGR_BASIC = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"]
const SGR_BRIGHT = ["#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]

function sgrHex(v) {
  const h = v.toString(16).padStart(2, "0")
  return `#${h}${h}${h}`
}

function sgr256(n) {
  if (n < 16) return n < 8 ? SGR_BASIC[n] : SGR_BRIGHT[n - 8]
  if (n < 232) {
    const v = n - 16
    const ramp = (x) => (x === 0 ? 0 : 55 + x * 40)
    const r = ramp(Math.floor(v / 36))
    const g = ramp(Math.floor((v % 36) / 6))
    const b = ramp(v % 6)
    return `#${sgrHex(r).slice(1)}${sgrHex(g).slice(1)}${sgrHex(b).slice(1)}`
  }
  const gray = 8 + (n - 232) * 10
  const h = sgrHex(gray).slice(1)
  return `#${h}${h}${h}`
}

function decodeSgr(codes) {
  let fg, bg, bold = false
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) { fg = undefined; bg = undefined; bold = false }
    else if (c === 1) bold = true
    else if (c === 38 && codes[i + 1] === 2) { fg = `#${codes.slice(i + 2, i + 5).map(sgrHex).join("").replace(/#/g, "")}`; i += 4 }
    else if (c === 48 && codes[i + 1] === 2) { bg = `#${codes.slice(i + 2, i + 5).map(sgrHex).join("").replace(/#/g, "")}`; i += 4 }
    else if (c === 38 && codes[i + 1] === 5) { fg = sgr256(codes[i + 2]); i += 2 }
    else if (c === 48 && codes[i + 1] === 5) { bg = sgr256(codes[i + 2]); i += 2 }
    else if (c >= 30 && c <= 37) fg = SGR_BASIC[c - 30]
    else if (c >= 90 && c <= 97) fg = SGR_BRIGHT[c - 90]
    else if (c >= 40 && c <= 47) bg = SGR_BASIC[c - 40]
    else if (c >= 100 && c <= 107) bg = SGR_BRIGHT[c - 100]
    else if (c === 39) fg = undefined
    else if (c === 49) bg = undefined
  }
  return { fg, bg, bold }
}

async function pollForDone(paneId, suffix, timeoutSeconds, abort, lines = 50) {
  const effectiveTimeout = Math.min(timeoutSeconds, 3600)
  const captureLines = Math.min(Math.max(lines, 10), 200)
  const startTime = Date.now()
  let elapsed = 0

  while (elapsed < effectiveTimeout) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000)
      abort?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
    })
    elapsed = Math.round((Date.now() - startTime) / 1000)

    if (abort?.aborted) {
      pendingPanes.delete(paneId)
      let tailLines = ""
      try {
        const sb = await runTmux(["capture-pane", "-t", paneId, "-p", "-S", `-${captureLines}`])
        tailLines = sb.split("\n").slice(-captureLines).join("\n")
      } catch {}
      return {
        status: "cancelled",
        message: `Client cancelled after ${elapsed}s. Command may still be running. Retry poll with same suffix to continue waiting.`,
        elapsed, suffix, lastLines: tailLines,
      }
    }

    let scrollback
    try {
      scrollback = await runTmux(["capture-pane", "-t", paneId, "-p", "-S", `-${captureLines}`])
    } catch {
      pendingPanes.delete(paneId)
      return {
        status: "error",
        message: `Pane ${paneId} no longer exists`,
        elapsed, lastLines: "",
      }
    }

    const lastLines = scrollback.split("\n").slice(-captureLines).join("\n")
    const lastLineTrimmed = scrollback.split("\n").slice(-10).filter(l => !/[│┌┐└┘║═╗╝╚╔╣╠╦╬╧╩]/.test(l)).pop() || ""

    const doneLineMatch = scrollback.match(new RegExp(`DONE_${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(\\d+)`, "m"))
    if (doneLineMatch) {
      const exitCode = parseInt(doneLineMatch[1])
      pendingPanes.delete(paneId)
      return {
        status: exitCode === 0 ? "complete" : "error",
        exitCode, elapsed, lastLines,
      }
    }

    const isContinuation = /^\s*>\s*$/.test(lastLineTrimmed)
    if (isContinuation) {
      pendingPanes.delete(paneId)
      return {
        status: "stuck",
        message: "Shell is waiting for more input (continuation prompt). Send Ctrl+C using keys with keys: 'C-c' to cancel.",
        elapsed, promptType: "continuation", lastLine: lastLineTrimmed, lastLines,
      }
    }

    const isPassword = /password:|\bpassphrase:\b|enter password/i.test(lastLineTrimmed)
    if (isPassword) {
      pendingPanes.delete(paneId)
      return {
        status: "input-needed",
        message: "Command is waiting for password input. Send password via keys, or Ctrl+C to cancel.",
        elapsed, promptType: "password", lastLine: lastLineTrimmed, lastLines,
      }
    }

    const isConfirm = /\[y\/[nN]\]|\[Y\/n\]|\[y\/N\]|\(y\/n\)|are you sure.*\?|proceed\?|continue\?|\(yes\/no/i.test(lastLineTrimmed)
    if (isConfirm) {
      pendingPanes.delete(paneId)
      return {
        status: "input-needed",
        message: "Command is waiting for yes/no confirmation. Send 'y' or 'n' via keys, or Ctrl+C to cancel.",
        elapsed, promptType: "confirm", lastLine: lastLineTrimmed, lastLines,
      }
    }

    const isYesNo = /yes|no|confirm|proceed/i.test(lastLineTrimmed) && /\?$/.test(lastLineTrimmed)
    if (isYesNo) {
      pendingPanes.delete(paneId)
      return {
        status: "input-needed",
        message: "Command is waiting for yes/no confirmation. Send 'y' or 'n' via keys, or Ctrl+C to cancel.",
        elapsed, promptType: "confirm", lastLine: lastLineTrimmed, lastLines,
      }
    }

    const isInput = /[^$#]:\s*$/.test(lastLineTrimmed)
      && !/^\s*=>\s/.test(lastLineTrimmed)
      && !/^(Uninstalling|Installing|Downloading|Collecting|Processing|Building|Setting up|Preparing|Removing|Upgrading)\b/i.test(lastLineTrimmed)
    if (isInput) {
      pendingPanes.delete(paneId)
      return {
        status: "input-needed",
        message: "Command is waiting for text input. Send input via keys, or Ctrl+C to cancel.",
        elapsed, promptType: "input", lastLine: lastLineTrimmed, lastLines,
      }
    }

    {
      const linesArr = scrollback.split("\n")
      let lastNonEmpty = ""
      let lastNonEmptyIdx = -1
      for (let i = linesArr.length - 1; i >= 0; i--) {
        const t = linesArr[i].trimEnd()
        if (t) { lastNonEmpty = t; lastNonEmptyIdx = i; break }
      }
      const isBareShellPrompt = /(^|[~\/\w:.-\]])[\$#]\s*$/.test(lastNonEmpty) || /^\s*└─\s*$/.test(lastNonEmpty)
      const nonBoxLine = isBareShellPrompt ? lastNonEmpty.replace(/^\s*└─\s*$/, "") : lastNonEmpty
      if (lastNonEmpty && isBareShellPrompt && !/[│┌┐└└└┘═║╔╗╚╝═╣╟╦╬╳╩⎧]/.test(nonBoxLine)) {
        const bottom10 = linesArr.slice(Math.max(0, lastNonEmptyIdx - 10), lastNonEmptyIdx + 1).join("\n")
        const hasRecentDone = /DONE_[a-z0-9]+=\d+/.test(bottom10)
        if (!hasRecentDone) {
          pendingPanes.delete(paneId)
          const { promptType } = await checkPaneIdle(paneId)
          return {
            status: "abnormal",
            message: `Shell prompt returned without DONE_${suffix} marker - command may have crashed or been interrupted. Inspect pane output with capture for details.`,
            elapsed, promptType, lastLine: lastNonEmpty, lastLines,
          }
        }
      }
    }
  }

  pendingPanes.delete(paneId)
  let tailLines = ""
  try {
    const sb = await runTmux(["capture-pane", "-t", paneId, "-p", "-S", `-${captureLines}`])
    tailLines = sb.split("\n").slice(-captureLines).join("\n")
  } catch {
    tailLines = "(pane no longer accessible)"
  }
  return {
    status: "timeout",
    message: `Timed out after ${elapsed}s waiting for DONE_${suffix} in pane ${paneId}`,
    elapsed, lastLines: tailLines,
  }
}

export default {
  description: `Pane lifecycle management for opencode's tmux window. 10 operations via 'op' discriminator. Backend: tmux CLI. Always operates in opencode's window regardless of which window user is viewing. Focus invariant: no op ever moves the tmux focus to a background pane (send-keys/capture are focus-free); the manage ops explicitly restore focus to the opencode pane - the user can always interact while the agent works.

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| run | paneId, command | wait, timeoutSeconds, lines |
| poll | paneId, suffix | timeoutSeconds, lines |
| keys | paneId, keys | enter |
| capture | paneId | lines, match, ansi |
| wait | paneId | timeoutSeconds |
| waitFor | paneId, pattern | absent, timeoutSeconds, lines |
| probe | paneId, patterns | lines |
| style | paneId, pattern | match, lines |
| log | - | logPath, lines |
| manage | action | paneId (kill), confirm (kill/kill-all), layout (spawn) |

Operations:
- manage: Pane lifecycle (list/spawn/kill/kill-all). Requires action. kill requires paneId+confirm="yes". kill-all requires confirm="yes". spawn's layout param applies a select-layout (e.g. 'even-vertical' = the 50/50 debug split) and exempts the pane from the width realign.
- run: Run command with exit code tracking. DEFAULT (wait=true): blocks until complete, returns {status, exitCode, elapsed, lastLines}. Set wait=false to overlap a long-running command with independent work in the same turn (file writes, reads, searches), then poll for the result. Use wait=true when no parallel work exists. NEVER pipe the command's output to tail/head (the pane shows the full output; the lines param limits what you receive instead - the pane guard flags it).
- keys: Send raw keys (Ctrl+C, password, y/n) to interactive session. NOT for commands. Special-key tokens and leader sequences ('C-x u', 'C-x r') send as raw keys; other strings send as literal text + Enter; enter=false sends literal text without Enter.
- poll: Wait for command sent via run to complete. Requires paneId and suffix returned by run.
- capture: Capture pane scrollback (match = return only the matching lines; ansi = raw escapes).
- wait: Wait for shell prompt (for SSH/REPL after keys).
- waitFor: Poll the pane capture until a regex MATCHES (or, with absent=true, DISAPPEARS). The state-based wait for TUI panes ONLY (the shell-prompt wait can't see TUI states): question panel popped ('esc dismiss'), model finished (busy spinner gone - absent), panel closed before the next hotkey (absent), compaction done ('▣  Compaction'). Polls every 500ms. NOT for shell commands or remote jobs - those end at a shell prompt and must use run (wait/poll) or capture; the tool refuses waitFor on shell panes.
- probe: ONE capture -> {label: true/false} verdict for a map of patterns + the matching lines only. Context-light scraping (no pane dump): probe({panel: 'esc dismiss', busy: '⬝', review: '^Review$'}).
- style: Color scrape - locate a pattern in the pane, decode the ANSI SGR at each occurrence -> [{text, fg: '#rrggbb', bg: '#rrggbb', bold}]. Opt-in color awareness (e.g. the success-green check, the diff red/green backgrounds, the muted-grey confirm) without the raw ANSI noise; match='all' for every occurrence.
- log: Tail a file (default /tmp/oc-debug.log - the instrumented pane's stderr trail) for the PDBG-debugging loop.

Status codes (poll/run wait=true): complete, error, abnormal, stuck, input-needed, timeout, cancelled.
Wait status codes: ready, stuck, input-needed, timeout, cancelled.

Safety: Use this tool's run (bash -c wrapper isolates child processes). Do not use tail/head in pane run commands (never pipe \`cmd 2>&1 | tail -N\`) - the pane is where output is meant to be seen (that's the point of running work in a pane); piping to tail/head hides it from the visible pane and buffers until close. To limit what you receive, set the \`lines\` parameter on run/poll/capture (10-200); it only affects your view, never the visible pane.

DONE marker format: bash -c '<command>' ; echo "DONE_<suffix>=\$?"
Subshell wrapper prevents destructive commands (exit, kill \$\$) from killing pane.
Unanchored match (progress-bar tools use \\r, file tails lack trailing \\n).

WORKFLOW PATTERNS:
- A pane is where work runs, not where you watch a detached process from. For any long-running job (local build/test/Docker OR remote sweep/training), run the job INSIDE the pane - the user sees live output and poll/wait returns the job's real exit code.
- Local long-running job: spawn pane, run the job. Prefer wait=false + poll when the same turn has independent file writes/reads/searches to overlap; use wait=true otherwise.
- Remote long-running job: spawn pane locally, keys 'ssh user@host', wait for prompt, keys 'sudo su -' if needed, wait, then run the job in that pane. SSH is transparent to run - the DONE marker is written to the pane regardless of host.
- Anti-pattern: launching a detached remote job via ssh ... 'nohup ... &' and using a local pane as a sentinel watcher (while ! ssh ... 'test -f ...'; do sleep 60; done). Hides live output, two layers of indirection, poll returns the watcher's exit code (always 0) rather than the job's, doubles SSH connections. The pane IS where work runs - SSH into the remote first, then run the job there.
- Anti-pattern: running remote-only scripts directly on the local pane shell (silently fails on remote-only paths like /mnt/vast/).
- Foreground (wait=true, default): blocks until complete. Use when no parallel work is available.
- Overlapped (wait=false): PREFER this when a turn combines a long-running job with independent file writes, reads, or searches. Pattern: spawn pane; then in ONE message issue run(wait=false) alongside the independent tool calls; then poll as the final call of the turn. The job runs concurrently with those tool calls.
- Anti-pattern: wait=false immediately followed by poll with nothing in between (just a worse wait=true). If you have no parallel work, use wait=true.
- Interactive (SSH/REPL): keys to send control keys/prompts, wait to detect ready prompt. Never poll after keys - no DONE marker is produced.
- Recovery: wait returns stuck (continuation '>') -> keys 'C-c C-c C-c' -> wait. wait returns input-needed -> keys with response -> wait. Triple C-c unwinds nested/stacked prompts (SSH+sudo, chained reads, sentinel loops) in one call; harmless at a clean prompt. Single 'C-c' works for simple stuck states.

USAGE NOTES:
- poll blocks until completion or timeout. Issue as last tool call in a turn so other work isn't blocked.
- Plugin tools have NO execution timeout (poll loops survive up to 3600s). User ESC delivers abort cleanly.
- Background panes for: visible long-running jobs (builds, test suites, Docker builds/logs, SSH sessions, monitoring like htop/nvtop/tail -f (follow logs)). One-shot commands (quick SSH, docker ps) run inline via Bash tool.
- Cleanup: close panes when task done unless providing ongoing value.`,
  args: {
    op: z.enum(["manage", "run", "keys", "poll", "capture", "wait", "waitFor", "probe", "style", "log"]).describe("Operation to perform"),
    action: z.enum(["list", "spawn", "kill", "kill-all"]).optional().describe("manage action (required for manage)"),
    paneId: z.string().optional().describe("Target pane ID (e.g., %123). Required for run/poll/keys/capture/wait/waitFor/probe/style and manage kill"),
    command: z.string().optional().describe("Command to run (required for run)"),
    keys: z.string().optional().describe("Raw keys to send (required for keys). Space-separated tokens: special keys (C-a, Escape, Enter, Tab, arrows...) and leader sequences ('C-x u') send as raw keys; any other string is sent as literal text + Enter (use enter=false for literal text without Enter)."),
    enter: z.boolean().optional().describe("keys: send literal text WITHOUT the trailing Enter (send-keys -l) - mid-turn drafts, panel picks"),
    wait: z.boolean().optional().describe("run: block until complete (default true)"),
    suffix: z.string().optional().describe("poll: suffix from run wait=false (required for poll). run: custom suffix (optional, auto-generated if omitted)"),
    timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds (run/poll: 600, wait: 30, waitFor: 120)"),
    lines: z.number().int().min(10).max(200).optional().describe("Lines of scrollback to return (default 50)"),
    confirm: z.string().optional().describe("kill/kill-all: must be 'yes'"),
    layout: z.string().optional().describe("manage spawn: tmux select-layout to apply after spawn (e.g. 'even-vertical' for the 50/50 debug split); the realign skips these panes"),
    pattern: z.string().optional().describe("waitFor: regex to wait for (required). style: text/regex to locate (required)"),
    absent: z.boolean().optional().describe("waitFor: wait for the pattern to DISAPPEAR instead of appear (e.g. a spinner or a closing panel)"),
    patterns: z.record(z.string(), z.string()).optional().describe("probe: {label: regex} map - one capture, each label = true/false (required for probe)"),
    match: z.string().optional().describe("capture: regex - return only the matching lines. style: 'one' (default) or 'all' occurrences"),
    ansi: z.boolean().optional().describe("capture: preserve ANSI escape sequences (capture-pane -e) - the style op uses this internally"),
    logPath: z.string().optional().describe("log: file to tail (default /tmp/oc-debug.log - the instrumented pane's stderr trail)"),
  },
  async execute(args, ctx) {
    const abort = ctx.abort
    const op = args.op

    const req = (field, opVal = op) => {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new Error(`${field} is required for op=${opVal}`)
      }
    }
    switch (op) {
      case "run": req("paneId"); req("command"); break
      case "poll": req("paneId"); req("suffix"); break
      case "keys": req("paneId"); req("keys"); break
      case "capture": req("paneId"); break
      case "wait": req("paneId"); break
      case "waitFor": req("paneId"); req("pattern"); break
      case "probe": req("paneId"); req("patterns"); break
      case "style": req("paneId"); req("pattern"); break
      case "log": break
      case "manage": {
        const a = args.action
        if (a === "kill") { req("paneId", "manage kill"); if (args.confirm !== "yes") throw new Error('confirm must be "yes" for manage kill') }
        else if (a === "kill-all") { if (args.confirm !== "yes") throw new Error('confirm must be "yes" for manage kill-all') }
        break
      }
    }

    if (op === "manage") {
      const action = args.action
      if (action === "list") {
        const wid = await getOpencodeWindowId()
        const out = await runTmux(["list-panes", "-t", wid, "-F", "#{pane_id} #{pane_width}x#{pane_height} #{pane_current_command} #{pane_active}"])
        const panes = out.split("\n").filter(Boolean).map(line => {
          const parts = line.split(" ")
          const paneId = parts[0]
          const dims = parts[1]
          const active = parts[parts.length - 1]
          const cmd = parts.slice(2, -1).join(" ")
          return { paneId, dimensions: dims, command: cmd || "(shell)", active: active === "1" }
        })
        return { title: "tmux panes", output: JSON.stringify(panes, null, 2), metadata: { panes } }
      }

      if (action === "spawn") {
        const wid = await getOpencodeWindowId()
        const opencodePane = process.env.TMUX_PANE
        const out = await runTmux(["list-panes", "-t", wid, "-F", "#{pane_id}"])
        const allPanes = out.split("\n").filter(Boolean)
        const bgPanes = allPanes.filter(p => p !== opencodePane)

        for (const p of bgPanes) {
          if (pendingPanes.has(p) || freshPanes.has(p)) continue
          const { idle } = await checkPaneIdle(p)
          if (idle) {
            freshPanes.add(p)
            return {
              title: `Reused pane ${p}`,
              output: JSON.stringify({
                paneId: p,
                info: `Reused existing idle pane ${p}. Use run to run a command with automatic DONE marker and completion tracking, or keys for special keys (Ctrl+C, prompt responses).`,
              }, null, 2),
              metadata: { paneId: p, reused: true },
            }
          }
        }

        const oldBgPanes = new Set(bgPanes)
        if (bgPanes.length === 0) {
          const winHeight = parseInt((await runTmux(["display-message", "-t", wid, "-p", "#{window_height}"])).trim())
          const paneHeight = Math.floor(winHeight * 20 / 100)
          await runTmux(["split-window", "-t", opencodePane, "-v", "-b", "-l", String(paneHeight), "-d"])
        } else {
          await runTmux(["split-window", "-t", bgPanes[0], "-h", "-d"])
        }
        const newOut = await runTmux(["list-panes", "-t", wid, "-F", "#{pane_id}"])
        const newBgPanes = newOut.split("\n").filter(Boolean).filter(p => p !== opencodePane)
        const newPaneId = newBgPanes.find(p => !oldBgPanes.has(p))
        freshPanes.add(newPaneId)
        await realignPanes()
        if (args.layout) {
          await runTmux(["select-layout", "-t", wid, args.layout]).catch(() => {})
          layoutPanes.set(newPaneId, args.layout)
        }
        await runTmux(["select-pane", "-t", opencodePane]).catch(() => {})
        return {
          title: `Spawned pane ${newPaneId}`,
          output: JSON.stringify({
            paneId: newPaneId,
            layout: args.layout ?? undefined,
            info: "Pane opened. Use run to run a command with automatic DONE marker and completion tracking, or keys for special keys (Ctrl+C, prompt responses).",
          }, null, 2),
          metadata: { paneId: newPaneId, reused: false, layout: args.layout },
        }
      }

      if (action === "kill") {
        const opencodePane = process.env.TMUX_PANE
        if (args.paneId === opencodePane) throw new Error(`Refused: cannot kill opencode's own pane (${args.paneId})`)
        freshPanes.delete(args.paneId)
        pendingPanes.delete(args.paneId)
        layoutPanes.delete(args.paneId)
        await runTmux(["kill-pane", "-t", args.paneId])
        await realignPanes()
        await runTmux(["select-pane", "-t", process.env.TMUX_PANE]).catch(() => {})
        return { title: `Killed ${args.paneId}`, output: `Pane ${args.paneId} killed`, metadata: { killed: args.paneId } }
      }

      if (action === "kill-all") {
        const wid = await getOpencodeWindowId()
        const opencodePane = process.env.TMUX_PANE
        const out = await runTmux(["list-panes", "-t", wid, "-F", "#{pane_id}"])
        const panes = out.split("\n").filter(Boolean)
        const toKill = panes.filter(p => p !== opencodePane)
        if (toKill.length === 0) return { title: "kill-all", output: "No background panes to kill", metadata: { killed: [] } }
        for (const p of toKill) {
          freshPanes.delete(p); pendingPanes.delete(p); layoutPanes.delete(p)
          await runTmux(["kill-pane", "-t", p])
        }
        await realignPanes()
        await runTmux(["select-pane", "-t", process.env.TMUX_PANE]).catch(() => {})
        return { title: `Killed ${toKill.length} pane(s)`, output: `Killed ${toKill.length} pane(s): ${toKill.join(", ")}`, metadata: { killed: toKill } }
      }

      throw new Error(`Unknown action: ${action}. Valid actions: list, spawn, kill, kill-all`)
    }

    if (op === "run") {
      const { idle, lastLine, promptType } = await checkPaneIdle(args.paneId)

      if (!idle) {
        let reason
        if (promptType === "continuation") {
          reason = "Shell is waiting for more input (continuation prompt '>' detected). Send Ctrl+C using keys with keys: 'C-c' to cancel, or use a different pane."
        } else if (promptType === "password") {
          reason = "Command is waiting for password input. Send password via keys, or use a different pane."
        } else if (promptType === "confirm") {
          reason = "Command is waiting for yes/no confirmation. Send 'y' or 'n' via keys, or use a different pane."
        } else if (promptType === "input") {
          reason = "Command is waiting for text input. Send input via keys, or use a different pane."
        } else {
          reason = `Last line: ${lastLine}. Wait for the previous command to complete by running poll first, or use a different pane.`
        }
        throw new Error(`Pane ${args.paneId} is busy - ${reason}`)
      }

      freshPanes.delete(args.paneId)
      const suffix = args.suffix || uniqueSuffix()
      const cmd = `bash -c '${args.command.replace(/'/g, "'\\''")}' ; echo "DONE_${suffix}=$?"`
      await runTmux(["send-keys", "-t", args.paneId, cmd, "Enter"])
      pendingPanes.set(args.paneId, suffix)

      const guard = paneGuardReminder(args.command)
      if (args.wait !== false) {
        const timeoutSeconds = Math.min(args.timeoutSeconds ?? 600, 3600)
        const result = await pollForDone(args.paneId, suffix, timeoutSeconds, abort, args.lines)
        return {
          title: `run ${result.status}`,
          output: JSON.stringify(result, null, 2) + guard,
          metadata: result,
        }
      } else {
        return {
          title: "Background started",
          output: JSON.stringify({
            suffix,
            pollCommand: `poll with paneId=${args.paneId} suffix=${suffix}`,
            info: "Background mode (wait=false). You MUST call poll next with paneId and this suffix to get the result - do NOT end your turn without polling.",
          }, null, 2) + guard,
          metadata: { suffix, background: true },
        }
      }
    }

    if (op === "keys") {
      freshPanes.delete(args.paneId)
      const SPECIAL_KEY = /^(C-[a-zA-Z]|Escape|Enter|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|BackSpace|Tab)$/
      const tokens = args.keys.split(/\s+/).filter(Boolean)
      // Single special tokens send as keys (a lone "Escape" or "C-c" must be
      // the real key, not literal text + Enter).
      const allSpecial = tokens.length > 0 && tokens.every(t => SPECIAL_KEY.test(t))
      // Leader sequences: "C-x u" / "C-x r" - a C- token followed by bare
      // letters sends each as a raw key (the tmux leader + the key).
      const isLeaderSeq =
        tokens.length >= 2 && /^C-[a-zA-Z]$/.test(tokens[0] ?? "") && tokens.slice(1).every(t => /^[a-zA-Z]$/.test(t))
      if (allSpecial || isLeaderSeq) {
        await runTmux(["send-keys", "-t", args.paneId, ...tokens])
      } else if (args.enter === false) {
        // Literal text without the trailing Enter (mid-turn drafts, panel picks).
        await runTmux(["send-keys", "-t", args.paneId, "-l", args.keys])
      } else {
        await runTmux(["send-keys", "-t", args.paneId, args.keys, "Enter"])
      }
      return { title: `Keys sent`, output: `Keys sent to pane ${args.paneId}`, metadata: { paneId: args.paneId, enter: args.enter } }
    }

    if (op === "poll") {
      const timeoutSeconds = Math.min(args.timeoutSeconds ?? 600, 3600)
      const result = await pollForDone(args.paneId, args.suffix, timeoutSeconds, abort, args.lines)
      return {
        title: `poll ${result.status}`,
        output: JSON.stringify(result, null, 2),
        metadata: result,
      }
    }

    if (op === "capture") {
      const lines = args.lines ?? 50
      const captureArgs = ["capture-pane", "-t", args.paneId, "-p"]
      if (args.ansi) captureArgs.push("-e")
      if (lines > 0) captureArgs.push("-S", `-${lines}`)
      else captureArgs.push("-S", "-")
      let out = await runTmux(captureArgs)
      if (args.match) {
        const re = new RegExp(args.match)
        out = out.split("\n").filter(l => re.test(l)).join("\n")
      }
      return { title: `capture ${args.paneId}`, output: out, metadata: { paneId: args.paneId, lines, match: args.match, ansi: args.ansi } }
    }

    if (op === "waitFor") {
      // TUI-only enforcement, enforced at the pane level: waitFor watches pane
      // states of the oc TUI window (spinner/panel) and nothing else. The only
      // pane it may run on is the one opencode itself lives in (TMUX_PANE);
      // every other pane is a work/shell pane whose commands end at a prompt
      // and must be tracked with run (wait/poll) or capture. Refusing non-TUI
      // panes removes both the stale-marker instant-match and the blind-wait
      // failure modes on shell output.
      const tuiPane = (process.env.TMUX_PANE || "").trim()
      if (!tuiPane || args.paneId !== tuiPane) {
        return {
          title: "waitFor refused (non-TUI pane)",
          output: JSON.stringify({ status: "error", message: `waitFor is for the oc TUI pane only (TMUX_PANE=${tuiPane || "(unset)"}); pane ${args.paneId} is a work/shell pane. Track shell commands with run (wait=true/false + poll) or capture.`, elapsed: 0 }, null, 2),
          metadata: { status: "error", elapsed: 0 },
        }
      }
      try {
        const paneState = await checkPaneIdle(args.paneId)
        if (paneState.promptType === "shell") {
          return {
            title: "waitFor refused (oc pane at shell prompt)",
            output: JSON.stringify({ status: "error", message: `oc pane is at a shell prompt; nothing to wait for TUI-state on.`, elapsed: 0 }, null, 2),
            metadata: { status: "error", elapsed: 0 },
          }
        }
      } catch { /* pane may vanish; the loop below reports it */ }
      const timeoutSeconds = Math.min(args.timeoutSeconds ?? 120, 3600)
      const pattern = new RegExp(args.pattern)
      const captureLines = Math.min(Math.max(args.lines ?? 50, 10), 200)
      const startTime = Date.now()
      let elapsed = 0
      while (elapsed < timeoutSeconds) {
        let sb = ""
        try {
          sb = await runTmux(["capture-pane", "-t", args.paneId, "-p", "-S", `-${captureLines}`])
        } catch {
          return { status: "error", message: `Pane ${args.paneId} no longer exists`, elapsed, matchedLines: "" }
        }
        const hit = pattern.test(sb)
        if (args.absent ? !hit : hit) {
          const matchedLines = sb.split("\n").filter(l => pattern.test(l)).join("\n")
          return {
            title: `waitFor ${args.absent ? "cleared" : "matched"}`,
            output: JSON.stringify({ status: "matched", message: `Pattern ${args.absent ? "cleared" : "matched"} in ${elapsed}s`, elapsed, matchedLines }, null, 2),
            metadata: { status: "matched", elapsed, matchedLines },
          }
        }
        if (abort?.aborted) {
          return {
            title: `waitFor cancelled`,
            output: JSON.stringify({ status: "cancelled", message: `Client cancelled after ${elapsed}s`, elapsed, matchedLines: "" }, null, 2),
            metadata: { status: "cancelled", elapsed },
          }
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500)
          abort?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
        })
        elapsed = Math.round((Date.now() - startTime) / 1000)
      }
      return {
        title: `waitFor timeout`,
        output: JSON.stringify({ status: "timeout", message: `Timed out after ${elapsed}s waiting for ${args.absent ? "the absence of" : ""} "${args.pattern}" in pane ${args.paneId}`, elapsed, matchedLines: "" }, null, 2),
        metadata: { status: "timeout", elapsed },
      }
    }

    if (op === "probe") {
      const captureLines = Math.min(Math.max(args.lines ?? 60, 10), 200)
      const sb = await runTmux(["capture-pane", "-t", args.paneId, "-p", "-S", `-${captureLines}`])
      const linesArr = sb.split("\n")
      const matches = {}
      for (const [label, re] of Object.entries(args.patterns ?? {})) {
        matches[label] = new RegExp(re).test(sb)
      }
      const matchedLines = linesArr
        .filter(l => Object.values(args.patterns ?? {}).some(re => new RegExp(re).test(l)))
        .join("\n")
      return {
        title: `probe ${args.paneId}`,
        output: JSON.stringify({ matches, matchedLines }, null, 2),
        metadata: { paneId: args.paneId, matches, matchedLines },
      }
    }

    if (op === "style") {
      const captureLines = Math.min(Math.max(args.lines ?? 100, 10), 200)
      const sb = await runTmux(["capture-pane", "-t", args.paneId, "-p", "-e", "-S", `-${captureLines}`])
      // Split into styled segments: track the SGR after each CSI sequence,
      // strip cursor-moves and other non-SGR escapes.
      const segments = []
      const CSI = /\x1b\[[0-9;?]*[A-Za-z]/g
      let last = 0
      let sgr = []
      for (let m = CSI.exec(sb); m; m = CSI.exec(sb)) {
        if (m.index > last) segments.push({ text: sb.slice(last, m.index), sgr })
        if (m[0].endsWith("m")) {
          const body = m[0].slice(2, -1)
          sgr = body ? body.split(";").map(Number) : [0]
        }
        last = m.index + m[0].length
      }
      if (last < sb.length) segments.push({ text: sb.slice(last), sgr })
      let plain = ""
      const segAt = []
      for (const s of segments) {
        segAt.push({ start: plain.length, end: plain.length + s.text.length, sgr: s.sgr })
        plain += s.text
      }
      const re = new RegExp(args.pattern, "g")
      const results = []
      let count = 0
      for (let m = re.exec(plain); m && (args.match === "all" || count === 0); m = re.exec(plain)) {
        const seg = segAt.find(s => m.index >= s.start && m.index < s.end)
        const dec = decodeSgr(seg?.sgr ?? [])
        results.push({ text: m[0], fg: dec.fg, bg: dec.bg, bold: dec.bold })
        count++
      }
      return {
        title: `style ${args.paneId}`,
        output: JSON.stringify(results, null, 2),
        metadata: { paneId: args.paneId, results },
      }
    }

    if (op === "log") {
      const path = args.logPath ?? "/tmp/oc-debug.log"
      const lines = args.lines ?? 50
      try {
        const content = await readFile(path, "utf8")
        const tail = content.split("\n").slice(-lines).join("\n")
        return { title: `log ${path}`, output: tail, metadata: { path, lines } }
      } catch (e) {
        return { title: `log ${path}`, output: `(no log file: ${e.message})`, metadata: { path } }
      }
    }

    if (op === "wait") {
      const timeoutSeconds = args.timeoutSeconds ?? 30
      const startTime = Date.now()
      let elapsed = 0

      while (elapsed < timeoutSeconds) {
        const { idle, lastLine, promptType } = await checkPaneIdle(args.paneId)
        let lastLines = ""
        try {
          const sb = await runTmux(["capture-pane", "-t", args.paneId, "-p", "-S", "-100"])
          lastLines = sb.split("\n").slice(-10).join("\n")
        } catch {
          lastLines = "(pane no longer accessible)"
        }

        if (idle) {
          return {
            title: `wait ready`,
            output: JSON.stringify({ status: "ready", elapsed, promptType, lastLine, lastLines }, null, 2),
            metadata: { status: "ready", elapsed, promptType, lastLine },
          }
        }
        if (promptType === "continuation") {
          return {
            title: `wait stuck`,
            output: JSON.stringify({
              status: "stuck",
              message: "Shell is waiting for more input (continuation prompt). Send Ctrl+C using keys with keys: 'C-c' to cancel.",
              elapsed, promptType: "continuation", lastLine, lastLines,
            }, null, 2),
            metadata: { status: "stuck", elapsed, promptType, lastLine },
          }
        }
        if (promptType === "password" || promptType === "confirm" || promptType === "input") {
          const messages = {
            password: "Command is waiting for password input. Send password via keys, or Ctrl+C to cancel.",
            confirm: "Command is waiting for yes/no confirmation. Send 'y' or 'n' via keys, or Ctrl+C to cancel.",
            input: "Command is waiting for text input. Send input via keys, or Ctrl+C to cancel.",
          }
          return {
            title: `wait input-needed`,
            output: JSON.stringify({
              status: "input-needed",
              message: messages[promptType],
              elapsed, promptType, lastLine, lastLines,
            }, null, 2),
            metadata: { status: "input-needed", elapsed, promptType, lastLine },
          }
        }

        if (abort?.aborted) {
          return {
            title: `wait cancelled`,
            output: JSON.stringify({
              status: "cancelled",
              message: `Client cancelled after ${elapsed}s. Prompt not yet visible. Retry wait to continue waiting.`,
              elapsed, lastLines,
            }, null, 2),
            metadata: { status: "cancelled", elapsed },
          }
        }

        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000)
          abort?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
        })
        elapsed = Math.round((Date.now() - startTime) / 1000)
      }

      let lastLines = ""
      try {
        const sb = await runTmux(["capture-pane", "-t", args.paneId, "-p", "-S", "-100"])
        lastLines = sb.split("\n").slice(-10).join("\n")
      } catch {
        lastLines = "(pane no longer accessible)"
      }
      return {
        title: `wait timeout`,
        output: JSON.stringify({ status: "timeout", message: `Timed out after ${elapsed}s waiting for prompt in pane ${args.paneId}`, elapsed, lastLines }, null, 2),
        metadata: { status: "timeout", elapsed },
      }
    }

    throw new Error(`Unknown op: ${op}. Valid ops: manage, run, keys, poll, capture, wait, waitFor, probe, style, log`)
  },
}
