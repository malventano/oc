# oc: Custom Build of opencode

This repository is **oc**, a custom fork of [opencode](https://github.com/anomalyco/opencode) maintained for personal use. It tracks upstream opencode (currently based on the `v1.18.16` tag) and is rebased onto new upstream releases as they land. There is no prebuilt binary and no published package: installing `opencode` from npm/bun gets the stock upstream build with none of these changes. The repo contains everything needed to build the patched version (full source + `bun.lock`; `dist/` and `node_modules/` are generated, not stored).

## Build

Requires only `bun`:

    git clone https://github.com/malventano/oc && cd oc
    bun install
    cd packages/opencode
    OPENCODE_VERSION=1.18.16-oc bun run script/build.ts --single --skip-install --skip-embed-web-ui
    cp dist/opencode-linux-x64/bin/oc /usr/local/bin/oc

- `--skip-embed-web-ui` is required: v1.18.5+ app Rollup cannot resolve `@opencode-ai/client/promise` (upstream dep issue, not ours); plain `bun run build` fails on it.
- Keep the `-oc` suffix in `OPENCODE_VERSION`: the autoupdate-disable patch (and `oc upgrade` message) key off it. Any `<tag>-oc` version works; `1.18.16-oc` matches this base.
- `OPENCODE_VERSION` also pins the channel to `latest`, which keeps the session DB at the standard `~/.local/share/opencode/opencode.db` (shared with stock opencode). Building WITHOUT it puts the branch name in the channel and the DB becomes `opencode-<branch>.db` (e.g. `opencode-main.db`): a separate empty database, so no existing sessions appear and new ones land in the wrong file.
- The built binary is `dist/opencode-linux-x64/bin/oc` (named `oc`, unlike upstream's `opencode`).

## What the custom patches fix / add

### Build & identity
- Built artifact named `oc`; CLI rebranded (OC logo, `oc` command name, oc-specific tips)
- **Auto-update disabled**: custom builds never query the upstream release channel (no npm/GitHub fetch at startup, no auto-replace of the binary); `oc upgrade` prints "custom build, update from its source repo" and exits

### Compaction & KV-cache efficiency
- **Inject-method compaction**: the `/compact` summary turn runs as a normal turn with the summary prompt injected as the final user message, keeping the request chain byte-identical to the cached prefix; the summary turn hits ~98% of the KV prefix cache instead of a full miss
- **Tail retention**: the last N full turns are kept verbatim post-compaction (`tail_turns`, default 2), with the retention budget no longer clamped (recent turns survive fully)
- Reasoning part type preserved on model switch (keeps the prompt byte-identical → cache hit)
- Mode reminders persisted; build-switch gated to the n-1 assistant turn (byte-identical prompts)

### Variants & model control
- Variant overrides retained per model, shared across agents/modes (set `max` in plan, it stays `max` after toggling to build); legacy agent-scoped keys migrated on use
- Opening an old session no longer restores its stale model/variant; the model resolves to the agent config default
- Variant cycle fixes: explicit-off treated as a real cycle position; current variant passed through manual `/compact`
- vLLM thinking control via `chat_template_kwargs` + MTP-safe body flatten (excludes `min_p`/`logit_bias`, which speculative decoding rejects)
- `reasoning_tokens` fallback for glm45-family parsers that omit `completion_tokens_details.reasoning_tokens`
- `maxOutputTokens`: provider `limit.output` authoritative, hard 32K cap fallback removed



### Editing (hashline anchors)
- **Content-anchored edits**: every op references lines by `LINE#ID` anchors validated against the file's live content; stale or fabricated anchors are rejected fail-closed with retry-with anchors, so edits are never applied blind
- **Atomic batches**: multiple ops in one call apply against a single snapshot, so inserts/deletes never shift anchors mid-call; `cut`/`paste` registers move content across sections and files
- **Autocorrect**: copied `N#ID:` / `+N#ID:` / `>>>` prefixes strip per line; `text: []` / `""` means deletion (no blank-line artifacts); trailing empty strings are dropped
- **Echo-reject**: `set_line` / `replace_lines` refuse text that repeats the anchor line's own content (fail-closed with guidance); op-shape mistakes get corrective hints (every op requires its `type`)
- Annotated diffs: applied lines carry their new refs (`+3#AB:content`) so the next edit can chain without a re-read

### Built-in tooling (ships in the binary)
- **Time context (0027)**: every user message carries a byte-stable local-ISO `<system-reminder>` stamp and every tool output a UTC one; the stale `Today's date` line is gone from the system prompt (both the env block and the SystemContext `core/date` feature)
- **Loop guard (0028)**: dual-channel loop detection: repeated identical tool output or repeated user prompts abort with a diagnostic instead of looping
- **Sessions DB tools (0030)**: read-only session browsing, SQLite queries, and confirm-gated write management against the session database
- **Squash output (0031)**: replace a finished tool output with a short summary you write (depth-gated), keeping the context chain small
- **Skill metadata (0034, 0038)**: frontmatter name/description, line/char counts, sibling inventory, mtime, and description byte count for one or all skills; reads raw SKILL.md frontmatter; built-in skills guarded
- **tmux pane management**: run/poll/keys/capture/wait lifecycle ops for long-running jobs in visible panes
- **Shell safety guards (0036, 0040, 0041)**: `pkill -f` and `kill -9` / `-KILL` on `$$` / `$PPID` are blocked in the bash tool (anchored to command position; covers semicolon-suffixed and sudo forms) because they hang the session

### Prompt guidance (0029, 0039, 0044)
- Tool prompts: question/read/write/webfetch ship refined guidance (exact JSON array shapes for the question tool, URL discipline for webfetch, output-budget chunking for write)
- `default.txt` ships time-awareness and output-efficiency guidance; the shell prompt warns to never `kill -9 $$` / `$PPID`; `write.txt` documents that heredocs/redirections bypass Read-before-Write and the same-turn read cache
- The edit description opens with a type-first requirement for every op

### TUI
- Subagent costs aggregated into the sidebar spent total (with placeholder-session-ID guard)
- Message pruning on prompt submit instead of during streaming (no viewport jumps while scrolled up)
- Session directory filter: non-git sessions scoped by directory, not hierarchical path
- Footbar: session-cwd directory label (home `~`-abbreviated), session title, cost DFS, path-first order
- Adaptive refresh cadence + reduced render lag
- Footbar spacing/order polish
- Footbar overflow fixed on narrow terminals (0032)
- Session resume: agent restore no longer races the agent-list load (0035)

### Session directory scoping & DB path repair

Sessions are scoped to the directory they were launched in: oc shows a session only when the current working directory matches its stored launch directory (git projects match hierarchically by path relative to the worktree; non-git sessions match by exact directory, the behavior of our session-directory-filter work, PR #31210 / patch 0004). Sessions launched in a different directory do not appear in the list.

The stored directory can also diverge from the original launch path: when a session's directory becomes part of a git repo (or a project is initialized there), the session row can be reassigned to that project, so it stops showing under the original context. If sessions are missing, restore the stored paths to the original launch directories.

The session database is SQLite at `~/.local/share/opencode/opencode.db`. Inspect:

    sqlite3 ~/.local/share/opencode/opencode.db \
      "SELECT id, title, directory, path, project_id FROM session ORDER BY time_updated DESC;"

Restore a session to its original launch directory:

    sqlite3 ~/.local/share/opencode/opencode.db \
      "UPDATE session SET directory = '/original/launch/dir', path = substr('/original/launch/dir', 2), project_id = 'global' WHERE id = '<session-id>';"

- `path` mirrors `directory`: for non-git sessions it is the launch directory relative to `/` with the leading slash stripped (e.g. `directory = /home/user/proj` → `path = home/user/proj`). This is the value the session filter matches against, so it must stay in sync with `directory`; do NOT set it to NULL (NULL-path sessions never match the TUI filter)
- `project_id` is `'global'` for non-git directories. If a session was reassigned into a git project, restore it. Sessions genuinely launched inside a git repo keep their project-specific `project_id` and worktree-relative `path`; resetting those hides them from the repo's session list
- If a whole tree moved (renamed parent), rewrite both columns in bulk:

    sqlite3 ~/.local/share/opencode/opencode.db \
      "UPDATE session SET directory = REPLACE(directory, '/old/parent', '/new/parent'), path = REPLACE(path, 'old/parent', 'new/parent') WHERE directory LIKE '/old/parent%';"

oc does not need to be stopped: you can direct oc to run these queries itself (the session database is live SQLite and the session list re-reads it). If a session is currently open in the TUI, reopen it to refresh its view.

**Optional: redo every session in the DB** (regenerates the filter `path` from each session's stored `directory`, undoing any stale or munged path values):

    sqlite3 ~/.local/share/opencode/opencode.db \
      "UPDATE session SET path = substr(directory, 2) WHERE project_id = 'global' AND directory != '/';"

This applies to all non-git sessions (project `global`): their `path` is the launch directory relative to `/` (leading slash stripped, e.g. `directory = /home/user/proj` becomes `path = home/user/proj`), which is what the session filter matches against. Run it after correcting `directory` values. It is also the backfill for legacy rows: sessions created before opencode 2026-04-28 (migration `add_session_path` added the column without backfill) have `path = NULL` and never match the filter; this command fills them in. Idempotent: already-correct paths are rewritten to the same value. **Sessions started inside a git repo are intentionally NOT touched**: they carry a project-specific `project_id` and a worktree-relative `path`, and resetting either would hide them from the repo's session list. Verify with:

    sqlite3 ~/.local/share/opencode/opencode.db \
      "SELECT path, COUNT(*) FROM session WHERE project_id = 'global' GROUP BY path ORDER BY COUNT(*) DESC LIMIT 10;"

## Everything is built in

The oc binary ships the full tooling: hashline editing, sessions DB tools, time context, loop guard, squash output, skill metadata, tmux pane management, and shell safety guards are compiled in. Nothing needs to be copied, configured, or installed.

## Repository layout

This repo is a lean snapshot of the upstream opencode release (upstream-specific CI, dogfood config, community docs, and deploy tooling are stripped) plus the oc patch series. `lean-base.sh` regenerates the snapshot from a new upstream tag; `main` is a derived artifact and force-pushes are the normal update path.
