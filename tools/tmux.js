import { spawn } from "node:child_process"
import z from "zod"

// Plugin tool port of tmux-pane MCP server.
// No stderr writes (leak to TUI), no JSON-RPC, no progress notifications
// (plugin tools have no execution timeout — poll loops survive up to 3600s).
// Abort via ctx.abort (AbortSignal) instead of MCP cancelled notification.

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
    // before hasDialogBox — "└" is in the dialog-box class and would classify the ash prompt as busy.
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
      await runTmux(["resize-pane", "-t", p, "-x", String(paneWidth)]).catch(() => {})
    }
  } catch {}
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
            message: `Shell prompt returned without DONE_${suffix} marker — command may have crashed or been interrupted. Inspect pane output with capture for details.`,
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
  description: `Pane lifecycle management for opencode's tmux window. 6 operations via 'op' discriminator. Backend: tmux CLI. Always operates in opencode's window regardless of which window user is viewing.

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| run | paneId, command | wait, timeoutSeconds, lines |
| poll | paneId, suffix | timeoutSeconds, lines |
| keys | paneId, keys | — |
| capture | paneId | lines |
| wait | paneId | timeoutSeconds |
| manage | action | paneId (kill), confirm (kill/kill-all) |

Operations:
- manage: Pane lifecycle (list/spawn/kill/kill-all). Requires action. kill requires paneId+confirm="yes". kill-all requires confirm="yes".
- run: Run command with exit code tracking. DEFAULT (wait=true): blocks until complete, returns {status, exitCode, elapsed, lastLines}. Set wait=false to overlap a long-running command with independent work in the same turn (file writes, reads, searches), then poll for the result. Use wait=true when no parallel work exists.
- keys: Send raw keys (Ctrl+C, password, y/n) to interactive session. NOT for commands.
- poll: Wait for command sent via run to complete. Requires paneId and suffix returned by run.
- capture: Capture pane scrollback.
- wait: Wait for shell prompt (for SSH/REPL after keys).

Status codes (poll/run wait=true): complete, error, abnormal, stuck, input-needed, timeout, cancelled.
Wait status codes: ready, stuck, input-needed, timeout, cancelled.

Safety: Use this tool's run (bash -c wrapper isolates child processes). NEVER pipe pane commands through tail/head — the pane is where output is meant to be seen (that's the point of running work in a pane); piping to tail hides it from the visible pane and buffers until close. The lines parameter only controls what the model receives, never the visible pane.

DONE marker format: bash -c '<command>' ; echo "DONE_<suffix>=\$?"
Subshell wrapper prevents destructive commands (exit, kill \$\$) from killing pane.
Unanchored match (progress-bar tools use \\r, file tails lack trailing \\n).

WORKFLOW PATTERNS:
- A pane is where work runs, not where you watch a detached process from. For any long-running job (local build/test/Docker OR remote sweep/training), run the job INSIDE the pane — the user sees live output and poll/wait returns the job's real exit code.
- Local long-running job: spawn pane, run the job. Prefer wait=false + poll when the same turn has independent file writes/reads/searches to overlap; use wait=true otherwise.
- Remote long-running job: spawn pane locally, keys 'ssh user@host', wait for prompt, keys 'sudo su -' if needed, wait, then run the job in that pane. SSH is transparent to run — the DONE marker is written to the pane regardless of host.
- Anti-pattern: launching a detached remote job via ssh ... 'nohup ... &' and using a local pane as a sentinel watcher (while ! ssh ... 'test -f ...'; do sleep 60; done). Hides live output, two layers of indirection, poll returns the watcher's exit code (always 0) rather than the job's, doubles SSH connections. The pane IS where work runs — SSH into the remote first, then run the job there.
- Anti-pattern: running remote-only scripts directly on the local pane shell (silently fails on remote-only paths like /mnt/vast/).
- Foreground (wait=true, default): blocks until complete. Use when no parallel work is available.
- Overlapped (wait=false): PREFER this when a turn combines a long-running job with independent file writes, reads, or searches. Pattern: spawn pane; then in ONE message issue run(wait=false) alongside the independent tool calls; then poll as the final call of the turn. The job runs concurrently with those tool calls.
- Anti-pattern: wait=false immediately followed by poll with nothing in between (just a worse wait=true). If you have no parallel work, use wait=true.
- Interactive (SSH/REPL): keys to send control keys/prompts, wait to detect ready prompt. Never poll after keys — no DONE marker is produced.
- Recovery: wait returns stuck (continuation '>') -> keys 'C-c C-c C-c' -> wait. wait returns input-needed -> keys with response -> wait. Triple C-c unwinds nested/stacked prompts (SSH+sudo, chained reads, sentinel loops) in one call; harmless at a clean prompt. Single 'C-c' works for simple stuck states.

USAGE NOTES:
- poll blocks until completion or timeout. Issue as last tool call in a turn so other work isn't blocked.
- Plugin tools have NO execution timeout (poll loops survive up to 3600s). User ESC delivers abort cleanly.
- Background panes for: visible long-running jobs (builds, test suites, Docker builds/logs, SSH sessions, monitoring like htop/nvtop/tail -f). One-shot commands (quick SSH, docker ps) run inline via Bash tool.
- Cleanup: close panes when task done unless providing ongoing value.`,
  args: {
    op: z.enum(["manage", "run", "keys", "poll", "capture", "wait"]).describe("Operation to perform"),
    action: z.enum(["list", "spawn", "kill", "kill-all"]).optional().describe("manage action (required for manage)"),
    paneId: z.string().optional().describe("Target pane ID (e.g., %123). Required for run/poll/keys/capture/wait and manage kill"),
    command: z.string().optional().describe("Command to run (required for run)"),
    keys: z.string().optional().describe("Raw keys to send (required for keys). Space-separated special key tokens (e.g., 'C-c C-c C-c') send each as a separate key press; any non-special-token string is sent as literal text + Enter."),
    wait: z.boolean().optional().describe("run: block until complete (default true)"),
    suffix: z.string().optional().describe("poll: suffix from run wait=false (required for poll). run: custom suffix (optional, auto-generated if omitted)"),
    timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds (run/poll: 600, wait: 30)"),
    lines: z.number().int().min(10).max(200).optional().describe("Lines of scrollback to return (default 50)"),
    confirm: z.string().optional().describe("kill/kill-all: must be 'yes'"),
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
        await runTmux(["select-pane", "-t", opencodePane]).catch(() => {})
        return {
          title: `Spawned pane ${newPaneId}`,
          output: JSON.stringify({
            paneId: newPaneId,
            info: "Pane opened. Use run to run a command with automatic DONE marker and completion tracking, or keys for special keys (Ctrl+C, prompt responses).",
          }, null, 2),
          metadata: { paneId: newPaneId, reused: false },
        }
      }

      if (action === "kill") {
        const opencodePane = process.env.TMUX_PANE
        if (args.paneId === opencodePane) throw new Error(`Refused: cannot kill opencode's own pane (${args.paneId})`)
        freshPanes.delete(args.paneId)
        pendingPanes.delete(args.paneId)
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
          freshPanes.delete(p); pendingPanes.delete(p)
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
        throw new Error(`Pane ${args.paneId} is busy — ${reason}`)
      }

      freshPanes.delete(args.paneId)
      const suffix = args.suffix || uniqueSuffix()
      const cmd = `bash -c '${args.command.replace(/'/g, "'\\''")}' ; echo "DONE_${suffix}=$?"`
      await runTmux(["send-keys", "-t", args.paneId, cmd, "Enter"])
      pendingPanes.set(args.paneId, suffix)

      if (args.wait !== false) {
        const timeoutSeconds = Math.min(args.timeoutSeconds ?? 600, 3600)
        const result = await pollForDone(args.paneId, suffix, timeoutSeconds, abort, args.lines)
        return {
          title: `run ${result.status}`,
          output: JSON.stringify(result, null, 2),
          metadata: result,
        }
      } else {
        return {
          title: "Background started",
          output: JSON.stringify({
            suffix,
            pollCommand: `poll with paneId=${args.paneId} suffix=${suffix}`,
            info: "Background mode (wait=false). You MUST call poll next with paneId and this suffix to get the result — do NOT end your turn without polling.",
          }, null, 2),
          metadata: { suffix, background: true },
        }
      }
    }

    if (op === "keys") {
      freshPanes.delete(args.paneId)
      const SPECIAL_KEY = /^(C-[a-zA-Z]|Escape|Enter|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|BackSpace|Tab)$/
      const tokens = args.keys.split(/\s+/).filter(Boolean)
      const allSpecial = tokens.length > 1 && tokens.every(t => SPECIAL_KEY.test(t))
      if (allSpecial) {
        await runTmux(["send-keys", "-t", args.paneId, ...tokens])
      } else {
        await runTmux(["send-keys", "-t", args.paneId, args.keys, "Enter"])
      }
      return { title: `Keys sent`, output: `Keys sent to pane ${args.paneId}`, metadata: { paneId: args.paneId } }
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
      if (lines > 0) captureArgs.push("-S", `-${lines}`)
      else captureArgs.push("-S", "-")
      const out = await runTmux(captureArgs)
      return { title: `capture ${args.paneId}`, output: out, metadata: { paneId: args.paneId, lines } }
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

    throw new Error(`Unknown op: ${op}. Valid ops: manage, run, keys, poll, capture, wait`)
  },
}
