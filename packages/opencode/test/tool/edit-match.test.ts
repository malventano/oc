import { afterEach, describe, expect, test } from "bun:test"
import { replaceOutcome } from "../../src/tool/edit"
import {
  hasMixedLineEndings,
  lfView,
  normalizeTypography,
  restoreLineEndings,
  splitLinesWithEndings,
} from "../../src/tool/edit-match"

afterEach(() => {
  delete process.env.OC_DISABLE_EDIT_TYPOGRAPHY
})

describe("edit matching", () => {
  test("typography tier matches curly quotes and reports the tier", () => {
    const content = "const x = \u201chello\u201d\n"
    const outcome = replaceOutcome(content, 'const x = "hello"\n', 'const x = "bye"\n')

    expect(outcome.tier).toBe("Typography")
    expect(outcome.text).toBe('const x = "bye"\n')
  })

  test("typography normalization folds dashes and NBSP", () => {
    expect(normalizeTypography("a\u2013b\u2014c\u00a0d\u2019e")).toBe("a-b-c d'e")
  })

  test("typography tier can be disabled by env", () => {
    process.env.OC_DISABLE_EDIT_TYPOGRAPHY = "1"
    const content = "const x = \u201chello\u201d\n"

    expect(() => replaceOutcome(content, 'const x = "hello"\n', 'const x = "bye"\n')).toThrow(/Could not find oldString/)
  })

  test("splitLinesWithEndings preserves mixed endings", () => {
    expect(splitLinesWithEndings("a\r\nb\nc\r\n")).toEqual([
      { line: "a", ending: "\r\n" },
      { line: "b", ending: "\n" },
      { line: "c", ending: "\r\n" },
    ])
  })

  test("mixed CRLF/LF edit preserves each replaced line's ending", () => {
    const content = "a\r\nb\nc\r\n"
    expect(hasMixedLineEndings(content)).toBe(true)

    const view = lfView(content)
    const outcome = replaceOutcome(view.text, "b\nc", "B\nC")
    const restored = restoreLineEndings(content, outcome.text)

    expect(restored).toBe("a\r\nB\nC\r\n")
  })

  test("LF region inside a CRLF file keeps its LF ending", () => {
    const content = "x\r\ny\nz\r\n"
    expect(hasMixedLineEndings(content)).toBe(true)

    const view = lfView(content)
    const outcome = replaceOutcome(view.text, "y", "Y")
    const restored = restoreLineEndings(content, outcome.text)

    expect(restored).toBe("x\r\nY\nz\r\n")
  })

  test("appending after an unterminated final line adds a separator", () => {
    const content = "a\r\nb\nc"
    const view = lfView(content)
    const outcome = replaceOutcome(view.text, "c", "c\nd")
    const restored = restoreLineEndings(content, outcome.text)

    expect(restored).toBe("a\r\nb\nc\nd\n")
  })

  test("0301 indentation rebase still applies before ending restoration", () => {
    const content = "  const a = 1\r\n  const b = 2\r\n"
    const view = lfView(content)
    const outcome = replaceOutcome(view.text, "const a = 1\nconst b = 2", "const a = 9\nconst b = 9")

    expect(outcome.tier).toBe("LineTrimmed")
    expect(outcome.rebased).toBe(2)

    const restored = restoreLineEndings(content, outcome.text)
    expect(restored).toBe("  const a = 9\r\n  const b = 9\r\n")
  })
})
