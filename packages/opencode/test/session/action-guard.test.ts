import { describe, expect, test } from "bun:test"
import { ActionGuard } from "@/session/action-guard"

const env = {} as NodeJS.ProcessEnv

describe("ActionGuard consecutive action repeats", () => {
  test("fires at 3 and 5 consecutive identical calls", () => {
    const guard = ActionGuard.make(env)
    expect(guard.recordCall("read", { filePath: "/tmp/a" })).toBeNull()
    expect(guard.recordCall("read", { filePath: "/tmp/a" })).toBeNull()
    expect(guard.recordCall("read", { filePath: "/tmp/a" })?.count).toBe(3)
    expect(guard.recordCall("read", { filePath: "/tmp/a" })).toBeNull()
    expect(guard.recordCall("read", { filePath: "/tmp/a" })?.count).toBe(5)
    expect(guard.takeAdvisory()).toContain("5 consecutive times")
  })

  test("different targets do not fire (legitimate same-script runs)", () => {
    const guard = ActionGuard.make(env)
    for (const filePath of ["/tmp/a", "/tmp/a", "/tmp/b", "/tmp/b", "/tmp/c", "/tmp/c"]) {
      expect(guard.recordCall("read", { filePath })).toBeNull()
    }
    expect(guard.takeAdvisory()).toBeNull()
  })

  test("pipe/redirection tails normalize to the same bash key", () => {
    expect(ActionGuard.keyFor("bash", { command: "cat /tmp/a | head -5" })).toBe(
      ActionGuard.keyFor("bash", { command: "cat /tmp/a" }),
    )
    expect(ActionGuard.keyFor("bash", { command: "cat /tmp/a 2>&1" })).toBe(
      ActionGuard.keyFor("bash", { command: "cat /tmp/a" }),
    )
    const guard = ActionGuard.make(env)
    expect(guard.recordCall("bash", { command: "cat /tmp/a | head -5" })).toBeNull()
    expect(guard.recordCall("bash", { command: "cat /tmp/a 2>&1" })).toBeNull()
    expect(guard.recordCall("bash", { command: "cat /tmp/a > /tmp/out" })?.count).toBe(3)
  })

  test("different bash targets stay distinct after normalization", () => {
    const guard = ActionGuard.make(env)
    expect(guard.recordCall("bash", { command: "cat /tmp/a | head" })).toBeNull()
    expect(guard.recordCall("bash", { command: "cat /tmp/b | head" })).toBeNull()
    expect(guard.recordCall("bash", { command: "cat /tmp/a | head" })).toBeNull()
    expect(guard.recordCall("bash", { command: "cat /tmp/b | head" })).toBeNull()
    expect(guard.takeAdvisory()).toBeNull()
  })

  test("poll and sleep-only calls are exempt", () => {
    const guard = ActionGuard.make(env)
    for (let i = 0; i < 5; i++) {
      expect(guard.recordCall("tmux", { op: "poll", paneId: "%1" })).toBeNull()
      expect(guard.recordCall("bash", { command: "sleep 120" })).toBeNull()
    }
    expect(guard.takeAdvisory()).toBeNull()
  })

  test("env kill switch disables the guard", () => {
    const guard = ActionGuard.make({ OC_DISABLE_ACTION_GUARD: "1" } as NodeJS.ProcessEnv)
    for (let i = 0; i < 5; i++) expect(guard.recordCall("read", { filePath: "/tmp/a" })).toBeNull()
    expect(guard.takeAdvisory()).toBeNull()
  })
})

describe("ActionGuard result-hash streak", () => {
  test("stubs byte-identical results >= 512 chars from the second repeat and advises at 3", () => {
    const guard = ActionGuard.make(env)
    const key = ActionGuard.keyFor("bash", { command: "cat /tmp/big" })
    const big = "x".repeat(600)
    expect(guard.recordResult("bash", big, key).stub).toBeNull()
    expect(guard.recordResult("bash", big, key).stub).toContain("identical result repeated")
    const third = guard.recordResult("bash", big, key)
    expect(third.stub).toContain("identical result repeated")
    expect(third.advisory?.count).toBe(3)
    expect(guard.takeAdvisory()).toContain("identical result")
  })

  test("read-repeat hint appends after 3 identical short read results", () => {
    const guard = ActionGuard.make(env)
    const key = ActionGuard.keyFor("read", { filePath: "/tmp/a" })
    expect(guard.recordResult("read", "short output", key).suffix).toBeNull()
    expect(guard.recordResult("read", "short output", key).suffix).toBeNull()
    expect(guard.recordResult("read", "short output", key).suffix).toContain("re-reading will not change it")
  })

  test("a changed result breaks the streak", () => {
    const guard = ActionGuard.make(env)
    const key = ActionGuard.keyFor("bash", { command: "cat /tmp/a" })
    const big = "x".repeat(600)
    expect(guard.recordResult("bash", big, key).stub).toBeNull()
    expect(guard.recordResult("bash", big.replace("x", "y"), key).stub).toBeNull()
    expect(guard.recordResult("bash", big, key).stub).toBeNull()
  })
})
