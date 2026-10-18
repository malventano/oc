import { afterEach, describe, expect, test } from "bun:test"
import {
  clearMisses,
  isAlreadyApplied,
  matchLocations,
  missCount,
  missGuidance,
  multiMatchError,
  noMatchError,
  occurrenceCount,
  recordMiss,
  resetMisses,
} from "../../src/tool/edit-feedback"
import { replaceOutcome } from "../../src/tool/edit"

afterEach(() => {
  clearMisses()
})

describe("edit feedback", () => {
  test("multi-match error lists up to five locations with snippets", () => {
    const content = ["alpha", "foo one", "beta", "foo two", "gamma", "foo three", "delta", "foo four", "epsilon", "foo five", "zeta", "foo six"].join(
      "\n",
    )
    const locations = matchLocations(content, "foo")

    expect(locations).toHaveLength(5)
    expect(locations[0]).toEqual({ line: 2, snippet: "foo one" })
    expect(locations[4]).toEqual({ line: 10, snippet: "foo five" })

    const message = multiMatchError(content, "foo")
    expect(message).toContain("Found multiple matches")
    expect(message).toContain("L2: foo one")
    expect(message).toContain("L10: foo five")
    expect(message).not.toContain("L12:")
    expect(message.toLowerCase()).toContain("provide more surrounding context")
  })

  test("no-match gives a bounded did-you-mean block", () => {
    const content = ["const alpha = 1", "const beta = 2", "const gamma = 3", "const delta = 4"].join("\n")
    const message = noMatchError(content, "const betta = 2")

    expect(message).toContain("Could not find oldString")
    expect(message).toContain("Did you mean L2?")
    expect(message.length).toBeLessThanOrEqual(800)
  })

  test("third consecutive miss escalates and success resets the counter", () => {
    const file = "/tmp/oc-feedback-test.txt"

    expect(recordMiss(file)).toBe(1)
    expect(missGuidance(1)).toBe("")
    expect(recordMiss(file)).toBe(2)
    expect(missGuidance(2)).toBe("")
    expect(recordMiss(file)).toBe(3)
    expect(missGuidance(3)).toContain("STOP retrying")

    resetMisses(file)
    expect(missCount(file)).toBe(0)
  })

  test("already-applied requires old absent and new present exactly once", () => {
    expect(isAlreadyApplied("value = new", "value = old", "value = new")).toBe(true)
    expect(isAlreadyApplied("value = new\nvalue = new", "value = old", "value = new")).toBe(false)
    expect(isAlreadyApplied("value = old", "value = old", "value = new")).toBe(false)
  })

  test("replaceAll count reports every occurrence", () => {
    const outcome = replaceOutcome("foo bar foo baz foo", "foo", "qux", true)

    expect(outcome.text).toBe("qux bar qux baz qux")
    expect(outcome.tier).toBe("Simple")
    expect(outcome.count).toBe(3)
    expect(occurrenceCount("foo bar foo baz foo", "foo")).toBe(3)
  })
})
