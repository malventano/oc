import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { unlink } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = `Replace a past tool output in this session with a short summary you write, so future prompts see the small version instead of the full output. Use proactively: every turn re-reads every output in the chain, so long outputs you've finished with keep costing context. Squash soon after use - edits near the end of the chain preserve the prefix cache; edits deep in history invalidate everything after them.

WHEN to squash: outputs > ~2K tokens you won't reference again (ls, grep, docker logs, git diff/status, build logs) once you've extracted what you need from them.

DON'T squash: reference material you'll consult again (skills, docs, configs you're studying), file contents you're about to edit (need originals for diffs), anything you'd re-read where the source may change first.

SUMMARY (required, non-empty): useless output → short phrase ("empty", "no matches", "0 errors"); useful output → include the findings, values, or lines you extracted. The summary is all you'll see going forward - if you'd need the full output again, don't squash. Must shrink the total: summary × parts must be smaller than the original (checked; single = summary < original).

TARGET: omit for the most recent completed tool output; pass { part_id } for precision (ids appear in sessions-browse/search output); or { tool, input_contains } to match a tool by input substring (backslashes in the pattern are auto-doubled to match the JSON-escaped stored form). match: "all" applies the pattern to every match (aggregate length check).

DEPTH (default 3): only outputs within the last 3 user turns. Deeper targets are refused - pass depth: -1 to reach any depth, including content below the compaction boundary (not in the current prompt; the change applies if that content re-enters the live chain; large prefix-cache invalidation).

The TUI record stays; only future prompts see the summary. Multiple calls in one message are fine (each targets its own output). Cannot squash this tool's own output.

POST-SQUASH STATE (read before squashing): the summary you write REPLACES the
original output - the old text is destroyed. The rewrite updates the session
DB and unlinks the dump file (if any); the original cannot be recovered via
session tools. Non-hint reminders (timestamp) survive. Squashing does NOT
change what earlier prompts in this conversation already showed you; it only
changes what FUTURE prompts reconstruct. So any fact you might need later
must be IN the summary - the summary is the only permanent record; anything
left out of it is gone.`

const SELF_ID = "squash-output"
const SELF_LEGACY = "squash_output"

export const Parameters = Schema.Struct({
  summary: Schema.String.annotate({
    description: "Short summary replacing the original output (e.g., '35K tokens of vLLM logs, 0 errors found'). Required, non-empty, must be shorter than the original output.",
  }),
  target: Schema.optional(
    Schema.Struct({
      part_id: Schema.optional(Schema.String).annotate({
        description: "Exact part id to squash (ids appear in sessions-browse/search output). Cannot be combined with tool/input_contains.",
      }),
      tool: Schema.optional(Schema.String).annotate({ description: "Tool name to match (e.g., 'bash', 'read')." }),
      input_contains: Schema.optional(Schema.String).annotate({
        description: "Substring matched against the tool's input JSON (e.g., 'serial-debug' matches a read whose filePath contains it). Backslashes are auto-doubled to match the JSON-escaped stored form.",
      }),
    }),
  ).annotate({
    description: "What to squash: omit for the most recent completed tool output, { part_id } for precision, or { tool, input_contains } for a pattern.",
  }),
  match: Schema.optional(Schema.Literals(["one", "all"])).annotate({
    description: "'one' (default) squashes the single most recent match; 'all' squashes every match (requires a pattern target; aggregate length check).",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Max user turns back from the most recent user message (default 3). Deeper targets are refused; -1 reaches any depth incl. below the compaction boundary (large prefix-cache invalidation).",
  }),
})

type Metadata = { [key: string]: any }

export function extractOutput(data: any) {
 const rawOutput = data.state?.output ?? ""
 const stampRun = rawOutput.match(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>\s*$/)
 let stamp = ""
 if (stampRun) {
   // Preserve every trailing reminder except squash hints: the hint must
   // die with the squash, the timestamp (and any other reminder) stays.
   const tags: string[] = stampRun[0].match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) ?? []
   const kept = tags.filter((t) => !t.includes("squash-output"))
   stamp = kept.length > 0 ? `\n\n${kept.join("\n\n")}` : ""
 }
 const stripped = stampRun ? rawOutput.slice(0, stampRun.index) : rawOutput
 return { stripped, stamp, originalLen: stripped.length }
}

