// Highlight dedupe for the shared TreeSitterClient (0400).
//
// highlightOnce is pure in (filetype, content) but its round trip is O(n) in
// content length and serialized on one worker - a render burst of identical
// requests issued inside one worker latency (a 15K markdown block parses in
// ~300-400ms) all miss a resolved-result cache and each queue a full parse.
// Measured live (streaming-stall trace, 2026-10-12): 29 x ~375ms parses of the
// same static reasoning block jammed into ~400ms, saturating the worker for
// ~11s of queued work, driving every subsequent highlight's round trip to
// ~434ms, which the adaptive batch-window controller reads as load and
// responds to by widening the flush window (">100ms for 7.5s") - the visible
// pane collapses to 1-2fps until the queue drains ("the extremely long stall",
// BUG_TUI_STREAM_STALL.md). Two dedupe layers close it:
//
// 1. IN-FLIGHT PROMISE SHARING: identical concurrent requests share one
//    pending promise - the burst costs one round trip regardless of size.
// 2. RESOLVED-RESULT LRU (pre-existing 0388 behavior): a call whose content
//    equals a recent resolved result for that filetype reuses it. Two slots
//    per filetype: surfaces with the SAME filetype but DIFFERENT stable
//    content (e.g. prompt echo + reasoning element) alternate, and a single
//    slot would thrash - two keeps both hot.
export type HighlightOnce = (content: string, filetype: string) => Promise<unknown>

export function wrapHighlightOnce(
  original: HighlightOnce,
  onSample: (now: number, durationMs: number) => void,
): HighlightOnce {
  const lastHighlights = new Map<string, { content: string; result: unknown }[]>()
  const inFlight = new Map<string, Promise<unknown>>()
  const record = (filetype: string, content: string, result: unknown) => {
    const list = lastHighlights.get(filetype)
    if (!list) {
      lastHighlights.set(filetype, [{ content, result }])
    } else {
      list.unshift({ content, result })
      if (list.length > 2) list.pop()
    }
  }
  return async (content: string, filetype: string) => {
    const list = lastHighlights.get(filetype)
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].content === content) {
          if (i > 0) {
            const [entry] = list.splice(i, 1)
            list.unshift(entry)
          }
          return list[0].result
        }
      }
    }
    const key = `${filetype}\u0000${content}`
    let pending = inFlight.get(key)
    if (!pending) {
      const start = performance.now()
      pending = original(content, filetype)
        .then((result) => {
          record(filetype, content, result)
          onSample(performance.now(), performance.now() - start)
          return result
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }
}
