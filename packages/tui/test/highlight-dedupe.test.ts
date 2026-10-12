import { describe, expect, test } from "bun:test"
import { wrapHighlightOnce, type HighlightOnce } from "../src/util/highlight-dedupe"

function deferred() {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("wrapHighlightOnce (0400)", () => {
  test("a burst of identical in-flight requests shares one round trip", async () => {
    let calls = 0
    const gates: ReturnType<typeof deferred>[] = []
    const original: HighlightOnce = (content, ft) => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    }
    const wrapped = wrapHighlightOnce(original, () => {})
    const six = Array.from({ length: 6 }, () => wrapped("same body", "markdown"))
    // all six callers are inside one worker latency: exactly ONE round trip
    expect(calls).toBe(1)
    gates[0]!.resolve({ spans: [] })
    const results = await Promise.all(six)
    for (const r of results) expect(r).toEqual({ spans: [] })
    expect(calls).toBe(1)
  })

  test("different contents do not share, and failures propagate to every sharer", async () => {
    let calls = 0
    const gates: ReturnType<typeof deferred>[] = []
    const original: HighlightOnce = () => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    }
    const wrapped = wrapHighlightOnce(original, () => {})
    const a = wrapped("aaa", "markdown")
    const b = wrapped("bbb", "markdown")
    expect(calls).toBe(2)
    gates[0]!.resolve("ra")
    gates[1]!.reject(new Error("boom"))
    expect(await a).toBe("ra")
    try {
      await b
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as Error).message).toBe("boom")
    }
  })

  test("a resolved result is reused by content identity (LRU), in-flight is cleared after settle", async () => {
    let calls = 0
    const original: HighlightOnce = (content, ft) => {
      calls++
      return Promise.resolve(`r:${ft}:${content}`)
    }
    const wrapped = wrapHighlightOnce(original, () => {})
    expect(await wrapped("x", "markdown")).toBe("r:markdown:x")
    expect(await wrapped("x", "markdown")).toBe("r:markdown:x")
    expect(calls).toBe(1)
    // the in-flight entry must not leak: a new call after settle that misses
    // the LRU (different content) still reaches the worker
    expect(await wrapped("y", "markdown")).toBe("r:markdown:y")
    expect(calls).toBe(2)
    // LRU: back to "x" (still within 2 slots) - resolved cache hit
    expect(await wrapped("x", "markdown")).toBe("r:markdown:x")
    expect(calls).toBe(2)
    // three alternating contents evict "x" (2 slots per filetype)
    await wrapped("z", "markdown")
    await wrapped("w", "markdown")
    expect(await wrapped("x", "markdown")).toBe("r:markdown:x")
    expect(calls).toBe(5)
  })

  test("the sample fires once per round trip with the worker duration", async () => {
    let calls = 0
    const samples: number[] = []
    const gates: ReturnType<typeof deferred>[] = []
    const original: HighlightOnce = () => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    }
    const wrapped = wrapHighlightOnce(original, (_now, ms) => samples.push(ms))
    const a = wrapped("big", "markdown")
    const b = wrapped("big", "markdown")
    gates[0]!.resolve(1)
    await Promise.all([a, b])
    expect(samples.length).toBe(1)
    expect(samples[0]!).toBeGreaterThanOrEqual(0)
  })
})
