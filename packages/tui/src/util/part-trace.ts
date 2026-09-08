// Always-on anomaly trace for the sync part stream (NO env gate - shipping
// build). Records the two mechanisms that make the TUI's part.text diverge
// from the server's accumulated (DB) text:
//   1. a part.delta that could not be applied (silently dropped at the
//      sync message.part.delta handler) - the display permanently misses that
//      text, and
//   2. a message.part.updated reconcile whose incoming text is SHORTER than
//      what the UI has accumulated - the display regresses.
// Disk writes happen ONLY on anomalies (drops/regressions) plus one
// per-completed-message summary, so the streaming hot path stays cheap (one
// Map assignment per applied text delta). NEVER stderr (plugin-stderr leak
// rule) - append to a file like stream-probe does.
import { appendFileSync } from "node:fs"

const LOG = "/tmp/oc-part-trace.log"

type Key = string // `${messageID}:${partID}`

// UI-accumulated length per part, driven by applied text deltas. Memory only.
const lens = new Map<Key, number>()

function key(messageID: string, partID: string): Key {
  return `${messageID}:${partID}`
}

function write(line: Record<string, unknown>) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n")
  } catch {}
}

export const partTrace = {
  // Every applied text delta: update the accumulated length (hot path).
  onDeltaApplied(info: { messageID: string; partID: string; field: string; deltaLen: number }) {
    if (info.field !== "text") return
    const k = key(info.messageID, info.partID)
    lens.set(k, (lens.get(k) ?? 0) + info.deltaLen)
  },

  // A delta could not be applied - text is permanently lost for the display.
  onDeltaDropped(info: {
    messageID: string
    partID: string
    field: string
    deltaLen: number
    site: "no-parts" | "part-not-found"
  }) {
    const k = key(info.messageID, info.partID)
    write({
      kind: "delta-drop",
      site: info.site,
      messageID: info.messageID,
      partID: info.partID,
      field: info.field,
      deltaLen: info.deltaLen,
      accumulatedLen: lens.get(k) ?? null,
    })
  },

  // A full part.updated reconcile whose incoming text is SHORTER than the
  // accumulated text: the display regresses (and late deltas onto the shrunken
  // part continue from the shorter base).
  onReconcileShrink(info: { messageID: string; partID: string; prevLen: number; nextLen: number; nextText: string }) {
    const k = key(info.messageID, info.partID)
    write({
      kind: "reconcile-shrink",
      messageID: info.messageID,
      partID: info.partID,
      prevLen: info.prevLen,
      nextLen: info.nextLen,
      nextHead: info.nextText.slice(0, 160),
      accumulatedLen: lens.get(k) ?? null,
    })
  },

  // The assistant message completed: dump the UI-accumulated per-part lengths
  // so the user/DB side can diff them against the persisted part lengths (the
  // correlation between "UI short" and "DB full").
  onMessageDone(info: { messageID: string; parts: Array<{ partID: string; len: number }> }) {
    write({ kind: "message-done", messageID: info.messageID, parts: info.parts })
    const prefix = info.messageID + ":"
    for (const k of lens.keys()) {
      if (k.startsWith(prefix)) lens.delete(k)
    }
    // 0322i: reset the global highlight trackers per message - they were
    // maxima that never reset, so a big healthy message poisoned the rows for
    // the next (broken) one (all smaller cl values filtered out of the
    // drop-ahead/pulse logs). Per-message reset gives clean capture.
    resetApplyTrackers()
  },

  // 0322c: reasoning block height/measure stall - the box renders ~1 line
  // while the content is large (the 0314-family wrap/height bug). Live-caught
  // 2026-09-08: message-done lens == DB for all parts (text is FULL) while the
  // display truncated - so this is a render-side height/wrap stall, not text
  // loss. Log once per part (avoid per-delta spam), including the measured
  // widths so a stale wrap width is visible.
  onReasoningHeightStall(info: { partID: string; len: number; bufLen?: number; lineCount: number; virtual: number; width: number }) {
    if (reasoningStallLogged.has(info.partID)) return
    reasoningStallLogged.add(info.partID)
    write({ kind: "reasoning-height-stall", ...info })
  },

  // 0322f: buffer length at the exact moment the reasoning completes - the
  // decisive check for "applied full (sl==cl per code-apply-short) but the
  // painted buffer is short". bufLen << len at DONE = a late short re-set of
  // the buffer after the full styled text was applied; bufLen ~= len at DONE
  // = the truncation is a transient/paint-only artifact.
  onReasoningDone(info: { partID: string; len: number; bufLen: number; lineCount: number; virtual: number; width: number }) {
    if (reasoningDoneLogged.has(info.partID)) return
    reasoningDoneLogged.add(info.partID)
    write({ kind: "reasoning-done", ...info })
  },
}

