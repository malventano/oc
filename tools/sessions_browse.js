import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import z from "zod"

const DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db")

function clamp(v, dflt, max) { const n = v ?? dflt; return Math.min(max, Math.max(0, n)) }

export default {
  description: `Browse opencode session data (read-only). Ops:

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| recent-sessions | — | offset, limit |
| session-search | pattern | offset, limit |
| session-info | sessionId | — |
| subagent-info | parentId | — |
| list-session-messages | sessionId | role, offset, limit, preview_length, full_content, after, before |
| list-session-parts-by-tool | sessionId | toolName, status, offset, limit, preview_length, full_content |
| session-goal-history | sessionId | offset, limit |
| search-text | term | sessionId, offset, limit, preview_length, full_content |

Operations:
- recent-sessions: List recent top-level sessions with message counts.
- session-search: Search sessions by title or directory pattern.
- session-info: Get session summary (messages, tokens, timestamps).
- subagent-info: Get subagent child sessions.
- list-session-messages: List messages in session with previews, timestamps, token counts.
- list-session-parts-by-tool: List tool call parts filtered by tool name and/or status.
- session-goal-history: Find ## Goal block updates chronologically.
- search-text: Search text content in messages and tool outputs across all sessions or within specific session ID.`,
  args: {
    op: z.enum(["recent-sessions", "session-search", "session-info", "subagent-info", "list-session-messages", "list-session-parts-by-tool", "session-goal-history", "search-text"]).describe("Operation to perform"),
    sessionId: z.string().optional().describe("Session ID. Required for session-info, list-session-messages, list-session-parts-by-tool, session-goal-history. Optional for search-text."),
    parentId: z.string().optional().describe("Parent session ID (required for subagent-info)"),
    pattern: z.string().optional().describe("Search pattern (required for session-search)"),
    term: z.string().optional().describe("Search term (required for search-text)"),
    role: z.string().optional().describe("Filter by role (for list-session-messages)"),
    toolName: z.string().optional().describe("Filter by tool name (for list-session-parts-by-tool)"),
    status: z.string().optional().describe("Filter by status (for list-session-parts-by-tool)"),
    offset: z.number().optional().describe("Result offset (default 0)"),
    limit: z.number().optional().describe("Result limit (default 50, max 500)"),
    preview_length: z.number().optional().describe("Preview length in chars (default 300)"),
    full_content: z.boolean().optional().describe("Return full content without truncation (default false)"),
    after: z.string().optional().describe("ISO date string, filter messages after this time (for list-session-messages)"),
    before: z.string().optional().describe("ISO date string, filter messages before this time (for list-session-messages)"),
  },
  async execute(args, ctx) {
    const op = args.op
    const req = (field) => {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new Error(`${field} is required for op=${op}`)
      }
    }
    switch (op) {
      case "session-search": req("pattern"); break
      case "session-info": req("sessionId"); break
      case "subagent-info": req("parentId"); break
      case "list-session-messages": req("sessionId"); break
      case "list-session-parts-by-tool": req("sessionId"); break
      case "session-goal-history": req("sessionId"); break
      case "search-text": req("term"); break
    }
    const db = new Database(DB_PATH, { readonly: true })

    try {
      if (op === "recent-sessions") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const rows = db.prepare(`SELECT s.id, s.title, s.directory, s.project_id,
          (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
          datetime(s.time_updated/1000, 'unixepoch') as last_active,
          s.cost
          FROM session s WHERE s.parent_id IS NULL
          ORDER BY s.time_updated DESC LIMIT ? OFFSET ?`).all(lim, off)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "session-search") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const pat = `%${args.pattern}%`
        const rows = db.prepare(`SELECT s.id, s.title, s.directory, s.project_id,
          (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
          datetime(s.time_updated/1000, 'unixepoch') as last_active
          FROM session s WHERE s.parent_id IS NULL
          AND (s.title LIKE ? OR s.directory LIKE ?)
          ORDER BY s.time_updated DESC LIMIT ? OFFSET ?`).all(pat, pat, lim, off)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "session-info") {
        const rows = db.prepare(`SELECT s.id, s.title, s.directory, s.project_id,
          json_extract(s.model, '$.id') as model_id,
          datetime(s.time_created/1000, 'unixepoch') as created,
          datetime(s.time_updated/1000, 'unixepoch') as updated,
          (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
          (SELECT SUM(json_extract(data, '$.tokens.input')) FROM message WHERE session_id = s.id) as total_input,
          (SELECT SUM(json_extract(data, '$.tokens.output')) FROM message WHERE session_id = s.id) as total_output,
          (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id AND json_extract(p.data, '$.type') = 'compaction') as compactions
          FROM session s WHERE s.id = ?`).all(args.sessionId)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "subagent-info") {
        const rows = db.prepare(`SELECT s.id, s.title,
          (SELECT COUNT(*) FROM message WHERE session_id = s.id) as messages,
          datetime(s.time_created/1000, 'unixepoch') as started,
          datetime(s.time_updated/1000, 'unixepoch') as finished,
          (SELECT SUM(json_extract(data, '$.tokens.input')) FROM message WHERE session_id = s.id) as total_input,
          (SELECT SUM(json_extract(data, '$.tokens.output')) FROM message WHERE session_id = s.id) as total_output
          FROM session s WHERE s.parent_id = ?
          ORDER BY s.time_created`).all(args.parentId)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "list-session-messages") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const plen = args.preview_length || 300
        const full = args.full_content === true
        const textExpr = full
          ? "json_extract(p.data, '$.text')"
          : `substr(json_extract(p.data, '$.text'), 1, ${plen})`
        let sql = `SELECT datetime(m.time_created/1000, 'unixepoch') as time,
          json_extract(m.data, '$.role') as role,
          json_extract(p.data, '$.type') as part_type,
          ${textExpr} as text_preview,
          json_extract(m.data, '$.tokens.input') as input_tokens,
          json_extract(m.data, '$.tokens.output') as output_tokens
          FROM message m
          JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?
          AND json_extract(p.data, '$.type') = 'text'`
        const params = [args.sessionId]
        if (args.role) { sql += ` AND json_extract(m.data, '$.role') = ?`; params.push(args.role) }
        if (args.after) { sql += ` AND m.time_created > ?`; params.push(Math.floor(new Date(args.after).getTime() / 1000)) }
        if (args.before) { sql += ` AND m.time_created < ?`; params.push(Math.floor(new Date(args.before).getTime() / 1000)) }
        sql += ` ORDER BY m.time_created DESC LIMIT ? OFFSET ?`
        params.push(lim, off)
        const rows = db.prepare(sql).all(...params)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "list-session-parts-by-tool") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const plen = args.preview_length || 300
        const full = args.full_content === true
        const inputExpr = full
          ? "json_extract(p.data, '$.state.input')"
          : `substr(json_extract(p.data, '$.state.input'), 1, ${plen})`
        const outputExpr = full
          ? "json_extract(p.data, '$.state.output')"
          : `substr(json_extract(p.data, '$.state.output'), 1, ${plen})`
        let sql = `SELECT datetime(p.time_created/1000, 'unixepoch') as time,
          json_extract(p.data, '$.tool') as tool,
          json_extract(p.data, '$.state.status') as status,
          ${inputExpr} as input_preview,
          ${outputExpr} as output_preview
          FROM part p
          WHERE p.session_id = ?
          AND json_extract(p.data, '$.type') = 'tool'`
        const params = [args.sessionId]
        if (args.toolName) { sql += ` AND json_extract(p.data, '$.tool') = ?`; params.push(args.toolName) }
        if (args.status && args.status !== "all") { sql += ` AND json_extract(p.data, '$.state.status') = ?`; params.push(args.status) }
        sql += ` ORDER BY p.time_created DESC LIMIT ? OFFSET ?`
        params.push(lim, off)
        const rows = db.prepare(sql).all(...params)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "session-goal-history") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const rows = db.prepare(`SELECT datetime(m.time_created/1000, 'unixepoch') as time,
          length(json_extract(p.data, '$.text')) as char_count,
          json_extract(p.data, '$.text') as text
          FROM message m
          JOIN part p ON p.message_id = m.id
          WHERE m.session_id = ?
          AND json_extract(p.data, '$.type') = 'text'
          AND json_extract(m.data, '$.role') = 'assistant'
          AND json_extract(p.data, '$.text') LIKE '%## Goal%'
          ORDER BY m.time_created ASC
          LIMIT ? OFFSET ?`).all(args.sessionId, lim, off)
        return JSON.stringify(rows, null, 2)
      }

      if (op === "search-text") {
        const off = clamp(args.offset, 0, Infinity)
        const lim = clamp(args.limit, 50, 500)
        const plen = args.preview_length || 300
        const full = args.full_content === true
        const previewExpr = full
          ? "COALESCE(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output'))"
          : `substr(COALESCE(json_extract(p.data, '$.text'), json_extract(p.data, '$.state.output')), 1, ${plen})`
        const term = `%${args.term}%`
        let sql, params
        if (args.sessionId) {
          sql = `SELECT p.id, json_extract(p.data, '$.type') as type,
            ${previewExpr} as preview
            FROM part p WHERE p.session_id = ?
            AND (json_extract(p.data, '$.text') LIKE ?
              OR json_extract(p.data, '$.state.output') LIKE ?)
            ORDER BY p.time_created DESC LIMIT ? OFFSET ?`
          params = [args.sessionId, term, term, lim, off]
        } else {
          sql = `SELECT s.title, p.id, json_extract(p.data, '$.type') as type,
            ${previewExpr} as preview
            FROM part p JOIN session s ON p.session_id = s.id
            WHERE json_extract(p.data, '$.text') LIKE ?
              OR json_extract(p.data, '$.state.output') LIKE ?
            ORDER BY p.time_created DESC LIMIT ? OFFSET ?`
          params = [term, term, lim, off]
        }
        const rows = db.prepare(sql).all(...params)
        return JSON.stringify(rows, null, 2)
      }

      throw new Error(`Unknown op: ${op}`)
    } finally {
      db.close()
    }
  },
}
