import { describe, expect, test } from "bun:test"
import { diffPatch } from "../../src/tool/edit"

describe("diffPatch adaptive hunk context", () => {
  const name = "t"

  // Content lines only (drop the --- / +++ header rows) so hunk-context counts
  // are unambiguous.
  function contextLines(patch: string): string[] {
    return patch
      .split("\n")
      .filter(
        (l) =>
          (l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) &&
          !l.startsWith("---") &&
          !l.startsWith("+++"),
      )
  }

  test("normal files keep the default 4-line hunk context", () => {
    const long = "x".repeat(40)
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: ${long}`).join("\n")
    const after = before.replace(`line 10: ${long}`, `LINE 10 CHANGED: ${long}`)
    const patch = diffPatch(name, before, after)
    expect(patch).toContain(`+LINE 10 CHANGED: ${long}`)
    const ctx = contextLines(patch)
    // 4 context rows above + 4 below the +/- pair (jsdiff 8.x default)
    expect(ctx.filter((l) => l.startsWith(" ")).length).toBe(8)
    expect(ctx.some((l) => l.startsWith(" line 6:"))).toBe(true)
    expect(ctx.some((l) => l.startsWith(" line 14:"))).toBe(true)
    expect(ctx.some((l) => l.startsWith(" line 5:"))).toBe(false)
    expect(ctx.some((l) => l.startsWith(" line 15:"))).toBe(false)
  })

  test("very-long-line files thin the hunk to 1 context line each side", () => {
    const long = "x".repeat(140)
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: ${long}`).join("\n")
    const after = before.replace(`line 10: ${long}`, `LINE 10 CHANGED: ${long}`)
    const patch = diffPatch(name, before, after)
    expect(patch).toContain(`+LINE 10 CHANGED: ${long}`)
    const ctx = contextLines(patch)
    // 1 context row above + 1 below the +/- pair
    expect(ctx.filter((l) => l.startsWith(" ")).length).toBe(2)
    expect(ctx.some((l) => l.startsWith(" line 9:"))).toBe(true)
    expect(ctx.some((l) => l.startsWith(" line 11:"))).toBe(true)
    expect(ctx.some((l) => l.startsWith(" line 8:"))).toBe(false)
    expect(ctx.some((l) => l.startsWith(" line 12:"))).toBe(false)
  })

  test("a long-line file keeps the default context when the longest line is at the cutoff", () => {
    const long = "x".repeat(91)
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: ${long}`).join("\n")
    const after = before.replace(`line 10: ${long}`, `LINE 10 CHANGED: ${long}`)
    const ctx = contextLines(diffPatch(name, before, after))
    expect(ctx.filter((l) => l.startsWith(" ")).length).toBe(8)
  })

  test("no change returns a header-only patch (no hunk) regardless of line length", () => {
    const before = "long ".repeat(60).trim()
    const patch = diffPatch(name, before, before)
    expect(patch).not.toContain("@@ ")
    expect(diffPatch(name, "short lines\n", "short lines\n")).not.toContain("@@ ")
  })
})
