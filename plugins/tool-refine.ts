import type { Hooks } from "@opencode-ai/plugin"

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
  }),
}
