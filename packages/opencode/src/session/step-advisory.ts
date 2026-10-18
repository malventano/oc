/**
 * Step-budget advisories: one-time 60% and 80% notices before a request when
 * the agent has a finite `steps` cap. The hard MAX_STEPS_PROMPT at 100% is
 * unchanged (core/session/runner/max-steps.ts). Infinite caps are a no-op.
 */

export const ENV_DISABLE = "OC_DISABLE_STEP_ADVISORIES"
export const THRESHOLDS = [0.6, 0.8] as const

export type StepAdvisory = {
  threshold: number
  step: number
  maxSteps: number
  message: string
}

export function stepAdvisoriesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_DISABLE] !== "1"
}

function message(threshold: number, step: number, maxSteps: number): string {
  const percent = Math.round(threshold * 100)
  return `<system-reminder source="step-advisory">
Step budget advisory: ${step} of ${maxSteps} steps used (${percent}%). ${
    threshold < 0.8
      ? "Prioritize the remaining work; defer optional exploration."
      : "Begin wrapping up: finish the critical path and prepare a concise summary of completed work and remaining tasks."
  }
</system-reminder>`
}

/**
 * Pure decision: returns the first unfired threshold reached, or null.
 * `fired` is the caller-owned set of already emitted thresholds.
 */
export function stepAdvisory(
  step: number,
  maxSteps: number,
  fired: ReadonlySet<number> | readonly number[],
  env: NodeJS.ProcessEnv = process.env,
): StepAdvisory | null {
  if (!stepAdvisoriesEnabled(env)) return null
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return null
  if (step >= maxSteps) return null
  const has = (threshold: number) =>
    Array.isArray(fired) ? fired.includes(threshold) : (fired as ReadonlySet<number>).has(threshold)
  for (const threshold of THRESHOLDS) {
    if (step >= Math.ceil(maxSteps * threshold) && !has(threshold)) {
      return { threshold, step, maxSteps, message: message(threshold, step, maxSteps) }
    }
  }
  return null
}

export * as StepAdvisory from "./step-advisory"
