import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { PartID, SessionID } from "./schema"
import { Session } from "./session"
import { isAfter } from "./message-v2"

/**
 * Frozen-system epochs: snapshot the wire system message at the epoch's first
 * user prompt (session start or first post-compaction prompt), serve those
 * exact bytes on every later request (byte-identical prefix for the vLLM
 * radix cache), and surface drift as tail <system-reminder> delta parts on
 * user messages.
 *
 * Per-section applied-state: each section (agent prompt, env, instructions
 * (AGENTS.md), MCP instructions, skills) tracks the last text the model was
 * shown. A delta is the diff from that applied text to the live text, so a
 * section edited twice produces two deltas each carrying only the NEW change.
 *
 * Tools (the wire tools array, fused into the system at token 0 by the DSV4
 * encoder) are deliberately NOT tracked: any tool-set change misses the cache
 * on restart regardless, so the epoch ignores it and eats the one-time miss.
 *
 * Record lifecycle: the hidden record part lives on the epoch's first user
 * message. It is never deleted by the epoch machinery - filterCompacted drops
 * it from the rendered chain at compaction (natural re-snapshot on the next
 * user message), and an undo back above that message removes it with the
 * message (revert.ts). Undoing back past a compaction resurfaces the old
 * record with its frozen system + applied deltas, making the chain byte-
 * identical to the pre-compaction prompt chain.
 *
 * See docs/FROZEN_SYSTEM_EPOCHS.md.
 */

export type EpochSections = {
  agentPrompt: string
  env: string
  instructions: string
  mcp: string
  skills: string
}

export type EpochRecord = {
  /** Message id of the summary:true assistant that started this epoch (null = session start). */
  boundary: string | null
  /** Snapshot time. */
  time: number
  /** The exact joined system bytes served on the wire for this epoch. */
  joined: string
  /** Per-section last-applied text (delta base). */
  applied: EpochSections
}

const SECTION_LABELS: Record<keyof EpochSections, string> = {
  agentPrompt: "agent prompt",
  env: "environment",
  instructions: "instructions (AGENTS.md)",
  mcp: "MCP instructions",
  skills: "skills",
}

const SECTION_KEYS = Object.keys(SECTION_LABELS) as (keyof EpochSections)[]

const MAX_DIFF_LINES = 40

/** Mirror of prompt.ts's real() helper: a user message is "real" if any part is non-synthetic. */
export function isRealUser(user: SessionV1.WithParts): boolean {
  return !user.parts.every((p) => "synthetic" in p && p.synthetic)
}

/** Id of the newest summary:true assistant in the chain (created-time scan), or null. */
export function findLastSummaryId(msgs: SessionV1.WithParts[]): string | null {
  // Chronological scan (created time, id tie-break): the rendered chain
  // interleaves the newest compaction pair at the front, so array position
  // is not time order - a multi-compaction tail can place an OLDER summary
  // after the newest one, which would wake the wrong (stale) epoch record.
  let newest: SessionV1.WithParts | undefined
  for (const m of msgs) {
    // Completed summaries only: an aborted compaction (cancelled summary
    // turn or retain-selection finalize) leaves a summary:true message with
    // an error and no finish - it must not reset the epoch boundary, or
    // live deltas on user messages after the last real summary go stale.
    if (
      m.info.role === "assistant" &&
      m.info.summary === true &&
      m.info.finish &&
      !m.info.error
    ) {
      if (!newest || isAfter(m.info, newest.info)) newest = m
    }
  }
  return newest?.info.id ?? null
}

/** The active epoch record for the chain (record whose boundary matches the newest
 * completed summary), or undefined. Exposed for prompt.ts to decide whether the
 * request is INSIDE a frozen epoch (serve frozen bytes / instruction delta is
 * meaningless) or in the POST-COMPACTION GAP (the chain was just compacted - the
 * record rode the dropped first user message - so this request MUST re-snapshot
 * with the full system rather than serve a stripped live one). */
export function activeRecord(msgs: SessionV1.WithParts[]): EpochRecord | undefined {
  const boundary = findLastSummaryId(msgs)
  for (const msg of msgs) {
    for (const part of msg.parts) {
      if (part.type === "text" && part.metadata?.epoch) {
        const record = part.metadata.epoch as EpochRecord
        if (record.boundary === boundary) return record
      }
    }
  }
  return undefined
}

