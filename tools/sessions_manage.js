import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import z from "zod"

const DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db")

function esc(s) { return String(s).replace(/'/g, "''") }

function doDuplicate(db, sourceId, newDirectory, newTitle, suffix, cutoffMsgId) {
  const newId = `ses_000000000000${suffix}`
  const title = newTitle || `Split: ${sourceId}`
  const now = Math.floor(Date.now())
  const cutoff = cutoffMsgId ? `AND id < '${esc(cutoffMsgId)}'` : ""

  db.run("PRAGMA foreign_keys = ON")
  db.exec("BEGIN;")
  try {
    db.run(`INSERT OR IGNORE INTO session (id, project_id, parent_id, workspace_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived)
      SELECT '${newId}', project_id, NULL, workspace_id, slug || '_split', '${esc(newDirectory)}', '${esc(newDirectory)}', '${esc(title)}', version, NULL, NULL, NULL, NULL, NULL, NULL, permission, agent, model, ${now}, ${now}, NULL, NULL
      FROM session WHERE id = '${esc(sourceId)}'`)

    db.run(`INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data)
      SELECT 'msg_000000000000' || substr(id, 19), '${newId}', time_created, time_updated, data
      FROM message WHERE session_id = '${esc(sourceId)}' ${cutoff} ORDER BY id`)

    db.run(`INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data)
      SELECT 'prt_000000000000' || substr(p.id, 19), 'msg_000000000000' || substr(m_orig.id, 19), '${newId}', p.time_created, p.time_updated, p.data
      FROM part p JOIN message m_orig ON p.message_id = m_orig.id
      WHERE p.session_id = '${esc(sourceId)}'`)

    db.run(`INSERT OR IGNORE INTO todo (session_id, content, status, priority, position, time_created, time_updated)
      SELECT '${newId}', content, status, priority, position, ${now}, ${now}
      FROM todo WHERE session_id = '${esc(sourceId)}'`)

    db.exec("COMMIT;")
  } catch (e) {
    try { db.exec("ROLLBACK;") } catch {}
    throw e
  }

  db.run("PRAGMA wal_checkpoint(TRUNCATE)")

  const verify = db.prepare(`SELECT
    (SELECT COUNT(*) FROM message WHERE session_id = ?) as original,
    (SELECT COUNT(*) FROM message WHERE session_id = ?) as duplicate`).get(sourceId, newId)

  return JSON.stringify({ newSessionId: newId, ...verify })
}

export default {
  description: `Manage opencode sessions (write operations). All ops require confirm="yes".

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| duplicate-session | sourceId, newDirectory, suffix, confirm | newTitle |
| split-session | sourceId, cutoffMessageId, newDirectory, suffix, confirm | newTitle |
| fix-paths | oldPath, newPath, confirm | — |
| unarchive-session | sessionId, confirm | — |
| reassign-project | newProjectId, confirm | filterSessionId |

Operations:
- duplicate-session: Duplicate session preserving all messages/parts/todos.
- split-session: Split session at cutoff message, copying earlier messages only.
- fix-paths: Fix stale directory/path values by replacing old segment with new.
- unarchive-session: Unarchive session by clearing time_archived.
- reassign-project: Reassign sessions to new project_id (fix TUI visibility).`,
  args: {
    op: z.enum(["duplicate-session", "split-session", "fix-paths", "unarchive-session", "reassign-project"]).describe("Operation to perform"),
    confirm: z.string().describe('Must be "yes" for all operations'),
    sourceId: z.string().optional().describe("Source session ID (required for duplicate-session/split-session)"),
    newDirectory: z.string().optional().describe("New directory path (required for duplicate-session/split-session)"),
    newTitle: z.string().optional().describe("New session title (optional for duplicate-session/split-session)"),
    suffix: z.string().optional().describe("Suffix appended to new session ID (required for duplicate-session/split-session)"),
    cutoffMessageId: z.string().optional().describe("Cutoff message ID, copies only earlier messages (required for split-session)"),
    oldPath: z.string().optional().describe("Old path segment to replace (required for fix-paths)"),
    newPath: z.string().optional().describe("New path segment (required for fix-paths)"),
    sessionId: z.string().optional().describe("Session ID (required for unarchive-session)"),
    newProjectId: z.string().optional().describe("New project ID (required for reassign-project)"),
    filterSessionId: z.string().optional().describe("Only reassign this session ID, not all (optional for reassign-project)"),
  },
  async execute(args, ctx) {
    if (args.confirm !== "yes") throw new Error('confirm must be "yes" for all sessions_manage operations')
    const op = args.op
    const req = (field) => {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new Error(`${field} is required for op=${op}`)
      }
    }
    switch (op) {
      case "duplicate-session": req("sourceId"); req("newDirectory"); req("suffix"); break
      case "split-session": req("sourceId"); req("cutoffMessageId"); req("newDirectory"); req("suffix"); break
      case "fix-paths": req("oldPath"); req("newPath"); break
      case "unarchive-session": req("sessionId"); break
      case "reassign-project": req("newProjectId"); break
    }

    if (op === "duplicate-session") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        return doDuplicate(db, args.sourceId, args.newDirectory, args.newTitle, args.suffix, null)
      } finally { db.close() }
    }

    if (op === "split-session") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        return doDuplicate(db, args.sourceId, args.newDirectory, args.newTitle, args.suffix, args.cutoffMessageId)
      } finally { db.close() }
    }

    if (op === "fix-paths") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        db.run(`UPDATE session SET directory = REPLACE(directory, '${esc(args.oldPath)}', '${esc(args.newPath)}') WHERE directory LIKE '${esc(args.oldPath)}%'`)
        db.run(`UPDATE session SET path = REPLACE(path, '${esc(args.oldPath)}', '${esc(args.newPath)}') WHERE path LIKE '${esc(args.oldPath)}%'`)
        return "Paths updated"
      } finally { db.close() }
    }

    if (op === "unarchive-session") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        db.run("UPDATE session SET time_archived = NULL WHERE id = ?", [args.sessionId])
        return "Session unarchived"
      } finally { db.close() }
    }

    if (op === "reassign-project") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        if (args.filterSessionId) {
          db.run("UPDATE session SET project_id = ? WHERE id = ?", [args.newProjectId, args.filterSessionId])
        } else {
          db.run("UPDATE session SET project_id = ? WHERE parent_id IS NULL", [args.newProjectId])
        }
        return "Project reassigned"
      } finally { db.close() }
    }

    throw new Error(`Unknown op: ${op}`)
  },
}
