import { Database } from "bun:sqlite"
import { unlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import z from "zod"

const DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db")

export default {
  description: `Void a previous tool output you won't reference again. Safe in plan mode: only touches opencode-internal session state, not user files.

REQUIRED: summary (non-empty string). All other fields are optional with defaults (any tool, latest match).

VOID when:
- Transient outputs (ls, grep, docker logs, git diff/status) you've extracted what you need from.
- Outputs > ~2K tokens where keeping costs more than re-running the tool.

DON'T VOID when:
- Reference material you'll consult again (skills, docs, configs you're studying).
- File contents you're about to edit (need originals for diffs/offsets).
- Anything you'd re-read where the source may change first.

SUMMARY:
- Useless output: short phrase (e.g., "empty", "no matches", "0 errors").
- Useful output: include any finding, value, or line you extracted.
- If you used a fact in your reasoning, put it in the summary.
- The summary is all you'll see going forward. If you'd need to re-read the full output, don't void.

Compaction boundary: void traversal never reaches parts at or before the most recent compaction message. The compaction marks the start of the current live prompt chain; pre-compaction parts aren't in the prompt and voiding them wouldn't reduce context. When the session has NO compaction message (cutoff=0), the search searches ALL session history — every part ever produced in the session is still in the live context window (no compaction has occurred to drop older turns). This is correct behavior, not a bug: uncompacted sessions retain full context including all historical tool outputs. The false-positive "No completed tool outputs found" errors some users encounter with broad substring matches are due to LIKE pattern mismatch with JSON-escaped regex metacharacters in tool input strings (JSON stores regex backslash escapes with doubled backslashes, so a user-supplied substring containing a single backslash before a regex letter won't match the JSON form), not due to absent context. Use precise substrings without regex metacharacters, or let the tool auto-escape them (see input_contains escaping fix below).

BATCH VOID with match: "all": Voids every matching row in one call using the same summary. Use when multiple tool outputs share the same stale status (e.g., multiple reads of a file you've finished restructuring). Aggregate length guard (summary vs sum of all original lengths) so bulk-voiding many small outputs doesn't fail per-row. Each row keeps its own timestamp stamp; each row's outputPath disk file is unlinked if present.

PARALLEL VOID: Issuing multiple void_output tool calls in a single assistant message runs them without an LLM round-trip between them — same KV cache savings as match: "all" but with per-target summaries. Use when N outputs need distinct summaries and target distinct parts (different input_contains substrings matching different parts). Caveat: targets must be disjoint; if two parallel calls match the same most-recent row, race condition. Use match: "all" for same-target cases instead.

OLDER_THAN_TURNS: When set, only voids parts whose parent message is more than N user-turns back from the most recent user message. Useful for voiding stale outputs without explicit targeting. Combined with match:'all' for bulk cleanup of old bash/read/grep outputs.

Full output is gone from future prompts; the TUI record stays. Cannot void void_output itself.`,
  args: {
    summary: z
      .string()
      .describe("Short summary replacing the original output (e.g., '35K tokens of vLLM logs, 0 errors found')"),
    tool_name: z
      .string()
      .optional()
      .describe("Name of the tool whose output to void (e.g., 'bash', 'read'). If omitted, voids the most recent tool output."),
    input_contains: z
      .string()
      .optional()
      .describe("Substring to match against the tool's input JSON (e.g., 'serial-debug' matches a read whose filePath contains it). Use to disambiguate parallel calls of the same tool. Regex metacharacters with backslashes (e.g., \\b, \\d) are auto-doubled to match the JSON-escaped form stored in the DB (JSON stores \\b as \\\\b, so LIKE pattern needs \\\\b to match). Plain substrings without backslashes work unchanged. Use precise substrings for reliable matching."),
    match: z
      .enum(["latest", "all"])
      .optional()
      .default("latest")
      .describe("'latest' (default) voids single most recent match. 'all' voids every matching row with the same summary — use when all matching outputs share the same stale status (e.g., multiple reads of the same file)."),
    olderThanTurns: z
      .number()
      .optional()
      .describe("Only void parts whose parent message is more than N user-turns back from the most recent user message. Useful for voiding stale outputs without explicit targeting. Combined with match:'all' for bulk cleanup."),
  },
  async execute(args, ctx) {
    if (!args.summary || typeof args.summary !== "string" || args.summary.length === 0) {
      throw new Error("summary is required (non-empty string). No other fields are required — tool_name, input_contains, and match are optional with defaults (any tool, latest match).")
    }
    const db = new Database(DB_PATH)
    db.run("PRAGMA foreign_keys = ON")
    try {
      const cutoff = getCompactionCutoff(db, ctx.sessionID)
      const ageCutoff = args.olderThanTurns ? getMessageAgeCutoff(db, ctx.sessionID, args.olderThanTurns) : 0
      const effectiveCutoff = Math.max(cutoff, ageCutoff)
      if (args.match === "all") {
        return voidAll(db, ctx.sessionID, args, effectiveCutoff)
      }
      return voidOne(db, ctx.sessionID, args, effectiveCutoff)
    } finally {
      db.close()
    }
  },
}

function getMessageAgeCutoff(db, sessionID, olderThanTurns) {
  const rows = db
    .query(`SELECT m.time_created FROM message m WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' ORDER BY m.time_created DESC LIMIT ?`)
    .all(sessionID, olderThanTurns + 1)
  if (rows.length < olderThanTurns + 1) return 0
  return rows[rows.length - 1].time_created
}

function getCompactionCutoff(db, sessionID) {
  const row = db
    .query(`SELECT MAX(m.time_created) as cutoff FROM message m WHERE m.session_id = ? AND json_extract(m.data, '$.mode') = 'compaction'`)
    .get(sessionID)
  return row?.cutoff ?? 0
}

function buildQuery(sessionID, target, cutoff, excludeIDs, limitOne) {
  let sql = `SELECT p.id, p.data FROM part p WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.state.status') = 'completed' AND json_extract(p.data, '$.tool') != 'void_output'`
  const params = [sessionID]
  if (target.tool_name) {
    sql += ` AND json_extract(p.data, '$.tool') = ?`
    params.push(target.tool_name)
  }
  if (target.input_contains) {
    sql += ` AND json_extract(p.data, '$.state.input') LIKE ?`
    // JSON string escaping doubles backslashes (\b → \\b, \d → \\d, etc).
    // user-supplied input_contains may contain regex metacharacters with single backslash
    // (e.g., "tp_size.*5\b") that won't match the JSON-escaped form ("tp_size.*5\\b").
    // Auto-double any backslashes in input_contains so LIKE matches the JSON form.
    const escaped = target.input_contains.replace(/\\/g, "\\\\")
    params.push(`%${escaped}%`)
  }
  if (cutoff > 0) {
    sql += ` AND p.time_created > ?`
    params.push(cutoff)
  }
  if (excludeIDs && excludeIDs.length > 0) {
    sql += ` AND p.id NOT IN (${excludeIDs.map(() => "?").join(",")})`
    params.push(...excludeIDs)
  }
  sql += ` ORDER BY p.time_created DESC`
  if (limitOne) sql += ` LIMIT 1`
  return { sql, params }
}

function extractOutput(data) {
  const rawOutput = data.state.output ?? ""
  const stampMatch = rawOutput.match(/\n\n<system-reminder>.*<\/system-reminder>\s*$/)
  const stamp = stampMatch ? stampMatch[0] : ""
  const stripped = stampMatch ? rawOutput.slice(0, stampMatch.index) : rawOutput
  return { stripped, stamp, originalLen: stripped.length }
}

function voidOne(db, sessionID, target, cutoff) {
  const { sql, params } = buildQuery(sessionID, target, cutoff, null, true)
  const row = db.query(sql).get(...params)
  if (!row) {
    throw new Error(`No completed tool output found${target.tool_name ? ` for tool '${target.tool_name}'` : ""}${target.input_contains ? ` with input containing '${target.input_contains}'` : ""}${cutoff > 0 ? ` after compaction boundary` : ""} to void.`)
  }

  const data = JSON.parse(row.data)
  const { stripped, stamp, originalLen } = extractOutput(data)
  const outputPath = data.state.metadata?.outputPath

  if (target.summary.length >= originalLen) {
    throw new Error(`Summary (${target.summary.length} chars) is not shorter than the original output (${originalLen} chars, excluding timestamp). Voiding would make the prompt larger, not smaller. Extract only the essential findings, or don't void if the output is already short.`)
  }

  data.state.output = target.summary + stamp
  db.run(`UPDATE part SET data = ?, time_updated = ? WHERE id = ?`, JSON.stringify(data), Date.now(), row.id)

  if (outputPath) {
    try { unlink(outputPath) } catch {}
  }

  return {
    title: `Voided ${data.tool} output`,
    output: `Voided ${data.tool} output (${originalLen} chars replaced with ${target.summary.length} char summary). The full output will not appear in future prompts.`,
    metadata: { voided: true, tool: data.tool, partID: row.id, originalLen, outputPath: outputPath ?? null },
  }
}

function voidAll(db, sessionID, target, cutoff) {
  const { sql, params } = buildQuery(sessionID, target, cutoff, null, false)
  const rows = db.query(sql).all(...params)
  if (rows.length === 0) {
    throw new Error(`No completed tool outputs found${target.tool_name ? ` for tool '${target.tool_name}'` : ""}${target.input_contains ? ` with input containing '${target.input_contains}'` : ""}${cutoff > 0 ? ` after compaction boundary` : ""} to void.`)
  }

  let aggregateOriginal = 0
  const updates = []
  for (const row of rows) {
    const data = JSON.parse(row.data)
    const { stripped, stamp, originalLen } = extractOutput(data)
    aggregateOriginal += originalLen
    updates.push({ row, data, stamp, originalLen, outputPath: data.state.metadata?.outputPath ?? null })
  }

  if (target.summary.length >= aggregateOriginal) {
    throw new Error(`Summary (${target.summary.length} chars) is not shorter than the aggregate original output (${aggregateOriginal} chars across ${rows.length} parts, excluding timestamps). Voiding would make the prompt larger, not smaller.`)
  }

  const results = []
  for (const u of updates) {
    u.data.state.output = target.summary + u.stamp
    db.run(`UPDATE part SET data = ?, time_updated = ? WHERE id = ?`, JSON.stringify(u.data), Date.now(), u.row.id)
    if (u.outputPath) {
      try { unlink(u.outputPath) } catch {}
    }
    results.push({ tool: u.data.tool, partID: u.row.id, originalLen: u.originalLen })
  }

  return {
    title: `Voided ${results.length} ${results[0].tool} outputs`,
    output: results.map((r) => `Voided ${r.tool} output (${r.originalLen} chars → ${target.summary.length} char summary)`).join("\n") + `\n\nAggregate: ${aggregateOriginal} chars replaced with ${target.summary.length} char summary across ${results.length} parts.`,
    metadata: { voided: true, count: results.length, results },
  }
}
