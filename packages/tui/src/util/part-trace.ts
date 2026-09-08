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
  },
}
