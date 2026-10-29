 import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { unlink } from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { isImageAttachment } from "@/util/media"
import * as Tool from "./tool"

// A media-only tool result has zero text, so the text "summary must be
// smaller" guard cannot apply. Cap the replacement summary per image instead;
// this is deliberately conservative and is not a token estimate.
const MEDIA_SUMMARY_CAP = 2_000

const DESCRIPTION = `Replace a past tool output in this session with a short summary, so future prompts see the small version instead of the full output.

WHY: every prompt re-prefills every output already in the chain. An unexpectedly large output you won't reference again (ls, grep, docker logs, build logs) costs its full size on every future prompt until compaction - shrinking it saves real tokens.

WHEN: only when the output is both unexpectedly large AND carries little you'll need again. Don't shrink reference material you'll consult again, or files you're about to edit - small outputs' savings don't justify the rewrite. NEVER shrink skill tool output: its full body is load-bearing for the 'Skill context drift' reminder machinery (a shrunken load becomes a bogus drift baseline - oc 0256). The tool refuses it regardless; reload the skill with the skill tool if you want a smaller view.

HOW: call it in the message right after the big output arrives, before other work. A rewrite invalidates the cached prefix of everything after it, so shrinking late busts the cache of all the output you've produced since - shrink early and the miss covers only the shrink call. If you missed the moment, shrink anyway; the large output keeps costing on every future prompt.

Your summary permanently replaces the original - include anything you might need later; non-hint reminders survive. The TUI record stays; only future prompts see the summary. Cannot shrink this tool's own output.

Target: omit for the newest unprocessed completed output, { part_id } or { part_ids } for precision, { tool, input_contains } for a pattern, or "one"/"all" as a shorthand for match. "all" walks newest-first and stops at the first already-shrunk part; use part_ids for an explicit group. minLength matches only outputs at least that many chars - use it to isolate one big output when input_contains also matches smaller ones. Depth (default 3): last 3 user turns and only the live context after the last compaction; -1 reaches deeper incl. below the compaction boundary.

MEDIA: an image-only tool result is eligible only with an explicit target (part_id, part_ids, or tool/input_contains); a default shrink refuses it. The image is removed, not resized, and the summary replaces it in future prompts. Non-image attachments are preserved. The result reports attachment count and decoded bytes; no image token estimate is claimed.`

// SELF ids over time (2026-09-08 rename squash-output -> shrink): the
// plugin-era id was "squash_output", the built-in was "squash-output", now
// "shrink". Old sessions' parts carry the PRIOR strings verbatim, so ALL of
// them must be excluded from shrinking (the where-clause NOT IN) and past
// parts must still render (the TUI switch matches old + new names).
const SELF_ID = "shrink"
const SELF_PRIOR = "squash-output"
const SELF_LEGACY = "squash_output"

export const Parameters = Schema.Struct({
  summary: Schema.String.annotate({
    description: "Short summary replacing the original output (e.g., '35K tokens of vLLM logs, 0 errors found'). Required, non-empty, must be shorter than the original output.",
  }),
  target: Schema.optional(
    Schema.Union([
      Schema.Literals(["one", "all"]),
      Schema.Struct({
        part_id: Schema.optional(Schema.String).annotate({
          description: "Exact part id to shrink (ids appear in sessions-browse/search output). Cannot be combined with tool/input_contains.",
        }),
        part_ids: Schema.optional(Schema.Array(Schema.String)).annotate({
          description: "Exact part ids to shrink as one group (prt_... ids). Use this for parallel outputs; cannot be combined with part_id or tool/input_contains.",
        }),
        tool: Schema.optional(Schema.String).annotate({ description: "Tool name to match (e.g., 'bash', 'read')." }),
        input_contains: Schema.optional(Schema.String).annotate({
          description: "Substring matched against the tool's input JSON (e.g., 'serial-debug' matches a read whose filePath contains it). Backslashes are auto-doubled to match the JSON-escaped stored form.",
        }),
      }),
    ]),
  ).annotate({
    description: "What to shrink: omit for the newest unprocessed completed tool output, { part_id } or { part_ids } for precision, { tool, input_contains } for a pattern, or 'one'/'all' as a shorthand for match.",
  }),
  minLength: Schema.optional(Schema.Number).annotate({
    description: "Only match tool outputs whose raw output is at least this many chars - excludes smaller outputs that also match the pattern (e.g. isolate a 49K dump from a 266-char check).",
  }),
  match: Schema.optional(Schema.Literals(["one", "all"])).annotate({
    description: "'one' (default) shrinks the newest unprocessed match; 'all' shrinks the newest unprocessed group and stops at the first already-shrunk part (requires a pattern target or part_ids; aggregate and per-part length checks).",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description: "Max user turns back from the most recent user message (default 3). Deeper targets are refused; -1 reaches any depth incl. below the compaction boundary (large prefix-cache invalidation).",
  }),
})

