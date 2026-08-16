// Bash file-op guard: nudges the agent toward the native Read/Edit/Write/
// Glob/Grep tools when a shell command operates on files instead. Passive -
// never blocks, just appends a reminder to the tool output so the pattern
// is corrected in the learning loop. Scoped to the local shell tool; remote
// (ssh), container (docker), build (npm/bun/make), and pane contexts are
// excluded. Pane/terminal output (tmux capture | grep) is not file work.
//
// Case table maintained in oc-spec/11 (bash guards). Every class here maps
// to a native-tool equivalent; the test suite (bash-file-op-guard.test.mjs)
// walks the table. Do not add regexes without extending the table and the
// suite.

const GUARDED = [
  // --- in-place mutations (edit tool OLD/NEW blocks) ---
  { re: /\bsed\s+-i/, hint: "sed -i in-place file mutation - the edit tool's OLD/NEW blocks do this" },
  { re: /\bperl\s+-[a-zA-Z]*i(?:\.\w+)?\b/, hint: "perl -i in-place file mutation - the edit tool's OLD/NEW blocks do this" },
  { re: /\bawk\s+-i\s+inplace\b/, hint: "awk -i inplace file mutation - the edit tool's OLD/NEW blocks do this" },
  { re: /\btruncate\s+-s\s+0\s+[^\s|;]+/, hint: "file truncation - the write tool does this" },
  { re: /\bjq\s+(?:--in-place|-i)\b/, hint: "jq -i in-place JSON editing - the edit tool's OLD/NEW blocks do this" },
  { re: /\byq\s+(?:--in-place|-i)\b/, hint: "yq -i in-place YAML editing - the edit tool's OLD/NEW blocks do this" },
  { re: /\b(dos2unix|unix2dos)\s+[^\s|;]+/, hint: "in-place line-ending conversion - the write tool does this" },

  // --- file lifecycle (edit DELETE/RENAME, write create) ---
  // rm: single-file forms only - -r/-R/--recursive flags and trailing-slash
  // targets (directories) are legitimate shell work the edit tool cannot
  // express. The flag group rejects any flag containing r.
  { re: /\brm\s+(?:-(?!-?[a-zA-Z]*[rR])\S+\s+)*[^-\s<|;>][^\s|;]*(?<!\/)(?=\s|;|$)/, hint: "file deletion - the edit tool's DELETE form does this" },
  // mv: two non-flag targets, neither ending in / (directory moves and
  // moves-into-directory are legitimate shell work). Known edge: mv -t
  // (GNU) moves into a directory but matches (rare; accepted).
  { re: /\bmv\s+(?:-[a-zA-Z0-9]+\s+)*[^-\s<|;>][^\s|;]*(?<!\/)\s+[^-\s<|;>][^\s|;]*(?<!\/)(?=\s|;|$)/, hint: "file rename - the edit tool's RENAME form does this" },
  { re: /\btouch\s+(?:-[a-zA-Z0-9]+\s+)*[^-\s<|;>][^\s|;]+/, hint: "file creation - the write tool does this" },

  // --- writes (write tool) ---
  { re: /:\s*>\s*\S+/, hint: "file truncation - the write tool does this" },
  { re: /\btee\s+[^\s|;]+/, hint: "tee into a file - the write tool does this" },
  { re: />>\s*(?!\/dev\/null|\/tmp\/opencode)[^\s|;]+\s*$/, hint: "append into a file - the edit tool's append mode (OLD with no lines) does this" },
  { re: />>\s*(?!\/dev\/null|\/tmp\/opencode)[^\s|;]+/, hint: "append into a file - the edit tool's append mode (OLD with no lines) does this" },
  { re: />\s*(?!\/dev\/null|\/tmp\/opencode|&)[^\s|;]+\s*$/, hint: "redirect into a file - the write tool does this" },
  { re: />\s*(?!\/dev\/null|\/tmp\/opencode|&)[^\s|;]+(\s*<<\s*['\"]?(EOF|PY)['\"]?)?$/, hint: "redirect into a file - the write tool does this" },
  { re: /python3?\s+-\s*<<\s*['\"]?(EOF|PY)['\"]?[\s\S]*open\([^)]*['\"]w/, hint: "python heredoc writing a file - the write/edit tools do this" },
  { re: /python3?\s+-c\s+['\"][\s\S]*\bopen\([^)]*['\"]w/, hint: "python writing a file - the write/edit tools do this" },
  { re: /\bdd\s+[^\s|;]*\s*of=(?!\/dev\/null)[^\s|;]+/, hint: "writing a file - the write tool does this" },

  // --- reads (read/grep tools) ---
  { re: /\bsed\s+-n\s+['\"]?[0-9,]+p['\"]?\s+[^\s|;]+/, hint: "sed -n line window on a file - the read tool's offset/limit does this" },
  // grep: pattern + at least one file target. Bare filenames included; the
  // target must not start with - (flag), < (stdin redirect), | (pipe), ;
  // or > (redirect). "rg" is deliberately not flagged (sanctioned for match
  // counting).
  { re: /\bgrep\s+(?:-[a-zA-Z0-9]+\s+)*[^-\s<|;>][^\s|;]*\s+[^-\s<|;>][^\s|;]+/, hint: "grep on a file - the grep tool (and rg for match counting) does this" },
  { re: /\bwc\s+(?:-[a-zA-Z0-9]+\s+)*[^-\s<|;>][^\s|;]+/, hint: "wc on a file - the read tool shows the content; negative offset reads the tail" },
]

// Remote / container / build / pane contexts where shell file work is legit.
const EXCLUDED = /\b(tmux|ssh|scp|rsync|docker|podman|kubectl|git|journalctl|systemctl|npm|bunx?|make|cargo|go|rustc|gcc|clang|vllm-start)\b/

// cat/head/tail on a file-like argument. Bare filenames included; the
// target must not start with - (flag), < (stdin redirect), > (redirect),
// | (pipe) or ; (separator) - "cat << EOF" and "cat < input" are not file
// reads. "cat" with no target at all is stdin (no match).
const READ_FILE = /\b(cat|head|tail)\s+(-[a-zA-Z0-9]+\s+)*[^-\s<|;>][^\s|;]+/

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
