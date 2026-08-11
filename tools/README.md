# Tools

Custom opencode plugin tools used by the oc build. Copy the files into your opencode tools directory and restart opencode to load them:

    cp tools/*.js ~/.config/opencode/tools/

# (or `.opencode/tools/` for project scope). Tools in the config directory are auto-discovered, no config entry needed. Retired 2026-08-11: `file_edit.js` (capabilities merged into the built-in hashline edit tool, patch 0026) and the sessions trio `sessions_query.js`/`sessions_browse.js`/`sessions_manage.js` (capabilities merged into built-in tools, patch 0030).

| File | What it does |
|------|--------------|
| `skill_metadata.js` | Skill metadata audit: frontmatter, line/char counts, sibling inventory, description byte counts, mtime. |
| `tmux.js` | tmux pane lifecycle: run, poll, keys, capture, wait, manage. Works only when opencode runs inside tmux (`TMUX_PANE` set); errors cleanly otherwise. |
| `void_output.js` | Replaces a previous tool output with a model-provided summary to free context space (compaction boundary aware, stamp preserving, length guarded). |

Prerequisites:
- Runtime is Bun (bundled with opencode). `bun:sqlite` and node builtins work as-is.
- `zod` must be resolvable from the config directory. If missing:

      mkdir -p ~/.config/opencode/node_modules && npm i zod

- The built-in sessions tools (`sessions-browse`, `sessions-manage`, `sessions-query`, patch 0030) use the app's own Drizzle connection; `sessions-query` op `query` is restricted to SELECT/WITH/EXPLAIN/PRAGMA (read-only prefix check).
- `tmux.js` needs tmux and only functions inside a tmux session.
