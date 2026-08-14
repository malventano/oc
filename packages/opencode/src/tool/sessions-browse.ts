import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = `Browse opencode session data (read-only). Ops:

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| recent-sessions | - | offset, limit |
| session-search | pattern | offset, limit |
| session-info | sessionId | - |
| subagent-info | parentId | - |
| list-session-messages | sessionId | role, offset, limit, preview_length, full_content, after, before, around_message_id, window |
| list-session-parts-by-tool | sessionId | toolName, status, offset, limit, preview_length, full_content |
| session-goal-history | sessionId | offset, limit |
| search-text | term | sessionId, offset, limit, preview_length, full_content, exclude_lineage |

Operations:
- recent-sessions: List recent top-level sessions with message counts.
- session-search: Search sessions by title or directory pattern.
- session-info: Get session summary (messages, tokens, UTC timestamps).
- subagent-info: Get subagent child sessions.
- list-session-messages: List messages in session with previews, UTC timestamps, token counts. around_message_id+window = anchored paging (bookends + before/after counts included).
- list-session-parts-by-tool: List tool call parts filtered by tool name and/or status. full_content capped at 80 KiB (omitted placeholder).
- session-goal-history: Find ## Goal block updates chronologically.
- search-text: Search text content in messages and tool outputs across all sessions or within specific session ID. Global search excludes current-session live-window hits and ancestor sessions by default; pre-compaction archived messages remain searchable (exclude_lineage=false to include everything).`

