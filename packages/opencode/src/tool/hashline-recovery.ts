// Stale-anchor recovery for hashline edits, ported from oh-my-pi's
// recovery.ts (MIT) without the pi-natives dependency: diff the snapshot
// content against live content, remap every anchor through unchanged lines,
// require all anchors to shift by one uniform offset, validate context for
// duplicated lines, then replay the edits onto live content. Fails closed:
// any unmapped, non-uniform, or ambiguous anchor returns null and the caller
// falls back to the mismatch error with retry-with anchors.

import { HashlineEdit, hashlineID, parseHashlineRef } from "./hashline"

type Run = { type: "equal" | "removed" | "added"; oldStart: number; newStart: number; count: number }

export function diffLineRuns(oldLines: string[], newLines: string[]): Run[] {
  const n = oldLines.length
  const m = newLines.length
  // LCS table guard: n*m cells is quadratic in time and memory. Beyond 50M
  // cells the diff degenerates to all-removed + all-added runs, which the
  // anchor remap below fails closed on (no equal runs = no anchors to remap).
  if (n * m > 50000000) {
    return [
      ...(n > 0 ? [{ type: "removed" as const, oldStart: 0, newStart: 0, count: n }] : []),
      ...(m > 0 ? [{ type: "added" as const, oldStart: 0, newStart: n, count: m }] : []),
    ]
  }

  const dp: number[][] = []
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const runs: Run[] = []
  let i = 0
  let j = 0
  let oldStart = 0
  let newStart = 0
  let type: "equal" | "removed" | "added" | null = null
  let count = 0
  const flush = () => {
    if (type === null || count === 0) return
    runs.push({ type, oldStart, newStart, count })
    type = null
    count = 0
  }
  const push = (next: "equal" | "removed" | "added") => {
    if (type !== next) {
      flush()
      type = next
      oldStart = i
      newStart = j
    }
    count++
  }

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      push("equal")
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed")
      i++
    } else {
      push("added")
      j++
    }
  }
  while (i < n) {
    push("removed")
    i++
  }
  while (j < m) {
    push("added")
    j++
  }
  flush()
  return runs
}

export function buildLineMap(runs: Run[], oldCount: number): Map<number, number> {
  const map = new Map<number, number>()
  for (const run of runs) {
    if (run.type !== "equal") continue
    for (let k = 0; k < run.count; k++) {
      map.set(run.oldStart + k + 1, run.newStart + k + 1)
    }
  }
  return map
}

type Anchored = Extract<
  HashlineEdit,
  | { type: "set_line" }
  | { type: "replace_lines" }
  | { type: "insert_after" }
  | { type: "insert_before" }
  | { type: "insert_between" }
>

function anchoredRefs(edit: Anchored): Array<{ key: string; line: number; id: string }> {
  const refs: Array<{ key: string; line: number; id: string }> = []
  if (edit.type === "set_line") {
    const ref = parseHashlineRef(edit.line, "set_line.line")
    refs.push({ key: "line", line: ref.line, id: ref.id })
  } else if (edit.type === "replace_lines") {
    const start = parseHashlineRef(edit.start_line, "replace_lines.start_line")
    const end = parseHashlineRef(edit.end_line, "replace_lines.end_line")
    refs.push({ key: "start_line", line: start.line, id: start.id })
    refs.push({ key: "end_line", line: end.line, id: end.id })
  } else if (edit.type === "insert_after") {
    const ref = parseHashlineRef(edit.line, "insert_after.line")
    refs.push({ key: "line", line: ref.line, id: ref.id })
  } else if (edit.type === "insert_before") {
    const ref = parseHashlineRef(edit.line, "insert_before.line")
    refs.push({ key: "line", line: ref.line, id: ref.id })
  } else {
    const after = parseHashlineRef(edit.after_line, "insert_between.after_line")
    const before = parseHashlineRef(edit.before_line, "insert_between.before_line")
    refs.push({ key: "after_line", line: after.line, id: after.id })
    refs.push({ key: "before_line", line: before.line, id: before.id })
  }
  return refs
}

function editWithRef(edit: Anchored, key: string, value: string): HashlineEdit {
  switch (edit.type) {
    case "set_line":
      return { type: "set_line", line: value, text: edit.text }
    case "replace_lines":
      return key === "start_line"
        ? { type: "replace_lines", start_line: value, end_line: edit.end_line, text: edit.text }
        : { type: "replace_lines", start_line: edit.start_line, end_line: value, text: edit.text }
    case "insert_after":
      return { type: "insert_after", line: value, text: edit.text }
    case "insert_before":
      return { type: "insert_before", line: value, text: edit.text }
    default:
      return key === "after_line"
        ? { type: "insert_between", after_line: value, before_line: edit.before_line, text: edit.text }
        : { type: "insert_between", after_line: edit.after_line, before_line: value, text: edit.text }
  }
}

