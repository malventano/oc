import { expect, test } from "bun:test"
import type { AssistantMessage, Part, Session, UserMessage } from "@opencode-ai/sdk/v2"
import { bindContextUsageKV, contextUsage, resolveContextUsage } from "../src/util/context-usage"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "ses_test",
  role: "user",
  time: { created: 1000 },
  agent: "build",
  model: { providerID: "opencode", modelID: "dsv4" },
})

const assistant = (over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: over.id ?? "asst-1",
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 1000, completed: 2000 },
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

const text = (id: string, messageID: string, value: string): Part => ({
  id,
  sessionID: "ses_test",
  messageID,
  type: "text",
  text: value,
})

const stepStart = (messageID: string, estimated: number): Part => ({
  id: "prt_start_" + messageID,
  sessionID: "ses_test",
  messageID,
  type: "step-start",
  estimated_input_tokens: estimated,
})

const stepStartBase = (messageID: string, base: number): Part => ({
  id: "prt_start_base_" + messageID,
  sessionID: "ses_test",
  messageID,
  type: "step-start",
  estimated_input_tokens: 0,
  estimated_base_tokens: base,
})

const compaction = (messageID: string, over: Partial<Extract<Part, { type: "compaction" }>> = {}): Part => ({
  id: "prt_compaction_" + messageID,
  sessionID: "ses_test",
  messageID,
  type: "compaction",
  auto: false,
  ...over,
})

const map = (entries: Record<string, Part[]>) => (id: string) => entries[id]

test("exact report: input side only, no forecast", () => {
  const messages = [user("user-0"), assistant({ tokens: { input: 900, output: 80, reasoning: 40, cache: { read: 200, write: 10 } } })]
  const usage = resolveContextUsage({
    messages,
    parts: () => undefined,
    provider: [],
    directory: "/tmp",
  })
  expect(usage).toEqual({ tokens: 1110, percent: null, forecast: false })
})

