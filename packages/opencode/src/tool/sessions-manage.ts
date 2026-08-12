import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = `Manage opencode sessions (write operations). All ops require confirm="yes".

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| duplicate-session | sourceId, newDirectory, suffix, confirm | newTitle |
| split-session | sourceId, cutoffMessageId, newDirectory, suffix, confirm | newTitle |
| fix-paths | oldPath, newPath, confirm | - |
| unarchive-session | sessionId, confirm | - |
| reassign-project | newProjectId, confirm | filterSessionId |

Operations:
- duplicate-session: Duplicate session preserving all messages/parts/todos.
- split-session: Split session at cutoff message, copying only earlier messages.
- fix-paths: Fix stale directory/path values by replacing old segment with new.
- unarchive-session: Unarchive session by clearing time_archived.
- reassign-project: Reassign sessions to new project_id (fix TUI visibility).`

export const Parameters = Schema.Struct({
  op: Schema.Literals([
    "duplicate-session",
    "split-session",
    "fix-paths",
    "unarchive-session",
    "reassign-project",
  ]).annotate({ description: "Operation to perform" }),
  confirm: Schema.String.annotate({ description: 'Must be "yes" for all operations' }),
  sourceId: Schema.optional(Schema.String).annotate({ description: "Source session ID (required for duplicate-session/split-session)" }),
  newDirectory: Schema.optional(Schema.String).annotate({ description: "New directory path (required for duplicate-session/split-session)" }),
  newTitle: Schema.optional(Schema.String).annotate({ description: "New session title (optional for duplicate-session/split-session)" }),
  suffix: Schema.optional(Schema.String).annotate({ description: "Suffix appended to new session ID (required for duplicate-session/split-session)" }),
  cutoffMessageId: Schema.optional(Schema.String).annotate({
    description: "Cutoff message ID, copies only earlier messages (required for split-session)",
  }),
  oldPath: Schema.optional(Schema.String).annotate({ description: "Old path segment to replace (required for fix-paths)" }),
  newPath: Schema.optional(Schema.String).annotate({ description: "New path segment (required for fix-paths)" }),
  sessionId: Schema.optional(Schema.String).annotate({ description: "Session ID (required for unarchive-session)" }),
  newProjectId: Schema.optional(Schema.String).annotate({ description: "New project ID (required for reassign-project)" }),
  filterSessionId: Schema.optional(Schema.String).annotate({ description: "Only reassign this session ID, not all (optional for reassign-project)" }),
})

type Metadata = { [key: string]: any }

export const SessionsManageTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "sessions-manage",
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const doDuplicate = (sourceId: string, newDirectory: string, newTitle: string | undefined, suffix: string, cutoffMsgId: string | undefined) =>
      Effect.gen(function* () {
        const newId = `ses_000000000000${suffix}`
        const title = newTitle || `Split: ${sourceId}`
        const now = Math.floor(Date.now())
        const cutoff = cutoffMsgId ? sql`AND id < ${cutoffMsgId}` : sql``

        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`INSERT OR IGNORE INTO session (id, project_id, parent_id, workspace_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived)
                SELECT ${newId}, project_id, NULL, workspace_id, slug || '_split', ${newDirectory}, ${newDirectory}, ${title}, version, NULL, NULL, NULL, NULL, NULL, NULL, permission, agent, model, ${now}, ${now}, NULL, NULL
                FROM session WHERE id = ${sourceId}`)
              yield* tx.run(sql`INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data)
                SELECT 'msg_000000000000' || substr(id, 19), ${newId}, time_created, time_updated, data
                FROM message WHERE session_id = ${sourceId} ${cutoff} ORDER BY id`)
              yield* tx.run(sql`INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data)
                SELECT 'prt_000000000000' || substr(p.id, 19), 'msg_000000000000' || substr(m_orig.id, 19), ${newId}, p.time_created, p.time_updated, p.data
                FROM part p JOIN message m_orig ON p.message_id = m_orig.id
                WHERE p.session_id = ${sourceId}`)
              yield* tx.run(sql`INSERT OR IGNORE INTO todo (session_id, content, status, priority, position, time_created, time_updated)
                SELECT ${newId}, content, status, priority, position, ${now}, ${now}
                FROM todo WHERE session_id = ${sourceId}`)
            }),
          )
          .pipe(Effect.orDie)

        yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.orDie)

        const verify = yield* db
          .get(sql`SELECT
            (SELECT COUNT(*) FROM message WHERE session_id = ${sourceId}) as original,
            (SELECT COUNT(*) FROM message WHERE session_id = ${newId}) as duplicate`)
          .pipe(Effect.orDie)

        return { newSessionId: newId, ...(verify as Record<string, unknown>) }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (params.confirm !== "yes") throw new Error('confirm must be "yes" for all sessions_manage operations')
          const op = params.op
          const req = (field: string) => {
            const v = (params as any)[field]
            if (v === undefined || v === null || v === "") throw new Error(`${field} is required for op=${op}`)
          }
          switch (op) {
            case "duplicate-session":
              req("sourceId")
              req("newDirectory")
              req("suffix")
              break
            case "split-session":
              req("sourceId")
              req("cutoffMessageId")
              req("newDirectory")
              req("suffix")
              break
            case "fix-paths":
              req("oldPath")
              req("newPath")
              break
            case "unarchive-session":
              req("sessionId")
              break
            case "reassign-project":
              req("newProjectId")
              break
          }

          if (op === "duplicate-session") {
            const result = yield* doDuplicate(params.sourceId!, params.newDirectory!, params.newTitle, params.suffix!, undefined)
            return { title: "duplicated", output: JSON.stringify(result, null, 2), metadata: {} }
          }

          if (op === "split-session") {
            const result = yield* doDuplicate(params.sourceId!, params.newDirectory!, params.newTitle, params.suffix!, params.cutoffMessageId!)
            return { title: "split", output: JSON.stringify(result, null, 2), metadata: {} }
          }

          if (op === "fix-paths") {
            yield* db
              .run(sql`UPDATE session SET directory = REPLACE(directory, ${params.oldPath}, ${params.newPath}) WHERE directory LIKE ${params.oldPath + "%"}`)
              .pipe(Effect.orDie)
            yield* db
              .run(sql`UPDATE session SET path = REPLACE(path, ${params.oldPath}, ${params.newPath}) WHERE path LIKE ${params.oldPath + "%"}`)
              .pipe(Effect.orDie)
            return { title: "fix-paths", output: "Paths updated", metadata: {} }
          }

          if (op === "unarchive-session") {
            yield* db.run(sql`UPDATE session SET time_archived = NULL WHERE id = ${params.sessionId}`).pipe(Effect.orDie)
            return { title: "unarchive", output: "Session unarchived", metadata: {} }
          }

          if (op === "reassign-project") {
            if (params.filterSessionId) {
              yield* db.run(sql`UPDATE session SET project_id = ${params.newProjectId} WHERE id = ${params.filterSessionId}`).pipe(Effect.orDie)
            } else {
              yield* db.run(sql`UPDATE session SET project_id = ${params.newProjectId} WHERE parent_id IS NULL`).pipe(Effect.orDie)
            }
            return { title: "reassign", output: "Project reassigned", metadata: {} }
          }

          throw new Error(`Unknown op: ${op}`)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
