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
export const STREAM_BATCH_MAX_MS = 256
const [streamBatchWindow, setStreamBatchWindowRaw] = createSignal(STREAM_BATCH_MIN_MS)
export function setStreamBatchWindow(ms: number) {
  setStreamBatchWindowRaw(Math.max(STREAM_BATCH_MIN_MS, Math.min(STREAM_BATCH_MAX_MS, ms)))
}
export function getStreamBatchWindow() {
  return streamBatchWindow()
}

// Reasoning highlight load hint (ms). Reasoning renders via <code> CodeRenderable +
// tree-sitter on a worker thread; the worker re-highlights the growing body per delta,
// so fast streaming can overwhelm it (visible lag / highlight toggle). The ReasoningPart
// sets this proportional to body size while streaming; the adaptive controller folds it
// into its widen decision (treats it like extra render load) so the SDK flush window
// widens and streaming slows enough for the highlight worker to keep up.
let streamLoadHintMs = 0
export function setStreamLoadHintMs(ms: number) {
  streamLoadHintMs = Math.max(0, Math.min(STREAM_BATCH_MAX_MS, ms))
}
export function getStreamLoadHintMs() {
  return streamLoadHintMs
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
