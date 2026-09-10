# Plugins

Custom opencode plugins used by the oc build (hook plugins: tool.execute
before/after interception). Copy the files into your opencode plugin
directory AND declare them in the config's `plugin` array, then restart
opencode:

    cp plugins/*.js ~/.config/opencode/plugins/

(or `.opencode/plugins/` for project scope), then in
`~/.config/opencode/config.json`:

    "plugin": ["/root/.config/opencode/plugins/bash-file-op-guard.js", ...]

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
| `bash-file-op-guard.js` | **CURRENT (0133/0151/0261/0342/0344)** - hook plugin, the ONE plugin this build needs. (a) Passive nudges (tool.execute.after) when a bash command does file work that the native Read/Edit/Write/Glob/Grep tools do (sed -i, perl -i, rm single-file, mv rename, touch, redirects/tee/heredocs, python/node writes, grep/wc/cat on files, dd of=) - appends a `<system-reminder>` pointing at the native tool. (b) HARD REJECT (tool.execute.before) of the `rg` replace-with-n foot-gun: `rg -rn` / `rg -r n` parse as `--replace n` (silently rewrites every match to `n`, exit 0), so the call is refused before the shell runs (anchored to command boundaries - start/`;`/`&`/`\|`/`&&`/`\|\|` - so prose mentioning the form, e.g. a commit message, is not blocked). Excluded contexts (ssh/remote, docker, git, build tools, tmux panes) are not nudged. Case table: oc-spec/11-bash-guards.md (workspace doc, not in this repo). Test: `node plugins/bash-file-op-guard.test.mjs` (130 pass / 0 fail). |

(Former hook plugins - time-context, loop-guard, tool-refine - were ported
into the binary and REMOVED from this directory; see the README's built-in
tooling list. Nothing else is here.)

The `.test.mjs` files are dev-only (run with `node`) - do NOT copy them into
the plugin directory.

Requires opencode v1.x. Type-only imports from `@opencode-ai/plugin`; no other dependencies.
