# Plugins

Custom opencode plugins used by the oc build. Copy the files into your opencode plugin directory and restart opencode to load them:

    cp plugins/*.js plugins/*.ts ~/.config/opencode/plugins/

(or `.opencode/plugins/` for project scope). Plugins in the config directory are auto-discovered, no config entry needed.

| File | What it does |
|------|--------------|
| `loop-guard.ts` | **REMOVED (patch 0028)** — behavior built into the oc binary: `src/session/loop-guard.ts` + processor/prompt wiring; detects repetition on both channels (reasoning + output) and cuts the stream, showing a red error banner on the cut message ("Loop guard interrupted the response: <detail>" plus the full thinking-loop-redirect underneath) while delivering the redirect to the model as a request-only synthetic message (no visible user turn; the error-marking also drops the looped garbage from the model request). |
| `time-context.js` | **REMOVED (patch 0027)** — behavior built into the oc binary: per-user-message local-ISO stamps + per-tool-output UTC stamps via `src/session/time-context.ts`; no plugin needed. |
| `tool-refine.ts` | Env-specific safety guardrails (kept plugin-side, NOT in the build): blocks `pkill -f` (kills the bash tool's own process; offers pkill -x / kill PID / tmux pane alternatives) and auto-execution of `vllm-start` without `--dry-run` (vLLM restart is user-managed). Prompt overlays for question/read/write/webfetch moved to the build's tool `*.txt` files (patch 0029). |

Requires opencode v1.x. Type-only imports from `@opencode-ai/plugin`; no other dependencies.