test("streaming output ticks the context live between reports", () => {
  const messages = [
    user("user-0"),
    assistant({
      id: "asst-1",
      parentID: "user-0",
      time: { created: 1000, completed: 2000 },
      tokens: { input: 900, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
    }),
    assistant({
      id: "asst-2",
      parentID: "user-0",
      time: { created: 3000 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const parts = map({ "asst-2": [text("prt_stream", "asst-2", "x".repeat(300))] })
  const live = resolveContextUsage({
    messages,
    parts,
    provider: [],
    directory: "/tmp",
    busy: true,
  })
  expect(live).toEqual({ tokens: 1260, percent: null, forecast: false })
})

test("step-start preflight also ticks with the in-flight stream", () => {
  const messages = [
    user("user-0"),
    assistant({
      id: "asst-1",
      parentID: "user-0",
      time: { created: 1000 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const parts = map({
    "asst-1": [stepStart("asst-1", 1000), text("prt_stream", "asst-1", "x".repeat(300))],
  })
  const live = resolveContextUsage({
    messages,
    parts,
    provider: [],
    directory: "/tmp",
    busy: true,
  })
  expect(live).toEqual({ tokens: 1100, percent: null, forecast: true })
})

test("new session: baseline plus prompt before the first report", () => {
  const messages = [user("user-0")]
  const usage = resolveContextUsage(
    {
      messages,
      parts: () => [text("prt_0", "user-0", "x".repeat(300))],
      provider: [],
      directory: "/tmp",
    },
    1100,
  )
  expect(usage).toEqual({ tokens: 1200, percent: null, forecast: true })
})

test("new session: step-start estimate is used before the first report", () => {
  const messages = [user("user-0"), assistant({ id: "asst-1", parentID: "user-0", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })]
  const usage = resolveContextUsage({
    messages,
    parts: map({ "asst-1": [stepStart("asst-1", 1800)] }),
    provider: [],
    directory: "/tmp",
  })
  expect(usage).toEqual({ tokens: 1800, percent: null, forecast: true })
})

test("completed compaction: predictive transcript plus baseline, not the old high", () => {
  const messages = [
    user("user-0"),
    assistant({ id: "asst-old", parentID: "user-0", tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } } }),
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({ "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })] }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 800, percent: null, forecast: true })
})

test("a server-provided compaction base beats a missing/stale cache", () => {
  const messages = [
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage({
    messages,
    parts: map({
      "user-marker": [
        compaction("user-marker", {
          no_tail: true,
          estimated_next_transcript_tokens: 115,
          estimated_context_base_tokens: 2000,
        }),
      ],
    }),
    provider: [],
    directory: "/tmp",
  })
  expect(usage).toEqual({ tokens: 2115, percent: null, forecast: true })
})

test("missing compaction base uses the latest step-start base before the stale cache", () => {
  const messages = [
    user("user-0"),
    assistant({ id: "asst-old", parentID: "user-0" }),
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({
        "asst-old": [stepStartBase("asst-old", 9000)],
        "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })],
      }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 9500, percent: null, forecast: true })
})

test("a newer step-start base replaces a stale marker base", () => {
  const messages = [
    user("user-0"),
    assistant({ id: "asst-old", parentID: "user-0" }),
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({
        "asst-old": [stepStartBase("asst-old", 9000)],
        "user-marker": [
          compaction("user-marker", {
            estimated_next_transcript_tokens: 500,
            estimated_context_base_tokens: 2000,
          }),
        ],
      }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 9500, percent: null, forecast: true })
})

test("post-compaction exact report wins over the estimate", () => {
  const messages = [
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
    user("user-1"),
    assistant({ id: "asst-1", parentID: "user-1", tokens: { input: 1200, output: 50, reasoning: 0, cache: { read: 300, write: 0 } } }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({ "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })] }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 1500, percent: null, forecast: false })
})

test("post-compaction prompt is added to the transcript estimate", () => {
  const messages = [
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
    user("user-1"),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({
        "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })],
        "user-1": [text("prt_1", "user-1", "x".repeat(300))],
      }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 900, percent: null, forecast: true })
})

test("auto-continue step-start estimate replaces the summary estimate", () => {
  const messages = [
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
    user("user-continue"),
    assistant({ id: "asst-continue", parentID: "user-continue", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({
        "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })],
        "asst-continue": [stepStart("asst-continue", 900)],
      }),
      provider: [],
      directory: "/tmp",
    },
    300,
  )
  expect(usage).toEqual({ tokens: 900, percent: null, forecast: true })
})

test("legacy compaction without a server estimate falls back to summary plus retained tail", () => {
  const messages = [
    user("user-tail"),
    assistant({ id: "asst-tail", parentID: "user-tail", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
    user("user-marker"),
    assistant({
      id: "asst-summary",
      parentID: "user-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage(
    {
      messages,
      parts: map({
        "user-marker": [compaction("user-marker", { tail_start_id: "user-tail" })],
        "user-tail": [text("prt_tail", "user-tail", "x".repeat(300))],
        "asst-tail": [text("prt_tail_a", "asst-tail", "y".repeat(300))],
        "asst-summary": [text("prt_summary", "asst-summary", "z".repeat(300))],
      }),
      provider: [],
      directory: "/tmp",
    },
    100,
  )
  expect(usage?.forecast).toBe(true)
  expect(usage?.tokens).toBe(
    100 + Math.round((300 + "[Compacted summary of the prior conversation]".length + 300 + 300) / 3),
  )
})

test("legacy virtual compaction uses the real summary plus the reduced tail", () => {
  const messages = [
    user("tail-old"),
    assistant({ id: "asst-old", parentID: "tail-old", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
    user("real-marker"),
    assistant({
      id: "real-summary",
      parentID: "real-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
    user("tail-keep"),
    assistant({ id: "asst-keep", parentID: "tail-keep", tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }),
    user("virtual-marker"),
    assistant({
      id: "virtual-summary",
      parentID: "virtual-marker",
      summary: true,
      finish: "end_turn",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const usage = resolveContextUsage({
    messages,
    parts: map({
      "real-marker": [compaction("real-marker", { tail_start_id: "tail-old" })],
      "virtual-marker": [compaction("virtual-marker", { virtual: true, tail_start_id: "tail-keep" })],
      "tail-old": [text("prt_old", "tail-old", "x".repeat(300))],
      "asst-old": [text("prt_old_a", "asst-old", "x".repeat(300))],
      "real-summary": [text("prt_real_summary", "real-summary", "x".repeat(300))],
      "tail-keep": [text("prt_keep", "tail-keep", "x".repeat(300))],
      "asst-keep": [text("prt_keep_a", "asst-keep", "x".repeat(300))],
      "virtual-summary": [text("prt_virtual_note", "virtual-summary", "Virtual compact note")],
    }),
    provider: [],
    directory: "/tmp",
  })
  const expected = Math.round(
    (300 + "[Compacted summary of the prior conversation]".length + 300 + 300) / 3,
  )
  expect(usage).toEqual({ tokens: expected, percent: null, forecast: true })
})

test("undoing a virtual compaction restores the real tail estimate", () => {
  const messages = [
    user("tail-old"),
    assistant({ id: "asst-old", parentID: "tail-old", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
    user("real-marker"),
    assistant({
      id: "real-summary",
      parentID: "real-marker",
      summary: true,
      finish: "stop",
      tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
    }),
    user("virtual-marker"),
    assistant({
      id: "virtual-summary",
      parentID: "virtual-marker",
      summary: true,
      finish: "end_turn",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ]
  const parts = map({
    "real-marker": [compaction("real-marker", { tail_start_id: "tail-old" })],
    "virtual-marker": [compaction("virtual-marker", { virtual: true, tail_start_id: "real-marker" })],
    "tail-old": [text("prt_old", "tail-old", "x".repeat(300))],
    "asst-old": [text("prt_old_a", "asst-old", "x".repeat(300))],
    "real-summary": [text("prt_real_summary", "real-summary", "x".repeat(300))],
    "virtual-summary": [text("prt_virtual_note", "virtual-summary", "Virtual compact note")],
  })
  const session = { revert: { messageID: "virtual-marker" } } as unknown as Session
  const usage = resolveContextUsage({
    messages,
    parts,
    session,
    provider: [],
    directory: "/tmp",
  })
  const expected = Math.round(
    (300 + "[Compacted summary of the prior conversation]".length + 300 + 300) / 3,
  )
  expect(usage).toEqual({ tokens: expected, percent: null, forecast: true })
})

test("the first post-compaction report teaches the baseline", () => {
  const store = new Map<string, unknown>()
  bindContextUsageKV({
    get: (key, fallback) => store.get(key) ?? fallback,
    set: (key, value) => {
      store.set(key, value)
    },
  })
  const directory = "/post-baseline-" + Math.random().toString(36).slice(2)
  const parts = map({
    "user-marker": [compaction("user-marker", { no_tail: true })],
    "asst-summary": [text("prt_summary", "asst-summary", "x".repeat(300))],
    "user-1": [text("prt_prompt", "user-1", "x".repeat(300))],
  })
  const first = contextUsage({
    messages: [
      user("user-marker"),
      assistant({
        id: "asst-summary",
        parentID: "user-marker",
        summary: true,
        finish: "stop",
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
      }),
      user("user-1"),
      assistant({ id: "asst-1", parentID: "user-1", tokens: { input: 1200, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ],
    parts: (id) => parts(id),
    provider: [],
    directory,
  })
  expect(first).toEqual({ tokens: 1200, percent: null, forecast: false })

  const next = contextUsage({
    messages: [user("user-1")],
    parts: (id) => parts(id),
    provider: [],
    directory,
  })
  expect(next).toEqual({ tokens: 1085, percent: null, forecast: true })
})

test("contextUsage measures a fresh-session baseline and reuses it for a new session", () => {
  const store = new Map<string, unknown>()
  bindContextUsageKV({
    get: (key, fallback) => store.get(key) ?? fallback,
    set: (key, value) => {
      store.set(key, value)
    },
  })
  const directory = "/baseline-" + Math.random().toString(36).slice(2)
  const parts: Record<string, Part[]> = { "user-0": [text("prt_prompt", "user-0", "x".repeat(300))] }

  const measured = contextUsage({
    messages: [user("user-0"), assistant({ id: "asst-1", parentID: "user-0", tokens: { input: 1200, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })],
    parts: (id) => parts[id],
    provider: [],
    directory,
  })
  expect(measured).toEqual({ tokens: 1200, percent: null, forecast: false })

  const next = contextUsage({
    messages: [user("user-0")],
    parts: (id) => parts[id],
    provider: [],
    directory,
  })
  expect(next).toEqual({ tokens: 1200, percent: null, forecast: true })
})

test("unknown legacy base borrows the nearest ancestor baseline", () => {
  const store = new Map<string, unknown>()
  bindContextUsageKV({
    get: (key, fallback) => store.get(key) ?? fallback,
    set: (key, value) => {
      store.set(key, value)
    },
  })
  const root = "/rough-" + Math.random().toString(36).slice(2)
  const directory = root + "/proj"
  store.set("context_baseline_v1:" + root + "|build|opencode/dsv4", 25000)
  const usage = contextUsage({
    messages: [
      user("user-marker"),
      assistant({
        id: "asst-summary",
        parentID: "user-marker",
        summary: true,
        finish: "stop",
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 1400, write: 0 } },
      }),
    ],
    parts: map({ "user-marker": [compaction("user-marker", { estimated_next_transcript_tokens: 500 })] }),
    provider: [],
    directory,
  })
  expect(usage).toEqual({ tokens: 25500, percent: null, forecast: true })
})

test("clean-start compaction with no base uses the rough base, not the stale exact", () => {
  const store = new Map<string, unknown>()
  bindContextUsageKV({
    get: (key, fallback) => store.get(key) ?? fallback,
    set: (key, value) => {
      store.set(key, value)
    },
  })
  const root = "/clean-" + Math.random().toString(36).slice(2)
  const directory = root + "/proj"
  store.set("context_baseline_v1:" + root + "|build|opencode/dsv4", 18000)
  const usage = contextUsage({
    messages: [
      user("user-old"),
      assistant({
        id: "asst-old",
        parentID: "user-old",
        tokens: { input: 5000, output: 10, reasoning: 0, cache: { read: 100000, write: 0 } },
      }),
      user("user-marker"),
      assistant({
        id: "asst-summary",
        parentID: "user-marker",
        summary: true,
        finish: "end_turn",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ],
    parts: map({
      "user-marker": [
        compaction("user-marker", {
          virtual: true,
          clean_start: true,
          estimated_next_transcript_tokens: 0,
        }),
      ],
    }),
    provider: [],
    directory,
  })
  expect(usage).toEqual({ tokens: 18000, percent: null, forecast: true })
})