type Metadata = { [key: string]: any }

function dataUrlByteLength(url: unknown): number {
  if (typeof url !== "string") return 0
  const match = /^data:[^,]*;base64,([\s\S]*)$/.exec(url)
  if (!match) return 0
  try {
    return Buffer.from(match[1]!, "base64").byteLength
  } catch {
    return 0
  }
}

/** Image attachments in a completed tool part. */
export function imageAttachments(data: any): any[] {
  const attachments = data?.state?.attachments
  if (!Array.isArray(attachments)) return []
  return attachments.filter((a: any) => typeof a?.mime === "string" && isImageAttachment(a.mime))
}

/** Preserve non-image attachments when a media shrink removes the images. */
export function keepNonImageAttachments(attachments: unknown): any[] {
  if (!Array.isArray(attachments)) return []
  return attachments.filter((a: any) => !(typeof a?.mime === "string" && isImageAttachment(a.mime)))
}

export function extractOutput(data: any) {
  const rawOutput = data.state?.output ?? ""
  const stampRun = rawOutput.match(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>\s*$/)
  let stamp = ""
  if (stampRun) {
    // Preserve every trailing reminder except shrink hints: the hint must
    // die with the shrink, the timestamp (and any other reminder) stays.
    const tags: string[] = stampRun[0].match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) ?? []
    // Drop the shrink hint tag (the "call shrink NOW" reminder must die with
    // the shrink - 0325 rename: the hint now says shrink, and old parts carry
    // the squash-output wording - drop both).
    const kept = tags.filter((t) => !t.includes("squash-output") && !t.includes("shrink NOW"))
    stamp = kept.length > 0 ? `\n\n${kept.join("\n\n")}` : ""
  }
  const stripped = stampRun ? rawOutput.slice(0, stampRun.index) : rawOutput
  const images = imageAttachments(data)
  return {
    stripped,
    stamp,
    originalLen: stripped.length,
    imageAttachments: images,
    imageCount: images.length,
    attachmentBytes: images.reduce((sum, a) => sum + dataUrlByteLength(a.url), 0),
  }
}

/** A part's own output has been replaced by a shrink summary. */
export function isShrunkPart(data: any): boolean {
  return data?.state?.metadata?.shrunk === true
}

/** Mark the TARGET part (not the shrink call) as processed. */
export function markShrunkPart(data: any): void {
  if (!data?.state) return
  const metadata = data.state.metadata
  data.state.metadata = {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
    shrunk: true,
  }
}

/**
 * Walk candidates newest-first. `one` skips processed parts and takes the
 * newest unprocessed part. `all` stops at the first processed part, so a
 * shrink aimed at the current group cannot land on an older summarized group.
 */
export function selectCandidateRows<T extends { data: string }>(rows: T[], match: "one" | "all"): T[] {
  const parsed = rows.map((row) => ({ row, data: JSON.parse(row.data) as any }))
  if (match === "one") {
    const hit = parsed.find((x) => !isShrunkPart(x.data))
    return hit ? [hit.row] : []
  }
  const boundary = parsed.findIndex((x) => isShrunkPart(x.data))
  return (boundary === -1 ? parsed : parsed.slice(0, boundary)).map((x) => x.row)
}

