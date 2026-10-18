import { describe, expect, test } from "bun:test"
import { subagentRunningTitle } from "../src/routes/session"

type State = Parameters<typeof subagentRunningTitle>[0]
const state = (value: unknown) => value as State

describe("subagent running line label", () => {
  test("running bash with no title uses the command", () => {
    expect(subagentRunningTitle(state({ status: "running", title: null, input: { command: "python3 ck2.py" } }))).toBe(
      "python3 ck2.py",
    )
  })

  test("completed tool keeps its title", () => {
    expect(
      subagentRunningTitle(state({ status: "completed", title: "tmp/opencode/ck2.py", input: { filePath: "/x" } })),
    ).toBe("tmp/opencode/ck2.py")
  })

  test("pending with no input shows only the tool name (no label)", () => {
    expect(subagentRunningTitle(state({ status: "pending", input: {} }))).toBeUndefined()
  })

  test("running edit falls back to the filePath", () => {
    expect(
      subagentRunningTitle(
        state({ status: "running", title: null, input: { filePath: "/root/x.ts", oldString: "a", newString: "b" } }),
      ),
    ).toBe("/root/x.ts")
  })
})
