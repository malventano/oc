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
    },
    "tool.definition": async (input, output) => {
      if (input.toolID === "edit") {
      if (input.toolID === "edit") {
        // Hashline/batch discipline lives in the oc build's edit.txt/read.txt
        // (ships with patch 0026); no overlay needed here. This block is
        // intentionally empty to keep the plugin build-agnostic.
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
- For files longer than ~400 lines, write the first section with this tool, then append subsequent sections with the edit tool, chunked to fit the budget.
- Each chunk should be small enough to fit within your remaining output budget. If a write fails with a parse error, the content was too large; split and retry.`
      }

      if (input.toolID === "webfetch") {
        output.description += `

URL discipline: NEVER fabricate URLs. Only fetch from: (a) user-provided links, (b) search results via the websearch tool, or (c) relative links from pages you already read. Do not guess vendor product slugs. Kernel docs: use kernel.org/doc/html/latest/... not docs.kernel.org/. GitHub raw files need full commit SHAs — prefer github.com/.../blob/main/... which auto-resolves. API endpoints requiring auth (GitHub /search/code, Hugging Face spaces, GitLab search) will fail. Prefer using the websearch tool to find URLs before calling webfetch. If unsure, verify with curl -I first.`
      }
    },
  }),
}
