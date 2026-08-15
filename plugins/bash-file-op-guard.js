// Bash file-op guard: nudges the agent toward the native Read/Edit/Write/
// Glob/Grep tools when a shell command operates on files instead. Passive -
// never blocks, just appends a reminder to the tool output so the pattern
// is corrected in the learning loop. Scoped to the local shell tool; remote
// (ssh), container (docker), build (npm/bun/make), and pane contexts are
// excluded. Pane/terminal output (tmux capture | grep) is not file work.

const GUARDED = [
  { re: /\bsed\s+-i/, hint: "sed -i in-place file mutation - the edit tool's OLD/NEW blocks do this" },
  { re: /\bsed\s+-n\s+['\"]?[0-9,]+p['\"]?\s+[^\s|;]+/, hint: "sed -n line window on a file - the read tool's offset/limit does this" },
  { re: /:\s*>\s*\S+/, hint: "file truncation - the write tool does this" },
  { re: /\btee\s+[^\s|;]+/, hint: "tee into a file - the write tool does this" },
  { re: />>\s*(?!\/dev\/null|\/tmp\/opencode)[^\s|;]+\s*$/, hint: "append into a file - the edit tool's append mode (OLD with no lines) does this" },
  { re: />>\s*(?!\/dev\/null|\/tmp\/opencode)[^\s|;]+/, hint: "append into a file - the edit tool's append mode (OLD with no lines) does this" },
  { re: />\s*(?!\/dev\/null|\/tmp\/opencode|&)[^\s|;]+\s*$/, hint: "redirect into a file - the write tool does this" },
  { re: />\s*(?!\/dev\/null|\/tmp\/opencode|&)[^\s|;]+(\s*<<\s*['\"]?(EOF|PY)['\"]?)?$/, hint: "redirect into a file - the write tool does this" },
  { re: /python3?\s+-\s*<<\s*['\"]?(EOF|PY)['\"]?[\s\S]*open\([^)]*['\"]w/, hint: "python heredoc writing a file - the write/edit tools do this" },
  { re: /\bgrep\s+(?:-[a-zA-Z0-9]+\s+)*[^\s|;]+\s+[~.\/][^\s|;]+/, hint: "grep on a file - the grep tool (and rg for match counting) does this" },
  { re: /\bwc\s+-l\s+[^\s|;]+/, hint: "wc -l on a file - the read tool shows the content; negative offset reads the tail" },
]

// Remote / container / build / pane contexts where shell file work is legit.
const EXCLUDED = /\b(tmux|ssh|scp|rsync|docker|podman|kubectl|git|journalctl|systemctl|npm|bunx?|make|cargo|go|rustc|gcc|clang|vllm-start)\b/

// cat/head/tail on a file-like argument (path-ish, not a pipe tail).
const READ_FILE = /\b(cat|head|tail)\s+(-[a-zA-Z0-9]+\s+)*[~.\/][^\s|;]+/

export default {
  id: "bash-file-op-guard",
  server: () => ({
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = String(input.args?.command ?? "")
      if (!cmd || EXCLUDED.test(cmd)) return
      const hits = []
      for (const g of GUARDED) {
        if (g.re.test(cmd)) hits.push(g.hint)
      }
      if (READ_FILE.test(cmd)) hits.push("cat/head/tail on a file - the read tool (offset/limit) does this")
      if (!hits.length) return
      output.output = `${output.output ?? ""}\n\n<system-reminder>Bash file-op guard: this command operates on files - the native Read/Edit/Write/Glob/Grep tools exist for that (${hits.join("; ")}).</system-reminder>`
    },
  }),
}
