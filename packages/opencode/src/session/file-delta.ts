import * as path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import * as NFS from "fs/promises"
import { PartID, SessionID } from "./schema"
import { Session } from "./session"
import { isRealUser, lineDiff } from "./epoch"
import { isAfter } from "./message-v2"
import { InstanceState } from "@/effect/instance-state"

/**
 * File-change delta reminders: the file counterpart to skill-delta.
 *
 * A read tool part establishes the file's stat (mtimeMs + size) at read time
 * (recorded by the read tool's metadata). If the file changes on disk, the
 * content shown in the read output is stale - the model may edit or reason
 * against outdated lines. On every step the walk re-stats every tracked path
 * and, when the disk stat differs from the newest recorded stat, appends a
 * synthetic fileDelta part showing the bounded window diff (old reported window
 * -> new window) so the model re-reads instead of acting on stale content.
 *
 * ANCHOR: the reminder rides the NEWEST message in the chain. At step 1 that
 * is the turn's user prompt - the reminder lands WITH the prompt (the same
 * shape as the epoch/skill deltas). At a later step it is the previous step's
 * assistant message, which the server's chain does not yet hold (the RDT hwm is
 * the last request's prompt length, and the assistant row was appended after
 * it). Either way the part lands at or after the hwm, so the hashed prefix is
 * untouched and the chain survives. Anchoring to the turn's user message on
 * EVERY step instead put the part deep inside an already-hashed prefix (a
 * mid-turn file change landed ~30K tokens back and re-prefilled the whole
 * suffix after it - BUG_MODEL_SWITCH_PREFIX_MISS 2026-09-16).
 *
 * STACKING: the reminder metadata carries the window text it just reported, so
 * the walk advances the baseline to it and the next delta is incremental from
 * the last reported window (epoch and skill deltas stack the same way via their
 * applied state). Without it every reminder re-diffed the original read window,
 * repeating the earlier edits in each later diff.
 *
 * Parts are identified by metadata.fileDelta (distinct from the epoch's
 * metadata.epoch/epochDelta and skill-delta's metadata.skillDelta) so the
 * epoch's record scans and delta strips never touch them. Deltas ride the newest
 * message and are lifecycle'd by message survival - filterCompacted needs no
 * fileDelta-aware rules.
 *
 * Idempotency is chain-derived: the newest event per path wins among read
 * parts (read-time stat), fileDelta parts (last-reported stat), and session
 * self-edit parts (post-edit stat from edit metadata.files[].stat / write
 * metadata.stat). A file still in the state the agent's own edit left it
 * yields no entry; an EXTERNAL change after the self-edit diffs against the
 * post-edit stat. A deletion already reported via a prior reminder yields
 * none either; a recreated file diffs from the deleted baseline.
 *
 * The window diff is bounded on both inputs: old text comes from the read
 * part's display.text (already capped at 50 KB / 2000 lines / 2000 chars per
 * line by the original read); new text is a bounded re-read of the same
 * window from disk, skipped entirely when the file exceeds the snapshot byte
 * cap (the diff would be noise for huge files). lineDiff caps output at 40
 * +/- lines with a truncation note.
 */

export type FileStat = { mtimeMs: number; size: number }

export type ReconstructedRead = {
  /** Absolute path of the file (from the read part's display). */
  path: string
  /** Stat of the file as of the newest event (read / fileDelta reminder / self-edit). */
  stat: FileStat | { deleted: true }
  /** Read window shown to the model (from the read part's display). */
  lineStart: number
  lineEnd: number
  /** Old text shown to the model (display.text - the exact raw window). */
  oldText: string | null
}

/** Reported per-path state: the disk stat plus the window text the model was
 *  shown (the next delta's baseline). Text is absent when the window could not
 *  be read (generic "changed on disk" note) - the baseline then stays at the
 *  prior reported window. */
export type FileDeltaState = FileStat & { text?: string }

export type FileDeltaEntry = {
  path: string
  kind: "changed" | "deleted"
  /** Bounded window diff (old reported window -> new window); undefined when too large to diff. */
  diff?: { lines: string[]; truncated: boolean }
  /** The new window text reported to the model (the next delta's baseline);
   *  undefined when the window could not be read (generic note). */
  text?: string
}

