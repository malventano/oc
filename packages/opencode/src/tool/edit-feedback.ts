// 0424: edit failure feedback + already-applied detection.
//
// The upstream ladder fails closed with two generic messages. Models respond
// poorly to a bare "not found" / "multiple matches": they retry the same
// anchor, sometimes many times. These helpers turn each failure into a bounded,
// actionable report:
//   - multiple matches: up to 5 locations (`L<line>: <snippet>`)
//   - no match: up to 3 closest line regions ("Did you mean L<line>?")
//   - per-file consecutive miss counter with explicit stop guidance on the 3rd
//   - already-applied detection (old absent, new present exactly once)
//
// The edit tool wires these into its error/success paths; nothing here writes.

export const ALREADY_APPLIED_MESSAGE = "Edit already applied; do not re-send this patch."

const MAX_MULTI_LOCATIONS = 5
const MAX_CLOSEST = 3
const MAX_DID_YOU_MEAN_CHARS = 800
const MAX_SCAN_LINES = 5000
const MAX_SNIPPET_CHARS = 120

/** Count non-overlapping exact occurrences. */
export function occurrenceCount(content: string, find: string): number {
  if (!find) return 0
  let count = 0
  let index = 0
  while (true) {
    index = content.indexOf(find, index)
    if (index === -1) return count
    count++
    index += find.length
  }
}

/** The edit is a no-op retry when the old bytes are already gone but the new
 *  bytes are present exactly once. */
export function isAlreadyApplied(content: string, oldString: string, newString: string): boolean {
  if (!oldString || !newString) return false
  if (content.includes(oldString)) return false
  return occurrenceCount(content, newString) === 1
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

function lineAt(content: string, offset: number): string {
  let start = content.lastIndexOf("\n", offset - 1) + 1
  let end = content.indexOf("\n", offset)
  if (end === -1) end = content.length
  return content.slice(start, end).replace(/\r$/, "").trim()
}

function snippet(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, " ")
  return oneLine.length > MAX_SNIPPET_CHARS ? `${oneLine.slice(0, MAX_SNIPPET_CHARS)}...` : oneLine
}

export type MatchLocation = { line: number; snippet: string }

/** Exact-match locations in document order, capped for prompt economy. */
export function matchLocations(content: string, find: string, limit = MAX_MULTI_LOCATIONS): MatchLocation[] {
  const out: MatchLocation[] = []
  if (!find) return out
  let index = 0
  while (out.length < limit) {
    index = content.indexOf(find, index)
    if (index === -1) break
    out.push({ line: lineOfOffset(content, index), snippet: snippet(lineAt(content, index)) })
    index += find.length
  }
  return out
}

/** Multi-match message with up to five locations and the uniqueness nudge. */
export function multiMatchError(content: string, find: string): string {
  let message =
    "Found multiple matches for oldString. Provide more surrounding context (a longer unique anchor) to make the match unique."
  const locations = matchLocations(content, find)
  if (locations.length > 0) {
    message +=
      "\nMatches:\n" +
      locations.map((location) => `L${location.line}: ${location.snippet || "(blank line)"}`).join("\n")
  }
  if (find && find.split("\n").length === 1) {
    message += "\nUse replaceAll: true to change every occurrence deliberately."
  }
  return message
}

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) previous[j] = j
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]
  }
  return previous[b.length]
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

export type ClosestRegion = { line: number; score: number; text: string }

/** Best matching line regions for a miss, ordered by descending similarity.
 *  Bounded scan and output so a miss on a huge file stays cheap. */
export function closestRegions(content: string, find: string, limit = MAX_CLOSEST): ClosestRegion[] {
  const contentLines = content.split("\n")
  const findLines = find.split("\n").map((line) => line.trim().replace(/\r$/, ""))
  if (findLines.length === 0) return []

  const scan = Math.min(contentLines.length, MAX_SCAN_LINES)
  const lastStart = Math.max(0, scan - findLines.length)
  const found: ClosestRegion[] = []

  for (let i = 0; i <= lastStart; i++) {
    let score = 0
    let counted = 0
    for (let j = 0; j < findLines.length && i + j < contentLines.length; j++) {
      const candidate = contentLines[i + j].trim().replace(/\r$/, "")
      const expected = findLines[j]
      if (candidate.length === 0 && expected.length === 0) continue
      score += similarity(candidate, expected)
      counted++
    }
    if (counted === 0) continue
    const average = score / counted
    if (average < 0.4) continue
    // Collapse overlapping windows so three entries are three distinct regions.
    const previous = found[found.length - 1]
    if (previous && i < previous.line - 1 + findLines.length) {
      if (average > previous.score) {
        previous.score = average
        previous.text = contentLines[i]!.trim()
      }
      continue
    }
    found.push({ line: i + 1, score: average, text: contentLines[i]!.trim() })
  }

  found.sort((a, b) => b.score - a.score)
  return found.slice(0, limit)
}

/** No-match message with bounded "Did you mean" regions. Keeps the upstream
 *  prefix intact so existing diagnostics/expectations still match. */
export function noMatchError(content: string, find: string): string {
  const base =
    "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
  const closest = closestRegions(content, find)
  if (closest.length === 0) return base

  let block = "\n\nDid you mean:"
  for (const region of closest) {
    const text = snippet(region.text)
    block += `\nDid you mean L${region.line}? ${text || "(blank line)"}`
    if (block.length >= MAX_DID_YOU_MEAN_CHARS) break
  }
  const cap = MAX_DID_YOU_MEAN_CHARS - base.length
  if (block.length > cap) block = cap > 3 ? `${block.slice(0, cap - 3)}...` : ""
  return base + block
}

const misses = new Map<string, number>()

/** Record a consecutive miss for a path. Returns the new consecutive count. */
export function recordMiss(filePath: string): number {
  const next = (misses.get(filePath) ?? 0) + 1
  misses.set(filePath, next)
  return next
}

/** Reset the consecutive-miss counter after any successful outcome (including
 *  the already-applied no-op). */
export function resetMisses(filePath: string): void {
  misses.delete(filePath)
}

/** Escalating guidance appended on the 3rd and later consecutive misses. */
export function missGuidance(count: number): string {
  if (count < 3) return ""
  return (
    "STOP retrying this anchor. Re-read the file to get its current content, " +
    "use a longer unique anchor (or a smaller stable one), or use write for an " +
    "intentional full-file replacement."
  )
}

export function missCount(filePath: string): number {
  return misses.get(filePath) ?? 0
}

/** Test/reset hook: clear all counters. */
export function clearMisses(): void {
  misses.clear()
}
