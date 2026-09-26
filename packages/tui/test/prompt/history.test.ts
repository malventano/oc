import { describe, expect, test } from "bun:test"
import {
  isDuplicateEntry,
  MAX_HISTORY_ENTRIES,
  moveHistory,
  parsePromptHistory,
  type PromptInfo,
} from "../../src/prompt/history"

const entry = (input: string, parts: PromptInfo["parts"] = []): PromptInfo => ({ input, parts })
const browse = (history: PromptInfo[], index = 0) => ({ index, history })

describe("prompt history", () => {
  test("recovers valid JSONL entries around corruption", () => {
    expect(parsePromptHistory(`${JSON.stringify(entry("one"))}\nnot-json\n${JSON.stringify(entry("two"))}\n`)).toEqual([
      entry("one"),
      entry("two"),
    ])
  })

  test("retains only the newest entries", () => {
    const input = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) =>
      JSON.stringify(entry(String(index))),
    ).join("\n")
    const result = parsePromptHistory(input)
    expect(result).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(result[0]?.input).toBe("5")
  })

  test("dedupes only identical consecutive entries", () => {
    expect(isDuplicateEntry(undefined, entry("hello"))).toBe(false)
    expect(isDuplicateEntry(entry("hello"), entry("hello"))).toBe(true)
    expect(isDuplicateEntry(entry("foo"), entry("bar"))).toBe(false)
    expect(isDuplicateEntry({ ...entry("ls"), mode: "normal" }, { ...entry("ls"), mode: "shell" })).toBe(false)
  })

  test("does not dedupe entries with different parts", () => {
    const a = entry("describe this", [
      { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
    ])
    const b = entry("describe this", [
      { type: "file", mime: "image/png", filename: "b.png", url: "data:image/png;base64,BBB" },
    ])
    expect(isDuplicateEntry(a, b)).toBe(false)
  })
})

describe("moveHistory: draft stash on up-arrow (0370)", () => {
  test("up-arrow on a fresh draft stashes it and lands on the prior entry", () => {
    const r = moveHistory(browse([entry("a"), entry("b")]), -1, "draft text", entry("draft text"))
    expect(r?.browse).toEqual({
      index: -2,
      history: [entry("a"), entry("b"), entry("draft text")],
    })
    expect(r?.item).toEqual(entry("b"))
    expect(r?.appended).toEqual(entry("draft text"))
    expect(r?.trimmed).toBe(false)
  })

  test("the stash dedups against the newest entry and still lands on the prior entry", () => {
    const r = moveHistory(browse([entry("a"), entry("draft text")]), -1, "draft text", entry("draft text"))
    expect(r?.browse).toEqual({ index: -2, history: [entry("a"), entry("draft text")] })
    expect(r?.item).toEqual(entry("a"))
    expect(r?.appended).toBeUndefined()
  })

  test("browsing up from the prior entry moves further back without re-stashing", () => {
    const stashed = moveHistory(browse([entry("a"), entry("b")]), -1, "d", entry("d"))!
    const r = moveHistory(stashed.browse, -1, "b")
    expect(r?.browse.index).toBe(-3)
    expect(r?.item).toEqual(entry("a"))
    expect(r?.appended).toBeUndefined()
  })

  test("down-arrow lands back on the draft, then one more down clears the field", () => {
    const stashed = moveHistory(browse([entry("a"), entry("b")]), -1, "d", entry("d"))!
    expect(stashed.item).toEqual(entry("b"))
    const back = moveHistory(stashed.browse, 1, "b")!
    expect(back.item).toEqual(entry("d"))
    const clear = moveHistory(back.browse, 1, "d")!
    expect(clear.browse.index).toBe(0)
    expect(clear.item).toEqual({ input: "", parts: [] })
  })

  test("up-arrow on the cleared field recalls the stashed draft", () => {
    const stashed = moveHistory(browse([entry("a")]), -1, "d", entry("d"))!
    expect(stashed.item).toEqual(entry("a")) // lands on the prior entry
    const walked = moveHistory(stashed.browse, 1, "a")! // down: onto the draft
    expect(walked.item).toEqual(entry("d"))
    const cleared = moveHistory(walked.browse, 1, "d")! // down: clear
    const recall = moveHistory(cleared.browse, -1, "")
    expect(recall?.item).toEqual(entry("d"))
  })

  test("down-arrow with a fresh draft still refuses (unchanged)", () => {
    expect(moveHistory(browse([entry("a")]), 1, "d", entry("d"))).toBeUndefined()
  })

  test("browsing with an edited field still refuses, and does not stash (unchanged)", () => {
    const r = moveHistory(browse([entry("a"), entry("b")], -1), -1, "edited", entry("edited"))
    expect(r).toBeUndefined()
  })

  test("stashing into an empty history creates the first entry", () => {
    const r = moveHistory(browse([]), -1, "d", entry("d"))
    expect(r?.browse).toEqual({ index: -1, history: [entry("d")] })
    expect(r?.item).toEqual(entry("d"))
    expect(r?.appended).toEqual(entry("d"))
  })

  test("stashing trims at the retention limit", () => {
    const full = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry(String(i)))
    const r = moveHistory(browse(full), -1, "d", entry("d"))
    expect(r?.browse.history).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(r?.browse.history.at(-1)).toEqual(entry("d"))
    expect(r?.browse.history[0]?.input).toBe("1")
    expect(r?.item).toEqual(entry("49"))
    expect(r?.trimmed).toBe(true)
  })
})
