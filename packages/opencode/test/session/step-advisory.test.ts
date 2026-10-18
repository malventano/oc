import { describe, expect, test } from "bun:test"
import { StepAdvisory, stepAdvisory } from "@/session/step-advisory"

const env = {} as NodeJS.ProcessEnv

describe("step advisories", () => {
  test("fires once at 60% and once at 80%", () => {
    const fired = new Set<number>()
    expect(stepAdvisory(5, 10, fired, env)).toBeNull()
    const sixty = stepAdvisory(6, 10, fired, env)
    expect(sixty?.threshold).toBe(0.6)
    fired.add(sixty!.threshold)
    expect(stepAdvisory(7, 10, fired, env)).toBeNull()
    const eighty = stepAdvisory(8, 10, fired, env)
    expect(eighty?.threshold).toBe(0.8)
    fired.add(eighty!.threshold)
    expect(stepAdvisory(9, 10, fired, env)).toBeNull()
  })

  test("the 100% hard prompt is left to MAX_STEPS_PROMPT", () => {
    expect(stepAdvisory(10, 10, new Set<number>(), env)).toBeNull()
  })

  test("Infinity is a no-op", () => {
    expect(stepAdvisory(1000, Infinity, new Set<number>(), env)).toBeNull()
  })

  test("accepts an array of fired thresholds", () => {
    expect(stepAdvisory(6, 10, [], env)?.threshold).toBe(0.6)
    expect(stepAdvisory(8, 10, [0.6], env)?.threshold).toBe(0.8)
    expect(stepAdvisory(8, 10, [0.6, 0.8], env)).toBeNull()
  })

  test("env kill switch", () => {
    expect(StepAdvisory.stepAdvisoriesEnabled({ OC_DISABLE_STEP_ADVISORIES: "1" } as NodeJS.ProcessEnv)).toBe(false)
    expect(
      stepAdvisory(9, 10, new Set<number>(), { OC_DISABLE_STEP_ADVISORIES: "1" } as NodeJS.ProcessEnv),
    ).toBeNull()
  })
})
