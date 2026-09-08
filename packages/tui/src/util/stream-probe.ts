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
  ;(globalThis as any).__ocStreamHlEvents = []
  ;(globalThis as any).__ocStreamHtEvents = []
  ;(globalThis as any).__ocStreamPaintEvents = []
  ;(globalThis as any).__ocStreamWriteEvents = []
  ;(globalThis as any).__ocStreamApplyEv = []

  const LOG = "/tmp/oc-stream-probe.log"
  let deltas = 0
  let deltaChars = 0
  let deltaNewlines = 0
  let hlCount = 0
  let hlMsSum = 0
  let hlMsMax = 0
  let hlLenSum = 0
  let hlLenMax = 0
  let hlInc = 0
  let hlSkip = 0
  let lagN = 0
  let lagSum = 0
  let lagMax = 0
  let lagBehind = 0
  let lagHlSum = 0
  let lagCurSum = 0
  let lagBufSum = 0
  const covByFile: Record<string, { n: number; endSum: number; lenSum: number; cntSum: number }> = {}
  let htN = 0
  let htC = 0
  let htVr = 0
  let htRaw = 0
  let htMaxGap = 0
  let ptN = 0
  let ptVlc = 0
  let ptColored = 0
  const ptByFile: Record<string, { n: number; vlc: number; colored: number }> = {}
  let apN = 0
  let apVlc = 0
  let apColored = 0
  let wrDef = 0
  let wrText = 0
  let wrStyled = 0
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
    const hlEvents = (globalThis as any).__ocStreamHlEvents as { hl: number; cur: number; buf: number; filetype?: string; hlEnd?: number; hlCount?: number }[] | undefined
    if (hlEvents && hlEvents.length) {
      for (const ev of hlEvents) {
        const behind = ev.cur - ev.hl
        lagN++
        lagSum += behind
        if (behind > lagMax) lagMax = behind
        if (behind > 0) lagBehind++
        lagHlSum += ev.hl
        lagCurSum += ev.cur
        if (ev.buf >= 0) lagBufSum += ev.buf
        if (ev.filetype !== undefined) {
          const ft = ev.filetype
          const c = covByFile[ft] ?? (covByFile[ft] = { n: 0, endSum: 0, lenSum: 0, cntSum: 0 })
          c.n++
          c.endSum += ev.hlEnd ?? 0
          c.lenSum += ev.hl
          c.cntSum += ev.hlCount ?? 0
        }
      }
      hlEvents.length = 0
    }
    const covRaw = (globalThis as any).__ocCovRaw as { t: number; len: number; qs: number; qe: number; cachedN: number; cachedEnd: number; freshN: number; freshEnd: number; mergedEnd: number }[] | undefined
    if (covRaw && covRaw.length) {
      try {
        const lines = covRaw.map((c) => JSON.stringify({ ...c, t: new Date().toISOString() })).join("\n") + "\n"
        appendFileSync("/tmp/oc-cov-raw.log", lines)
      } catch {}
      covRaw.length = 0
    }
    const htEvents = (globalThis as any).__ocStreamHtEvents as { c: number; vr: number; rawLines: number; w?: number; rows?: number; bl?: number; painted?: number }[] | undefined
    if (htEvents && htEvents.length) {
      try {
        const lines = htEvents.map((ev) => JSON.stringify({ t: new Date().toISOString(), c: ev.c, vr: ev.vr, rawLines: ev.rawLines, w: ev.w, rows: ev.rows, bl: ev.bl, painted: ev.painted })).join("\n") + "\n"
        appendFileSync("/tmp/oc-ht-raw.log", lines)
      } catch {}
      for (const ev of htEvents) {
        htN++
        htC += ev.c
        htVr += ev.vr
        htRaw += ev.rawLines
        const gap = ev.rawLines - ev.vr
        if (gap > htMaxGap) htMaxGap = gap
      }
      htEvents.length = 0
    }
    const ptEvents = (globalThis as any).__ocStreamPaintEvents as { vlc: number; colored: number }[] | undefined
    if (ptEvents && ptEvents.length) {
      for (const ev of ptEvents) {
        ptN++
        ptVlc += ev.vlc
        ptColored += ev.colored
        const f = (ev as any).filetype ?? "none"
        const b = ptByFile[f] ?? (ptByFile[f] = { n: 0, vlc: 0, colored: 0 })
        b.n++
        b.vlc += ev.vlc
        b.colored += ev.colored
      }
      ptEvents.length = 0
    }
    const apEvents = (globalThis as any).__ocStreamApplyEv as { vlc: number; colored: number }[] | undefined
    if (apEvents && apEvents.length) {
      for (const ev of apEvents) {
        apN++
        apVlc += ev.vlc
        apColored += ev.colored
      }
      apEvents.length = 0
    }
    const wrEvents = (globalThis as any).__ocStreamWriteEvents as { kind: string }[] | undefined
    if (wrEvents && wrEvents.length) {
      for (const ev of wrEvents) {
        if (ev.kind === "defer") wrDef++
        else if (ev.kind === "settext") wrText++
        else if (ev.kind === "styled-init") wrStyled++
      }
      wrEvents.length = 0
    }
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
        newlines: deltaNewlines,
      },
      hi: {
        n: hlCount,
        workerAvg: hlCount ? +(hlMsSum / hlCount).toFixed(2) : 0,
        workerMax: Math.round(hlMsMax),
        lenAvg: hlCount ? Math.round(hlLenSum / hlCount) : 0,
        lenMax: hlLenMax,
        inc: hlInc,
        skip: hlSkip,
        write: { defer: wrDef, settext: wrText, styledInit: wrStyled },
        cov: Object.fromEntries(
          Object.entries(covByFile).map(([k, v]) => [k, { n: v.n, pct: v.lenSum ? Math.round((v.endSum / v.lenSum) * 100) : 0, avgCount: v.n ? +(v.cntSum / v.n).toFixed(0) : 0 }]),
        ),
      apply: apN
        ? { n: apN, rows: +(apVlc / apN).toFixed(2), colored: +(apColored / apN).toFixed(2), pct: apVlc ? Math.round((apColored / apVlc) * 100) : 0 }
        : { n: 0, rows: 0, colored: 0, pct: 0 },
      paint: ptN
        ? { n: ptN, avgRows: +(ptVlc / ptN).toFixed(2), avgColored: +(ptColored / ptN).toFixed(2), pct: ptVlc ? Math.round((ptColored / ptVlc) * 100) : 0 }
        : { n: 0, avgRows: 0, avgColored: 0, pct: 0 },
      paintByFile: Object.fromEntries(
        Object.entries(ptByFile).map(([k, v]) => [k, { n: v.n, pct: v.vlc ? Math.round((v.colored / v.vlc) * 100) : 0 }]),
      ),
      ht: htN
        ? { n: htN, avgC: +(htC / htN).toFixed(2), avgVr: +(htVr / htN).toFixed(2), avgRaw: +(htRaw / htN).toFixed(2), maxGap: Math.round(htMaxGap) }
        : { n: 0, avgC: 0, avgVr: 0, avgRaw: 0, maxGap: 0 },
      lag: lagN
          ? {
              n: lagN,
              avgBehind: +(lagSum / lagN).toFixed(2),
              maxBehind: Math.round(lagMax),
              behind: lagBehind,
              avgHl: Math.round(lagHlSum / lagN),
              avgCur: Math.round(lagCurSum / lagN),
              avgBuf: lagBufSum > 0 ? Math.round(lagBufSum / lagN) : -1,
            }
          : { n: 0, avgBehind: 0, maxBehind: 0, behind: 0, avgHl: 0, avgCur: 0, avgBuf: -1 },
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
    deltaNewlines = 0
    hlCount = 0
    hlMsSum = 0
    hlMsMax = 0
    hlLenSum = 0
    hlLenMax = 0
    hlInc = 0
    hlSkip = 0
    lagN = 0
    lagSum = 0
    lagMax = 0
    lagBehind = 0
    lagHlSum = 0
    lagCurSum = 0
    lagBufSum = 0
    htN = 0
    htC = 0
    htVr = 0
    htRaw = 0
    htMaxGap = 0
    ptN = 0
    ptVlc = 0
    ptColored = 0
    apN = 0
    apVlc = 0
    apColored = 0
    for (const k of Object.keys(ptByFile)) delete ptByFile[k]
    for (const k of Object.keys(covByFile)) delete covByFile[k]
    wrDef = 0
    wrText = 0
    wrStyled = 0
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
