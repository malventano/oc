import { expect, test } from "bun:test"
import { consumeEventStream } from "../../src/context/sdk"

// 0367 regression: the client's event-stream consumption loop must survive a
// throwing event handler and must reconnect on a stream failure. Before the fix a
// single throw propagated out of the loop and killed consumption permanently
// (BUG_TUI_EVENT_STREAM_DEATH), so the store went stale and the live footer
// stuck busy after the server had completed the turn.

test("a throwing handler does not stop the stream", async () => {
  const received: number[] = []
  const traces: Array<{ kind: string; event?: number }> = []
  const controller = new AbortController()
  let cycles = 0

  await consumeEventStream<number>({
    signal: controller.signal,
    retryDelay: 1,
    // Abort once the single cycle has drained, so the loop cannot reconnect
    // forever in the test.
    sleep: async () => controller.abort(),
    connect: async () => {
      cycles += 1
      return (async function* () {
        yield 1
        yield 2
        yield 3
      })()
    },
    onEvent: (event) => {
      received.push(event)
      if (event === 2) throw new Error("boom")
    },
    onTrace: (kind, _error, event) => traces.push({ kind, event }),
  })

  // Event 2 threw in its handler; events 1 and 3 still arrive, so the stream
  // survived the throw.
  expect(received).toEqual([1, 2, 3])
  expect(traces).toEqual([{ kind: "handler", event: 2 }])
  expect(cycles).toBe(1)
})

test("a stream failure reconnects and keeps consuming", async () => {
  const received: number[] = []
  const traces: string[] = []
  const controller = new AbortController()
  let cycles = 0

  await consumeEventStream<number>({
    signal: controller.signal,
    retryDelay: 1,
    sleep: async () => {},
    connect: async () => {
      cycles += 1
      if (cycles === 1) throw new Error("connect failed")
      if (cycles === 2) {
        return (async function* () {
          yield 1
          throw new Error("stream failed")
        })()
      }
      return (async function* () {
        yield 2
        controller.abort()
      })()
    },
    onEvent: (event) => received.push(event),
    onTrace: (kind) => traces.push(kind),
  })

  // Cycle 1 failed to connect, cycle 2 failed mid-stream (after event 1), and
  // cycle 3 delivered event 2 - consumption survived both failures.
  expect(received).toEqual([1, 2])
  expect(traces).toEqual(["stream", "stream"])
  expect(cycles).toBe(3)
})

test("reconnect backoff doubles and caps", async () => {
  const delays: number[] = []
  const controller = new AbortController()
  let cycles = 0

  await consumeEventStream<number>({
    signal: controller.signal,
    retryDelay: 1000,
    maxRetryDelay: 4000,
    sleep: async (ms) => {
      delays.push(ms)
      if (delays.length >= 3) controller.abort()
    },
    connect: async () => {
      cycles += 1
      throw new Error("down")
    },
    onEvent: () => {},
    onTrace: () => {},
  })

  expect(delays).toEqual([1000, 2000, 4000])
  expect(cycles).toBe(3)
})

test("an aborted signal stops the loop without reconnecting", async () => {
  const controller = new AbortController()
  controller.abort()
  let cycles = 0

  await consumeEventStream<number>({
    signal: controller.signal,
    connect: async () => {
      cycles += 1
      return (async function* () {
        yield 1
      })()
    },
    onEvent: () => {},
    onTrace: () => {},
  })

  expect(cycles).toBe(0)
})
