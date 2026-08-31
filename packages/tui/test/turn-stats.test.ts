import { expect, test } from "bun:test"
import {
  computeTurn,
  countTurnWalkParts,
  estimateStepTokens,
  foldTurnSteps,
  formatCount,
  newTurnLiveAccum,
  pendingTally,
  settledReport,
  streamedChars,
  streamRateFor,
  toolResultTokens,
  turnLiveFromAccum,
  turnLiveTokens,
} from "../src/component/prompt/turn-stats"
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

test("settledReport: reports the message id (for frozen-base staleness detection)", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-final",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
    }),
  ]
  const r = settledReport(messages)
  expect(r?.id).toBe("asst-final")
})

test("settledReport: undefined when no step has any usage", () => {
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0"),
    assistant({ parentID: "user-0", time: { created: 1000, completed: 2000 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  expect(settledReport(messages)).toBeUndefined()
})

test("pendingTally: fresh session before the first report - anchored 0, only the prompt + in-flight streamed", () => {
  // The fresh-session gap: no step has reported yet, so the anchor is 0 and
  // the display is just the just-submitted prompt + what streams. It is only a
  // ~2s window - the first step-finish adopts the real wire input (next test).
  const parts: Record<string, Part[]> = {
    "user-0": [textPart("find the fineweb session")], // 24 chars -> 6
    "asst-1": [textPart("y".repeat(80))], // 80 chars -> 20
  }
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1500 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  const p = pendingTally(messages, t, (id) => parts[id])
  expect(p.anchored).toBe(0)
  expect(p.inputPending).toBe(6)
  expect(p.streamedPending).toBe(20)
})

test("pendingTally: the first step-finish report becomes the anchor (exact wire input)", () => {
  // The moment the first semi-turn completes, the counter must adopt the
  // endpoint's reported input side (input + cache.read) - the original bug:
  // a fresh session held near 0 through the whole first turn.
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1500, completed: 2000 },
      tokens: { input: 23980, output: 84, reasoning: 0, cache: { read: 8, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  const p = pendingTally(messages, t)
  expect(p.anchored).toBe(23980 + 8)
  // The anchor step's own output is not inside its report -> still pending.
  expect(p.inputPending).toBe(84)
  expect(p.streamedPending).toBe(0)
})

test("pendingTally: mid-turn tool gap - the anchor step's output + tool result are pending", () => {
  const completed: ToolPart = {
    ...toolPart("t-k"),
    messageID: "asst-1",
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(800),
      title: "bash",
      metadata: {},
      time: { start: 0, end: 1 },
    } as const,
  }
  const parts: Record<string, Part[]> = { "asst-1": [completed] }
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-1",
      time: { created: 1500, completed: 2000 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  const p = pendingTally(messages, t, (id) => parts[id])
  expect(p.anchored).toBe(200)
  // output + reasoning + the completed tool output (800 chars / 4 = 200).
  expect(p.inputPending).toBe(20 + 30 + 200)
  expect(p.streamedPending).toBe(0)
})

test("pendingTally: prior-turn anchor - only the new prompt is pending", () => {
  const parts: Record<string, Part[]> = { "user-1": [textPart("continue")] } // 8 chars -> 2
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "asst-prev",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
    }),
    user("user-1", 3000),
    assistant({
      parentID: "user-1",
      id: "asst-1",
      time: { created: 4000 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const t = computeTurn(messages)
  const p = pendingTally(messages, t, (id) => parts[id])
  expect(p.anchored).toBe(100)
  expect(p.inputPending).toBe(2)
  expect(p.streamedPending).toBe(0) // asst-1 has no streamed parts yet
})

test("pendingTally: a compaction / model-switch SHRINK adopts the next report (no frozen hold)", () => {
  // The compaction summary's report read the whole pre-compaction context
  // (294900); the post-compaction turn's first step reports the real compacted
  // total. the anchor is the NEWEST report - the high summary value does NOT
  // hold, mirroring the old re-anchor correction at the first report landing.
  const messages: Array<UserMessage | AssistantMessage> = [
    user("user-0", 1000),
    assistant({
      parentID: "user-0",
      id: "summary",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 294900, output: 60, reasoning: 0, cache: { read: 16, write: 0 } },
    }),
    user("user-1", 3000),
    assistant({
      parentID: "user-1",
      id: "post",
      time: { created: 4000, completed: 5000 },
      tokens: { input: 77400, output: 20, reasoning: 0, cache: { read: 20, write: 0 } },
    }),
  ]
  const t = computeTurn(messages) // current turn rooted at user-1
  const p = pendingTally(messages, t)
  expect(p.anchored).toBe(77400 + 20)
  expect(p.inputPending).toBe(20) // post's own output
  expect(p.streamedPending).toBe(0)
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

test("streamedChars: counts reasoning + text + the tool-call payload (any streaming input)", () => {
  const parts: Part[] = [
    { id: "r1", sessionID: "ses_test", messageID: "asst-s", type: "reasoning", text: "r".repeat(40), time: { start: 0 } },
    { id: "t1", sessionID: "ses_test", messageID: "asst-s", type: "text", text: "x".repeat(120) },
    {
      ...toolPart("tool-1"),
      messageID: "asst-s",
      state: { status: "pending", input: {}, raw: "y".repeat(200) },
    },
  ]
  // pending: raw JSON chars count (40 + 120 + 200)
  expect(streamedChars(parts)).toBe(360)
  // landed: the structured input JSON chars count
  const landed: Part[] = [
    { id: "t2", sessionID: "ses_test", messageID: "asst-s", type: "text", text: "z".repeat(50) },
    {
      ...toolPart("tool-2"),
      messageID: "asst-s",
      state: {
        status: "completed",
        input: { content: "abcdefgh" },
        output: "",
        title: "write",
        metadata: {},
        time: { start: 0, end: 1 },
      } as const,
    },
  ]
  expect(streamedChars(landed)).toBe(50 + JSON.stringify({ content: "abcdefgh" }).length)
  expect(streamedChars([])).toBe(0)
})

test("streamRateFor: rate from streamed chars (4 chars/token), EMA-smoothed toward the raw window rate", () => {
  expect(streamRateFor("t-rate", "step-a", 40, 1000)).toBe(0) // episode reset: frozen
  expect(streamRateFor("t-rate", "step-a", 440, 1100)).toBe(0) // anchor sample: no delta, still frozen
  // the second chunk measures a real rate and snaps to the raw 1000 tok/s
  const v = streamRateFor("t-rate", "step-a", 1240, 1300)
  expect(v).toBeCloseTo(1000, 1)
  // a constant-rate stream stays there (alpha chases, raw is flat)
  const v2 = streamRateFor("t-rate", "step-a", 1640, 1400)
  expect(v2).toBeCloseTo(1000, 1)
})

test("streamRateFor: freezes when chars stop growing (tool-call / TTFT stall)", () => {
  streamRateFor("t-freeze", "step-a", 40, 1000)
  streamRateFor("t-freeze", "step-a", 440, 1100) // anchor sample
  const v = streamRateFor("t-freeze", "step-a", 840, 1200) // raw 1000, snaps
  expect(v).toBe(1000)
  // stall: chars unchanged for 2s - the smoothed value must not move
  expect(streamRateFor("t-freeze", "step-a", 840, 1500)).toBe(v)
  expect(streamRateFor("t-freeze", "step-a", 840, 3100)).toBe(v)
})

test("streamRateFor: the EMA spans the whole turn and is shared across the turn's footers", () => {
  streamRateFor("t-turn", "step-a", 40, 1000)
  streamRateFor("t-turn", "step-a", 440, 1100) // anchor
  expect(streamRateFor("t-turn", "step-a", 1240, 1300)).toBeCloseTo(1000, 1) // raw 1000, snaps
  // step B's footer (a DIFFERENT caller, same turn key) - the EPISODE key changed
  // (a new in-flight step) -> the EMA holds the frozen value through the change
  expect(streamRateFor("t-turn", "step-b", 1640, 1400)).toBe(1000) // episode change: frozen
  expect(streamRateFor("t-turn", "step-b", 2040, 1500)).toBe(1000) // anchor
  expect(streamRateFor("t-turn", "step-b", 2440, 1600)).toBeCloseTo(1000, 1) // same raw rate
  // a NEW turn starts a fresh window and EMA
  expect(streamRateFor("t-turn2", "step-a", 40, 2000)).toBe(0)
  expect(streamRateFor("t-turn2", "step-a", 240, 2100)).toBe(0) // anchor
  expect(streamRateFor("t-turn2", "step-a", 440, 2200)).toBeCloseTo(500, 1) // raw 500, snaps
})

test("streamRateFor: rolling 1s window - stale samples age out, EMA governs the display", () => {
  streamRateFor("t-roll", "step-a", 0, 0) // episode anchor
  streamRateFor("t-roll", "step-a", 800, 1000) // raw 200, snaps
  streamRateFor("t-roll", "step-a", 1600, 2000) // steady 200
  const v = streamRateFor("t-roll", "step-a", 2400, 2200) // accelerated to raw 1000 tok/s
  expect(v).toBeCloseTo(589.27, 2)
  const v2 = streamRateFor("t-roll", "step-a", 3200, 2400) // raw 1000, converging
  expect(v2).toBeCloseTo(789.12, 2)
})

test("streamRateFor: a delivery after a stall is a NEW EPISODE - the EMA freezes through it", () => {
  streamRateFor("t-burst1", "step-a", 40, 1900)
  streamRateFor("t-burst1", "step-a", 200, 2000) // anchor
  streamRateFor("t-burst1", "step-a", 400, 2100) // raw 500, snaps
  // the step completes, the tool runs, then a 200-token delivery lands (step-b):
  // the episode change freezes the EMA at the pre-stall value - no dilution, no drop
  expect(streamRateFor("t-burst1", "step-b", 1200, 3000)).toBe(500)
  // the CHANGE seeded the anchor, so the FIRST growth chunk after the stall
  // already measures: raw (2000-1200)/0.2s/4 = 1000, alpha 0.487 from the
  // frozen 500 -> 743.3. No 2-sample blind spot after a tool gap (the
  // BUG_FOOTER_LIVE_STATS_STALE fix) - the EMA resumes immediately.
  expect(streamRateFor("t-burst1", "step-b", 2000, 3200)).toBeCloseTo(743.3, 1)
  // the next chunk converges toward the raw rate
  const v2 = streamRateFor("t-burst1", "step-b", 2800, 3400)
  expect(v2).toBeGreaterThan(743.3)
  expect(v2).toBeLessThan(1000)
})

test("streamRateFor: an episode change holds the frozen value through ANY gap length", () => {
  streamRateFor("t-burst3", "step-a", 40, 1900)
  streamRateFor("t-burst3", "step-a", 200, 2000) // anchor
  streamRateFor("t-burst3", "step-a", 400, 2100) // raw 500, snaps
  // 3s later (any gap length - the trigger is the episode change, not time)
  expect(streamRateFor("t-burst3", "step-b", 1200, 5000)).toBe(500)
})

test("streamRateFor: a gap between streams freezes the EMA (no drop to 0 on resume)", () => {
  streamRateFor("t-gap", "step-a", 40, 0)
  streamRateFor("t-gap", "step-a", 240, 500) // anchor
  streamRateFor("t-gap", "step-a", 440, 1000) // raw 100, snaps
  expect(streamRateFor("t-gap", "step-a", 440, 1500)).toBe(100) // stall within the step: frozen
  // the step ends, the tool runs, then step-b streams: episode change -> frozen
  expect(streamRateFor("t-gap", "step-b", 540, 3500)).toBe(100) // NOT dragged toward ~0
  // the episode-change anchor makes the FIRST growth chunk measure: raw
  // (940-540)/1s/4 = 100 tok/s, resumes immediately (was 2-sample frozen)
  const tracking = streamRateFor("t-gap", "step-b", 940, 3700)
  expect(tracking).toBeGreaterThan(0)
  expect(tracking).toBeLessThan(500)
  // the second real chunk holds ~100
  const hold = streamRateFor("t-gap", "step-b", 240, 4000)
  expect(hold).toBeGreaterThan(0)
  expect(hold).toBeLessThan(500)
})

test("streamRateFor: a chunked tool-call delivery bounces between chunks but tracks the chunks", () => {
  // chunks of 50 tokens (200 chars) each, 500ms apart: delivered at 100 tok/s
  streamRateFor("t-chunk", "step-a", 40, 0)
  streamRateFor("t-chunk", "step-a", 240, 500) // anchor
  const c1 = streamRateFor("t-chunk", "step-a", 440, 1000) // raw 100, snaps
  expect(c1).toBeCloseTo(100, 1)
  // a 600ms gap then the next chunk: raw dips to ~83, EMA to ~86
  const c3 = streamRateFor("t-chunk", "step-a", 640, 1600)
  expect(c3).toBeCloseTo(85.6, 1)
  expect(c3).toBeGreaterThan(0)
})

test("streamRateFor: the EMA damps a single chunk spike and recovers as it ages out", () => {
  streamRateFor("t-spike", "step-a", 40, 0)
  streamRateFor("t-spike", "step-a", 240, 500) // raw 100, snaps
  streamRateFor("t-spike", "step-a", 440, 1000) // raw 100
  // a 50ms spike of 800 chars: the window raw jumps to ~454 tok/s (spike spans
  // the 550ms window), but the EMA moves only ~15% of the way -> ~154
  const spiked = streamRateFor("t-spike", "step-a", 1240, 1050)
  expect(spiked).toBeCloseTo(154.4, 1)
  expect(spiked).toBeLessThan(300) // damped, nowhere near the raw spike
  // the spike stays in the 1s window, so the display keeps converging upward
  const followup = streamRateFor("t-spike", "step-a", 1440, 1150)
  expect(followup).toBeCloseTo(241.5, 1)
  // once the spike ages out (>1s later) the window raw returns to ~100 and the
  // display settles back toward it (alpha ~= 0.96 over the long gap)
  const settled = streamRateFor("t-spike", "step-a", 1840, 2150)
  expect(settled).toBeCloseTo(105.0, 1)
})

test("countTurnWalkParts: counts the steps AFTER the root user message (chronological page)", () => {
  const items = [
    { info: { id: "older-user", role: "user", parentID: null }, parts: [] },
    { info: { id: "older-asst", role: "assistant", parentID: "older-user" }, parts: [toolPart("t-old")] },
    { info: { id: "root", role: "user", parentID: null, time: { created: 1000 } }, parts: [] },
    {
      info: { id: "s1", role: "assistant", parentID: "root", tokens: { reasoning: 50, output: 20 } },
      parts: [toolPart("t1"), toolPart("t2")],
    },
    { info: { id: "s2", role: "assistant", parentID: "root", tokens: { reasoning: 30, output: 5 } }, parts: [toolPart("t3")] },
  ]
  const r = countTurnWalkParts(items, "root", { tools: 0, reasoning: 0, output: 0, reachedRoot: false })
  expect(r).toEqual({ tools: 3, reachedRoot: true, start: 1000, reasoning: 80, output: 25 })
})

test("streamRateFor: a stall re-anchors the window so the resume does not measure across the gap (0225)", () => {
  // The user-visible bug (BUG_FOOTER_LIVE_STATS_STALE): text streams, a tool
  // call runs (chars stop growing under the SAME streamKey), then text
  // resumes. The old window kept its pre-gap samples, so the first post-gap
  // chunk measured dt across the entire tool call and smoothed was dragged
  // toward 0 - the rate "climbed back up from 0" after every tool call.
  // The stall re-anchor resets the window when >1s passes since the last
  // measured growth, so the resume measures from the resume.
  streamRateFor("t-stall", "step-a", 0, 0)
  streamRateFor("t-stall", "step-a", 800, 1000) // raw 200, snaps
  streamRateFor("t-stall", "step-a", 1600, 2000) // steady 200
  expect(streamRateFor("t-stall", "step-a", 1600, 3000)).toBe(200) // frozen, no growth
  // tool executes - chars frozen for 4s (the real stall): no re-anchor yet
  expect(streamRateFor("t-stall", "step-a", 1600, 7000)).toBe(200)
  // resume: first growth NOW arrives after a >1s stall -> re-anchor, holds 200
  // (no dt across the 4s gap -> no drag toward 0)
  expect(streamRateFor("t-stall", "step-a", 2400, 7500)).toBe(200)
  // the next chunk measures the actual resume rate from the re-anchor
  const resumed = streamRateFor("t-stall", "step-a", 3200, 8000)
  // the resume measures the true post-gap rate (~400 here: 800 chars/0.5s/4)
  // instead of being dragged toward 0 by a dt spanning the tool call - any
  // value well above 0 and near the real 400 proves the gap was excluded.
  expect(resumed).toBeCloseTo(362.2, 1)
})

test("countTurnWalkParts: the root user message's created time anchors the clock even when found on an older page", () => {
  let st = countTurnWalkParts(
    [{ info: { id: "s1", role: "assistant", parentID: "root" }, parts: [toolPart("t1")] }],
    "root",
    { tools: 0, reasoning: 0, output: 0, reachedRoot: false },
  )
  expect(st.start).toBeUndefined()
  st = countTurnWalkParts(
    [
      { info: { id: "older", role: "assistant", parentID: "older-user" }, parts: [] },
      { info: { id: "root", role: "user", parentID: null, time: { created: 500 } }, parts: [] },
    ],
    "root",
    st,
  )
  expect(st.start).toBe(500)
})

test("countTurnWalkParts: a steps-only page (root on an older page) counts via the parentID filter", () => {
  const items = [
    { info: { id: "s1", role: "assistant", parentID: "root", tokens: { reasoning: 10, output: 2 } }, parts: [toolPart("t1")] },
    { info: { id: "s2", role: "assistant", parentID: "root", tokens: { reasoning: 5, output: 1 } }, parts: [toolPart("t2")] },
  ]
  const r = countTurnWalkParts(items, "root", { tools: 0, reasoning: 0, output: 0, reachedRoot: false })
  expect(r).toEqual({ tools: 2, reachedRoot: false, reasoning: 15, output: 3 })
})

test("countTurnWalkParts: the root on a later page stops the walk without double-counting", () => {
  let st = countTurnWalkParts(
    [{ info: { id: "s1", role: "assistant", parentID: "root", tokens: { reasoning: 10, output: 2 } }, parts: [toolPart("t1")] }],
    "root",
    { tools: 0, reasoning: 0, output: 0, reachedRoot: false },
  )
  expect(st).toEqual({ tools: 1, reachedRoot: false, reasoning: 10, output: 2 })
  // older page: another turn's messages, then the root - nothing further to count
  st = countTurnWalkParts(
    [
      { info: { id: "older", role: "assistant", parentID: "older-user" }, parts: [toolPart("t-old")] },
      { info: { id: "root", role: "user", parentID: null }, parts: [] },
    ],
    "root",
    st,
  )
  expect(st).toEqual({ tools: 1, reachedRoot: true, reasoning: 10, output: 2 })
})

test("foldTurnSteps: folds a completed step's real values once (idempotent)", () => {
  const acc = newTurnLiveAccum()
  const step = assistant({
    parentID: "user-1",
    id: "asst-1",
    time: { created: 4000, completed: 4500 },
    tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
  })
  const parts = [toolPart("t1"), textPart("y".repeat(400))]
  expect(foldTurnSteps(acc, [step], (id) => parts)).toBe(true)
  expect(acc.reasoning).toBe(30)
  expect(acc.output).toBe(20)
  expect(acc.tools).toBe(1)
  expect(acc.chars).toBe(400)
  // Re-fold (same step, e.g. another footer re-runs the fold): no double count.
  expect(foldTurnSteps(acc, [step], (id) => parts)).toBe(false)
  expect(acc.reasoning).toBe(30)
  expect(acc.output).toBe(20)
  expect(acc.tools).toBe(1)
  expect(acc.chars).toBe(400)
})

test("foldTurnSteps: skips in-flight (not yet completed) steps", () => {
  const acc = newTurnLiveAccum()
  const step = assistant({
    parentID: "user-1",
    id: "asst-1",
    time: { created: 4000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  expect(foldTurnSteps(acc, [step], (id) => [toolPart("t1")])).toBe(false)
  expect(acc.reasoning).toBe(0)
  expect(acc.tools).toBe(0)
})

test("foldTurnSteps: accumulates across multiple completed steps", () => {
  const acc = newTurnLiveAccum()
  const s1 = assistant({
    parentID: "user-1",
    id: "asst-1",
    time: { created: 4000, completed: 4500 },
    tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
  })
  const s2 = assistant({
    parentID: "user-1",
    id: "asst-2",
    time: { created: 5000, completed: 5500 },
    tokens: { input: 300, output: 40, reasoning: 50, cache: { read: 0, write: 0 } },
  })
  foldTurnSteps(acc, [s1], (id) => [toolPart("t1")])
  foldTurnSteps(acc, [s2], (id) => [toolPart("t2"), toolPart("t3")])
  expect(acc.reasoning).toBe(80)
  expect(acc.output).toBe(60)
  expect(acc.tools).toBe(3)
})

test("foldTurnSteps: real tokens from completed steps are exact (no char estimation)", () => {
  const acc = newTurnLiveAccum()
  const step = assistant({
    parentID: "user-1",
    id: "asst-1",
    time: { created: 4000, completed: 4500 },
    tokens: { input: 200, output: 500, reasoning: 300, cache: { read: 0, write: 0 } },
  })
  // 4 chars/token would estimate these very differently - the fold must use
  // the endpoint's real numbers.
  foldTurnSteps(acc, [step], (id) => [textPart("y".repeat(1000))])
  expect(acc.reasoning).toBe(300)
  expect(acc.output).toBe(500)
  expect(acc.chars).toBe(1000)
})

test("turnLiveFromAccum: folded real values + in-flight estimate", () => {
  const acc = newTurnLiveAccum()
  foldTurnSteps(acc, [
    assistant({
      parentID: "user-1",
      id: "asst-1",
      time: { created: 4000, completed: 4500 },
      tokens: { input: 200, output: 20, reasoning: 30, cache: { read: 0, write: 0 } },
    }),
  ])
  const inFlight = assistant({
    parentID: "user-1",
    id: "asst-2",
    time: { created: 5000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  // 160 chars / 4 = 40 output for the in-flight step.
  const live = turnLiveFromAccum(acc, inFlight, (id) => [textPart("y".repeat(160))])
  expect(live).toEqual({ reasoning: 30, output: 60 })
  // No in-flight step: just the folded values.
  expect(turnLiveFromAccum(acc, undefined, (id) => [])).toEqual({ reasoning: 30, output: 20 })
  // No accumulator yet: zero base.
  expect(turnLiveFromAccum(undefined, undefined, (id) => [])).toEqual({ reasoning: 0, output: 0 })
})

test("newTurnLiveAccum: carries the seed start and starts folded-empty", () => {
  const acc = newTurnLiveAccum(1234)
  expect(acc.start).toBe(1234)
  expect(acc.reasoning).toBe(0)
  expect(acc.output).toBe(0)
  expect(acc.tools).toBe(0)
  expect(acc.chars).toBe(0)
  expect(acc.folded.size).toBe(0)
})
