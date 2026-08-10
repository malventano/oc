import type { Hooks, PluginInput } from "@opencode-ai/plugin"

export default {
  id: "tool-refine",
  server: async (): Promise<Hooks> => ({
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && output.args?.command) {
        const cmd = output.args.command as string
        if (/pkill\s+.*-f/.test(cmd)) {
          throw new Error(
            "BLOCKED: pkill -f kills the bash tool's own process and hangs the session. " +
            "Use one of these safe alternatives:\n" +
            "1. pkill -x <name> — exact process name match\n" +
            "2. kill -9 <pid> — use PID from pgrep\n" +
            "3. run \"pkill -f <pattern>\" — isolated in tmux pane"
          )
        }
        if (/(?:^|[;&|]|\b&&\b|\b\|\|\b)\s*vllm-start(?:\s|$)/.test(cmd)
            && !/--dry-run/.test(cmd)) {
          throw new Error(
            "BLOCKED: Do not execute vllm-start automatically. " +
            "After editing /usr/local/bin/vllm-start or model configs, " +
            "always ask the user to restart vLLM (run vllm-start). " +
            "Use --dry-run to print the command without executing. " +
            "See the High-Priority Operational Conventions in AGENTS.md."
          )
        }
      }

      // file_edit plugin tool safety enforcement (see BUG_FILE_EDIT_MANGLING.md)
      if (input.tool === "file_edit" && output.args) {
        const args = output.args as any
        const ops = args.operations || []

        // Force backup for any write operation (delete/replace/insert/move/moveToFile/extractToFile)
        if (ops.length > 0 && args.backup !== true) {
          args.backup = true
        }
      }

    },
    "tool.definition": async (input, output) => {
      if (input.toolID === "edit") {
        output.description += `

JSON editing: the edit tool tries 9 fallback replacers in order: Simple, LineTrimmed, BlockAnchor, WhitespaceNormalized, IndentationFlexible, EscapeNormalized, TrimmedBoundary, ContextAware, MultiOccurrence. Only oldString is normalized - newString is written literally. Provide 2-3 lines of context around oldString for uniqueness; bare key-value pairs match multiple times. Escape sequences like \\n, \\t, \\\\, \\" are unescaped in oldString by EscapeNormalizedReplacer - include them as they appear in Read output. After JSON edits, verify with python3 -c "import json; json.load(open('path'))". If edit fails repeatedly on escaping, use Python to rewrite.

Output budget: newString is part of your output token budget. When using edit to append large content (oldString = last unique line, newString = oldString + new content), keep newString small enough to fit within your remaining output budget. If newString is too large, the tool call will truncate mid-JSON and fail with a parse error ("Unterminated string"). Split the addition into multiple smaller edit calls.`
      }

      if (input.toolID === "file_edit") {
        output.description += `

Backups: auto-created for all write operations (delete/replace/insert/move/moveToFile/extractToFile). Backup path reported in tool output on success: "Backup: /tmp/opencode/file-edit-backup/<timestamp>/". Kept for 1 hour (swept lazily on next invocation). To roll back a bad edit: cp /tmp/opencode/file-edit-backup/<timestamp>/<file> <original_path>. Verify line ranges with a read op before applying destructive edits.`
      }

      if (input.toolID === "question") {
        output.description += `

CRITICAL: questions must be a native JSON array, never stringified. The arguments object must be valid JSON that can be parsed by JSON.parse(). Common failures: truncating mid-object, stringifying the array, or exceeding token limits in option text.

EXACT STRUCTURE (copy this shape, fill in your values):
{"questions":[{"question":"Short question?","header":"Label (30 chars max)","options":[{"label":"Yes","description":"Under 30 chars"},{"label":"No","description":"Under 30 chars"}],"multiple":false}]}

RULES:
- questions is an array literal [{...}], NEVER a quoted string "[{...}]"
- label: 1-3 words max
- description: under 30 characters
- header: under 30 characters
- Keep total payload small. If you have many options, ask multiple smaller questions instead.
- DO NOT use this tool in build mode or as a subagent. Subagents have no user channel and will hang indefinitely.`
      }

      if (input.toolID === "read") {
        output.description += `

CRITICAL: filePath is always required. Even when continuing a prior read with offset/limit, you must explicitly restate the filePath. The read tool does not remember which file was last accessed.`
      }

      if (input.toolID === "write") {
        output.description += `

Output budget: Your total output per turn is limited (typically 12k-32k tokens). A write call containing a large file is part of that output budget. If the content exceeds the remaining token budget, the tool call JSON will be truncated mid-string and fail with a parse error ("Unterminated string"). To avoid this:
- For files longer than ~400 lines, write the first section with this tool, then append subsequent sections using the edit tool (match the last unique line of the file as oldString, replace with itself plus new content) or file_edit with {"type": "insert", "atLine": -1, "content": "..."}.
- Each chunk should be small enough to fit within your remaining output budget. If a write fails with a parse error, the content was too large; split and retry.`
      }

      if (input.toolID === "webfetch") {
        output.description += `

URL discipline: NEVER fabricate URLs. Only fetch from: (a) user-provided links, (b) search results via the websearch tool, or (c) relative links from pages you already read. Do not guess vendor product slugs. Kernel docs: use kernel.org/doc/html/latest/... not docs.kernel.org/. GitHub raw files need full commit SHAs — prefer github.com/.../blob/main/... which auto-resolves. API endpoints requiring auth (GitHub /search/code, Hugging Face spaces, GitLab search) will fail. Prefer using the websearch tool to find URLs before calling webfetch. If unsure, verify with curl -I first.`
      }
    },
  }),
}
