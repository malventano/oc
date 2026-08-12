import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { copyFile } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = `Query the opencode session database (SQLite). Ops:

REQUIRED vs OPTIONAL args differ per op:

| op | required | optional |
|----|----------|----------|
| query | sql | format |
| list-tables | - | format |
| describe-table | tableName | - |
| execute | sql, confirm | - |
| transaction | statements, confirm | - |
| checkpoint | - | mode |
| backup | outputPath | - |

Operations:
- query: Run SELECT sql (read-only; only SELECT/WITH/EXPLAIN/PRAGMA allowed). Returns json/csv/table (default json).
- list-tables: List all tables.
- describe-table: Get table schema (columns, indexes, foreign keys).
- execute: Run write SQL (INSERT/UPDATE/DELETE/PRAGMA). Requires confirm="yes".
- transaction: Run multiple SQL statements in a transaction. Requires confirm="yes".
- checkpoint: Run PRAGMA wal_checkpoint. Modes: TRUNCATE (default), PASS, RERESTART.
- backup: Create DB backup copy. Checkpoints WAL first.`

export const Parameters = Schema.Struct({
  op: Schema.Literals(["query", "list-tables", "describe-table", "execute", "transaction", "checkpoint", "backup"]).annotate({
    description: "Operation to perform",
  }),
  sql: Schema.optional(Schema.String).annotate({ description: "SQL query or statement (required for query/execute)" }),
  format: Schema.optional(Schema.Literals(["json", "csv", "table"])).annotate({ description: "Output format for query/list-tables (default json)" }),
  tableName: Schema.optional(Schema.String).annotate({ description: "Table name (required for describe-table)" }),
  confirm: Schema.optional(Schema.String).annotate({ description: 'Must be "yes" (required for execute/transaction)' }),
  statements: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "SQL statements (required for transaction)" }),
  mode: Schema.optional(Schema.Literals(["TRUNCATE", "PASS", "RERESTART"])).annotate({ description: "Checkpoint mode (default TRUNCATE)" }),
  outputPath: Schema.optional(Schema.String).annotate({ description: "Backup file path (required for backup)" }),
})

type Metadata = { [key: string]: any }

function formatRows(rows: unknown[], format: string | undefined) {
  if (!rows || !rows.length) return format === "json" ? "[]" : ""
  if (format === "csv") return toCsv(rows as Record<string, unknown>[])
  if (format === "table") return toTable(rows as Record<string, unknown>[])
  return JSON.stringify(rows, null, 2)
}

function toCsv(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0])
  const esc_ = (v: unknown) => {
    const s = String(v ?? "")
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc_(r[k])).join(","))].join("\n")
}

function toTable(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0])
  const widths = keys.map((k, i) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)))
  const fmt = (vals: string[]) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ")
  return [fmt(keys), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map((r) => fmt(keys.map((k) => String(r[k] ?? ""))))].join("\n")
}

const READONLY_PREFIX = /^(SELECT|WITH|EXPLAIN|PRAGMA)\b/i

export const SessionsQueryTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  "sessions-query",
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
            case "query":
            case "execute":
              req("sql")
              break
            case "describe-table":
              req("tableName")
              break
            case "transaction":
              req("statements")
              break
            case "backup":
              req("outputPath")
              break
          }

          if (op === "query") {
            const stmt = params.sql!.trim()
            if (!READONLY_PREFIX.test(stmt)) throw new Error("query op only allows SELECT/WITH/EXPLAIN/PRAGMA (use execute for writes)")
            const format = params.format
            const rows = yield* db.all(sql`${sql.raw(stmt)}`).pipe(Effect.orDie)
            return { title: "query", output: formatRows(rows, format), metadata: {} }
          }

          if (op === "list-tables") {
            const rows = yield* db
              .all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
              .pipe(Effect.orDie)
            return { title: "tables", output: formatRows(rows, params.format), metadata: {} }
          }

          if (op === "describe-table") {
            const t = String(params.tableName || "").replace(/"/g, '""')
            const columns = yield* db.all(sql`PRAGMA table_info(${sql.raw(`"${t}"`)})`).pipe(Effect.orDie)
            const indexes = yield* db.all(sql`PRAGMA index_list(${sql.raw(`"${t}"`)})`).pipe(Effect.orDie)
            const foreignKeys = yield* db.all(sql`PRAGMA foreign_key_list(${sql.raw(`"${t}"`)})`).pipe(Effect.orDie)
            return {
              title: "describe",
              output: JSON.stringify({ tableName: t, columns, indexes, foreignKeys }, null, 2),
              metadata: {},
            }
          }

          if (op === "execute") {
            if (params.confirm !== "yes") throw new Error('confirm must be "yes" for op=execute')
            yield* db.run(sql`${sql.raw(params.sql!)}`).pipe(Effect.orDie)
            const result = yield* db.get(sql`SELECT changes() as changes, last_insert_rowid() as lastInsertRowid`).pipe(Effect.orDie)
            return { title: "execute", output: `OK (changes: ${(result as any).changes}, lastInsertRowid: ${(result as any).lastInsertRowid})`, metadata: {} }
          }

          if (op === "transaction") {
            if (params.confirm !== "yes") throw new Error('confirm must be "yes" for op=transaction')
            const stmts = (params.statements || []).map((s) => s.trim()).filter(Boolean)
            if (!stmts.length) throw new Error("No statements to execute")
            yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  for (const s of stmts) {
                    yield* tx.run(sql`${sql.raw(s)}`)
                  }
                }),
              )
              .pipe(Effect.orDie)
            return { title: "transaction", output: "Transaction committed successfully", metadata: {} }
          }

          if (op === "checkpoint") {
            const mode = params.mode || "TRUNCATE"
            const result = yield* db.get(sql`PRAGMA wal_checkpoint(${sql.raw(mode)})`).pipe(Effect.orDie)
            return { title: "checkpoint", output: JSON.stringify(result), metadata: {} }
          }

          if (op === "backup") {
            yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`).pipe(Effect.orDie)
            yield* Effect.promise(() => copyFile(Database.path(), params.outputPath!))
            return { title: "backup", output: `Backup created at ${params.outputPath}`, metadata: {} }
          }

          throw new Error(`Unknown op: ${op}`)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
