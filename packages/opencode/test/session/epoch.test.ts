import { describe, expect, mock, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Epoch, findLastSummaryId, isRealUser, lineDiff, buildDeltaText } from "../../src/session/epoch"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"

const env = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const it = testEffect(env)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createSummaryAssistant(sessionID: SessionID, parentID: MessageID, root: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    return yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      agent: "compaction",
      mode: "compaction",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      summary: true,
      time: { created: Date.now() },
      finish: "end_turn",
    })
  })
}

function loadMsgs(sessionID: SessionID) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    return yield* ssn.messages({ sessionID })
  })
}

function epochInput(user: SessionV1.User, msgs: SessionV1.WithParts[], overrides: Partial<Parameters<typeof Epoch.apply>[0]> = {}) {
  return {
    msgs,
    sessionID: user.sessionID,
    user: msgs.findLast((m) => m.info.id === user.id)!,
    agentPrompt: "agent prompt",
    env: ["env block"],
    instructions: ["instructions: AGENTS.md v1"],
    mcpInstructions: undefined,
    skills: undefined,
    userSystem: undefined,
    step: 1,
    compactingPrompt: false,
    ...overrides,
  }
}

describe("epoch helpers", () => {
  test("isRealUser: synthetic-only message is not real", () => {
    const synthetic = { info: {} as SessionV1.User, parts: [{ type: "text", text: "", synthetic: true } as SessionV1.TextPart] }
    const real = { info: {} as SessionV1.User, parts: [{ type: "text", text: "hi" } as SessionV1.TextPart] }
    expect(isRealUser(synthetic)).toBe(false)
    expect(isRealUser(real)).toBe(true)
  })

  test("findLastSummaryId: null without summary, newest id with one", () => {
    const noSummary = [
      { info: { role: "assistant" as const, id: "msg_a", time: { created: 100 } } as SessionV1.Assistant, parts: [] },
    ]
    expect(findLastSummaryId(noSummary)).toBeNull()
    const withSummary = [
      {
        info: { role: "assistant" as const, id: "msg_a", summary: true, finish: "stop", time: { created: 100 } } as SessionV1.Assistant,
        parts: [],
      },
      {
        info: { role: "assistant" as const, id: "msg_b", summary: true, finish: "stop", time: { created: 200 } } as SessionV1.Assistant,
        parts: [],
      },
      { info: { role: "assistant" as const, id: "msg_c", time: { created: 300 } } as SessionV1.Assistant, parts: [] },
    ]
    expect(findLastSummaryId(withSummary)).toBe("msg_b")
  })

  test("findLastSummaryId: an aborted summary (error, no finish) is not a boundary", () => {
    const aborted = {
      info: {
        role: "assistant" as const,
        id: "s_aborted",
        summary: true,
        error: { name: "MessageAbortedError" },
        time: { created: 300 },
      } as SessionV1.Assistant,
      parts: [],
    }
    const completed = {
      info: {
        role: "assistant" as const,
        id: "s_completed",
        summary: true,
        finish: "stop",
        time: { created: 200 },
      } as SessionV1.Assistant,
      parts: [],
    }
    // The aborted finalize is chronologically NEWER than the completed
    // summary: it must not win the boundary scan.
    expect(findLastSummaryId([aborted, completed])).toBe("s_completed")
    expect(findLastSummaryId([aborted])).toBeNull()
  })

  test("findLastSummaryId: newest by created time wins regardless of array order", () => {
    const oldSummary = {
      info: { role: "assistant" as const, id: "s_old", summary: true, finish: "stop", time: { created: 100 } } as SessionV1.Assistant,
      parts: [],
    }
    const newSummary = {
      info: { role: "assistant" as const, id: "s_new", summary: true, finish: "stop", time: { created: 200 } } as SessionV1.Assistant,
      parts: [],
    }
    // Rendered-chain shape: [compaction pair at the front, ...tail with an
    // OLDER summary..., continue-user] - array-last is NOT the newest.
    const tail = { info: { role: "user" as const, id: "u", time: { created: 150 } } as SessionV1.User, parts: [] }
    expect(findLastSummaryId([newSummary, tail, oldSummary])).toBe("s_new")
    expect(findLastSummaryId([oldSummary, tail, newSummary])).toBe("s_new")
  })

  test("lineDiff: identical text yields no lines", () => {
    const d = lineDiff("a\nb\nc", "a\nb\nc")
    expect(d.lines).toEqual([])
    expect(d.truncated).toBe(false)
  })

  test("lineDiff: insertion and removal", () => {
    const d = lineDiff("a\nb\nc", "a\nx\nb\nc")
    expect(d.lines).toContain("+ x")
    expect(d.lines).not.toContain("- x")
  })

  test("lineDiff: replacement shows - and +", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc")
    expect(d.lines).toContain("- b")
    expect(d.lines).toContain("+ B")
  })

  test("lineDiff: truncation beyond maxLines", () => {
    const old = Array.from({ length: 60 }, (_, i) => `old${i}`).join("\n")
    const fresh = Array.from({ length: 60 }, (_, i) => `new${i}`).join("\n")
    const d = lineDiff(old, fresh, 10)
    expect(d.truncated).toBe(true)
    expect(d.lines.length).toBe(10)
  })

  test("buildDeltaText: renders section labels and diff lines", () => {
    const text = buildDeltaText([{ label: "instructions (AGENTS.md)", diff: { lines: ["- v1", "+ v2"], truncated: false } }])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("instructions (AGENTS.md)")
    expect(text).toContain("- v1")
    expect(text).toContain("+ v2")
  })

  test("buildDeltaText: truncated diff points at re-read", () => {
    const text = buildDeltaText([{ label: "skills", diff: { lines: ["+ lots"], truncated: true } }])
    expect(text).toContain("re-read the source with the read tool")
  })
})

