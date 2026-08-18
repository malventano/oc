import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

// Adaptive streaming batch window. Baseline 4ms (faster update cadence; hit the widen
// condition sooner on high-refresh displays); the renderer controller widens it
// when frames start exceeding the frame budget (approaching render lag) and narrows
// it back toward baseline once frames stay within budget. Batching more tokens per
// flush reduces render frequency, trading update smoothness for a responsive loop.
export const STREAM_BATCH_MIN_MS = 4
export const STREAM_BATCH_MAX_MS = 1024
const [streamBatchWindow, setStreamBatchWindowRaw] = createSignal(STREAM_BATCH_MIN_MS)
export function setStreamBatchWindow(ms: number) {
  setStreamBatchWindowRaw(Math.max(STREAM_BATCH_MIN_MS, Math.min(STREAM_BATCH_MAX_MS, ms)))
}
export function getStreamBatchWindow() {
  return streamBatchWindow()
}

// Widen slack: the controller widens when the measured load comes within this much of
// the flush window, so the window lands slightly ABOVE the worker's per-update time -
// the flush cadence must be at least the worker's processing time plus slack for the
// per-flush highlight to complete before the next flush supersedes it.
export const STREAM_WIDEN_MARGIN_MS = 2

// Measured tree-sitter highlight update time (ms): every colored renderable (reasoning,
// tool streams, diffs, markdown) highlights through the shared TreeSitterClient's
// highlightOnce - app.tsx wraps that call and samples its round-trip duration (worker
// parse+query + message latency) here. Tracked only while highlights arrive in a
// sustained burst (>= 3 within the freshness window) so a one-off render can't spike
// the window; reads 0 once the burst goes cold, so the window narrows back toward
// baseline after streaming settles. One source for every highlighted surface - no
// per-view size heuristics.
const STREAM_HIGHLIGHT_FRESH_MS = 2 * STREAM_BATCH_MAX_MS
const STREAM_HIGHLIGHT_MIN_BURST = 3
let lastHighlightAt = 0
let highlightDurations: number[] = []
export function onStreamHighlight(now: number, durationMs: number) {
  lastHighlightAt = now
  if (durationMs <= STREAM_HIGHLIGHT_FRESH_MS) {
    highlightDurations.push(durationMs)
    if (highlightDurations.length > STREAM_HIGHLIGHT_MIN_BURST) highlightDurations.shift()
  }
}
export function getStreamHighlightMs(now: number): number {
  if (now - lastHighlightAt > STREAM_HIGHLIGHT_FRESH_MS) return 0
  if (highlightDurations.length < STREAM_HIGHLIGHT_MIN_BURST) return 0
  return Math.min(STREAM_BATCH_MAX_MS, highlightDurations[highlightDurations.length - 1]!)
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within the batch window), batch this with
      // future events. Otherwise, process immediately to avoid latency.
      if (elapsed < streamBatchWindow()) {
        timer = setTimeout(flush, streamBatchWindow())
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})