export const SquashOutputTool = Tool.define<typeof Parameters, Metadata, Database.Service>(
  SELF_ID,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const sessionID = ctx.sessionID
          const target = params.target ?? {}
          const match = params.match ?? "one"
          const depth = params.depth ?? 3
          const hasId = Boolean(target.part_id)
          const hasPattern = Boolean(target.tool || target.input_contains)

          if (hasId && hasPattern) {
            throw new Error("target: part_id cannot be combined with tool/input_contains - pick one.")
          }
          if (match === "all" && !hasPattern) {
            throw new Error("match: 'all' requires a pattern target (tool and/or input_contains).")
          }

          const cutoffRow = yield* db
            .get(sql`SELECT MAX(m.time_created) AS cutoff FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.mode') = 'compaction'`)
            .pipe(Effect.orDie)
          const cutoff = (cutoffRow as { cutoff: number | null } | undefined)?.cutoff ?? 0

          let turnCutoff = 0
          if (depth >= 0) {
            const turns = yield* db
              .all(sql`SELECT m.time_created FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.mode') IS NOT 'compaction' ORDER BY m.time_created DESC LIMIT ${depth + 1}`)
              .pipe(Effect.orDie)
            const t = turns as { time_created: number }[]
            if (t.length > 0) turnCutoff = t[t.length - 1].time_created
          }

          let whereSql = sql`p.session_id = ${sessionID}
            AND json_extract(p.data, '$.type') = 'tool'
            AND json_extract(p.data, '$.state.status') = 'completed'
            AND json_extract(p.data, '$.tool') NOT IN (${SELF_ID}, ${SELF_LEGACY})`
          if (hasId) {
            whereSql = sql`${whereSql} AND p.id = ${target.part_id}`
          }
          if (target.tool) {
            whereSql = sql`${whereSql} AND json_extract(p.data, '$.tool') = ${target.tool}`
          }
          if (target.input_contains) {
            const escaped = target.input_contains.replace(/\\/g, "\\\\")
            whereSql = sql`${whereSql} AND json_extract(p.data, '$.state.input') LIKE ${`%${escaped}%`}`
          }
          if (turnCutoff > 0) {
            whereSql = sql`${whereSql} AND p.time_created >= ${turnCutoff}`
          }
          const limitSql = match === "one" ? sql`LIMIT 1` : sql``

          const rows = yield* db
            .all(sql`SELECT p.id, p.data, p.time_created FROM part p WHERE ${whereSql} ORDER BY p.time_created DESC ${limitSql}`)
            .pipe(Effect.orDie)

          if (rows.length === 0) {
            const where = hasId
              ? `part '${target.part_id}'`
              : hasPattern
                ? `for tool '${target.tool ?? "(any)"}'${target.input_contains ? ` with input containing '${target.input_contains}'` : ""}`
                : "for the most recent completed tool output"
            throw new Error(
              `No completed tool output found ${where} to squash${depth >= 0 ? ` within the last ${depth} user turn(s)` : ""}.`
            )
          }

          let aggregateOriginal = 0
          const updates = []
          for (const row of rows as { id: string; data: string; time_created: number }[]) {
            const data = JSON.parse(row.data)
            const { stripped, stamp, originalLen } = extractOutput(data)
            aggregateOriginal += originalLen
            updates.push({ row, data, stamp, originalLen, outputPath: data.state?.metadata?.outputPath ?? null })
          }

          if (params.summary.length * updates.length >= aggregateOriginal) {
            throw new Error(
              `Summary (${params.summary.length} chars) × ${updates.length} part(s) (${params.summary.length * updates.length} total) is not smaller than the original output (${aggregateOriginal} chars across ${updates.length} part(s), excluding timestamps). Squashing would make the prompt larger, not smaller. Extract only the essential findings, or don't squash.`
            )
          }

          const results = []
          let maxTurnsBack = 0
          let belowBoundary = false
          for (const u of updates) {
            const turnsBackRow = yield* db
              .get(sql`SELECT COUNT(*) AS c FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.mode') IS NOT 'compaction' AND m.time_created > ${u.row.time_created}`)
              .pipe(Effect.orDie)
            const turnsBack = (turnsBackRow as { c: number }).c
            maxTurnsBack = Math.max(maxTurnsBack, turnsBack)
            if (cutoff > 0 && u.row.time_created <= cutoff) belowBoundary = true

            u.data.state.output = params.summary + u.stamp
            yield* db
              .run(sql`UPDATE part SET data = ${JSON.stringify(u.data)}, time_updated = ${Date.now()} WHERE id = ${u.row.id}`)
              .pipe(Effect.orDie)
            if (u.outputPath) {
              yield* Effect.tryPromise(() => unlink(u.outputPath)).pipe(Effect.ignore)
            }
            results.push({ tool: u.data.tool, partID: u.row.id, originalLen: u.originalLen, turnsBack })
          }

          const totalRow = yield* db
            .get(sql`SELECT COUNT(*) AS c FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.mode') IS NOT 'compaction'`)
            .pipe(Effect.orDie)
          const totalTurns = (totalRow as { c: number }).c

          const lines = results
            .map((r) => `Squashed ${r.tool} output (${r.originalLen} chars → ${params.summary.length} char summary)`)
            .join("\n")
          const note = `\n\nDepth: ${maxTurnsBack} user turn(s) back of ${totalTurns}; this edit invalidates the prefix cache for the chain after it.`
          const boundaryNote = belowBoundary
            ? `\nBelow the compaction boundary: not in the current prompt; applies if/when it re-enters the live chain.`
            : ""

          return {
            title: results.length === 1 ? `Squashed ${results[0].tool} output` : `Squashed ${results.length} outputs`,
            output: lines + note + boundaryNote,
            metadata: {
              squashed: true,
              count: results.length,
              results,
              aggregateOriginal,
              summaryLen: params.summary.length,
              maxTurnsBack,
              belowBoundary,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