// Per-part de-dupe for the height-stall anomaly (fires on every delta while
// stalled - log the first occurrence only).
const reasoningStallLogged = new Set<string>()
const reasoningDoneLogged = new Set<string>()

// 0322e: flush loop for the core bundle's always-on apply-site events
// (globalThis.__ocPartApplyEvents - pushed at the Code setStyledText apply).
// sl < cl = the applied styled text LOST content (stale/missing chunks) - the
// live symptom for the reasoning/answer mid-line cuts. Log every anomaly +
// a 10s beat while applies are happening (liveness), never stderr.
let applyFlushStarted = false
let applyBeat = 0
let shortBeat = 0
let maxLanded = 0
let pulseStart = 0
let pulseEnd = 0
let prevPulseStart = 0
let prevPulseEnd = 0
function resetApplyTrackers() {
  maxLanded = 0
  pulseStart = 0
  pulseEnd = 0
  prevPulseStart = 0
  prevPulseEnd = 0
}

function startApplyFlush() {
  if (applyFlushStarted) return
  applyFlushStarted = true
  setInterval(() => {
    const evs = (globalThis as { __ocPartApplyEvents?: Array<{ cl: number; sl: number; cc: string }> }).__ocPartApplyEvents
    if (!evs || evs.length === 0) return
    let n = 0
    let short = 0
    for (const ev of evs) {
      n++
      // 0322h: highlight request/response pulse - hl-start (issued) vs
      // hl-end (worker responded). If startCl keeps advancing past endCl, the
      // worker stopped responding (hang) - the cumulative-parser-state theory.
      if ((ev as { kind?: string }).kind === "hl-start") {
        if (ev.cl > pulseStart) pulseStart = ev.cl
        continue
      }
      if ((ev as { kind?: string }).kind === "hl-end") {
        if (ev.cl > pulseEnd) pulseEnd = ev.cl
        continue
      }
      // 0322g: drop events (the snapshotId guard superseded a highlight
      // result). If the dropped content is beyond the largest landed apply,
      // the final full-content highlight never landed - the mid-stream
      // snapshot stays on screen (the 'reasoning-done' bufLen << len case).
      if ((ev as { kind?: string }).kind === "drop") {
        if (ev.cl > maxLanded) {
          write({ kind: "code-apply-drop-ahead", cl: ev.cl, maxLanded })
        }
        continue
      }
      if (ev.sl < ev.cl) {
        short++
        write({ kind: "code-apply-short", cl: ev.cl, sl: ev.sl, head: ev.cc })
      }
      if (ev.cl > maxLanded) maxLanded = ev.cl
    }
    evs.length = 0
    if (pulseStart !== prevPulseStart || pulseEnd !== prevPulseEnd) {
      write({ kind: "hl-pulse", startCl: pulseStart, endCl: pulseEnd })
      prevPulseStart = pulseStart
      prevPulseEnd = pulseEnd
    }
    applyBeat += n
    shortBeat += short
  }, 100)
  setInterval(() => {
    if (applyBeat === 0 && shortBeat === 0) return
    write({ kind: "code-apply-beat", applies: applyBeat, short: shortBeat })
    applyBeat = 0
    shortBeat = 0
  }, 10000)
}
startApplyFlush()
