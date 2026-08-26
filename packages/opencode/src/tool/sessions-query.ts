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
| schema | - | - |

Operations:
- query: Run SELECT sql (read-only; only SELECT/WITH/EXPLAIN/PRAGMA allowed). Returns json/csv/table (default json).
- list-tables: List all tables.
- describe-table: Get table schema (columns, indexes, foreign keys) INCLUDING json-extract keys of any data/metadata content blob.
- schema: Get ALL tables' real columns + data-blob keys in one call - run this BEFORE querying to avoid no-such-column retries.
- execute: Run write SQL (INSERT/UPDATE/DELETE/PRAGMA). Requires confirm="yes".
- transaction: Run multiple SQL statements in a transaction. Requires confirm="yes".
- checkpoint: Run PRAGMA wal_checkpoint. Modes: TRUNCATE (default), PASS, RERESTART.
- backup: Create DB backup copy. Checkpoints WAL first.

Content is stored as JSON: the message/part/event data column holds {role,text} / {type,text}; session.metadata and message.data have more keys. Query it with json_extract(data, '$.role') rather than data.role (avoid no-such-column errors). Prefer browse ops for anchored page reads instead of hand-rolled SQL.`

export const Parameters = Schema.Struct({
  op: Schema.Literals(["query", "list-tables", "describe-table", "schema", "execute", "transaction", "checkpoint", "backup"]).annotate({
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

// The DB's `message`/`part`/`event` tables store their real content in a JSON
// `data` blob (`{role,text}` / `{type,text}`) - nearly all "no such column:
// m.role / p.type" failures came from the agent guessing scalar columns for
// data that actually lives inside the blob. Surface the blob keys in
// describe/schema + on error so the agent can write json_extract from the
// start.
const JSON_PAYLOAD_FIELDS = ["data", "metadata", "options"]

const tableInfo = (db: Database.Interface["db"], table: string): Effect.Effect<unknown, never, never> =>
  db.all(sql`PRAGMA table_info(${sql.raw(`"${table.replace(/[^A-Za-z0-9_]/g, "")}"`)})`).pipe(Effect.orDie) as Effect.Effect<unknown, never, never>

// probeJsonKeys: for each JSON payload column on the table, collect the union
// of top-level keys across a sample of rows (so describe/schema tell the agent
// the content lives in the blob, written with json_extract).
const probeJsonKeys = Effect.fn("sessions-query.probeJsonKeys")(function* (db: Database.Interface["db"], table: string) {
  const cleaned = table.replace(/[^A-Za-z0-9_]/g, "")
  const cols = (yield* tableInfo(db, cleaned)) as { name: string; type: string }[]
  const out: { key: string; keys: string[] }[] = []
  for (const field of JSON_PAYLOAD_FIELDS) {
    if (!cols.some((c) => c.name === field)) continue
    const rows = (yield* db
      .all(
        sql`SELECT ${sql.raw(field)} FROM ${sql.raw(`"${cleaned}"`)} WHERE ${sql.raw(field)} IS NOT NULL AND ${sql.raw(field)} != '' LIMIT 200`,
      )
      .pipe(Effect.orDie)) as Record<string, unknown>[]
    const keys = new Set<string>()
    for (const r of rows) {
      const v = r[field]
      if (typeof v !== "string") continue
      try {
        const parsed = JSON.parse(v)
        if (parsed && typeof parsed === "object") for (const k of Object.keys(parsed)) keys.add(k)
      } catch {
        // row not JSON - skip
      }
    }
    if (keys.size) out.push({ key: field, keys: [...keys].sort() })
  }
  return out
})

// hintedError: on a no-such-column/function failure, append the referenced
// table's real columns + JSON payload keys so the failed call teaches the
// correction instead of prompting a second blind guess.
const hintedError = Effect.fn("sessions-query.hintedError")(function* (db: Database.Interface["db"], sqlText: string, raw: unknown) {
  const msg = String((raw as { message?: unknown })?.message ?? raw)
  if (!msg.includes("no such column") && !msg.includes("no such function")) return new Error(msg)
  const tables = [...new Set([...sqlText.matchAll(/\b(?:from|join)\s+["']?([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]))]
  if (!tables.length) return new Error(msg)
  let hint = ""
  for (const t of tables) {
    const cleaned = t.replace(/["']/g, "")
    const cols = (yield* tableInfo(db, cleaned)) as { name: string; type: string }[]
    if (!cols.length) continue
    const jsonKeys = yield* probeJsonKeys(db, cleaned)
    const parts = [`"${cleaned}" columns: ${cols.map((c) => c.name).join(", ")}`]
    for (const j of jsonKeys) parts.push(`content '{${j.keys.join(", ")}}' lives in ${j.key} (use json_extract(${j.key}, '$.key'))`)
    hint = (hint ? hint + "\n" : "") + parts.join("; ")
  }
  return new Error(`${msg}\n\nschema: ${hint}`)
})

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
            // db.all defects on a sqlite error; catchDefect recomputes the
            // hinted message and re-defects so the failed call teaches the
            // real schema (columns + json payload keys) instead of a bare
            // "no such column".
            const rows = (yield* db.all(sql`${sql.raw(stmt)}`).pipe(
              Effect.orDie,
              // After orDie, the sqlite failure is a defect; catch it, compute
              // the hinted message, re-die so the failed call teaches the real
              // schema (columns + json payload keys) instead of a bare
              // "no such column".
              Effect.catchDefect((e) => hintedError(db as any, stmt, e).pipe(Effect.andThen((hint) => Effect.die(hint)))),
            )) as unknown[]
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
            const jsonKeys = yield* probeJsonKeys(db, t)
            return {
              title: "describe",
              output: JSON.stringify({ tableName: t, columns, indexes, foreignKeys, jsonKeys }, null, 2),
              metadata: {},
            }
          }

          if (op === "schema") {
            const tables = (yield* db
              .all(sql`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
              .pipe(Effect.orDie)) as { name: string }[]
            const out: Record<string, { columns: string[]; json?: { key: string; keys: string[] }[] }> = {}
            for (const { name } of tables) {
              const cols = (yield* db.all(sql`PRAGMA table_info(${sql.raw(`"${name.replace(/"/g, "")}"`)})`).pipe(
                Effect.orDie,
              )) as { name: string; type: string }[]
              out[name] = { columns: cols.map((c) => c.name) }
              const jsonKeys = yield* probeJsonKeys(db, name)
              if (jsonKeys.length) out[name]!.json = jsonKeys
            }
            return { title: "schema", output: JSON.stringify(out, null, 2), metadata: {} }
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
