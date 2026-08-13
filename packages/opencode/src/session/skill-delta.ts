import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { PartID, SessionID } from "./schema"
import { Session } from "./session"
import type { Skill } from "@/skill"
import { isRealUser, lineDiff } from "./epoch"
import { applyPatch } from "diff"

/**
 * Skill-change delta reminders: the skill counterpart to frozen-system epochs.
 *
 * The epoch freezes the wire system and diffs live-rendered section text
 * (the skill TABLE - descriptions in available_skills) against applied state.
 * Skill bodies live in TOOL OUTPUTS, not the system, so their drift is tracked
 * separately: the baseline is the skill tool's load part in the chain, prior
 * skillDelta reminder parts (full new content in metadata) replace it, and the
 * reconstructed "applied" text is diffed against the current file body on each
 * step-1 real user prompt.
 *
 * The skill's "epoch" begins at its most recent load: the walk integrates only
 * deltas that follow a load part (re-loading resets the applied state, and
 * pre-load deltas stay in the chain but are never integrated - prior context is
 * never invalidated). Compaction is the only true reset: a load part compacted
 * away takes its deltas with it.
 *
 * Session self-edits are incorporated as applied-state updates (not reminders):
 * the agent's own edit/write of a skill file is applied to the reconstruction
 * (unified-diff application for the edit tool, full content for the write
 * tool), so a file still in the state the agent left it diffs to 0 naturally
 * and a later EXTERNAL change diffs incrementally against the self-edited
 * state rather than the stale load body.
 *
 * Parts are identified by metadata.skillDelta (distinct from the epoch's
 * metadata.epoch / metadata.epochDelta) so the epoch's record scans and delta
 * strips never touch them. Deltas ride user messages and are lifecycle'd by
 * message survival - filterCompacted needs no skill-aware rules.
 */

const BASE_DIR_MARKER = "Base directory for this skill:"

export type ReconstructedSkill = {
  /** Body shown in context as of the most recent load + post-load deltas + session self-edits (null when reported deleted). */
  applied: string | null
  /** Body from the most recent skill-tool load. */
  baseline: string | null
  deleted: boolean
  /** Absolute path of the skill's SKILL.md (from the load output's base-dir line). */
  location: string | null
}

/** Canonical body extraction: the region between the "# Skill:" header and the base-dir note in the tool output. */
export function extractSkillBody(output: string): string {
  const lines = output.split("\n")
  const start = lines.findIndex((l) => l.startsWith("# Skill:"))
  const end = lines.findIndex((l) => l.startsWith(BASE_DIR_MARKER))
  if (start < 0 || end <= start) return output.trim()
  return lines.slice(start + 1, end).join("\n").trim()
}
function extractSkillLocation(output: string): string | null {
  const m = output.match(/Base directory for this skill: (.+)/)
  return m?.[1] ? `${m[1].trim()}/SKILL.md` : null
}

function extractSkillName(output: string): string | undefined {
  const m = output.match(/<skill_content name="([^"]+)">/)
  return m?.[1]
}

/**
 * Ordered walk: skill-tool load parts establish the baseline and reset the
 * applied state; later skillDelta parts (post-load only) replace it; session
 * file edits (edit/write tool parts, completed) touching a tracked skill's
 * SKILL.md record the newest self-edit time so self-authored changes are not
 * re-reminded. Returns the reconstructed view per skill name.
 */
export function integrateSkillBodies(msgs: SessionV1.WithParts[]): Map<string, ReconstructedSkill> {
  const out = new Map<string, ReconstructedSkill>()
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type === "tool" && part.tool === "skill" && part.state?.status === "completed" && part.state.output) {
        const input = part.state.input as { name?: unknown } | undefined
        const name = typeof input?.name === "string" ? input.name : extractSkillName(part.state.output)
        if (!name) continue
        out.set(name, {
         applied: null,
         baseline: extractSkillBody(part.state.output),
         deleted: false,
         location: extractSkillLocation(part.state.output),
    })
      } else if (part.type === "text" && part.synthetic && part.metadata?.skillDelta) {
        const delta = part.metadata.skillDelta as Record<string, { content?: string } | { deleted?: boolean }>
        for (const [name, entry] of Object.entries(delta)) {
          const cur = out.get(name)
          if (!cur) continue
          if ("content" in entry && typeof entry.content === "string") {
            cur.applied = entry.content
            cur.deleted = false
          } else {
            cur.applied = null
            cur.deleted = true
          }
        }
      } else if (
        part.type === "tool" &&
        part.state?.status === "completed" &&
        (part.tool === "edit" || part.tool === "write")
      ) {
        // Session self-edits become applied-state updates (no reminder): the
        // agent's own change is already in context. The edit tool records the
        // per-file unified diffs in the completed state's metadata; the write
        // tool carries the full content in its input.
        for (const entry of out.values()) {
          if (!entry.location) continue
          const loc = entry.location
          if (part.tool === "edit") {
           const files = Array.isArray(part.state.metadata?.files) ? part.state.metadata.files : []
           const hit = files.find(
              (f: { filePath?: unknown; relativePath?: unknown; patch?: unknown }) =>
               f?.patch != null &&
               typeof f.patch === "string" &&
               (f.filePath === loc ||
                  (typeof f.relativePath === "string" && loc.endsWith(`/${f.relativePath}`))),
           )
           if (!hit || typeof hit.patch !== "string") continue
           const prev = entry.applied ?? entry.baseline ?? ""
           const patched = applyPatch(prev, hit.patch)
           if (typeof patched === "string") {
            entry.applied = patched.trim()
           }
           // A patch that does not apply cleanly against the reconstruction
           // (e.g. the file had external drift since the load) leaves the
           // state as-is; the residual diff surfaces via the normal path.
          } else {
           const content = (part.state.input as { content?: unknown } | undefined)?.content
           if (typeof content === "string") entry.applied = content.trim()
          }
        }
      }
    }
  }
  return out
}

