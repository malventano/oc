/**
 * Liveness watchdog (DEFAULT OFF - enabled only with OC_ENABLE_LIVENESS=1).
 *
 * Progress for a step is either a completed edit/write mutation or a NEW
 * distinct tool-result hash (reading the same bytes again is not progress).
 * After K consecutive no-progress steps (default 10) the watchdog returns one
 * advisory; if the following K-step window is also empty it returns a halt.
 *
 * The decision core is pure/testable; prompt.ts owns the thin wiring. When the
 * env switch is off the state is still fed and decisions are logged
 * (observe-only), but no steer and no halt are applied.
 */

import { hashResult } from "./action-guard"

export const ENV_ENABLE = "OC_ENABLE_LIVENESS"
export const DEFAULT_WINDOW = 10
export const MUTATION_TOOLS = new Set(["edit", "write"])

export type LivenessAction = "none" | "advisory" | "halt"

export const LIVENESS_ADVISORY = `<system-reminder source="liveness-watchdog">
No progress has been detected for a full observation window: no file mutation and no new tool result. If you are stuck, change approach or explain the blocker; repeating reads or listing the same state will not move the task forward.
</system-reminder>`

export interface State {
  recordMutation(): void
  recordResultHash(hash: string): void
  /** Called once per completed step; returns the action for the step boundary. */
  endStep(): LivenessAction
  readonly noProgressSteps: number
}

export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_ENABLE] === "1"
}

/** Pure decision on the accumulated no-progress run. */
export function decide(noProgress: number, advisoryFired: boolean, window: number): LivenessAction {
  if (window <= 0) return "none"
  if (!advisoryFired) return noProgress >= window ? "advisory" : "none"
  return noProgress >= window * 2 ? "halt" : "none"
}

class Watchdog implements State {
  #window: number
  #noProgress = 0
  #progress = false
  #advisoryFired = false
  #seen = new Set<string>()

  constructor(window: number) {
    this.#window = window
  }

  recordMutation(): void {
    this.#progress = true
  }

  recordResultHash(hash: string): void {
    if (this.#seen.has(hash)) return
    this.#seen.add(hash)
    this.#progress = true
  }

  endStep(): LivenessAction {
    if (this.#progress) {
      this.#noProgress = 0
      this.#advisoryFired = false
    } else {
      this.#noProgress++
    }
    this.#progress = false
    const action = decide(this.#noProgress, this.#advisoryFired, this.#window)
    if (action === "advisory") this.#advisoryFired = true
    return action
  }

  get noProgressSteps(): number {
    return this.#noProgress
  }
}

export function make(window = DEFAULT_WINDOW): State {
  return new Watchdog(window)
}

/** Convenience for the processor: feed one completed tool result. */
export function observeResult(state: State, tool: string, output: string): void {
  if (MUTATION_TOOLS.has(tool)) state.recordMutation()
  else state.recordResultHash(hashResult(output))
}

export * as Liveness from "./liveness"
