# Tools

Custom opencode plugin tools used by the oc build. Copy the files into your opencode tools directory and restart opencode to load them:

    cp tools/*.js ~/.config/opencode/tools/

(or `.opencode/tools/` for project scope). Tools in the config directory are auto-discovered, no config entry needed. `file_edit.js` was retired 2026-08-11: its capabilities (batch, cut/paste registers, boundary previews, summary mode) merged into the built-in hashline edit tool (patch 0026).

| File | What it does |
|------|--------------|
| `sessions_query.js` | Raw SQLite access to the opencode session DB: query, list-tables, describe-table, execute, transaction, checkpoint, backup. |
| `sessions_browse.js` | Read-only session DB browsing: recent sessions, session info, messages, tool calls, text search. |
| `sessions_manage.js` | Session DB write ops: duplicate, split, fix-paths, unarchive, reassign-project (all require `confirm: "yes"`). |
| `skill_metadata.js` | Skill metadata audit: frontmatter, line/char counts, sibling inventory, description byte counts, mtime. |
| `tmux.js` | tmux pane lifecycle: run, poll, keys, capture, wait, manage. Works only when opencode runs inside tmux (`TMUX_PANE` set); errors cleanly otherwise. |
| `void_output.js` | Replaces a previous tool output with a model-provided summary to free context space (compaction boundary aware, stamp preserving, length guarded). |

Prerequisites:
- Runtime is Bun (bundled with opencode). `bun:sqlite` and node builtins work as-is.
- `zod` must be resolvable from the config directory. If missing:

      mkdir -p ~/.config/opencode/node_modules && npm i zod

- `sessions_*` tools operate on `~/.local/share/opencode/opencode.db` (the standard opencode session DB; `opencode-<channel>.db` variants are not used unless OPENCODE_VERSION is unset during a custom build).
- `tmux.js` needs tmux and only functions inside a tmux session.