export function buildSkillDeltaText(
  entries: { name: string; deleted: boolean; diff?: { lines: string[]; truncated: boolean } }[],
): string {
  const sections = entries.map((e) => {
    if (e.deleted) {
      return `- ${e.name}: (skill deleted from disk - the cached content remains until restart)`
    }
    const body =
      e.diff && e.diff.lines.length > 0
        ? e.diff.lines.map((l) => `  ${l}`).join("\n") +
          (e.diff.truncated ? "\n  ... (diff truncated - reload the skill with the skill tool for the full content)" : "")
        : "  (content replaced - reload the skill with the skill tool for the full content)"
    return `- ${e.name}:\n${body}`
  })
  return `<system-reminder>\nSkill context drift: the following skills changed on disk since they were loaded into this session (old -> new):\n${sections.join("\n")}\n</system-reminder>`
}

export type SkillDeltaEntry = {
  name: string
  deleted: boolean
  diff?: { lines: string[]; truncated: boolean }
  content?: string
}

/**
 * Diff the reconstructed view (most recent load + post-load deltas + session
 * self-edits) against the refreshed cache content for each skill with a chain
 * baseline. A skill whose file is unchanged since the last reported state -
 * including one left in the state the session's own edit produced - yields no
 * entry (0 delta); a deletion already reported via a prior reminder yields
 * none either. A recreated file diffs from empty.
 */
export function computeSkillDeltas(
  reconstructed: Map<string, ReconstructedSkill>,
  changed: Skill.RefreshChange[],
): SkillDeltaEntry[] {
  const entries: SkillDeltaEntry[] = []
  for (const [name, st] of reconstructed) {
    const ch = changed.find((c) => c.name === name)
    if (!ch) continue // file unchanged (or deletion already reported - refresh suppresses repeats)
    if (ch.deleted) {
      if (!st.deleted) entries.push({ name, deleted: true })
      continue
    }
    // Self-authored edits were incorporated into the applied state by the
    // walk, so a file still in the agent's edited state diffs to 0 here; an
    // external change after the self-edit diffs incrementally. No special
    // case needed.
    const current = ch.content.trim()
    const view = st.deleted ? "" : (st.applied ?? st.baseline) // recreated: diff from empty
    if (!st.deleted && view === current) continue // 0 delta: file still in the state already shown
    entries.push({ name, deleted: false, diff: lineDiff(view ?? "", current), content: current })
  }
  return entries
}
export const apply = Effect.fn("SessionSkillDelta.apply")(function* (input: {
  msgs: SessionV1.WithParts[]
  sessionID: SessionID
  user: SessionV1.WithParts
  userSystem: string | undefined
  step: number
  compactingPrompt: boolean
  /** The skill file changes detected by the prompt-stage refresh (already run once this turn). */
  changed: Skill.RefreshChange[]
}) {
  // Mirror epoch gating: deltas ride step-1 real user messages only. Mid-turn
  // drift is held in the chain and surfaces on the next user prompt; compaction
  // turns and per-message system overrides bypass.
  if (input.userSystem || input.compactingPrompt || input.step !== 1 || !isRealUser(input.user)) return

  if (input.changed.length === 0) return

  const reconstructed = integrateSkillBodies(input.msgs)
  if (reconstructed.size === 0) return

  const entries = computeSkillDeltas(reconstructed, input.changed)
  if (entries.length === 0) return

  const hasDelta = input.user.parts.some((p) => p.type === "text" && p.metadata?.skillDelta)
  if (hasDelta) return

  const sessions = yield* Session.Service
  const metadata: Record<string, { content?: string } | { deleted: true }> = {}
  for (const e of entries) {
    metadata[e.name] = e.deleted ? { deleted: true } : { content: e.content ?? "" }
  }
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: input.user.info.id,
    sessionID: input.sessionID,
    type: "text",
    text: buildSkillDeltaText(entries),
    synthetic: true,
    metadata: { skillDelta: metadata },
  })
  input.user.parts.push(part)
})

export * as SkillDelta from "./skill-delta"
