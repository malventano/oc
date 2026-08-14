// Fence patch grammar: OLD/NEW raw content blocks (the "old code, then new
// code" style). Replaces the hashline anchor grammar (0026-0117) per the
// 2026-08-14 edit-format investigation (docs/edit_format_investigation_20260814.md).
//
//   *** Begin Patch
//   [path/to/file.ts]
//   OLD:
//   <raw lines, byte-exact from the read output (N: prefix stripped)>
//   NEW:
//   <raw replacement lines>
//   [path/to/other.ts]
//   OLD:
//   ...
//   *** End Patch
//
// Rules:
// - OLD with a NEW block = replace the matched OLD range with NEW.
// - OLD with no NEW block = delete the matched range.
// - OLD empty (no lines) with NEW = append NEW at the end of the file.
// - OLD and NEW byte-identical = a no-op - rejected at parse time
//   ("No changes to apply" - upstream wording).
// - Inserts are expressed by including the anchor line in BOTH blocks and
//   extending NEW (the model's natural echo-diff pattern).
// - Multiple OLD/NEW pairs per section apply in order (non-overlapping).
// - DELETE and RENAME NEWPATH are file-level ops (alone in their section).
//
// The parser is pure text: the ENGINE (edit.ts) resolves each OLD block to
// a UNIQUE byte-exact match in the file (fail-closed on no-match and
// ambiguity) and applies the splices.

export type FenceOp =
  | { kind: "replace"; old: string[]; new: string[] }
  | { kind: "append"; text: string[] }

export type FenceSection = {
  filePath: string
  ops: FenceOp[]
  delete?: boolean
  rename?: string
}

export type FenceParseResult = { ok: true; files: FenceSection[] } | { ok: false; errors: string[] }

export function parseFencePatch(input: string | null | undefined): FenceParseResult {
  const rawLines = String(input ?? "").split(/\r?\n/)
  const nonEmpty = rawLines.filter((l) => l.trim() !== "")
  let common = Infinity
  for (const l of nonEmpty) {
    const m = l.match(/^ */)?.[0].length ?? 0
    if (m < common) common = m
  }
  const dedented = common > 0 && common < Infinity ? rawLines.map((l) => l.slice(common)) : rawLines
  const lines = dedented
  const errors: string[] = []
  const files: FenceSection[] = []
  let cur: FenceSection | null = null
  let curOld: string[] | null = null
  let curNew: string[] | null = null
  let fileLevelDone = false

  const fail = (i: number, line: string, msg: string) => {
    errors.push(`line ${i + 1}: ${msg} - got: ${JSON.stringify(line.slice(0, 80))}`)
  }

  // Resolve the current OLD/NEW pair into an op. A no-op (OLD === NEW) is a
  // parse error - the upstream "No changes to apply" wording - so it fails
  // BEFORE any metadata is emitted (the TUI shows a clean red tool call).
  const resolvePair = (i: number) => {
    if (!cur) return
    const oldLines = curOld
    const newLines = curNew ?? []
    if (oldLines === null) return
    if (oldLines.length === 0 && newLines.length === 0) {
      errors.push(`line ${i + 1}: OLD and NEW are both empty - nothing to do`)
      return
    }
    if (oldLines.length === 0) {
      cur.ops.push({ kind: "append", text: [...newLines] })
      return
    }
    if (oldLines.join("\n") === newLines.join("\n")) {
      errors.push(
        `line ${i + 1}: No changes to apply: the OLD and NEW blocks are identical. Add the actual change to the NEW block.`,
      )
      return
    }
    cur.ops.push({ kind: "replace", old: [...oldLines], new: [...newLines] })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === "" && curOld === null && curNew === null) continue
    if (trimmed.startsWith("*** Begin Patch")) {
      if (files.length > 0) {
        fail(i, line, "duplicate begin marker")
        return { ok: false, errors }
      }
      continue
    }
    if (trimmed.startsWith("*** End Patch")) {
      if (curOld !== null) {
        resolvePair(i)
        if (errors.length > 0) return { ok: false, errors }
      }
      if (files.length === 0) {
        fail(i, line, "empty patch (no file sections)")
        return { ok: false, errors }
      }
      return { ok: true, files }
    }
    const sec = /^\[([^#\r\n]+)(?:#[0-9A-Za-z]{1,16})?\]$/.exec(trimmed)
    if (sec) {
      if (curOld !== null) {
        resolvePair(i)
        if (errors.length > 0) return { ok: false, errors }
      }
      cur = { filePath: sec[1], ops: [] }
      files.push(cur)
      curOld = null
      curNew = null
      fileLevelDone = false
      continue
    }
    if (!cur) {
      fail(i, line, "file content before any [PATH] section")
      return { ok: false, errors }
    }
    if (fileLevelDone) {
      fail(i, line, "file-level op takes no blocks")
      return { ok: false, errors }
    }
    if (trimmed === "OLD:") {
      if (curNew !== null) {
        resolvePair(i)
        if (errors.length > 0) return { ok: false, errors }
        curOld = null
        curNew = null
      } else if (curOld !== null) {
        fail(i, line, "OLD: when a block is already open - finish the previous NEW: block first")
        return { ok: false, errors }
      }
      curOld = []
      curNew = null
      continue
    }
    if (trimmed === "NEW:") {
      if (curOld === null) {
        fail(i, line, "NEW: without a preceding OLD: block")
        return { ok: false, errors }
      }
      if (curNew !== null) {
        fail(i, line, "duplicate NEW: - one OLD/NEW pair per change")
        return { ok: false, errors }
      }
      curNew = []
      continue
    }
    if (trimmed === "DELETE" || /^RENAME /.test(trimmed)) {
      if (curOld !== null || curNew !== null || cur.ops.length > 0) {
        fail(i, line, "file-level op must be alone in its section")
        return { ok: false, errors }
      }
      if (trimmed === "DELETE") cur.delete = true
      else cur.rename = line.slice(7).trim()
      fileLevelDone = true
      continue
    }
    // Content rows: raw, verbatim (no markers, no separator conventions).
    if (curNew !== null) curNew.push(line)
    else if (curOld !== null) curOld.push(line)
    else {
      fail(i, line, "content outside of an OLD:/NEW: block")
      return { ok: false, errors }
    }
  }
  fail(lines.length, "", "missing *** End Patch")
  return { ok: false, errors }
}

/** First `[PATH]` section header in a patch (for TUI titles/approvals). */
export function patchSectionPath(input: string): string | undefined {
  const match = /^\[([^#\r\n]+)(?:#[0-9A-Za-z]{1,16})?\]/m.exec(String(input ?? ""))
  return match?.[1]
}

/** All `[PATH]` section headers in a patch, in order (for TUI/CLI titles). */
export function patchSectionPaths(input: string | null | undefined): string[] {
  const paths: string[] = []
  for (const line of String(input ?? "").split(/\r?\n/)) {
    const match = /^\[([^#\r\n]+?)(?:#[0-9A-Za-z]{1,16})?\]$/.exec(line.trim())
    if (match) paths.push(match[1])
  }
  return paths
}
