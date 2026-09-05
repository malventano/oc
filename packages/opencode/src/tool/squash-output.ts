import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { unlink } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import * as Tool from "./tool"

const DESCRIPTION = `Replace a past tool output in this session with a short summary, so future prompts see the small version instead of the full output.

WHY: every prompt re-prefills every output already in the chain. An unexpectedly large output you won't reference again (ls, grep, docker logs, build logs) costs its full size on every future prompt until compaction - squashing it saves real tokens.

WHEN: only when the output is both unexpectedly large AND carries little you'll need again. Don't squash reference material you'll consult again, or files you're about to edit - small outputs' savings don't justify the rewrite.

HOW: call it in the message right after the big output arrives, before other work. A rewrite invalidates the cached prefix of everything after it, so squashing late busts the cache of all the output you've produced since - squash early and the miss covers only the squash call. If you missed the moment, squash anyway; the large output keeps costing on every future prompt.

Your summary permanently replaces the original - include anything you might need later; non-hint reminders survive. The TUI record stays; only future prompts see the summary. Cannot squash this tool's own output.

Target: omit for the most recent completed output, { part_id } for precision, or { tool, input_contains } for a pattern (match: "all" for every match). Depth (default 3): last 3 user turns; -1 reaches deeper incl. below the compaction boundary.`

// SELF_LEGACY: plugin-era tool id ("squash_output"). Old sessions' parts
// carry it, so both names must be excluded from squashing.
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
          if (target.tool === "skill") {
            throw new Error(
              "Refusing to squash skill tool output: the skill-delta walk uses a completed skill load's full output as the skill baseline (calibrating the 'Skill context drift' reminder). Squashing it rewrote the baseline to a summary and emitted a bogus drift (oc 0256). Reload the skill with the skill tool instead of squashing it."
            )
          }

          // Newest compaction message's timestamp is the boundary; parts at
          // or before it are below the compaction (see the `<=` below).
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
            AND json_extract(p.data, '$.tool') NOT IN (${SELF_ID}, ${SELF_LEGACY}, 'skill')`
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
          let maxPartsBack = 0
          let maxIntervening = 0
          let belowBoundary = false
          for (const u of updates) {
            const turnsBackRow = yield* db
              .get(sql`SELECT COUNT(*) AS c FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.mode') IS NOT 'compaction' AND m.time_created > ${u.row.time_created}`)
              .pipe(Effect.orDie)
            const turnsBack = (turnsBackRow as { c: number }).c
            maxTurnsBack = Math.max(maxTurnsBack, turnsBack)
            const partsBackRow = yield* db
              .get(sql`SELECT COUNT(*) AS c FROM part p WHERE p.session_id = ${sessionID} AND p.time_created > ${u.row.time_created}`)
              .pipe(Effect.orDie)
            const partsBack = (partsBackRow as { c: number }).c
            maxPartsBack = Math.max(maxPartsBack, partsBack)
            // Intervening TOOL work between the target and this squash - the
            // LATE signal. Structural parts (step-start/step-finish/reasoning/
            // the intro text/this call itself) always land after any target,
            // so counting ALL parts flagged every in-turn squash as late. Only
            // real tool calls (or a cross-turn squash) mean the moment passed.
            const interveningRow = yield* db
              .get(sql`SELECT COUNT(*) AS c FROM part p WHERE p.session_id = ${sessionID} AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.tool') NOT IN (${SELF_ID}, ${SELF_LEGACY}) AND p.time_created > ${u.row.time_created}`)
              .pipe(Effect.orDie)
            const intervening = (interveningRow as { c: number }).c
            maxIntervening = Math.max(maxIntervening, intervening)
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
          const late =
            maxTurnsBack > 0 || maxIntervening > 0
              ? " LATE SQUASH - issue squash-output in the message right after the target output arrives."
              : ""
          const note = `\n\nDepth: ${maxTurnsBack} user turn(s) back of ${totalTurns}; target ${maxPartsBack} part(s) behind the live edge - the rewrite invalidates the cached prefix from the target forward.${late}`
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
              maxPartsBack,
              belowBoundary,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