describe("Epoch.apply", () => {
  it.live(
    "snapshot: first real user message creates a hidden record part and serves live",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)

        const result = yield* Epoch.apply(epochInput(user, msgs))
        expect(result.frozen).toBeUndefined()

        const msgs2 = yield* loadMsgs(info.id)
        const record = msgs2
          .find((m) => m.info.id === user.id)
          ?.parts.find((p): p is SessionV1.TextPart => p.type === "text" && p.metadata?.epoch !== undefined)
        expect(record).toBeDefined()
        expect(record!.synthetic).toBe(true)
        expect(record!.ignored).toBe(true)
        const rec = record!.metadata!.epoch as Epoch.EpochRecord
        expect(rec.boundary).toBeNull()
        expect(rec.joined).toContain("agent prompt")
        expect(rec.joined).toContain("env block")
        expect(rec.joined).toContain("AGENTS.md v1")
      }),
    ),
  )

  it.live(
    "frozen: subsequent turn with no drift serves the snapshot bytes and injects nothing",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user, msgs))

        const msgs2 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(epochInput(user, msgs2))
        expect(result.frozen).toContain("agent prompt")
        expect(result.frozen).toContain("env block")

        const parts = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        expect(parts.filter((p) => p.type === "text" && p.metadata?.epochDelta)).toHaveLength(0)
      }),
    ),
  )

  it.live(
    "delta: instructions change injects a delta part on the user message and updates applied state",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user, msgs))

        const msgs2 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(
          epochInput(user, msgs2, { instructions: ["instructions: AGENTS.md v2"] }),
        )
        expect(result.frozen).toContain("v1")

        const parts = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        const delta = parts.find((p): p is SessionV1.TextPart => p.type === "text" && p.metadata?.epochDelta !== undefined)
        expect(delta).toBeDefined()
        expect(delta!.text).toContain("- instructions: AGENTS.md v1")
        expect(delta!.text).toContain("+ instructions: AGENTS.md v2")
      }),
    ),
  )

  it.live(
    "delta: second change on a later user prompt carries only the NEW content, not the first delta",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user1 = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user1, msgs))

        const msgs2 = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user1, msgs2, { instructions: ["instructions: AGENTS.md v2"] }))

        // second mod lands on the NEXT user prompt
        const user2 = yield* createUserMessage(info.id, "second prompt")
        const msgs3 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(
          epochInput(user2, msgs3, { instructions: ["instructions: AGENTS.md v3"] }),
        )
        const parts2 = (yield* loadMsgs(info.id)).find((m) => m.info.id === user2.id)!.parts
        const deltas2 = parts2.filter((p): p is SessionV1.TextPart => p.type === "text" && p.metadata?.epochDelta !== undefined)
        expect(deltas2).toHaveLength(1)
        // second delta: only v2 -> v3
        expect(deltas2[0].text).toContain("- instructions: AGENTS.md v2")
        expect(deltas2[0].text).toContain("+ instructions: AGENTS.md v3")
        expect(deltas2[0].text).not.toContain("v1")
        expect(result.frozen).toContain("v1")

        // the first user message keeps only the first delta
        const parts1 = (yield* loadMsgs(info.id)).find((m) => m.info.id === user1.id)!.parts
        const deltas1 = parts1.filter((p): p is SessionV1.TextPart => p.type === "text" && p.metadata?.epochDelta !== undefined)
        expect(deltas1).toHaveLength(1)
        expect(deltas1[0].text).toContain("- instructions: AGENTS.md v1")
        expect(deltas1[0].text).toContain("+ instructions: AGENTS.md v2")
      }),
    ),
  )

  it.live(
    "step > 1: no injection, no applied update, frozen still served",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user, msgs))

        const msgs2 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(
          epochInput(user, msgs2, { instructions: ["instructions: AGENTS.md v2"], step: 2 }),
        )
        expect(result.frozen).toContain("v1")
        const parts = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        expect(parts.filter((p) => p.type === "text" && p.metadata?.epochDelta)).toHaveLength(0)

        // next step-1 prompt surfaces the held drift
        const msgs3 = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user, msgs3, { instructions: ["instructions: AGENTS.md v2"] }))
        const parts2 = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        expect(parts2.filter((p) => p.type === "text" && p.metadata?.epochDelta)).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "compaction turn: frozen served, no snapshot, no injection",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user, msgs))

        const msgs2 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(
          epochInput(user, msgs2, { instructions: ["instructions: AGENTS.md v2"], compactingPrompt: true }),
        )
        expect(result.frozen).toContain("v1")
        const parts = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        expect(parts.filter((p) => p.type === "text" && p.metadata?.epochDelta)).toHaveLength(0)
      }),
    ),
  )

  it.instance(
    "post-compaction: old record is dormant (boundary mismatch), new snapshot on next user message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user1 = yield* createUserMessage(info.id, "first prompt")
        const msgs = yield* loadMsgs(info.id)
        yield* Epoch.apply(epochInput(user1, msgs))

        // compaction: summary assistant finalizes
        yield* createSummaryAssistant(info.id, user1.id, test.directory)

        // post-compaction chain retains the first prompt in the tail (both
        // records present); boundary = summary id, old record is dormant
        const msgsPost = yield* loadMsgs(info.id)
        const summaryId = msgsPost.find((m) => m.info.role === "assistant" && m.info.summary === true)!.info.id

        // next user message re-snapshots with the new boundary
        const user2 = yield* createUserMessage(info.id, "second prompt")
        const msgs2 = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(epochInput(user2, msgs2))
        expect(result.frozen).toBeUndefined()

        const records = (yield* loadMsgs(info.id))
          .flatMap((m) => m.parts)
          .filter((p): p is SessionV1.TextPart => p.type === "text" && !!p.metadata?.epoch)
        expect(records).toHaveLength(2)
        expect((records[0].metadata!.epoch as Epoch.EpochRecord).boundary).toBeNull()
        expect((records[1].metadata!.epoch as Epoch.EpochRecord).boundary).toBe(summaryId)

        // frozen now comes from the new epoch
        const msgs3 = yield* loadMsgs(info.id)
        const result2 = yield* Epoch.apply(epochInput(user2, msgs3))
        expect(result2.frozen).toContain("agent prompt")
      }),
  )

  it.live(
    "userSystem override bypasses the epoch entirely",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const user = yield* createUserMessage(info.id, "hello")
        const msgs = yield* loadMsgs(info.id)
        const result = yield* Epoch.apply(epochInput(user, msgs, { userSystem: "override" }))
        expect(result.frozen).toBeUndefined()
        const parts = (yield* loadMsgs(info.id)).find((m) => m.info.id === user.id)!.parts
        expect(parts.filter((p) => p.type === "text" && p.metadata?.epoch)).toHaveLength(0)
      }),
    ),
  )
})
