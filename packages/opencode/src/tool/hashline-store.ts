// Session-scoped file snapshot store backing hashline staleness detection,
// seen-line enforcement, and drift recovery. Modeled on oh-my-pi's
// InMemorySnapshotStore (MIT): content-hash tags per path, LRU retention,
// whole-file content retained for anchor remapping.
//
// The store is process-global (not per-session): paths are absolute and tags
// are content-derived, so cross-session sharing is harmless and the session
// DB plumbing omp needs is unnecessary here.

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import * as path from "path"

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_PATHS = 30

export interface Snapshot {
  tag: string
  content: string
  seenLines: Set<number>
}

const snapshots = new Map<string, Snapshot>()

export function clearSnapshots() {
  snapshots.clear()
}

export function recordSnapshot(path: string, content: string, seenLines?: Set<number> | number[]): string {
  const tag = fileTag(content)
  const key = FSUtil.resolve(path)
  const existing = snapshots.get(key)
  const merged = new Set(seenLines ?? [])
  if (existing && existing.tag === tag && existing.content === content) {
    for (const line of existing.seenLines) merged.add(line)
  }
  snapshots.set(key, { tag, content, seenLines: merged })
  if (snapshots.size > MAX_PATHS) {
    const oldest = snapshots.keys().next().value as string | undefined
    if (oldest !== undefined) snapshots.delete(oldest)
  }
  return tag
}

export function snapshotOf(path: string): Snapshot | undefined {
  return snapshots.get(FSUtil.resolve(path))
}

export function invalidateSnapshot(path: string) {
  snapshots.delete(FSUtil.resolve(path))
}

export function relocateSnapshot(from: string, to: string) {
  const key = FSUtil.resolve(from)
  const existing = snapshots.get(key)
  snapshots.delete(key)
  if (existing) snapshots.set(FSUtil.resolve(to), existing)
}

export function mergeSeenLines(path: string, lines: number[]) {
  const key = FSUtil.resolve(path)
  const existing = snapshots.get(key)
  if (!existing) return
  for (const line of lines) existing.seenLines.add(line)
}

/**
 * Whole-file content tag: xxHash32 (seed 0) of the text with trailing
 * [ \t\r] stripped before each newline and at EOF, low 16 bits, 4-hex
 * uppercase. CRLF and display-trimmed lines therefore do not invalidate tags.
 */
export function fileTag(text: string): string {
  const normalized = text.replace(/[ \t\r]+(?=\n|$)/g, "")
  const hash = Bun.hash.xxHash32(normalized, 0) & 0xffff
  return hash.toString(16).padStart(4, "0").toUpperCase()
}

/**
* Path rendered in `[PATH#TAG]` section headers (read output and edit success).
* Files inside the project resolve from the instance directory so the header
* round-trips through the edit tool's path resolution; files outside it use
* their absolute path, since a bare basename would resolve to a different
* file of the same name in the project root.
*/
export function hashlineHeaderPath(instanceDirectory: string, filepath: string): string {
  const rel = path.relative(instanceDirectory, filepath)
  return rel === "" || rel.startsWith("..") ? filepath : rel
}

export function snapshotBytesLimit() {
  return MAX_SNAPSHOT_BYTES
}

/**
 * Read a file's full text for snapshotting, skipping files over the byte cap.
 * Returns undefined when the file should not be snapshotted.
 */
export function readForSnapshot(afs: FSUtil.Interface, filePath: string, size?: number) {
  return Effect.gen(function* () {
    if (size !== undefined && size > MAX_SNAPSHOT_BYTES) return undefined
    const text = yield* afs.readFileStringSafe(filePath)
    if (text === undefined || Buffer.byteLength(text, "utf-8") > MAX_SNAPSHOT_BYTES) return undefined
    return text.startsWith("\uFEFF") ? text.slice(1) : text
  })
}