const MAX_DIFF_FILE_BYTES = 4 * 1024 * 1024 // mirror snapshot cap: beyond this, no window diff
const MAX_DIFF_WINDOW_BYTES = 50 * 1024 // mirror read.ts MAX_BYTES
const MAX_DIFF_LINE_LENGTH = 2000 // mirror read.ts MAX_LINE_LENGTH
const MAX_REMIND_PATHS = 8

/**
 * Ordered walk: read parts establish the baseline stat; later fileDelta parts
 * (last-reported stat + window) and session self-edit parts (post-edit stat)
 * replace it. Returns the reconstructed view per absolute path. A path whose
 * read part has no recorded stat (e.g. pre-0116 reads, directory reads) is not
 * tracked.
 */
export function integrateFileReads(msgs: SessionV1.WithParts[]): Map<string, ReconstructedRead> {
  const out = new Map<string, ReconstructedRead>()
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state?.status === "completed") {
        const metadata = part.state.metadata as
          | { display?: { type?: string; path?: unknown; text?: unknown; lineStart?: unknown; lineEnd?: unknown }; stat?: unknown }
          | undefined
        const display = metadata?.display
        if (display?.type !== "file" || typeof display.path !== "string") continue
        const stat = metadata?.stat
        if (!isFileStat(stat)) continue
        out.set(display.path, {
          path: display.path,
          stat,
          lineStart: typeof display.lineStart === "number" ? display.lineStart : 1,
          lineEnd: typeof display.lineEnd === "number" ? display.lineEnd : 1,
          oldText: typeof display.text === "string" ? display.text : null,
        })
      } else if (part.type === "text" && part.synthetic && part.metadata?.fileDelta) {
        const delta = part.metadata.fileDelta as Record<string, FileDeltaState | { deleted?: boolean }>
        for (const [filePath, entry] of Object.entries(delta)) {
          const cur = out.get(filePath)
          if (!cur) continue
          if (entry && "deleted" in entry && entry.deleted) {
            cur.stat = { deleted: true }
          } else if (isFileStat(entry)) {
            cur.stat = { mtimeMs: entry.mtimeMs, size: entry.size }
            // Advance the diff baseline: this reminder reported the window at
            // this point, so the next delta is incremental from it instead of
            // re-diffing the original read window.
            if (typeof (entry as { text?: unknown }).text === "string") {
              cur.oldText = (entry as { text: string }).text
            }
          }
        }
      } else if (
        part.type === "tool" &&
        part.state?.status === "completed" &&
        (part.tool === "edit" || part.tool === "write")
      ) {
        // Session self-edits become applied-state updates (no reminder): the
        // agent's own change is already in context. The edit tool records the
        // post-edit stat per file in metadata.files[].stat; the write tool
        // records it in metadata.stat.
        if (part.tool === "edit") {
          const files = Array.isArray(part.state.metadata?.files) ? part.state.metadata.files : []
          for (const f of files) {
            const filePath = f?.filePath
            if (typeof filePath !== "string") continue
            const cur = out.get(filePath)
            if (!cur) continue
            // Delete/move self-edits record a { deleted: true } stat sentinel:
            // the agent saw the file go away (or relocate) in its own edit
            // output, so the missing source path is never re-reminded.
            if (f?.stat && "deleted" in f.stat) {
              cur.stat = { deleted: true }
              continue
            }
            if (isFileStat(f?.stat)) cur.stat = f.stat
          }
        } else {
          const metadata = part.state.metadata as { stat?: unknown } | undefined
          const input = part.state.input as { filePath?: unknown } | undefined
          const filePath = typeof input?.filePath === "string" ? input.filePath : undefined
          const metadataPath = metadata && "filepath" in metadata ? metadata.filepath : undefined
          const resolved = typeof metadataPath === "string" ? metadataPath : filePath
          if (typeof resolved === "string" && isFileStat(metadata?.stat)) {
            const cur = out.get(resolved)
            if (!cur) continue
            cur.stat = metadata!.stat as FileStat
          }
        }
      }
    }
  }
  return out
}

