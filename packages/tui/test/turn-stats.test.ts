import { expect, test } from "bun:test"
import {
  computeTurn,
  countTurnWalkParts,
  estimateStepTokens,
  formatCount,
  settledReport,
  shouldReanchorBase,
  streamedChars,
  streamRateFor,
  toolResultTokens,
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

test("shouldReanchorBase: re-anchors a stale base when a NEWER report shows LESS context (compaction)", () => {
  // The base was frozen from the compaction summary's report, which read the
  // whole pre-compaction context; the post-compaction turn's first step
  // reports the real compacted total - strictly smaller -> re-anchor.
  expect(
    shouldReanchorBase({ at: "summary-asst", tokens: 294916 }, { id: "next-step-1", input: 77420 }),
  ).toBe(true)
})

test("shouldReanchorBase: holds the frozen base on normal growth (base + prompt)", () => {
  // A newer report that GREW is normal turn progression - re-anchoring would
  // introduce step-boundary flicker, so the frozen base must hold.
  expect(
    shouldReanchorBase({ at: "prev-final", tokens: 40000 }, { id: "step-1", input: 43000 }),
  ).toBe(false)
})

test("shouldReanchorBase: same message (no newer report yet) never re-anchors", () => {
  expect(
    shouldReanchorBase({ at: "step-1", tokens: 77420 }, { id: "step-1", input: 77420 }),
  ).toBe(false)
})

test("shouldReanchorBase: undefined settled report never re-anchors", () => {
  expect(shouldReanchorBase({ at: "step-1", tokens: 77420 }, undefined)).toBe(false)
})

test("shouldReanchorBase: equal input is NOT a correction (strict less-than)", () => {
  // The turn's first step can report the same context the base already holds
  // (e.g. a zero-accumulation turn); re-anchoring would only flip the caller's
  // anchored flag and wrongly drop the prompt estimate.
  expect(
    shouldReanchorBase({ at: "prev-final", tokens: 40000 }, { id: "step-1", input: 40000 }),
  ).toBe(false)
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
  // the delivery is the anchor of the new episode (still frozen)
  expect(streamRateFor("t-burst1", "step-b", 2000, 3200)).toBe(500)
  // the next chunk resumes tracking: raw 1000, alpha 0.487 from the frozen 500
  const v2 = streamRateFor("t-burst1", "step-b", 2800, 3400)
  expect(v2).toBeCloseTo(743.3, 1)
  expect(v2).toBeGreaterThan(500)
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
  expect(streamRateFor("t-gap", "step-b", 740, 3600)).toBe(100) // anchor of the new episode
  // the next chunk resumes tracking: raw 500, alpha 0.283
  const tracking = streamRateFor("t-gap", "step-b", 940, 3700)
  expect(tracking).toBeCloseTo(213.4, 1)
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
