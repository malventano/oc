import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { copyFile } from "node:fs/promises"
import z from "zod"

const DB_PATH = path.join(os.homedir(), ".local/share/opencode/opencode.db")

function esc(s) { return String(s).replace(/'/g, "''") }

function formatRows(rows, format) {
  if (!rows || !rows.length) return format === "json" ? "[]" : ""
  if (format === "csv") return toCsv(rows)
  if (format === "table") return toTable(rows)
  return JSON.stringify(rows, null, 2)
}

function toCsv(rows) {
  const keys = Object.keys(rows[0])
  const esc_ = (v) => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s }
  return [keys.join(","), ...rows.map(r => keys.map(k => esc_(r[k])).join(","))].join("\n")
}

function toTable(rows) {
  const keys = Object.keys(rows[0])
  const widths = keys.map((k, i) => Math.max(k.length, ...rows.map(r => String(r[k] ?? "").length)))
  const fmt = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")
  return [fmt(keys), widths.map(w => "-".repeat(w)).join("  "), ...rows.map(r => fmt(keys.map(k => r[k])))].join("\n")
}

export default {
  description: `Query the opencode session database (SQLite). Ops:

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| query | sql | format |
| list-tables | — | format |
| describe-table | tableName | — |
| execute | sql, confirm | — |
| transaction | statements, confirm | — |
| checkpoint | — | mode |
| backup | outputPath | — |

Operations:
- query: Run SELECT sql. Returns json/csv/table (default json).
- list-tables: List all tables.
- describe-table: Get table schema (columns, indexes, foreign keys).
- execute: Run write SQL (INSERT/UPDATE/DELETE/PRAGMA). Requires confirm="yes".
- transaction: Run multiple SQL statements in a transaction. Requires confirm="yes".
- checkpoint: Run PRAGMA wal_checkpoint. Modes: TRUNCATE (default), PASS, RERESTART.
- backup: Create DB backup copy. Checkpoints WAL first.`,
  args: {
    op: z.enum(["query", "list-tables", "describe-table", "execute", "transaction", "checkpoint", "backup"]).describe("Operation to perform"),
    sql: z.string().optional().describe("SQL query or statement (required for query/execute)"),
    format: z.enum(["json", "csv", "table"]).optional().describe("Output format for query/list-tables (default json)"),
    tableName: z.string().optional().describe("Table name (required for describe-table)"),
    confirm: z.string().optional().describe('Must be "yes" (required for execute/transaction)'),
    statements: z.array(z.string()).optional().describe("SQL statements (required for transaction)"),
    mode: z.enum(["TRUNCATE", "PASS", "RERESTART"]).optional().describe("Checkpoint mode (default TRUNCATE)"),
    outputPath: z.string().optional().describe("Backup file path (required for backup)"),
  },
  async execute(args, ctx) {
    const op = args.op
    const req = (field) => {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new Error(`${field} is required for op=${op}`)
      }
    }
    switch (op) {
      case "query": req("sql"); break
      case "describe-table": req("tableName"); break
      case "execute": req("sql"); if (args.confirm !== "yes") throw new Error('confirm must be "yes" for op=execute'); break
      case "transaction": req("statements"); if (args.confirm !== "yes") throw new Error('confirm must be "yes" for op=transaction'); break
      case "backup": req("outputPath"); break
    }

    if (op === "query") {
      const format = args.format || "json"
      const db = new Database(DB_PATH, { readonly: true })
      try {
        const rows = db.prepare(args.sql).all()
        return formatRows(rows, format)
      } finally { db.close() }
    }

    if (op === "list-tables") {
      const format = args.format || "json"
      const db = new Database(DB_PATH, { readonly: true })
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        return formatRows(rows, format)
      } finally { db.close() }
    }

    if (op === "describe-table") {
      const t = String(args.tableName || "").replace(/"/g, '""')
      const db = new Database(DB_PATH, { readonly: true })
      try {
        const columns = db.prepare(`PRAGMA table_info("${t}")`).all()
        const indexes = db.prepare(`PRAGMA index_list("${t}")`).all()
        const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${t}")`).all()
        return JSON.stringify({ tableName: t, columns, indexes, foreignKeys }, null, 2)
      } finally { db.close() }
    }

    if (op === "execute") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        const result = db.run(args.sql)
        return `OK (changes: ${result.changes}, lastInsertRowid: ${result.lastInsertRowid})`
      } finally { db.close() }
    }

    if (op === "transaction") {
      const stmts = (args.statements || []).map(s => s.trim()).filter(Boolean)
      if (!stmts.length) throw new Error("No statements to execute")
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        db.exec("BEGIN;")
        for (const s of stmts) db.exec(s)
        db.exec("COMMIT;")
        return "Transaction committed successfully"
      } catch (e) {
        try { db.exec("ROLLBACK;") } catch {}
        throw e
      } finally { db.close() }
    }

    if (op === "checkpoint") {
      const mode = args.mode || "TRUNCATE"
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        const result = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()
        return JSON.stringify(result)
      } finally { db.close() }
    }

    if (op === "backup") {
      const db = new Database(DB_PATH)
      db.run("PRAGMA foreign_keys = ON")
      try {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      } finally { db.close() }
      await copyFile(DB_PATH, args.outputPath)
      return `Backup created at ${args.outputPath}`
    }

    throw new Error(`Unknown op: ${op}`)
  },
}