function isFileStat(value: unknown): value is FileStat {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as FileStat).mtimeMs === "number" &&
    typeof (value as FileStat).size === "number"
  )
}

/** Bounded re-read of the same window (lineStart..lineEnd) with read.ts caps. */
function readNewWindow(text: string, lineStart: number, lineEnd: number): string | undefined {
  const raw = text.split("\n")
  if (raw.length < lineStart) return undefined
  const window = raw.slice(lineStart - 1, lineEnd)
  const out: string[] = []
  let bytes = 0
  for (const line of window) {
    const capped = line.length > MAX_DIFF_LINE_LENGTH ? line.substring(0, MAX_DIFF_LINE_LENGTH) : line
    const size = Buffer.byteLength(capped, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > MAX_DIFF_WINDOW_BYTES) break
    out.push(capped)
    bytes += size
  }
  return out.join("\n")
}

/** Bounded window diff (old reported window -> current window); undefined when
 *  too large/unreadable. Also returns the new window text so the reminder can
 *  report the baseline the next delta diffs from. */
async function windowDiff(
  st: ReconstructedRead,
  disk: FileStat,
  readNew: (path: string) => Promise<string | undefined>,
): Promise<{ diff?: { lines: string[]; truncated: boolean }; text?: string } | undefined> {
  if (disk.size > MAX_DIFF_FILE_BYTES || st.oldText === null) return undefined
  const text = await readNew(st.path)
  if (text === undefined) return undefined
  const window = readNewWindow(text, st.lineStart, st.lineEnd) ?? ""
  const diff = lineDiff(st.oldText, window)
  if (diff.lines.length === 0 && !diff.truncated) return undefined
  return { diff, text: window }
}

/**
 * Diff the reconstructed view (most recent read + post-load deltas + session
 * self-edits) against the current disk stat for each tracked path. A path
 * whose disk stat equals the newest recorded stat yields no entry; a deletion
 * already reported via a prior reminder yields none either; a recreated file
 * diffs from the deleted baseline.
 *
 * `readNew` supplies the current file text for the window diff (undefined
 * when the file is too large or unreadable - such entries get a generic
 * "changed on disk" note).
 */
export function computeFileDeltas(
  reconstructed: Map<string, ReconstructedRead>,
  diskStats: Map<string, FileStat | undefined>,
  readNew: (path: string) => Promise<string | undefined>,
): Promise<FileDeltaEntry[]> {
  return (async () => {
    const entries: FileDeltaEntry[] = []
    for (const [path, st] of reconstructed) {
      const disk = diskStats.get(path)
      if ("deleted" in st.stat) {
        // Recreated: the read window diffs against the recreated content.
        if (disk) {
          const d = await windowDiff(st, disk, readNew)
          entries.push({ path, kind: "changed", diff: d?.diff, text: d?.text })
        }
        continue
      }
      if (!disk) {
        entries.push({ path, kind: "deleted" })
        continue
      }
      // Integer-ms convention (0120): every recorded stat is truncated to
      // integer milliseconds (Date.getTime() parity - the read tool, and
      // Math.trunc at each NFS.stat source: apply below, edit.ts, write.ts).
      // The comparison truncates BOTH sides: edit/write metadata recorded by
      // pre-0120 binaries carried raw float mtimeMs, which would never match
      // the truncated disk stat (spurious drift after the 0120 rollout, one
      // prompt later). Sub-ms precision is noise either way.
      if (Math.trunc(disk.mtimeMs) === Math.trunc(st.stat.mtimeMs) && disk.size === st.stat.size) continue
      const d = await windowDiff(st, disk, readNew)
      entries.push({ path, kind: "changed", diff: d?.diff, text: d?.text })
    }
    return entries
  })()
}

