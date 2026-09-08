// Always-on anomaly trace for sync part streaming + the code highlight apply
// path (NO env gate - shipping build). Records the mechanisms that make the
// TUI's rendered display diverge from the session DB:
//   1. delta-drop - a message.part.delta the sync handler could not apply
//      (silently dropped - the display permanently misses that text).
//   2. reconcile-shrink - a message.part.updated reconcile whose incoming
//      text is SHORTER than what the UI accumulated (display regression).
//   3. reasoning-height-stall / reasoning-done - the reasoning <code> box's
//      measured height vs the buffer/prop lengths (the 2026-09-08 truncation):
//      a rendered-buffer shortfall means the APPLIED styled text is an early
//      snapshot (bufLen << len).
//   4. code-apply-space - from the core's apply-site push (only when the
//      chunked styled text is materially shorter than the content - the small
//      constant title/conceal strip is ignored; a big deficit = lost content).
// Disk writes happen ONLY on anomalies + one per-completed-message summary, so
// the streaming hot path stays cheap (one Map assignment per applied text
// delta). NEVER stderr (plugin-stderr leak rule) - append to a file.
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
  // so they can be diffed against the persisted part lengths (the "UI short vs
  // DB full" divergence).
  onMessageDone(info: { messageID: string; parts: Array<{ partID: string; len: number }> }) {
    write({ kind: "message-done", messageID: info.messageID, parts: info.parts })
    const prefix = info.messageID + ":"
    for (const k of lens.keys()) {
      if (k.startsWith(prefix)) lens.delete(k)
    }
  },

  // 0322c/d/f: reasoning block measure anomaly - the box renders ~1 line while
  // the content is large, or the rendered-buffer length at completion is far
  // below the part text (bufLen << len). Log once per part (de-duped).
  onReasoningHeightStall(info: { partID: string; len: number; bufLen?: number; lineCount: number; virtual: number; width: number }) {
    if (reasoningStallLogged.has(info.partID)) return
    reasoningStallLogged.add(info.partID)
    write({ kind: "reasoning-height-stall", ...info })
  },

  onReasoningDone(info: { partID: string; len: number; bufLen: number; lineCount: number; virtual: number; width: number }) {
    if (reasoningDoneLogged.has(info.partID)) return
    reasoningDoneLogged.add(info.partID)
    write({ kind: "reasoning-done", ...info })
  },
}

const reasoningStallLogged = new Set<string>()
const reasoningDoneLogged = new Set<string>()

// Minimal drain for the core's always-on apply-site events
// (globalThis.__ocPartApplyEvents - the 0322e push at the Code setStyledText
// apply). Only a MATERIAL deficit is logged (the constant ~62-char markdown
// title strip is expected); everything else is discarded so the array stays
// bounded in the hot path.
const APPLY_DEFICIT_MIN = 1000
setInterval(() => {
  const evs = (globalThis as { __ocPartApplyEvents?: Array<{ cl: number; sl: number; cc?: string }> }).__ocPartApplyEvents
  if (!evs || evs.length === 0) return
  for (const ev of evs) {
    if (ev.cl > APPLY_DEFICIT_MIN && ev.sl < ev.cl - APPLY_DEFICIT_MIN) {
      write({ kind: "code-apply-short-big", cl: ev.cl, sl: ev.sl, head: ev.cc })
    }
  }
  evs.length = 0
}, 250)