export const ShrinkTool = Tool.define<typeof Parameters, Metadata, Database.Service | EventV2Bridge.Service>(
  SELF_ID,
  Effect.gen(function* () {
    // Services are captured in INIT (not execute): Def.execute has R=never
    // (tool.ts:63), so any service yielded inside execute is a typecheck
    // error (the 0316 events yield sat in execute and shipped as a baseline
    // failure - fixed 0325, matching write.ts's init-capture pattern).
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const sessionID = ctx.sessionID
          // target accepts "one"/"all" as a shorthand for match (2026-09-08
          // 0325): shortens the common string-literal form to one field
          // (target: "one" was the shape confusion - "one" is a match value,
          // not a target object).
          const rawTarget = params.target
          let match = params.match ?? "one"
          let target: { part_id?: string; part_ids?: readonly string[]; tool?: string; input_contains?: string } = {}
          if (typeof rawTarget === "string") {
            if (params.match !== undefined && params.match !== rawTarget) {
              throw new Error(`target shorthand '${rawTarget}' conflicts with the explicit match '${params.match}' - pick one.`)
            }
            match = rawTarget
          } else {
            target = rawTarget ?? {}
          }
          const depth = params.depth ?? 3
          const ids = target.part_ids ?? []
          const hasId = Boolean(target.part_id)
          const hasIds = ids.length > 0
          const hasPattern = Boolean(target.tool || target.input_contains)

          if (hasId && hasIds) {
            throw new Error("target: part_id cannot be combined with part_ids - use one exact id or an explicit group.")
          }
          if ((hasId || hasIds) && hasPattern) {
            throw new Error("target: part_id/part_ids cannot be combined with tool/input_contains - pick one.")
          }
          if (match === "all" && !hasPattern && !hasIds) {
            throw new Error("match: 'all' requires a pattern target (tool and/or input_contains) or explicit part_ids.")
          }
          for (const id of [...(hasId ? [target.part_id!] : []), ...ids]) {
            if (!id.startsWith("prt_")) {
              throw new Error(
                `target part id '${id}' is not a part id (expected prt_...). tool_<hash> is an outputPath basename; search_<hash> is a websearch result id.`
              )
            }
          }
          if (target.tool === "skill") {
            throw new Error(
              "Refusing to shrink skill tool output: the skill-delta walk uses a completed skill load's full output as the skill baseline (calibrating the 'Skill context drift' reminder). Shrinking it rewrote the baseline to a summary and emitted a bogus drift (oc 0256). Reload the skill with the skill tool instead of shrinking it."
            )
          }

          // Newest compaction message's timestamp is the live-context boundary.
          // Default depth never reaches below it; depth -1 is the explicit
          // archived-content opt-in (and still reports belowBoundary).
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
            AND json_extract(p.data, '$.tool') NOT IN (${SELF_ID}, ${SELF_PRIOR}, ${SELF_LEGACY}, 'skill')`
          if (hasId) {
            whereSql = sql`${whereSql} AND p.id = ${target.part_id}`
          }
          if (hasIds) {
            whereSql = sql`${whereSql} AND p.id IN (${sql.join([...ids], sql`, `)})`
          }
          if (target.tool) {
            whereSql = sql`${whereSql} AND json_extract(p.data, '$.tool') = ${target.tool}`
          }
          if (target.input_contains) {
            const escaped = target.input_contains.replace(/\\/g, "\\\\")
            whereSql = sql`${whereSql} AND json_extract(p.data, '$.state.input') LIKE ${`%${escaped}%`}`
          }
          if (params.minLength !== undefined) {
            // Target filter: isolate a big output when the pattern also
            // matches smaller ones (the 0325 failure - the newest match was a
            // 266-char check, not the 49K dump). Raw output length (the
            // stripped length is computed in JS after the query - close enough
            // for a targeting threshold).
            whereSql = sql`${whereSql} AND length(json_extract(p.data, '$.state.output')) >= ${params.minLength}`
          }
          if (turnCutoff > 0) {
            whereSql = sql`${whereSql} AND p.time_created >= ${turnCutoff}`
          }
          if (cutoff > 0 && depth >= 0) {
            whereSql = sql`${whereSql} AND p.time_created > ${cutoff}`
          }

          const rows = (yield* db
            .all(sql`SELECT p.id, p.data, p.time_created, p.message_id FROM part p WHERE ${whereSql} ORDER BY p.time_created DESC`)
            .pipe(Effect.orDie)) as { id: string; data: string; time_created: number; message_id: string }[]
          const explicitIds = hasId || hasIds
          // A pattern target is explicit permission for media, but match:"one"
          // still selects only the newest matching row.
          const explicitTarget = explicitIds || hasPattern
          const candidateRows = explicitIds ? rows : selectCandidateRows(rows, match)

          if (rows.length === 0) {
            const where = hasIds
              ? `${ids.length} part id(s)`
              : hasId
                ? `part '${target.part_id}'`
                : hasPattern
                  ? `for tool '${target.tool ?? "(any)"}'${target.input_contains ? ` with input containing '${target.input_contains}'` : ""}`
                  : "for the most recent completed tool output"
            throw new Error(
              `No completed tool output found ${where} to shrink${params.minLength !== undefined ? ` with minLength >= ${params.minLength}` : ""}${depth >= 0 ? ` within the last ${depth} user turn(s); for older targets retry with depth: -1.` : "."}`
            )
          }
          if (candidateRows.length === 0) {
            throw new Error(
              `No unprocessed completed tool output found to shrink${depth >= 0 ? ` within the last ${depth} user turn(s)` : ""}; all matching parts are already shrunk. Use explicit part_ids for a different group.`
            )
          }
          if (explicitIds) {
            const processed = candidateRows.find((row) => isShrunkPart(JSON.parse(row.data)))
            if (processed) {
              throw new Error(`Part '${processed.id}' is already shrunk; refusing to overwrite its summary.`)
            }
          }

          let aggregateOriginal = 0
          let aggregateImages = 0
          let aggregateAttachmentBytes = 0
          const updates = []
          for (const row of candidateRows) {
            const data = JSON.parse(row.data)
            const { stripped, stamp, originalLen, imageCount, attachmentBytes } = extractOutput(data)
            aggregateOriginal += originalLen
            aggregateImages += imageCount
            aggregateAttachmentBytes += attachmentBytes
            updates.push({
              row,
              data,
              stamp,
              originalLen,
              imageCount,
              attachmentBytes,
              outputPath: data.state?.metadata?.outputPath ?? null,
            })
          }
          // 0316: publish the canonical PartUpdated event after each write so
          // the TUI reconciles the shrunk part IN PLACE - the raw DB UPDATE
          // alone bypassed it and the TUI's later re-sync reconciled more
          // coarsely (remount/cull -> the 1-frame viewport dip after a shrink,
          // the "scrollback heights reset then re-lock" report).

          const mediaCandidate = updates.find((u) => u.imageCount > 0)
          if (!explicitTarget && mediaCandidate) {
            throw new Error(
              `Media-only tool output requires an explicit target; use target.part_id, target.part_ids, or target.tool for ${mediaCandidate.data.tool}. Default shrink will not remove image attachments.`,
            )
          }

          // 0325: the guard now says WHICH parts it matched, so a
          // mis-targeted match (a small output caught by a broad pattern
          // instead of the big one) is diagnosable instead of cryptic.
          const matchedDesc = updates
            .map((u) => `${u.data.tool}(${u.originalLen}${u.imageCount > 0 ? ` + ${u.imageCount} image(s)` : ""})`)
            .join(", ")
          const tooSmall = updates.find((u) =>
            u.imageCount > 0
              ? params.summary.length > MEDIA_SUMMARY_CAP * u.imageCount
              : u.originalLen <= params.summary.length,
          )
          if (tooSmall) {
            if (tooSmall.imageCount > 0) {
              throw new Error(
                `Summary (${params.summary.length} chars) exceeds the ${MEDIA_SUMMARY_CAP}-char-per-image summary cap for ${tooSmall.imageCount} image attachment(s) on part '${tooSmall.row.id}'. Matched: ${matchedDesc}. Refusing to grow the summary.`,
              )
            }
            throw new Error(
              `Summary (${params.summary.length} chars) is not smaller than the ${tooSmall.data.tool} output for part '${tooSmall.row.id}' (${tooSmall.originalLen} chars). Matched: ${matchedDesc}. Refusing to grow an individual part. Use explicit part_ids or target.minLength to exclude the smaller outputs.`
            )
          }
          // Text-only aggregate guard. Media parts are bounded by the
          // per-image summary cap above; comparing their zero text length to
          // the summary would reject every media-only shrink.
          const textUpdates = updates.filter((u) => u.imageCount === 0)
          const textOriginal = textUpdates.reduce((sum, u) => sum + u.originalLen, 0)
          if (textUpdates.length > 0 && params.summary.length * textUpdates.length >= textOriginal) {
            throw new Error(
              `Summary (${params.summary.length} chars) × ${textUpdates.length} text part(s) (${params.summary.length * textUpdates.length} total) is not smaller than the original text output (${textOriginal} chars across ${textUpdates.length} text part(s), excluding timestamps). Matched: ${matchedDesc}. Shrinking would make the prompt larger, not smaller. Extract only the essential findings, or don't shrink. If the matched list shows the wrong (smaller) output, add target.minLength or use target.part_id.`
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
            // Intervening TOOL work between the target and this shrink - the
            // LATE signal. Structural parts (step-start/step-finish/reasoning/
            // the intro text/this call itself) always land after any target,
            // so counting ALL parts flagged every in-turn shrink as late. Only
            // real tool calls (or a cross-turn shrink) mean the moment passed.
            const interveningRow = yield* db
              .get(sql`SELECT COUNT(*) AS c FROM part p WHERE p.session_id = ${sessionID} AND json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.tool') NOT IN (${SELF_ID}, ${SELF_LEGACY}) AND p.time_created > ${u.row.time_created}`)
              .pipe(Effect.orDie)
            const intervening = (interveningRow as { c: number }).c
            maxIntervening = Math.max(maxIntervening, intervening)
            if (cutoff > 0 && u.row.time_created <= cutoff) belowBoundary = true

            markShrunkPart(u.data)
            u.data.state.output = params.summary + u.stamp
            if (u.imageCount > 0) {
              const kept = keepNonImageAttachments(u.data.state.attachments)
              if (kept.length > 0) u.data.state.attachments = kept
              else delete u.data.state.attachments
              u.data.state.metadata = {
                ...u.data.state.metadata,
                attachmentsRemoved: u.imageCount,
                attachmentBytes: u.attachmentBytes,
              }
            }
            yield* db
              .run(sql`UPDATE part SET data = ${JSON.stringify(u.data)}, time_updated = ${Date.now()} WHERE id = ${u.row.id}`)
              .pipe(Effect.orDie)
            // 0316: the in-place reconcile event (same payload shape as the
            // session service's updatePart, session.ts:638-646).
            yield* events.publish(SessionV1.Event.PartUpdated, {
              sessionID,
              part: structuredClone({ ...u.data, id: u.row.id, sessionID, messageID: u.row.message_id }),
              time: Date.now(),
            })
            if (u.outputPath) {
              yield* Effect.tryPromise(() => unlink(u.outputPath)).pipe(Effect.ignore)
            }
            results.push({
              tool: u.data.tool,
              partID: u.row.id,
              originalLen: u.originalLen,
              imageCount: u.imageCount,
              attachmentBytes: u.attachmentBytes,
              turnsBack,
            })
          }

          const totalRow = yield* db
            .get(sql`SELECT COUNT(*) AS c FROM message m WHERE m.session_id = ${sessionID} AND json_extract(m.data, '$.role') = 'user' AND json_extract(m.data, '$.mode') IS NOT 'compaction'`)
            .pipe(Effect.orDie)
          const totalTurns = (totalRow as { c: number }).c

          const lines = results
            .map((r) => {
              if (r.imageCount > 0) {
                const images = `${r.imageCount} image attachment${r.imageCount === 1 ? "" : "s"} (${r.attachmentBytes.toLocaleString()} decoded bytes)`
                const text = r.originalLen > 0 ? `${r.originalLen} chars + ` : ""
                return `Shrank ${r.tool} output (${text}${images}) → ${params.summary.length} char summary; removed ${r.imageCount} image attachment${r.imageCount === 1 ? "" : "s"}`
              }
              // ~3 chars/token - the same divisor as the time-context hint
              // (time-context.ts Math.round(len/3)) and the TUI title, so
              // both surfaces agree (display divisor derived from session
              // history against provider-reported tokens, 2026-09-26).
              const tokensSaved = Math.round((r.originalLen - params.summary.length) / 3)
              return `Shrank ${r.tool} output (${r.originalLen} chars → ${params.summary.length} char summary) = ~${tokensSaved.toLocaleString()} tokens saved`
            })
            .join("\n")
          const late =
            maxTurnsBack > 0 || maxIntervening > 0
              ? " LATE SHRINK - issue shrink in the message right after the target output arrives."
              : ""
          const note = `\n\nDepth: ${maxTurnsBack} user turn(s) back of ${totalTurns}; target ${maxPartsBack} part(s) behind the live edge - the rewrite invalidates the cached prefix from the target forward.${late}`
          const boundaryNote = belowBoundary
            ? `\nBelow the compaction boundary: not in the current prompt; applies if/when it re-enters the live chain.`
            : ""

          return {
            title: results.length === 1 ? `Shrank ${results[0].tool} output` : `Shrank ${results.length} outputs`,
            output: lines + note + boundaryNote,
            metadata: {
              shrunk: true,
              count: results.length,
              results,
              aggregateOriginal,
              aggregateImages,
              aggregateAttachmentBytes,
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
