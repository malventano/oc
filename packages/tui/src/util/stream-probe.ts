// Research-only streaming probe (STREAM_RENDER_OPTIMIZATION_AUDIT baseline).
// Gated by OC_STREAM_PROBE=1 - everything is a few counters + one 100ms JSONL
// line to /tmp/oc-stream-probe.log (NEVER stderr - the plugin-stderr leak rule).
// No timing fences in the hot path beyond the already-present samples; removed
// after the optimization pass.
import { appendFileSync } from "node:fs"

 export type StreamProbe = {
  onDelta(): void
  onDeltaChars(n: number): void
  onHighlight(filetype: string, contentLength: number, workerMs: number, incremental: boolean, timings?: { parse?: number; query?: number; inject?: number; merge?: number; total?: number; count?: number }): void
  onHighlightSkip(): void
  onFrame(renderMs: number): void
  onReasoning(d: { len: number; lineCount: number; virtual: number }): void
  onFn(kind: string, ms: number): void
  onApply(ms: number): void
  stop(): void
}

 let INSTANCE: StreamProbe | undefined
const NOOP: StreamProbe = { onDelta() {}, onDeltaChars() {}, onHighlight() {}, onHighlightSkip() {}, onFrame() {}, onReasoning() {}, onFn() {}, onApply() {}, stop() {} }

