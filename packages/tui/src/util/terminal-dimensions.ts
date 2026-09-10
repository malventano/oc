import { createSignal, type Accessor } from "solid-js"
import type { CliRenderer } from "@opentui/core"

// ONE renderer "resize" subscription for the whole TUI, instead of one per
// component/hook. A terminal resize affects the ENTIRE screen - every
// height/re-measure consumer (the oc StreamSegment system mounts up to
// MAX_SLOTS=24 bash segments per tool call, the diff re-wrap hooks, the
// dual/single diff choice) only needs the same width signal. Per-call
// subscriptions multiplied renderer listeners with no benefit and tripped
// Node's default maxListeners=10 (false MaxListenersExceededWarning).
// Initialized once in Tui.run (before the tree mounts), disposed on destroy.
let dims: Accessor<{ width: number; height: number }> | undefined
let dispose: (() => void) | undefined

export function initTerminalDimensions(renderer: CliRenderer) {
  const [d, setD] = createSignal({ width: renderer.width, height: renderer.height })
  dims = d
  const onResize = (width: number, height: number) => setD({ width, height })
  renderer.on("resize", onResize)
  dispose = () => {
    renderer.off("resize", onResize)
    dims = undefined
    dispose = undefined
  }
}

export function disposeTerminalDimensions() {
  dispose?.()
}

// Reads the shared dimensions. Replaces per-component useTerminalDimensions
// for the oc height/re-measure hooks (the per-object multipliers).
export function useTuiDimensions(): Accessor<{ width: number; height: number }> {
  if (!dims) throw new Error("Tui dimensions not initialized (Tui.run)")
  return dims
}
