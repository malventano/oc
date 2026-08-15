# Tools

Custom opencode plugin tools used by the oc build. Copy the files into your opencode tools directory and restart opencode to load them:

    cp tools/*.js ~/.config/opencode/tools/

# (or `.opencode/tools/` for project scope). Tools in the config directory are auto-discovered, no config entry needed. Retired 2026-08-11: `file_edit.js` (capabilities merged into the built-in hashline edit tool, patch 0026), the sessions trio `sessions_query.js`/`sessions_browse.js`/`sessions_manage.js` (capabilities merged into built-in tools, patch 0030), `void_output.js` + `squash_output.js` (redesigned as built-in `squash-output`, patch 0031), and `skill_metadata.js` (redesigned as built-in `skill-metadata`, patch 0034).

| File | What it does |
|------|--------------|
| `tmux.js` | tmux pane lifecycle: 10 ops (manage/run/keys/poll/capture/wait/waitFor/probe/style/log), keys fixes (single specials, leader sequences, enter:false), spawn layout param, pane guard (reminder on `\| tail`/`\| head` pipes - use the `lines` param instead). Works only when opencode runs inside tmux (`TMUX_PANE` set); errors cleanly otherwise. |

Prerequisites:
- Runtime is Bun (bundled with opencode). `bun:sqlite` and node builtins work as-is.
- `zod` must be resolvable from the config directory. If missing:

      mkdir -p ~/.config/opencode/node_modules && npm i zod

- The built-in sessions tools (`sessions-browse`, `sessions-manage`, `sessions-query`, patch 0030) use the app's own Drizzle connection; `sessions-query` op `query` is restricted to SELECT/WITH/EXPLAIN/PRAGMA (read-only prefix check).
- The built-in `squash-output` tool (patch 0031) replaces a past tool output with a model-written summary (depth-scoped, prefix-cache aware); see `bugs/BUG_CONTEXT_VOID_TOOL.md`.
- The built-in `skill-metadata` tool (patch 0034) audits skill state (frontmatter description + byte count, line/char counts, siblings, mtime) via the app's Skill service; the plugin only scanned the global config dir, the built-in covers all scopes.
- `tmux.js` needs tmux and only functions inside a tmux session.
