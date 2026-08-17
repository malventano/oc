import { expect, test } from "bun:test"
import { computeTurn, estimateStepTokens, formatCount, settledReport, toolResultTokens, turnLiveTokens } from "../src/component/prompt/turn-stats"
import type { AssistantMessage, Part, ReasoningPart, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"

const assistant = (over: Partial<AssistantMessage>): AssistantMessage => ({
  id: over.id ?? "asst-" + Math.random().toString(36).slice(2),
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 1000 },
  parentID: "user-0",
  modelID: "dsv4",
  providerID: "opencode",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...over,
})

const user = (id: string, created = 1000): UserMessage => ({
  id,
  sessionID: "ses_test",
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "opencode", modelID: "dsv4" },
})

const toolPart = (id: string): ToolPart => ({
  id,
  sessionID: "ses_test",
  messageID: "asst-1",
  type: "tool",
  callID: id,
  tool: "bash",
  state: { status: "pending", input: {}, raw: "" },
})

test("computeTurn: returns the last turn even when idle (no in-flight step)", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0"),
    assistant({ parentID: "user-0", time: { created: 1000, completed: 2000 }, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } } }),
  ]
  const t = computeTurn(messages)
  expect(t.active).toBe(false)
  expect(t.steps.map((s) => s.id)).toHaveLength(1)
  expect(t.reasoning).toBe(10)
  expect(t.output).toBe(50)
  expect(t.start).toBe(1000)
  expect(t.parentID).toBe("user-0")
})

test("computeTurn: tool-execution gap keeps the turn's steps (no step in flight)", () => {
  // The tool-call step completed and the next step has not started yet - the
  // turn window must still resolve to this turn so counters keep their values
  // through tool execution (the live-vs-idle decision is the session status).
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-1", 3000),
    assistant({
      parentID: "user-1",
      id: "asst-2",
      time: { created: 4000, completed: 4500 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  expect(t.active).toBe(false)
  expect(t.steps.map((s) => s.id)).toEqual(["asst-2"])
  expect(t.reasoning).toBe(30)
  expect(t.output).toBe(20)
  expect(t.parentID).toBe("user-1")
})

test("computeTurn: active turn picks in-flight steps after the last completed one", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0"),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
    }),
    user("user-1", 3000),
    assistant({
      parentID: "user-1",
      id: "asst-2",
      time: { created: 4000 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
    assistant({
      parentID: "user-1",
      id: "asst-3",
      time: { created: 5000 },
      tokens: { input: 300, output: 80, reasoning: 40, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  expect(t.active).toBe(true)
  expect(t.steps.map((s) => s.id)).toEqual(["asst-2", "asst-3"])
  expect(t.reasoning).toBe(70)
  expect(t.output).toBe(100)
  expect(t.start).toBe(3000)
})

test("computeTurn: earlier completed steps of the same turn still count", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 10, reasoning: 10, cache: { read: 0, write: 0 } },
    }),
    user("user-1", 3000),
    // Completed mid-turn step (tool call) + the in-flight final step - both
    // parent to user-1 and both belong to the turn.
    assistant({
      parentID: "user-1",
      id: "asst-2",
      time: { created: 4000, completed: 4500 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
    assistant({
      parentID: "user-1",
      id: "asst-3",
      time: { created: 5000 },
      tokens: { input: 300, output: 80, reasoning: 40, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  expect(t.active).toBe(true)
  expect(t.steps.map((s) => s.id)).toEqual(["asst-2", "asst-3"])
  expect(t.reasoning).toBe(70)
  expect(t.output).toBe(100)
})

test("computeTurn: elapsed start falls back to the first in-flight step", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    assistant({ id: "asst-0", parentID: "ghost", time: { created: 5000 }, tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  const t = computeTurn(messages)
  expect(t.active).toBe(true)
  expect(t.start).toBe(5000)
})

test("computeTurn: counts tool parts per step when a part resolver is given", () => {
  const parts: Record<string, Part[]> = {
    "asst-2": [toolPart("tool-1")],
    "asst-3": [toolPart("tool-2"), toolPart("tool-3")],
  }
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-1", 3000),
    assistant({ parentID: "user-1", id: "asst-2", time: { created: 4000 }, tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } } }),
    assistant({ parentID: "user-1", id: "asst-3", time: { created: 5000 }, tokens: { input: 300, output: 80, reasoning: 40, cache: { read: 0, write: 0 } } }),
  ]
  const t = computeTurn(messages, (id) => parts[id])
  expect(t.tools).toBe(3)
})

test("computeTurn: no tool counting without a part resolver", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-1", 3000),
    assistant({ parentID: "user-1", id: "asst-2", time: { created: 4000 }, tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } } }),
  ]
  const t = computeTurn(messages)
  expect(t.tools).toBe(0)
})

test("settledReport: picks the final step with ANY usage, not just output", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
    }),
    // Final step: reasoning-only, output === 0 - the old findLast(output > 0)
    // would skip it and report asst-1 (stale).
    assistant({
      parentID: "user-0",
      id: "asst-2",
      time: { created: 2000, completed: 3000 },
      tokens: { input: 400, output: 0, reasoning: 120, cache: { read: 60, write: 10 } },
    }),
  ]
  const r = settledReport(messages)
  expect(r?.providerID).toBe("opencode")
  expect(r?.tokens).toBe(400 + 0 + 120 + 60 + 10)
  // input side = the context sent (input + cached prefix/writes), not the
  // generated output/reasoning.
  expect(r?.input).toBe(400 + 60 + 10)
  expect(r?.output).toBe(0 + 120)
})

