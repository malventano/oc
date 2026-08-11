import { describe, expect, test } from "bun:test"
import { hashlineRef } from "../../src/tool/hashline"
import { diffLineRuns, remapEditsToCurrent } from "../../src/tool/hashline-recovery"

describe("tool.hashline-recovery", () => {
  test("diffLineRuns reports uniform insertions as unchanged runs", () => {
    const runs = diffLineRuns(["a", "b", "c"], ["0", "a", "b", "c"])
    const equal = runs.filter((r) => r.type === "equal")
    expect(equal).toHaveLength(1)
    expect(equal[0].oldStart).toBe(0)
    expect(equal[0].newStart).toBe(1)
    expect(equal[0].count).toBe(3)
  })

  test("remaps anchors through a uniform insertion", () => {
    const oldLines = ["alpha", "beta", "gamma"]
    const newLines = ["preamble", "alpha", "beta", "gamma"]
    const edits = [{ type: "set_line" as const, line: hashlineRef(2, "beta"), text: "BETA" }]

    const remapped = remapEditsToCurrent(edits, oldLines, newLines)
    expect(remapped).not.toBeNull()
    expect(remapped![0].type).toBe("set_line")
    if (remapped![0].type === "set_line") {
      expect(remapped![0].line).toBe(hashlineRef(3, "beta"))
    }
  })

  test("remaps anchors on the last line through a uniform insertion", () => {
    const oldLines = ["alpha", "beta", "gamma"]
    const newLines = ["preamble", "alpha", "beta", "gamma"]
    const edits = [{ type: "set_line" as const, line: hashlineRef(3, "gamma"), text: "GAMMA" }]

    const remapped = remapEditsToCurrent(edits, oldLines, newLines)
    expect(remapped).not.toBeNull()
    expect(remapped![0].type).toBe("set_line")
    if (remapped![0].type === "set_line") {
      expect(remapped![0].line).toBe(hashlineRef(4, "gamma"))
    }
  })


  test("fails closed when an anchor is not in an unchanged run", () => {
    const oldLines = ["alpha", "beta", "gamma"]
    const newLines = ["alpha", "BETA-CHANGED", "gamma"]
    const edits = [{ type: "set_line" as const, line: hashlineRef(2, "beta"), text: "beta2" }]

    expect(remapEditsToCurrent(edits, oldLines, newLines)).toBeNull()
  })

  test("fails closed when offsets are not uniform", () => {
    const oldLines = ["a", "b", "c", "d", "e"]
    const newLines = ["a", "b", "X", "c", "d", "e"]
    const edits = [
      { type: "set_line" as const, line: hashlineRef(1, "a"), text: "A" },
      { type: "set_line" as const, line: hashlineRef(3, "c"), text: "C" },
    ]

    // line 1 shifts 0, line 3 shifts +1: non-uniform, fail closed
    expect(remapEditsToCurrent(edits, oldLines, newLines)).toBeNull()
  })

  test("fails closed when there is no net shift", () => {
    const oldLines = ["a", "b"]
    const newLines = ["a", "b"]
    const edits = [{ type: "set_line" as const, line: hashlineRef(1, "a"), text: "A" }]

    expect(remapEditsToCurrent(edits, oldLines, newLines)).toBeNull()
  })

  test("returns null when there are no anchored ops (nothing to remap)", () => {
    const oldLines = ["a", "b"]
    const newLines = ["x", "a", "b"]
    const edits = [
      { type: "append" as const, text: "tail" },
      { type: "replace" as const, old_text: "a", new_text: "A" },
    ]

    expect(remapEditsToCurrent(edits, oldLines, newLines)).toBeNull()
  })
})