export const Parameters = Schema.Struct({
  op: Schema.Literals([
    "recent-sessions",
    "session-search",
    "session-info",
    "subagent-info",
    "list-session-messages",
    "list-session-parts-by-tool",
    "session-goal-history",
    "search-text",
  ]).annotate({ description: "Operation to perform" }),
  sessionId: Schema.optional(Schema.String).annotate({
    description:
      "Session ID. Required for session-info, list-session-messages, list-session-parts-by-tool, session-goal-history. Optional for search-text.",
  }),
  parentId: Schema.optional(Schema.String).annotate({ description: "Parent session ID (required for subagent-info)" }),
  pattern: Schema.optional(Schema.String).annotate({ description: "Search pattern (required for session-search)" }),
  term: Schema.optional(Schema.String).annotate({ description: "Search term (required for search-text)" }),
  role: Schema.optional(Schema.String).annotate({ description: "Filter by role (for list-session-messages)" }),
  toolName: Schema.optional(Schema.String).annotate({ description: "Filter by tool name (for list-session-parts-by-tool)" }),
  status: Schema.optional(Schema.String).annotate({ description: "Filter by status (for list-session-parts-by-tool)" }),
  offset: Schema.optional(Schema.Number).annotate({ description: "Result offset (default 0)" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Result limit (default 50, max 500)" }),
  preview_length: Schema.optional(Schema.Number).annotate({ description: "Preview length in chars (default 300)" }),
  full_content: Schema.optional(Schema.Boolean).annotate({ description: "Return full content without truncation (default false)" }),
  after: Schema.optional(Schema.String).annotate({ description: "ISO date string, filter messages after this time (for list-session-messages)" }),
  before: Schema.optional(Schema.String).annotate({ description: "ISO date string, filter messages before this time (for list-session-messages)" }),
  around_message_id: Schema.optional(Schema.String).annotate({
    description: "Anchor message ID for windowed paging (list-session-messages): returns window before/after + bookends + counts",
  }),
  window: Schema.optional(Schema.Number).annotate({ description: "Window size for anchored paging, clamped 1-20 (default 10)" }),
  exclude_lineage: Schema.optional(Schema.Boolean).annotate({
    description: "Exclude current-session live-window + ancestor sessions from global search-text results (default true); pre-compaction archived messages stay searchable",
  }),
})

type Metadata = { [key: string]: any }

const clamp = (v: number | undefined, dflt: number, max: number) => {
  const n = v ?? dflt
  return Math.min(max, Math.max(0, n))
}

const MSG_SQL = (textExpr: string, sessionId: string | undefined) => sql`SELECT m.id as message_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', m.time_created/1000, 'unixepoch') as time,
  json_extract(m.data, '$.role') as role,
  json_extract(p.data, '$.type') as part_type,
  ${sql.raw(textExpr)} as text_preview,
  json_extract(m.data, '$.tokens.input') as input_tokens,
  json_extract(m.data, '$.tokens.output') as output_tokens
  FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ${sessionId} AND json_extract(p.data, '$.type') = 'text'`

export const SessionsBrowseTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "sessions-browse",
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const op = params.op
          const req = (field: string) => {
            const v = (params as any)[field]
            if (v === undefined || v === null || v === "") throw new Error(`${field} is required for op=${op}`)
          }
          switch (op) {
            case "session-search":
              req("pattern")
              break
            case "session-info":
            case "list-session-messages":
            case "list-session-parts-by-tool":
            case "session-goal-history":
              req("sessionId")
              break
            case "subagent-info":
              req("parentId")
              break
            case "search-text":
              req("term")
              break
          }

          const off = clamp(params.offset, 0, Infinity)
          const lim = clamp(params.limit, 50, 500)
          const plen = params.preview_length || 300
          const full = params.full_content === true

          if (op === "recent-sessions") {
            const rows = yield* db
              .all(sql`SELECT s.id, s.title, s.directory, s.project_id,
                (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_updated/1000, 'unixepoch') as last_active,
                s.cost
                FROM session s WHERE s.parent_id IS NULL
                ORDER BY s.time_updated DESC LIMIT ${lim} OFFSET ${off}`)
              .pipe(Effect.orDie)
            return { title: `sessions (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          if (op === "session-search") {
            const pat = `%${params.pattern}%`
            const rows = yield* db
              .all(sql`SELECT s.id, s.title, s.directory, s.project_id,
                (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_updated/1000, 'unixepoch') as last_active
                FROM session s WHERE s.parent_id IS NULL
                AND (s.title LIKE ${pat} OR s.directory LIKE ${pat})
                ORDER BY s.time_updated DESC LIMIT ${lim} OFFSET ${off}`)
              .pipe(Effect.orDie)
            return { title: `sessions (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          if (op === "session-info") {
            const row = yield* db
              .get(sql`SELECT s.id, s.title, s.directory, s.project_id,
                json_extract(s.model, '$.id') as model_id,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_created/1000, 'unixepoch') as created,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_updated/1000, 'unixepoch') as updated,
                (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
                (SELECT SUM(json_extract(data, '$.tokens.input')) FROM message WHERE session_id = s.id) as total_input,
                (SELECT SUM(json_extract(data, '$.tokens.output')) FROM message WHERE session_id = s.id) as total_output,
                (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id AND json_extract(p.data, '$.type') = 'compaction') as compactions
                FROM session s WHERE s.id = ${params.sessionId}`)
              .pipe(Effect.orDie)
            return { title: "session info", output: JSON.stringify(row, null, 2), metadata: {} }
          }

          if (op === "subagent-info") {
            const rows = yield* db
              .all(sql`SELECT s.id, s.title,
                (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_created/1000, 'unixepoch') as started,
                strftime('%Y-%m-%dT%H:%M:%SZ', s.time_updated/1000, 'unixepoch') as finished,
                (SELECT SUM(json_extract(data, '$.tokens.input')) FROM message WHERE session_id = s.id) as total_input,
                (SELECT SUM(json_extract(data, '$.tokens.output')) FROM message WHERE session_id = s.id) as total_output
                FROM session s WHERE s.parent_id = ${params.parentId}
                ORDER BY s.time_created`).pipe(Effect.orDie)
            return { title: `subagents (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          const textExpr = full ? "json_extract(p.data, '$.text')" : `substr(json_extract(p.data, '$.text'), 1, ${plen})`

          if (op === "list-session-messages") {
            const roleSql = params.role ? sql` AND json_extract(m.data, '$.role') = ${params.role}` : sql``
            const base = MSG_SQL(textExpr, params.sessionId)

            if (params.around_message_id) {
              const w = Math.min(20, Math.max(1, params.window ?? 10))
              const anchor = yield* db
                .get(sql`SELECT time_created FROM message WHERE id = ${params.around_message_id} AND session_id = ${params.sessionId}`)
                .pipe(Effect.orDie)
              if (!anchor) throw new Error(`around_message_id not found in session: ${params.around_message_id}`)
              const at = (anchor as { time_created: number }).time_created

              const before = yield* db
                .all(sql`${base}${roleSql}
                  AND (m.time_created < ${at} OR (m.time_created = ${at} AND m.id < ${params.around_message_id}))
                  ORDER BY m.time_created DESC, m.id DESC LIMIT ${w}`)
                .pipe(Effect.orDie)
              before.reverse()

              const after = yield* db
                .all(sql`${base}${roleSql}
                  AND (m.time_created > ${at} OR (m.time_created = ${at} AND m.id > ${params.around_message_id}))
                  ORDER BY m.time_created ASC, m.id ASC LIMIT ${w}`)
                .pipe(Effect.orDie)

              const countRow = (dir: "<" | ">") =>
                db
                  .get(sql`SELECT COUNT(*) as c FROM message m JOIN part p ON p.message_id = m.id
                    WHERE m.session_id = ${params.sessionId} AND json_extract(p.data, '$.type') = 'text'${roleSql}
                    AND (m.time_created ${sql.raw(dir)} ${at} OR (m.time_created = ${at} AND m.id ${sql.raw(dir)} ${params.around_message_id}))`)
                  .pipe(Effect.orDie)

              const bookendSql = sql`${base}${roleSql} AND json_extract(m.data, '$.role') IN ('user','assistant')`
              const first = yield* db
                .all(sql`${bookendSql} ORDER BY m.time_created ASC, m.id ASC LIMIT 3`)
                .pipe(Effect.orDie)
              const lastRows = yield* db
                .all(sql`${bookendSql} ORDER BY m.time_created DESC, m.id DESC LIMIT 3`)
                .pipe(Effect.orDie)
              lastRows.reverse()

              const anchorRow = yield* db
                .get(sql`${base}${roleSql} AND m.id = ${params.around_message_id}`)
                .pipe(Effect.orDie)
              const anchorMeta: unknown =
                anchorRow ??
                (yield* db
                  .get(sql`SELECT m.id as message_id, strftime('%Y-%m-%dT%H:%M:%SZ', m.time_created/1000, 'unixepoch') as time,
                    json_extract(m.data, '$.role') as role, null as part_type, '(no text part)' as text_preview,
                    null as input_tokens, null as output_tokens FROM message m WHERE m.id = ${params.around_message_id} AND m.session_id = ${params.sessionId}`)
                  .pipe(Effect.orDie))

              return {
                title: "window",
                output: JSON.stringify(
                  {
                    mode: "window",
                    anchor_message_id: params.around_message_id,
                    window: w,
                    messages_before: ((yield* countRow("<")) as any).c,
                    messages_after: ((yield* countRow(">")) as any).c,
                    bookends_first: first,
                    window_before: before,
                    anchor: anchorMeta,
                    window_after: after,
                    bookends_last: lastRows,
                  },
                  null,
                  2,
                ),
                metadata: {},
              }
            }

            let where = sql`WHERE m.session_id = ${params.sessionId} AND json_extract(p.data, '$.type') = 'text'${roleSql}`
            // The DB stores message times as epoch SECONDS; the API takes ISO
            // strings. Convert to ms, then to seconds for the comparison.
            if (params.after) where = sql`${where} AND m.time_created > ${Math.floor(new Date(params.after).getTime() / 1000)}`
            if (params.before) where = sql`${where} AND m.time_created < ${Math.floor(new Date(params.before).getTime() / 1000)}`
            const rows = yield* db
              .all(sql`SELECT m.id as message_id,
                strftime('%Y-%m-%dT%H:%M:%SZ', m.time_created/1000, 'unixepoch') as time,
                json_extract(m.data, '$.role') as role,
                json_extract(p.data, '$.type') as part_type,
                ${sql.raw(textExpr)} as text_preview,
                json_extract(m.data, '$.tokens.input') as input_tokens,
                json_extract(m.data, '$.tokens.output') as output_tokens
                FROM message m
                JOIN part p ON p.message_id = m.id
                ${where}
                ORDER BY m.time_created DESC, m.id DESC LIMIT ${lim} OFFSET ${off}`)
              .pipe(Effect.orDie)
            return { title: `messages (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          if (op === "list-session-parts-by-tool") {
            const inputExpr = full ? "json_extract(p.data, '$.state.input')" : `substr(json_extract(p.data, '$.state.input'), 1, ${plen})`
            const outputExpr = full ? "json_extract(p.data, '$.state.output')" : `substr(json_extract(p.data, '$.state.output'), 1, ${plen})`
            let where = sql`WHERE p.session_id = ${params.sessionId} AND json_extract(p.data, '$.type') = 'tool'`
            if (params.toolName) where = sql`${where} AND json_extract(p.data, '$.tool') = ${params.toolName}`
            if (params.status && params.status !== "all") where = sql`${where} AND json_extract(p.data, '$.state.status') = ${params.status}`
            const rows = yield* db
              .all(sql`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', p.time_created/1000, 'unixepoch') as time,
                json_extract(p.data, '$.tool') as tool,
                json_extract(p.data, '$.state.status') as status,
                ${sql.raw(inputExpr)} as input_preview,
                ${sql.raw(outputExpr)} as output_preview
                FROM part p
                ${where}
                ORDER BY p.time_created DESC LIMIT ${lim} OFFSET ${off}`)
              .pipe(Effect.orDie)
            const CAP = 80 * 1024
            for (const r of rows as any[]) {
              for (const f of ["input_preview", "output_preview"]) {
                if (typeof r[f] === "string" && r[f].length > CAP) {
                  r[f] = r[f].slice(0, CAP) + ` [omitted: ${r[f].length - CAP} chars]`
                }
              }
            }
            return { title: `tool parts (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          if (op === "session-goal-history") {
            const rows = yield* db
              .all(sql`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', m.time_created/1000, 'unixepoch') as time,
                length(json_extract(p.data, '$.text')) as char_count,
                json_extract(p.data, '$.text') as text
                FROM message m
                JOIN part p ON p.message_id = m.id
                WHERE m.session_id = ${params.sessionId}
                AND json_extract(p.data, '$.type') = 'text'
                AND json_extract(m.data, '$.role') = 'assistant'
                AND json_extract(p.data, '$.text') LIKE '%## Goal%'
                ORDER BY m.time_created ASC
                LIMIT ${lim} OFFSET ${off}`)
              .pipe(Effect.orDie)
            return { title: `goal updates (${rows.length})`, output: JSON.stringify(rows, null, 2), metadata: {} }
          }

          if (op === "search-text") {
            const previewExpr = full
              ? "COALESCE(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output'))"
              : `substr(COALESCE(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output')), 1, ${plen})`
            const term = `%${params.term}%`
            let output: string
            if (params.sessionId) {
              const rows = yield* db
                .all(sql`SELECT p.id, json_extract(p.data, '$.type') as type,
                  ${sql.raw(previewExpr)} as preview
                  FROM part p WHERE p.session_id = ${params.sessionId}
                  AND (json_extract(p.data, '$.text') LIKE ${term}
                    OR json_extract(p.data, '$.state.output') LIKE ${term})
                  ORDER BY p.time_created DESC LIMIT ${lim} OFFSET ${off}`)
                .pipe(Effect.orDie)
              output = JSON.stringify(rows, null, 2)
            } else {
              let where = sql`WHERE (json_extract(p.data, '$.text') LIKE ${term}
                OR json_extract(p.data, '$.state.output') LIKE ${term})`
              if (params.exclude_lineage !== false) {
                const lineage: string[] = []
                const seen = new Set<string>()
                let cur: string | undefined = ctx.sessionID
                while (cur && !seen.has(cur)) {
                  seen.add(cur)
                  lineage.push(cur)
                  const row = (yield* db
                    .get(sql`SELECT parent_id FROM session WHERE id = ${cur}`)
                    .pipe(Effect.orDie)) as { parent_id?: string } | undefined
                  cur = row?.parent_id
                }
                if (lineage.length) {
                  const ancestors = lineage.slice(1)
                  if (ancestors.length) {
                    const ids = ancestors.map((id) => sql`${id}`)
                    where = sql`${where} AND s.id NOT IN (${sql.join(ids, sql`, `)})`
                  }
                  const curId = ctx.sessionID
                  where = sql`${where} AND NOT (s.id = ${curId} AND p.time_created >= COALESCE(
                    (SELECT MAX(p2.time_created) FROM part p2 JOIN message m2 ON p2.message_id = m2.id
                      WHERE m2.session_id = ${curId} AND json_extract(p2.data, '$.type') = 'compaction'),
                    0))`
                }
              }
              const rows = yield* db
                .all(sql`SELECT s.title, p.id, json_extract(p.data, '$.type') as type,
                  ${sql.raw(previewExpr)} as preview
                  FROM part p JOIN session s ON p.session_id = s.id
                  ${where}
                  ORDER BY p.time_created DESC LIMIT ${lim} OFFSET ${off}`)
                .pipe(Effect.orDie)
              output = JSON.stringify(rows, null, 2)
            }
            return { title: "search", output, metadata: {} }
          }

          throw new Error(`Unknown op: ${op}`)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
