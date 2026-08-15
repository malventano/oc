# Plugins

Custom opencode plugins used by the oc build (hook plugins: tool.execute
before/after interception). Copy the files into your opencode plugin
directory AND declare them in the config's `plugin` array, then restart
opencode:

    cp plugins/*.js plugins/*.ts ~/.config/opencode/plugins/

(or `.opencode/plugins/` for project scope), then in
`~/.config/opencode/config.json`:

    "plugin": ["/root/.config/opencode/plugins/<file>.ts", ...]

**NOT auto-discovered - never was** (verified 2026-08-15 in
`src/plugin/index.ts:179` + `src/config/config.ts:344`: the loader is
config-array-only; the oc fork never patched it - upstream code in both
eras). Hook plugins load ONLY from the config's `plugin` array. The
earlier "auto-discovered, no config entry needed" claim on this page
(Aug 9, 2026) was wrong. HISTORY: the era's plugins (time-context,
loop-guard, tool-refine) worked because of the config declaration
`"plugin": ["tool-refine"]` (added 2026-06-18, removed 2026-07-22 -
session DB edit parts). The July 22 removal did not stop the running
process: config/plugin changes require a restart, and the long-running
process kept the already-loaded plugins (time-context stamps continued
through Aug 9). The Aug 11 v1.18.16 rebase + the fresh `plugin: []`
config killed them for good - the same-day ports (time-context 0027,
loop-guard 0028, tool-refine pkill 0036) were the reaction; the
surviving plugins went silent at the rebase unnoticed. In this build:
declare each hook plugin in the config array or it silently never
loads. Tool plugins under `~/.config/opencode/tools/` ARE
auto-discovered - a different mechanism (the tool registry, no config
entry).

| File | What it does |
|------|--------------|
| `loop-guard.ts` | **REMOVED (patch 0028)** — behavior built into the oc binary: `src/session/loop-guard.ts` + processor/prompt wiring; detects repetition on both channels (reasoning + output) and cuts the stream, showing a red error banner on the cut message ("Loop guard interrupted the response: <detail>" plus the full thinking-loop-redirect underneath) while delivering the redirect to the model as a request-only synthetic message (no visible user turn; the error-marking also drops the looped garbage from the model request). |
| `time-context.js` | **REMOVED (patch 0027)** — behavior built into the oc binary: per-user-message local-ISO stamps + per-tool-output UTC stamps via `src/session/time-context.ts`; no plugin needed. |
| `tool-refine.ts` | **REMOVED (patch 0036)** — the `pkill -f` guard was ported into the oc binary (shell tool: blocks commands matching `/pkill\s+.*-f/` with the safe-alternatives message). The plugin's remaining guardrail (`vllm-start` execution blocked without `--dry-run`) is environment-specific and lives only in the owner's local `~/.config/opencode/plugins/tool-refine.ts`, NOT in the repo. Prompt overlays for question/read/write/webfetch moved to the build's tool `*.txt` files (patch 0029). |

Requires opencode v1.x. Type-only imports from `@opencode-ai/plugin`; no other dependencies.
