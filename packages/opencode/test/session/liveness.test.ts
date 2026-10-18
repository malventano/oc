import { describe, expect, test } from "bun:test"
import { Liveness } from "@/session/liveness"

describe("liveness watchdog", () => {
  test("is disabled by default and enabled only by OC_ENABLE_LIVENESS=1", () => {
    expect(Liveness.enabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(Liveness.enabled({ OC_ENABLE_LIVENESS: "1" } as NodeJS.ProcessEnv)).toBe(true)
  })

  test("no-progress window steers, then the next window halts", () => {
    const watchdog = Liveness.make(3)
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("advisory")
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("halt")
  })

  test("an edit/write mutation resets the window", () => {
    const watchdog = Liveness.make(3)
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("none")
    watchdog.recordMutation()
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.noProgressSteps).toBe(0)
    expect(watchdog.endStep()).toBe("none")
  })

  test("a new distinct tool-result hash is progress; a repeated one is not", () => {
    const watchdog = Liveness.make(2)
    watchdog.recordResultHash("hash-a")
    expect(watchdog.endStep()).toBe("none")
    watchdog.recordResultHash("hash-a")
    expect(watchdog.endStep()).toBe("none")
    watchdog.recordResultHash("hash-a")
    expect(watchdog.endStep()).toBe("advisory")
  })

  test("no-progress run restarts after progress", () => {
    const watchdog = Liveness.make(2)
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.endStep()).toBe("advisory")
    watchdog.recordMutation()
    expect(watchdog.endStep()).toBe("none")
    expect(watchdog.noProgressSteps).toBe(0)
  })
})