// Singleton: whoever first calls initStreamProbe wins the env getters; later
// callers (app.tsx) just read the instance via getStreamProbe(). No-op when
// OC_STREAM_PROBE is not "1".
export function initStreamProbe(env?: {
  getWindow: () => number
  getFlush: () => number
  getHighlight: () => number
}): StreamProbe {
   if (INSTANCE) return INSTANCE
  // Gated: only active with OC_STREAM_PROBE=1 (no-op otherwise - the clean
  // shipping builds). See docs/STREAM_RENDER_OPTIMIZATION_AUDIT.md section 10
  // for the telemetry inventory.
  const enabled = process.env.OC_STREAM_PROBE === "1"
  if (!enabled) {
    INSTANCE = NOOP
    return NOOP
  }
  const e = env!

  const LOG = "/tmp/oc-stream-probe.log"
  let deltas = 0
  let deltaChars = 0
  let hlCount = 0
  let hlMsSum = 0
  let hlMsMax = 0
  let hlLenSum = 0
  let hlLenMax = 0
  let hlInc = 0
  let hlSkip = 0
  const tlSum: Record<string, number> = { parse: 0, query: 0, inject: 0, merge: 0, total: 0, count: 0 }
  let frameCount = 0
  let frameMsSum = 0
  let frameMsMax = 0
  let rsSamples = 0
  let rsLen = 0
  let rsLine = 0
  let rsVirtual = 0
  let rsLineMin = 0
  let rsLineMax = 0
  let rsVirtMax = 0
  let rsDiffMax = 0
  const fnMs: Record<string, { n: number; sum: number; max: number }> = {}
  let apMsSum = 0
  let apMsMax = 0
  let apMsN = 0
   let prev = 0
  // Landed applies vs superseded calls, from the core bundle's
  // __ocStreamApplyStats (probe-only instrumentation in startHighlight).
  const applyStats = { calls: 0, applied: 0, superseded: 0, bytes: 0, lastLen: 0 }
  let prevApplyCalls = 0
  let prevApplied = 0
  let prevSuperseded = 0
  let prevBytes = 0
  let prevLastLen = 0

  const id = setInterval(() => {
    const now = performance.now()
    const dt = prev === 0 ? 0 : Math.round(now - prev)
    prev = now
    // Read the core counters (if the instrumentation is present).
    const core = (globalThis as any).__ocStreamApplyStats
    if (core) {
      applyStats.calls = core.calls ?? 0
      applyStats.applied = core.applied ?? 0
      applyStats.superseded = core.superseded ?? 0
      applyStats.bytes = core.bytes ?? 0
      applyStats.lastLen = core.lastContentLen ?? 0
    }
    const dCalls = applyStats.calls - prevApplyCalls
    const dApplied = applyStats.applied - prevApplied
    const dSup = applyStats.superseded - prevSuperseded
    const dBytes = applyStats.bytes - prevBytes
    const dLastLen = applyStats.lastLen - prevLastLen
    prevApplyCalls = applyStats.calls
    prevApplied = applyStats.applied
    prevSuperseded = applyStats.superseded
    prevBytes = applyStats.bytes
    prevLastLen = applyStats.lastLen
    const line = {
      t: new Date().toISOString(),
      dtMs: dt,
      windowMs: Math.round(e.getWindow()),
      flushMs: Math.round(e.getFlush()),
      highlightMs: Math.round(e.getHighlight()),
      deltas,
      dch: {
        perDelta: deltas ? +(deltaChars / deltas).toFixed(1) : 0,
        chars: deltaChars,
      },
      hi: {
        n: hlCount,
        workerAvg: hlCount ? +(hlMsSum / hlCount).toFixed(2) : 0,
        workerMax: Math.round(hlMsMax),
        lenAvg: hlCount ? Math.round(hlLenSum / hlCount) : 0,
        lenMax: hlLenMax,
        inc: hlInc,
        skip: hlSkip,
        t: hlCount
          ? {
              parse: +(tlSum.parse / hlCount).toFixed(2),
              query: +(tlSum.query / hlCount).toFixed(2),
              inject: +(tlSum.inject / hlCount).toFixed(2),
              merge: +(tlSum.merge / hlCount).toFixed(2),
              total: +(tlSum.total / hlCount).toFixed(2),
              count: Math.round(tlSum.count / hlCount),
            }
          : { parse: 0, query: 0, inject: 0, merge: 0, total: 0, count: 0 },
      },
      apply: {
        calls: dCalls,
        applied: dApplied,
        superseded: dSup,
        bytesPerApply: dApplied ? Math.round(dBytes / dApplied) : 0,
        incPerApply: dApplied ? Math.round(dLastLen / dApplied) : 0,
        lastLen: applyStats.lastLen,
      },
      reason: {
        n: rsSamples,
        lenA: rsLen,
        lineCount: rsLine,
        lineMin: rsLineMin,
        lineMax: rsLineMax,
        virtual: rsVirtual,
        virtMax: rsVirtMax,
        diffMax: rsDiffMax,
      },
      fn: Object.fromEntries(
        Object.entries(fnMs).map(([k, v]) => [k, { n: v.n, avg: +(v.sum / v.n).toFixed(3), max: +v.max.toFixed(3) }]),
      ),
      applyMs: { n: apMsN, avg: apMsN ? +(apMsSum / apMsN).toFixed(3) : 0, max: +apMsMax.toFixed(3) },
      frame: {
        n: frameCount,
        avg: frameCount ? +(frameMsSum / frameCount).toFixed(2) : 0,
        max: Math.round(frameMsMax),
      },
    }
    try {
      appendFileSync(LOG, JSON.stringify(line) + "\n")
    } catch {}
    deltas = 0
    deltaChars = 0
    hlCount = 0
    hlMsSum = 0
    hlMsMax = 0
    hlLenSum = 0
    hlLenMax = 0
    hlInc = 0
    hlSkip = 0
    tlSum.parse = 0
    tlSum.query = 0
    tlSum.inject = 0
    tlSum.merge = 0
    tlSum.total = 0
    tlSum.count = 0
    frameCount = 0
    frameMsSum = 0
    frameMsMax = 0
    rsSamples = 0
    rsLen = 0
    rsLine = 0
    rsVirtual = 0
    rsLineMin = 0
    rsLineMax = 0
    rsVirtMax = 0
    rsDiffMax = 0
    for (const k of Object.keys(fnMs)) fnMs[k] = { n: 0, sum: 0, max: 0 }
    apMsSum = 0
    apMsMax = 0
    apMsN = 0
  }, 100)

   INSTANCE = {
    onDelta() {
      deltas++
    },
    onDeltaChars(n: number) {
      deltaChars += n
    },
    onHighlightSkip() {
      hlSkip++
    },
    onHighlight(_filetype: string, contentLength: number, workerMs: number, incremental: boolean, timings?: { parse?: number; query?: number; inject?: number; merge?: number; total?: number; count?: number }) {
      hlCount++
      hlMsSum += workerMs
      if (workerMs > hlMsMax) hlMsMax = workerMs
      hlLenSum += contentLength
      if (contentLength > hlLenMax) hlLenMax = contentLength
      if (incremental) hlInc++
      if (timings) {
        tlSum.parse += timings.parse ?? 0
        tlSum.query += timings.query ?? 0
        tlSum.inject += timings.inject ?? 0
        tlSum.merge += timings.merge ?? 0
        tlSum.total += timings.total ?? 0
        tlSum.count += timings.count ?? 0
      }
    },
    onFrame(renderMs: number) {
      frameCount++
      frameMsSum += renderMs
      if (renderMs > frameMsMax) frameMsMax = renderMs
    },
    onReasoning(d: { len: number; lineCount: number; virtual: number }) {
      rsSamples++
      rsLen = d.len
      rsLine = d.lineCount
      rsVirtual = d.virtual
      if (rsSamples === 1) { rsLineMin = d.lineCount; rsLineMax = d.lineCount }
      if (d.lineCount < rsLineMin) rsLineMin = d.lineCount
      if (d.lineCount > rsLineMax) rsLineMax = d.lineCount
      if (d.virtual > rsVirtMax) rsVirtMax = d.virtual
      const diff = d.virtual - d.lineCount
      if (diff > rsDiffMax) rsDiffMax = diff
    },
    onFn(kind: string, ms: number) {
      const f = fnMs[kind] ?? (fnMs[kind] = { n: 0, sum: 0, max: 0 })
      f.n++
      f.sum += ms
      if (ms > f.max) f.max = ms
    },
    onApply(ms: number) {
      apMsN++
      apMsSum += ms
      if (ms > apMsMax) apMsMax = ms
    },
    stop() {
      clearInterval(id)
    },
  }
  return INSTANCE
}

export function getStreamProbe(): StreamProbe {
  return INSTANCE ?? NOOP
}