test("settledReport: undefined when no step has any usage", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0"),
    assistant({ parentID: "user-0", time: { created: 1000, completed: 2000 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  expect(settledReport(messages)).toBeUndefined()
})

test("formatCount: integers below 1000", () => {
  expect(formatCount(0)).toBe("0")
  expect(formatCount(999)).toBe("999")
})

test("formatCount: x.xK from 1000, no M branch", () => {
  expect(formatCount(1000)).toBe("1.0K")
  expect(formatCount(1234)).toBe("1.2K")
  expect(formatCount(1000000)).toBe("1,000.0K")
  expect(formatCount(12500000)).toBe("12,500.0K")
})

const textPart = (text: string): TextPart => ({
  id: "p-" + Math.random().toString(36).slice(2),
  sessionID: "ses_test",
  messageID: "asst-1",
  type: "text",
  text,
})

const reasoningPart = (text: string): ReasoningPart => ({
  id: "p-" + Math.random().toString(36).slice(2),
  sessionID: "ses_test",
  messageID: "asst-1",
  type: "reasoning",
  text,
  time: { start: 0 },
})

test("estimateStepTokens: real endpoint tokens win when present", () => {
  const step = assistant({
    parentID: "user-1",
    id: "asst-2",
    time: { created: 4000, completed: 4500 },
    tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
  })
  const est = estimateStepTokens(step, [textPart("x".repeat(1000))])
  expect(est).toEqual({ reasoning: 30, output: 20 })
})

test("estimateStepTokens: in-flight step estimates from streamed chars (4 chars/token)", () => {
  const step = assistant({
    parentID: "user-1",
    id: "asst-2",
    time: { created: 4000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const est = estimateStepTokens(step, [
    reasoningPart("x".repeat(800)),
    textPart("y".repeat(160)),
    { ...toolPart("tool-1"), messageID: "asst-2", state: { status: "pending", input: {}, raw: "z".repeat(160) } },
  ])
  expect(est).toEqual({ reasoning: 200, output: 80 })
})

test("turnLiveTokens: mixes real tokens (completed) + estimates (in-flight)", () => {
  const parts: Record<string, Part[]> = { "asst-3": [textPart("y".repeat(400))] }
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-1", 3000),
    assistant({
      parentID: "user-1",
      id: "asst-2",
      time: { created: 4000, completed: 4500 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
    assistant({
      parentID: "user-1",
      id: "asst-3",
      time: { created: 5000 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  const live = turnLiveTokens(t, (id) => parts[id])
  // asst-2 real (30/20) + asst-3 estimated from textPart (0/100).
  expect(live).toEqual({ reasoning: 30, output: 120 })
})

test("toolResultTokens: counts completed tool outputs (4 chars/token)", () => {
  const parts: Record<string, Part[]> = {
    "asst-2": [
      {
        ...toolPart("tool-1"),
        messageID: "asst-2",
        state: {
          status: "completed",
          input: {},
          output: "x".repeat(800),
          title: "bash",
          metadata: {},
          time: { start: 0, end: 1 },
        } as const,
      },
      {
        ...toolPart("tool-2"),
        messageID: "asst-2",
        state: { status: "running", input: {}, time: { start: 0 } } as const,
      },
    ],
  }
  const step = assistant({ parentID: "user-1", id: "asst-2", time: { created: 4000 } })
  expect(toolResultTokens([step], (id) => parts[id])).toBe(200)
  expect(toolResultTokens([step])).toBe(0)
})
