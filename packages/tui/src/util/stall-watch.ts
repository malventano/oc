// 0326: main-thread stall/freeze watchdog (always-on, file-only).
//
// The freeze is an infinite/synchronous loop - the event loop (and this
// interval) stop, so a gap-only logger sees NOTHING at the freeze. This version
// keeps a ROLLING last-state, records on ANY tick gap >= GAP_WARN_MS (60ms -
// the stutter), and writes a HEARTBEAT ~1s so the state (and the __ocHot
// marker = the function that was entered last - the loop's home) is always
// within ~1s of the freeze. On the freeze the LAST heartbeat + the gap record
// show: gapMs (the freeze, huge on recovery), hot (the culprit fn), the window/
// flush/delta/hl state, and the pending render (cull) state.
//
// File: /tmp/oc-stall-watch.log (never stderr).
import { appendFileSync } from "node:fs"

const LOG = "/tmp/oc-stall-watch.log"
const TICK_MS = 50
const GAP_WARN_MS = 60 // a tick that took >60ms = a perceptible stutter/freeze
const HEARTBEAT_MS = 1000

let lastTick = performance.now()
let lastHeartbeat = 0
let lastState: Record<string, unknown> = {}
let frozenSince = 0

export function initStallWatch(snapshot: () => Record<string, unknown>) {
  setInterval(() => {
    const now = performance.now()
    const gap = now - lastTick
    lastTick = now
    try {
      const state = snapshot()
      // Recovery from a hard freeze (the interval starved then ran again).
      if (frozenSince > 0 && gap < TICK_MS * 2) {
        appendFileSync(LOG, JSON.stringify({ t: now, kind: "recovered", gapMs: Math.round(gap), frozenMs: Math.round(now - frozenSince), prev: lastState, ...state }) + "\n")
        frozenSince = 0
      } else if (gap > GAP_WARN_MS) {
        if (gap > 400 && frozenSince === 0) frozenSince = now
        appendFileSync(LOG, JSON.stringify({ t: now, kind: frozenSince > 0 ? "freeze" : "tick-gap", gapMs: Math.round(gap), prev: lastState, ...state }) + "\n")
      }
      if (now - lastHeartbeat >= HEARTBEAT_MS && gap < GAP_WARN_MS) {
        lastHeartbeat = now
        appendFileSync(LOG, JSON.stringify({ t: now, kind: "hb", ...state }) + "\n")
      }
      lastState = state
    } catch {}
  }, TICK_MS)
}
