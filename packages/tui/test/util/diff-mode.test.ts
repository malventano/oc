import { describe, expect, test } from "bun:test"
import { diffMode, patchDiffMode } from "../../src/routes/session"

describe("diff mode", () => {
  test("split by default for short lines at a wide diff box", () => {
    expect(diffMode("a\nb", "a\nc", 200)).toBe("split")
  })

  test("unified when a column is too narrow for two usable columns", () => {
    expect(diffMode("a\nb", "a\nc", 60)).toBe("unified")
  })

  test("unified when more than DIFF_WRAP_LIMIT lines wrap in a column", () => {
    const long = "x".repeat(120)
    expect(diffMode(`${long}\n${long}\n${long}`, `${long}\n${long}\n${long}\ny`, 200)).toBe("unified")
  })

  test("patch: unified when the diff is change-sparse against a large context", () => {
    const lines = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,21 +1,21 @@"]
    for (let i = 0; i < 20; i++) lines.push(` ctx line ${i} ${"y".repeat(20)}`)
    lines.push("-old line")
    lines.push("+new line")
    expect(patchDiffMode(lines.join("\n"), 200)).toBe("unified")
  })

  test("patch: wrapped lines at the DIFF BOX width flip to unified (2026-09-20)", () => {
    const lines = ["--- a/f.ts", "+++ b/f.ts", "@@ -0,0 +1,20 @@"]
    for (let i = 0; i < 20; i++) lines.push(`+${"x".repeat(60)}${i}`)
    const patch = lines.join("\n")
    // The decision width is the DIFF BOX width, not the terminal width:
    // at a 100-col box the ~62-char added lines wrap (colW 40) and the view
    // goes unified; at a 200-col box they fit (colW 90) and it stays split.
    // The callers must pass ctx.width - DIFF_BOX_CHROME (the diff box), not
    // the raw terminal width - the pre-fix bug that missed every wrap.
    expect(patchDiffMode(patch, 100)).toBe("unified")
    expect(patchDiffMode(patch, 200)).toBe("split")
  })

  test("patch: a line just past the column width flips to unified (DIFF_WRAP_MARGIN)", () => {
    const build = (len: number) => {
      const lines = ["--- a/f.ts", "+++ b/f.ts", "@@ -0,0 +1,20 @@"]
      for (let i = 0; i < 20; i++) lines.push(`+${"x".repeat(len)}`)
      return lines.join("\n")
    }
    // width 159 -> colW 69, wrapW 67 (colW - DIFF_WRAP_MARGIN): a 68-char line
    // is one col past the estimated column and renders wrapped, so it must count
    // (the 2026-09-20 boundary case); a 66-char line fits and stays split.
    expect(patchDiffMode(build(68), 159)).toBe("unified")
    expect(patchDiffMode(build(66), 159)).toBe("split")
  })
})