export function buildFileDeltaText(entries: FileDeltaEntry[]): string {
  const sections = entries.slice(0, MAX_REMIND_PATHS).map((e) => {
    if (e.kind === "deleted") {
      return `- ${e.path}: (deleted from disk)`
    }
    if (e.diff && e.diff.lines.length > 0) {
      const body = e.diff.lines.map((l) => `  ${l}`).join("\n")
      const note = e.diff.truncated
        ? "\n  ... (diff truncated - re-read with the read tool for the full content)"
        : ""
      return `- ${e.path}:\n${body}${note}`
    }
    return `- ${e.path}: (changed on disk - re-read with the read tool for the current content)`
  })
  if (entries.length > MAX_REMIND_PATHS) {
    sections.push(`- ... and ${entries.length - MAX_REMIND_PATHS} more file(s)`)
  }
  return `<system-reminder>\nFile context drift: the following files changed on disk since they were read into this session (old -> new):\n${sections.join("\n")}\n</system-reminder>`
}

export const apply = Effect.fn("SessionFileDelta.apply")(function* (input: {
  msgs: SessionV1.WithParts[]
  sessionID: SessionID
  user: SessionV1.WithParts
  userSystem: string | undefined
  step: number
  compactingPrompt: boolean
}) {
  // Loaded files are re-statted on EVERY step (mid-turn included): the stats
  // are one batched Effect.all, so staleness is caught while the model is
  // still working on the files instead of deferred to the next user prompt.
  // Compaction turns and per-message system overrides bypass.
  if (input.userSystem || input.compactingPrompt || !isRealUser(input.user)) return

  const reconstructed = integrateFileReads(input.msgs)
  if (reconstructed.size === 0) return

  // The reminder rides the NEWEST message in the chain (created time, id
  // tie-break - the array is reordered by compaction, so position is not
  // time order). At step 1 that is the turn's user prompt, so the reminder
  // lands WITH the prompt; at a later step it is the previous step's
  // assistant message. Either way the part lands at or after the RDT hwm.
  let anchor: SessionV1.WithParts | undefined
  for (const m of input.msgs) if (!anchor || isAfter(m.info, anchor.info)) anchor = m
  if (!anchor) return

  const hasDelta = anchor.parts.some((p) => p.type === "text" && p.metadata?.fileDelta)
  if (hasDelta) return

  const instance = yield* InstanceState.context
  // Batch the per-path stats into one Effect.all (a single suspension - the
  // app's scheduler costs ~20ms per sequential yield, so per-file loops scale
  // linearly otherwise).
  const paths = Array.from(reconstructed.keys())
  const stats = yield* Effect.all(
    paths.map((path) =>
      Effect.tryPromise(() => NFS.stat(path)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.map((st) => ({ path, st })),
      ),
    ),
    { concurrency: "unbounded" },
  )
  const diskStats = new Map<string, FileStat | undefined>(
    stats.map(({ path, st }) => [path, st ? { mtimeMs: Math.trunc(st.mtimeMs), size: st.size } : undefined]),
  )

  const readNew = async (path: string): Promise<string | undefined> => {
    try {
      return await NFS.readFile(path, "utf8")
    } catch {
      return undefined
    }
  }

  const entries = yield* Effect.promise(() => computeFileDeltas(reconstructed, diskStats, readNew))
  if (entries.length === 0) return

  const metadata: Record<string, FileDeltaState | { deleted: true }> = {}
  for (const e of entries.slice(0, MAX_REMIND_PATHS)) {
    metadata[e.path] =
      e.kind === "deleted"
        ? { deleted: true }
        : { ...diskStats.get(e.path)!, ...(e.text !== undefined ? { text: e.text } : {}) }
  }

  const sessions = yield* Session.Service
  // Render paths project-relative when inside the worktree; outside-project
  // files keep their absolute path. The metadata keeps absolute paths for
  // the walk.
  const rendered = entries.map((e) => {
    const rel = path.relative(instance.directory, e.path)
    return { ...e, path: !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : e.path }
  })
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: anchor.info.id,
    sessionID: input.sessionID,
    type: "text",
    text: buildFileDeltaText(rendered),
    synthetic: true,
    metadata: { fileDelta: metadata },
  })
  anchor.parts.push(part)
})

export * as FileDelta from "./file-delta"
