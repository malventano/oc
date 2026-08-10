# Plugins

Custom opencode plugins used by the oc build. Copy the files into your opencode plugin directory and restart opencode to load them:

    cp plugins/*.js plugins/*.ts ~/.config/opencode/plugins/

(or `.opencode/plugins/` for project scope). Plugins in the config directory are auto-discovered, no config entry needed.

| File | What it does |
|------|--------------|
| `loop-guard.ts` | Loop detection on both channels (thinking + output text). Detects generic repetition signatures and interrupts infinite thinking/text loops. Ported from omp / oh-my-pi `thinking-loop.ts` (MIT). |
| `time-context.js` | Appends an ISO-8601 timestamp with local offset to tool outputs (`<system-reminder>` stamp), giving the model time awareness across tool calls. |
| `tool-refine.ts` | Safety guardrails on tool calls: blocks `pkill -f` and other patterns that kill the bash tool's own process, forces `backup: true` on file_edit write operations, and injects safe-alternative guidance for destructive commands. |

Requires opencode v1.x. Type-only imports from `@opencode-ai/plugin`; no other dependencies.
