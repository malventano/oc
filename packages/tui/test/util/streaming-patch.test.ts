import { describe, expect, test } from "bun:test"
import { parseStreamingPatch } from "../../src/util/streaming-patch"

// Column projections for compact assertions: the streaming diff preview
// renders ONLY the left (removed) and right (added) columns; anything that
// lands in `raw` is invisible to LiveEditDiff and would produce the
// "Patching title + empty columns, snap at completion" non-streaming bug.
const cols = (patch: string) =>
  parseStreamingPatch(patch).sections.map((s) => ({ left: s.left, right: s.right, raw: s.raw }))

describe("util.streaming-patch", () => {
  test("inline OLD:/NEW: markers populate their columns (0234 mirror)", () => {
    const out = cols(`*** Begin Patch
[src/stall.cpp]
OLD:  local err=99
NEW:  local err=99 // fixed
*** End Patch`)
    expect(out).toEqual([{ left: ["  local err=99"], right: ["  local err=99 // fixed"], raw: [] }])
  })

  test("multi-line OLD:/NEW: blocks still stream (marker on its own line)", () => {
    const out = cols(`*** Begin Patch
[src/stall.cpp]
OLD:
  local err=99
  more
NEW:
  local err=99 // fixed
  more
*** End Patch`)
    expect(out).toEqual([
      {
        left: ["  local err=99", "  more"],
        right: ["  local err=99 // fixed", "  more"],
        raw: [],
      },
    ])
  })

  test("inline marker with the '*** ' envelope form", () => {
    const out = cols(`*** Begin Patch
[src/a.ts]
*** OLD:  const x = 1
*** NEW:  const x = 2
*** End Patch`)
    expect(out).toEqual([{ left: ["  const x = 1"], right: ["  const x = 2"], raw: [] }])
  })

  test("inline first row followed by multi-line continuation stays in one block", () => {
    const out = cols(`*** Begin Patch
[src/a.ts]
OLD:  const x = 1
  const y = 2
NEW:  const x = 10
  const y = 2
*** End Patch`)
    expect(out).toEqual([
      {
        left: ["  const x = 1", "  const y = 2"],
        right: ["  const x = 10", "  const y = 2"],
        raw: [],
      },
    ])
  })

  test("CUT/PASTE streams removed/added content (unchanged)", () => {
    const out = cols(`*** Begin Patch
[src/b.ts]
CUT @r:
  aaa
PASTE @r AFTER:
  aaa
  zzz
*** End Patch`)
    expect(out).toEqual([{ left: ["  aaa"], right: ["  aaa", "  zzz"], raw: [] }])
  })

  test("preamble content outside any block stays in raw (invisible to preview, as designed)", () => {
    const out = cols(`*** Begin Patch
[src/c.ts]
some preamble line
OLD:
  x
NEW:
  y
*** End Patch`)
    expect(out).toEqual([{ left: ["  x"], right: ["  y"], raw: ["some preamble line"] }])
  })

  test("empty content after a marker leaves the column empty but not the section in raw", () => {
    const out = cols(`*** Begin Patch
[src/d.ts]
OLD:
NEW:
*** End Patch`)
    expect(out).toEqual([{ left: [], right: [], raw: [] }])
  })
})