/** Bounded line diff (LCS) of two texts; returns up to maxLines -/+ lines. */
export function lineDiff(oldText: string, newText: string, maxLines = MAX_DIFF_LINES): { lines: string[]; truncated: boolean } {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length > 600 || b.length > 600) return { lines: [], truncated: true }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i++]}`)
    } else {
      lines.push(`+ ${b[j++]}`)
    }
  }
  while (i < n) lines.push(`- ${a[i++]}`)
  while (j < m) lines.push(`+ ${b[j++]}`)
  const truncated = lines.length > maxLines
  return { lines: truncated ? lines.slice(0, maxLines) : lines, truncated }
}

export function buildDeltaText(
  changes: { label: string; diff: { lines: string[]; truncated: boolean } }[],
): string {
  const sections = changes.map((c) => {
    const body =
      c.diff.lines.length === 0
        ? "  (content replaced - re-read the source with the read tool)"
        : c.diff.lines.map((l) => `  ${l}`).join("\n") +
          (c.diff.truncated ? "\n  ... (diff truncated - re-read the source with the read tool)" : "")
    return `- ${c.label}:\n${body}`
  })
  return `<system-reminder>\nSystem context drift: the following sections of this session's system prompt changed since the context snapshot:\n${sections.join("\n")}\n</system-reminder>`
}

export const apply = Effect.fn("SessionEpoch.apply")(function* (input: {
  msgs: SessionV1.WithParts[]
  sessionID: SessionID
  /** The current user message (with parts), where snapshot/delta parts attach. */
  user: SessionV1.WithParts
  agentPrompt: string
  env: string[]
  instructions: string[]
  mcpInstructions: string | undefined
  skills: string | undefined
  /** Per-message system override; when set the epoch is bypassed for this turn. */
  userSystem: string | undefined
  step: number
  compactingPrompt: boolean
}) {
  const sessions = yield* Session.Service

  // A per-message system override cannot be frozen (it is per-message); serve
  // live and leave the epoch untouched.
  if (input.userSystem) return { frozen: undefined }

  const sections: EpochSections = {
    agentPrompt: input.agentPrompt,
    env: input.env.filter(Boolean).join("\n"),
    instructions: input.instructions.filter(Boolean).join("\n"),
    mcp: input.mcpInstructions ?? "",
    skills: input.skills ?? "",
  }
  const joined = [
    input.agentPrompt,
    ...input.env,
    ...input.instructions,
    ...(input.mcpInstructions ? [input.mcpInstructions] : []),
    ...(input.skills ? [input.skills] : []),
    ...(input.userSystem ? [input.userSystem] : []),
  ]
    .filter(Boolean)
    .join("\n")

  const boundary = findLastSummaryId(input.msgs)

  const records: { part: SessionV1.TextPart; record: EpochRecord }[] = []
  for (const msg of input.msgs) {
    for (const part of msg.parts) {
      if (part.type === "text" && part.metadata?.epoch) {
        records.push({ part, record: part.metadata.epoch as EpochRecord })
      }
    }
  }
  const active = records.findLast((r) => r.record.boundary === boundary)

  // Snapshot: no active record on a fresh real user message (step 1). The
  // record part is hidden (synthetic + ignored + empty text: skipped by
  // message-v2 conversion and TUI rendering) and rides the epoch's first
  // user message so compaction filtering and undo lifecycle it naturally.
  if (!active && input.step === 1 && !input.compactingPrompt && isRealUser(input.user)) {
    const record: EpochRecord = { boundary, time: Date.now(), joined, applied: sections }
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: input.user.info.id,
      sessionID: input.sessionID,
      type: "text",
      text: "",
      synthetic: true,
      ignored: true,
      metadata: { epoch: record },
    })
    input.user.parts.push(part)
    // This turn IS the snapshot: serve live (request.ts joins the same bytes).
    return { frozen: undefined }
  }

  // No active record elsewhere (mid-turn sub-step, synthetic user message):
  // serve live, never snapshot.
  if (!active) return { frozen: undefined }

  // Compaction turns keep the frozen snapshot byte-identical (the summary
  // turn is a full-chain prefix hit); no injection, no snapshot.
  if (input.compactingPrompt) return { frozen: active.record.joined }

  // Drift detection. Deltas ride user messages only (step 1, real user):
  // mid-turn drift is held in `applied` and surfaces on the next user prompt.
  const changes: { label: string; diff: { lines: string[]; truncated: boolean } }[] = []
  for (const key of SECTION_KEYS) {
    const live = sections[key]
    const applied = active.record.applied[key]
    if (live !== applied) changes.push({ label: SECTION_LABELS[key], diff: lineDiff(applied, live) })
  }

  if (changes.length > 0 && input.step === 1 && isRealUser(input.user)) {
    const text = buildDeltaText(changes)
    const hasDelta = input.user.parts.some((p) => p.type === "text" && p.metadata?.epochDelta)
    if (!hasDelta) {
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: input.user.info.id,
        sessionID: input.sessionID,
        type: "text",
        text,
        synthetic: true,
        metadata: { epochDelta: true },
      })
      input.user.parts.push(part)
    }
    const nextApplied = { ...active.record.applied }
    for (const key of SECTION_KEYS) {
      if (sections[key] !== active.record.applied[key]) nextApplied[key] = sections[key]
    }
    yield* sessions.updatePart({ ...active.part, metadata: { epoch: { ...active.record, applied: nextApplied } } })
  }

  // Revert: serve the frozen snapshot bytes (byte-identical every turn).
  return { frozen: active.record.joined }
})

export * as Epoch from "./epoch"
