// 0424: matching helpers beyond the byte-exact tier.
//
// - Typography tier: model-emitted curly quotes, en/em dashes, and NBSP are
//   normalized before matching, so prose edits stop failing on invisible
//   typography drift. The normalized mapping is one UTF-16 unit per character,
//   so match offsets map straight back onto the original content.
// - Mixed-EOL mapping: CRLF files, LF files, and files that contain BOTH are
//   matched on an LF-normalized view, then each replacement line inherits the
//   line ending of the old line it replaced (LCS alignment via diffArrays).
//   Untouched lines keep their original endings.
//
// Ordering: the typography tier is inserted after Simple and before the
// whitespace tiers. The 0301 indentation rebase runs inside replaceOutcome on
// the LF view, so mixed-EOL restoration sees the already-rebased text.

import { diffArrays } from "diff"

const TYPOGRAPHY: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u201f": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u00a0": " ",
}

const TYPOGRAPHY_PATTERN = new RegExp(`[${Object.keys(TYPOGRAPHY).join("")}]`, "g")

export function normalizeTypography(text: string): string {
  return text.replace(TYPOGRAPHY_PATTERN, (character) => TYPOGRAPHY[character] ?? character)
}

export function typographyDisabled(): boolean {
  return process.env.OC_DISABLE_EDIT_TYPOGRAPHY === "1"
}

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

/** Match after folding typographic variants to ASCII. Both sides are
 *  normalized; replacements are 1:1 in UTF-16 units so offsets align. */
export const TypographyReplacer: Replacer = function* (content, find) {
  if (typographyDisabled()) return
  const normalizedFind = normalizeTypography(find)
  const normalizedContent = normalizeTypography(content)
  if (normalizedFind === find && normalizedContent === content) return

  let index = 0
  while (true) {
    index = normalizedContent.indexOf(normalizedFind, index)
    if (index === -1) return
    yield content.substring(index, index + normalizedFind.length)
    index += Math.max(1, normalizedFind.length)
  }
}

export type LineWithEnding = { line: string; ending: string }

/** Split preserving each line's exact ending (CRLF, LF, lone CR, or none). */
export function splitLinesWithEndings(text: string): LineWithEnding[] {
  const out: LineWithEnding[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const character = text[i]
    if (character === "\r") {
      const crlf = text[i + 1] === "\n"
      out.push({ line: text.slice(start, i), ending: crlf ? "\r\n" : "\r" })
      if (crlf) i++
      start = i + 1
    } else if (character === "\n") {
      out.push({ line: text.slice(start, i), ending: "\n" })
      start = i + 1
    }
  }
  if (start < text.length) out.push({ line: text.slice(start), ending: "" })
  return out
}

export function hasMixedLineEndings(text: string): boolean {
  if (!text.includes("\r\n")) return false
  return text.replaceAll("\r\n", "").includes("\n")
}

/** LF-normalized content plus the line array used for LCS alignment. */
export function lfView(text: string): { text: string; lines: string[] } {
  const rows = splitLinesWithEndings(text)
  return {
    text: rows.map((row) => row.line + (row.ending ? "\n" : "")).join(""),
    lines: rows.map((row) => row.line),
  }
}

/** Restore the ORIGINAL line endings onto an LF-normalized result.
 *
 *  diffArrays is the LCS alignment of old/new lines. For a replaced region,
 *  each added line takes the ending of the removed line at the same position
 *  (leftovers inherit the last removed ending). Untouched lines keep their own
 *  ending. A pure insertion inherits the preceding line's ending. */
export function restoreLineEndings(original: string, nextLf: string): string {
  const rows = splitLinesWithEndings(original)
  const before = rows.map((row) => row.line)
  const afterRows = splitLinesWithEndings(nextLf)
  const after = afterRows.map((row) => row.line)
  const changes = diffArrays(before, after)

  const out: string[] = []
  let beforeIndex = 0
  let pending: string[] = []
  let lastEnding = rows.length > 0 ? rows[0]!.ending || "\n" : "\n"

  // A new line needs a separator when the previous emitted line had no
  // terminator (the original file ended without EOL and the edit appended).
  const push = (line: string, ending: string) => {
    if (out.length > 0) {
      const previous = out[out.length - 1]!
      if (!/[\r\n]$/.test(previous)) out[out.length - 1] = `${previous}\n`
    }
    out.push(line + ending)
  }

  for (const change of changes) {
    if (change.removed) {
      pending = change.value.map((_, index) => rows[beforeIndex + index]?.ending ?? "\n")
      if (pending.length > 0) {
        const last = pending[pending.length - 1]!
        if (last) lastEnding = last
      }
      beforeIndex += change.value.length
      continue
    }

    if (change.added) {
      for (const line of change.value) {
        const ending = pending.length > 0 ? pending.shift()! : lastEnding
        push(line, ending)
        if (ending) lastEnding = ending
      }
      pending = []
      continue
    }

    for (const line of change.value) {
      const ending = rows[beforeIndex]?.ending ?? ""
      push(line, ending)
      if (ending) lastEnding = ending
      beforeIndex++
    }
    pending = []
  }

  return out.join("")
}