/**
 * Remap anchored edits onto live content. Returns null when recovery is
 * unsafe: any anchor unmapped or offsets not uniform (fail closed).
 */
export function remapEditsToCurrent(
  edits: HashlineEdit[],
  oldLines: string[],
  newLines: string[],
): HashlineEdit[] | null {
  const runs = diffLineRuns(oldLines, newLines)
  const map = buildLineMap(runs, oldLines.length)

  let delta: number | null = null
  let hadAnchored = false
  const out: HashlineEdit[] = []
  for (const edit of edits) {
    if (edit.type === "replace" || edit.type === "append" || edit.type === "prepend") {
      out.push(edit)
      continue
    }

    hadAnchored = true
    const refs = anchoredRefs(edit)
    const remapped = new Map<string, string>()
    for (const ref of refs) {
      const mapped = map.get(ref.line)
      if (mapped === undefined) return null
      const shift = mapped - ref.line
      if (delta === null) {
        delta = shift
      } else if (shift !== delta) {
        return null
      }
      remapped.set(ref.key, `${mapped}#${ref.id}`)
    }

    let next: HashlineEdit = edit
    for (const [key, value] of remapped) {
      next = editWithRef(next as Anchored, key, value)
    }
    out.push(next)
  }

  // delta === 0 with a uniform zero shift means the anchors are stale (content
  // changed in place, so offsets cannot fix it) - fail closed. delta === null
  // means mixed/non-uniform shifts, also unrecoverable.
  if (!hadAnchored || delta === null || delta === 0) return null
  return out
}

/**
* Same-line stale-anchor substitution (patch 0113). The remap above only
* recovers anchors whose lines SHIFTED (uniform offset through unchanged
* lines). It fails closed on in-place content changes at the same line
* number - exactly what the model's own prior edit (or a parallel session)
* produces. This walks each anchor and substitutes the fresh ID when the
* anchor's ID matches a candidate state at the SAME line number:
* - candidates[0] = current disk lines (anchor fresh, no substitution)
* - later candidates = older states the model actually saw (snapshot
*   content, snapshot.previous) - anchor verified stale, substitute
* An anchor matching NO candidate (fabricated/guessed, or copied from a
* different file) fails the whole patch - the caller keeps the mismatch
* error. The substituted IDs are re-validated by applyHashlineEdits
* against live content before any splice runs, so nothing applies blind.
*/
export function substituteSameLineAnchors(
  edits: HashlineEdit[],
  candidates: Array<string[] | undefined>,
): { edits: HashlineEdit[]; substituted: string[] } | null {
  const out: HashlineEdit[] = []
  const substituted: string[] = []
  for (const edit of edits) {
    if (edit.type === "replace" || edit.type === "append" || edit.type === "prepend") {
      out.push(edit)
      continue
    }
    const refs = anchoredRefs(edit)
    let next: HashlineEdit = edit
    let ok = true
    for (const ref of refs) {
      let matched = false
      for (let c = 0; c < candidates.length; c++) {
        const line = candidates[c]?.[ref.line - 1]
        if (line === undefined) continue
        if (hashlineID(ref.line, line) === ref.id) {
          if (c > 0) {
            // Fresh ID comes from the CURRENT disk line (candidates[0]),
            // never from the matched older state - hashing the old content
            // would reproduce the stale ID and make the substitution a no-op.
            const diskLine = candidates[0]?.[ref.line - 1]
            if (diskLine === undefined) {
              ok = false
              break
            }
            const fresh = hashlineID(ref.line, diskLine)
            next = editWithRef(next as Anchored, ref.key, `${ref.line}#${fresh}`)
            substituted.push(`${ref.line}#${ref.id} -> ${ref.line}#${fresh}`)
          }
          matched = true
          break
        }
      }
      if (!matched) {
        ok = false
        break
      }
      if (!ok) return null
      out.push(next)
    }
  }
  if (substituted.length === 0) return null
  return { edits: out, substituted }
}

/**
* 0113: validate that every remapped anchor's ID matches the LIVE content at
* its mapped line number. Gates the Tier 1 shift-remap: the remap moves
* anchors by line-offset, which is right when the model's read predates the
* shift, but WRONG when the model read the post-shift file with fresh anchors
* (they would be moved off their intended lines). Fresh anchors fail this
* check and the caller falls through to same-line substitution (a no-op for
* fresh anchors) - the edit then applies untouched.
*/
export function remappedAnchorsValidate(edits: HashlineEdit[], diskLines: string[]): boolean {
  for (const edit of edits) {
    if (edit.type === "replace" || edit.type === "append" || edit.type === "prepend") continue
    for (const ref of anchoredRefs(edit)) {
      const line = diskLines[ref.line - 1]
      if (line === undefined) return false
      if (hashlineID(ref.line, line) !== ref.id) return false
    }
  }
  return true
}
