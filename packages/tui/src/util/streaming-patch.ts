// Streaming edit-patch parser for the live two-column diff preview.
// Mirrors the server grammar tolerance (packages/opencode/src/tool/
// grammar-fence.ts) exactly - "*** Begin Patch"/"*** End Patch" matched by
// startsWith, OLD:/NEW: accepting the "*** " envelope form, CUT/PASTE and
// DELETE/RENAME as-is - but NEVER fails: lines that don't yet fit the
// structure (preamble, an in-progress [path] header, a half-typed marker,
// content outside any block) fall to the raw list and render muted.
//
// The OLD/NEW/CUT/PASTE block membership IS the diff semantic: OLD and CUT
// lines are pre-change content (the removed column), NEW and PASTE lines
// are post-change content (the added column). No file matching is involved
// - the role comes from the block type alone. Resulting-file line numbers
// need the match ladder (step 2); this is the two-column format only.

export type StreamPatchSection = {
  path?: string
  // Removed-content lines: OLD + CUT blocks.
  left: string[]
  // Added-content lines: NEW + PASTE blocks.
  right: string[]
  // Lines inside the section not yet assignable to a column.
  raw: string[]
}

export type StreamPatchParse = {
  sections: StreamPatchSection[]
  raw: string[]
}

const SECTION_RE = /^\[([^#\r\n]+)(?:#[0-9A-Za-z]{1,16})?\]$/
const CUT_RE = /^CUT @([A-Za-z0-9_]+):\s*$/
const PASTE_RE = /^PASTE @([A-Za-z0-9_]+) (AFTER|BEFORE):\s*$/
// INLINE markers (0234 mirror): the server grammar accepts the model's
// compact form - "OLD:<first row>" / "NEW:<first row>" with content glued
// after the colon (leading spaces preserved as code indentation). The
// pre-0234 OLD:/NEW: regexes (marker must END the line) only matched the
// multi-line form, so an inline edit fell through the CUT/PASTE handling,
// matched nothing, and its content landed in `raw` - which LiveEditDiff
// never renders. Result: the exact bug-report symptom ("Patching" title +
// two column headers, no content streaming, snap at completion). Mirror the
// server's grammar-fence.ts inline tolerance exactly: run on the RAW line
// (leading whitespace on the marker allowed, `*** ` envelope optional, the
// rest after the colon captured verbatim).
const OLD_RE = /^\s*(?:\*{3}\s+)?OLD:(.*)$/
const NEW_RE = /^\s*(?:\*{3}\s+)?NEW:(.*)$/

export function parseStreamingPatch(content: string): StreamPatchParse {
  if (content.length === 0) return { sections: [], raw: [] }
  // A terminal "\n" is a line TERMINATOR, not a line: the streamed content
  // ends with one after every completed line, so split("\n") would append a
  // phantom empty element per boundary (a phantom empty row per line in the
  // columns - the heredoc-segments lesson). Strip exactly one; a genuinely
  // blank trailing line (content ending "\n\n") keeps its empty line.
  const lines = content.replace(/\n$/, "").split("\n")
  const sections: StreamPatchSection[] = []
  const raw: string[] = []
  let cur: StreamPatchSection | null = null
  let col: "left" | "right" | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    // The patch envelope: startsWith tolerance, same as the server.
    if (trimmed.startsWith("*** Begin Patch") || trimmed.startsWith("*** End Patch")) continue

    const sec = SECTION_RE.exec(trimmed)
    if (sec) {
      cur = { path: sec[1], left: [], right: [], raw: [] }
      sections.push(cur)
      col = null
      continue
    }

    if (!cur) {
      raw.push(line)
      continue
    }

    // INLINE OLD/NEW markers (0234): "OLD:  local err=99" - the rest after
    // the colon is the block's FIRST content row, kept verbatim (leading
    // spaces are code indentation and are preserved). Matched against the
    // RAW line so the marker's own leading whitespace tolerance and the
    // optional "*** " envelope both work exactly as grammar-fence.ts does.
    const oldM = OLD_RE.exec(line)
    if (oldM && oldM[1] !== undefined) {
      const rest = oldM[1]
      col = "left"
      if (rest.trim() !== "") cur.left.push(rest)
      continue
    }
    const newM = NEW_RE.exec(line)
    if (newM && newM[1] !== undefined) {
      const rest = newM[1]
      col = "right"
      if (rest.trim() !== "") cur.right.push(rest)
      continue
    }

    // A full CUT/PASTE directive: terminates the open block and opens a new
    // one (CUT content is removed, PASTE content is added). A directive-
    // LOOKING line that isn't the full form (still streaming, or a typo)
    // falls through to the content path, exactly like the server treats it.
    if (/^(CUT|PASTE) @/.test(trimmed) && (CUT_RE.test(trimmed) || PASTE_RE.test(trimmed))) {
      col = CUT_RE.test(trimmed) ? "left" : "right"
      continue
    }

    if (trimmed === "DELETE" || /^RENAME /.test(trimmed)) continue

    if (col) cur[col].push(line)
    else cur.raw.push(line)
  }

  return { sections, raw }
}
