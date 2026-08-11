# Plugins

Custom opencode plugins used by the oc build. Copy the files into your opencode plugin directory and restart opencode to load them:

    cp plugins/*.js plugins/*.ts ~/.config/opencode/plugins/

(or `.opencode/plugins/` for project scope). Plugins in the config directory are auto-discovered, no config entry needed.

| File | What it does |
|------|--------------|
| `loop-guard.ts` | **REMOVED (patch 0028)** — behavior built into the oc binary: `src/session/loop-guard.ts` + processor/prompt wiring; detects repetition on both channels (reasoning + output) and cuts the stream, showing a red error banner on the cut message ("Loop guard interrupted the response: <detail>" plus the full thinking-loop-redirect underneath) while delivering the redirect to the model as a request-only synthetic message (no visible user turn; the error-marking also drops the looped garbage from the model request). |
| `time-context.js` | **REMOVED (patch 0027)** — behavior built into the oc binary: per-user-message local-ISO stamps + per-tool-output UTC stamps via `src/session/time-context.ts`; no plugin needed. |
| `tool-refine.ts` | Safety guardrails on tool calls: blocks `pkill -f` and other patterns that kill the bash tool's own process, forces `backup: true` on file_edit write operations, and injects safe-alternative guidance for destructive commands. |

Requires opencode v1.x. Type-only imports from `@opencode-ai/plugin`; no other dependencies.
