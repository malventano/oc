import { describe, expect, test } from "bun:test"
import { extractOutput } from "@/tool/squash-output"

const HINT = "\n\n<system-reminder>Very large tool output (9000 chars, ~2250 tokens). If you won't reference it again, call squash-output NOW, in your very next message, before other tool calls; every future prompt in this session re-reads it.</system-reminder>"
const STAMP = "\n\n<system-reminder>2026-08-12T03:53:00.000Z</system-reminder>"

describe("extractOutput", () => {
  test("strips timestamp and hint, preserves only the timestamp", () => {
    const out = extractOutput({ state: { output: `content${STAMP}${HINT}` } })
    expect(out.stripped).toBe("content")
    expect(out.stamp).toBe(STAMP)
    expect(out.originalLen).toBe(7)
  })

  test("preserves the timestamp when no hint is present", () => {
    const out = extractOutput({ state: { output: `content${STAMP}` } })
    expect(out.stripped).toBe("content")
    expect(out.stamp).toBe(STAMP)
  })

  test("drops a lone hint tag entirely", () => {
    const out = extractOutput({ state: { output: `content${HINT}` } })
    expect(out.stripped).toBe("content")
    expect(out.stamp).toBe("")
  })

  test("preserves non-hint reminders (e.g. read's loaded reminder)", () => {
    const loaded = "\n\n<system-reminder>\nInstructions from: /x/AGENTS.md\n</system-reminder>"
    const out = extractOutput({ state: { output: `content${loaded}${STAMP}` } })
    expect(out.stripped).toBe("content")
    expect(out.stamp).toContain("Instructions from: /x/AGENTS.md")
    expect(out.stamp).toContain(STAMP)
  })

  test("no trailing reminder leaves output untouched", () => {
    const out = extractOutput({ state: { output: "content" } })
    expect(out.stripped).toBe("content")
    expect(out.stamp).toBe("")
  })

  test("missing output yields empty stripped", () => {
    const out = extractOutput({ state: {} })
    expect(out.stripped).toBe("")
    expect(out.stamp).toBe("")
  })
})
