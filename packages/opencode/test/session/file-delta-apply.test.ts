import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import * as path from "path"
import { Session as SessionNs } from "@/session/session"
import { FileDelta } from "../../src/session/file-delta"
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
import { provideTmpdirInstance } from "../fixture/fixture"

const env = AppNodeBuilder.build(
  LayerNode.group([SessionNs.node, SessionProjector.node, Database.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
)
const it = testEffect(env)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const STALE = { mtimeMs: 1, size: 10 }

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

function createAssistantMessage(sessionID: SessionID, parentID: MessageID) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    return yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      agent: "build",
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
    })
  })
}

function addReadPart(sessionID: SessionID, messageID: MessageID, filePath: string, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      tool: "read",
      callID: "call-read",
      state: {
        status: "completed",
        input: { filePath },
        output: `<path>${filePath}</path>`,
        title: filePath,
        metadata: {
          display: { type: "file", path: filePath, text, lineStart: 1, lineEnd: 3, totalLines: 3, truncated: false },
          stat: STALE,
        },
        time: { start: 1, end: 2 },
      },
    } as unknown as SessionV1.Part)
  })
}

function loaded(sessionID: SessionID) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    return yield* ssn.messages({ sessionID })
  })
}

function fileDeltaPart(msgs: SessionV1.WithParts[], messageID: MessageID) {
  return msgs
    .find((m) => m.info.id === messageID)
    ?.parts.find((p) => p.type === "text" && p.metadata?.fileDelta)
}

// ---------------------------------------------------------------------------

describe("FileDelta.apply anchor", () => {
  it.live(
    "step 1: the reminder rides the turn's user prompt (with the prompt)",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const file = path.join(dir, "foo.ts")
        yield* Effect.promise(() => fs.writeFile(file, "a\nB\nc"))
        const user = yield* createUserMessage(info.id, "hello")
        yield* addReadPart(info.id, user.id, file, "a\nb\nc")

        const msgs = yield* loaded(info.id)
        yield* FileDelta.apply({
          msgs,
          sessionID: info.id,
          user: msgs.findLast((m) => m.info.id === user.id)!,
          userSystem: undefined,
          step: 1,
          compactingPrompt: false,
        })

        const after = yield* loaded(info.id)
        const part = fileDeltaPart(after, user.id)
        expect(part).toBeDefined()
        expect(part!.synthetic).toBe(true)
        const entry = (part!.metadata!.fileDelta as Record<string, { text?: string }>)[file]
        expect(entry.text).toBe("a\nB\nc")
      }),
    ),
  )

  it.live(
    "mid-turn: the reminder rides the newest message, never the user prompt",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const file = path.join(dir, "foo.ts")
        yield* Effect.promise(() => fs.writeFile(file, "a\nB\nc"))
        const user = yield* createUserMessage(info.id, "hello")
        yield* addReadPart(info.id, user.id, file, "a\nb\nc")
        const assistant = yield* createAssistantMessage(info.id, user.id)

        const msgs = yield* loaded(info.id)
        yield* FileDelta.apply({
          msgs,
          sessionID: info.id,
          user: msgs.findLast((m) => m.info.id === user.id)!,
          userSystem: undefined,
          step: 2,
          compactingPrompt: false,
        })

        const after = yield* loaded(info.id)
        expect(fileDeltaPart(after, user.id)).toBeUndefined()
        expect(fileDeltaPart(after, assistant.id)).toBeDefined()
      }),
    ),
  )

  it.live(
    "mid-turn: a second apply on the same step does not double-inject",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const file = path.join(dir, "foo.ts")
        yield* Effect.promise(() => fs.writeFile(file, "a\nB\nc"))
        const user = yield* createUserMessage(info.id, "hello")
        yield* addReadPart(info.id, user.id, file, "a\nb\nc")
        const assistant = yield* createAssistantMessage(info.id, user.id)

        const apply = Effect.gen(function* () {
          const msgs = yield* loaded(info.id)
          yield* FileDelta.apply({
            msgs,
            sessionID: info.id,
            user: msgs.findLast((m) => m.info.id === user.id)!,
            userSystem: undefined,
            step: 2,
            compactingPrompt: false,
          })
        })
        yield* apply
        yield* apply

        const after = yield* loaded(info.id)
        const parts = after.find((m) => m.info.id === assistant.id)!.parts
        expect(parts.filter((p) => p.type === "text" && p.metadata?.fileDelta)).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "the reported window text becomes the next delta's baseline (incremental stacking)",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const file = path.join(dir, "foo.ts")
        yield* Effect.promise(() => fs.writeFile(file, "a\nB\nc"))
        yield* Effect.promise(() => fs.utimes(file, 1000, 1000))
        const user = yield* createUserMessage(info.id, "hello")
        yield* addReadPart(info.id, user.id, file, "a\nb\nc")

        const first = yield* loaded(info.id)
        yield* FileDelta.apply({
          msgs: first,
          sessionID: info.id,
          user: first.findLast((m) => m.info.id === user.id)!,
          userSystem: undefined,
          step: 1,
          compactingPrompt: false,
        })

        // A second external change stacks from the reported window: the diff
        // shows only the new change, not the first one again.
        const firstDelta = (yield* loaded(info.id))
          .find((m) => m.info.id === user.id)!
          .parts.find((p) => p.type === "text" && p.metadata?.fileDelta)
        expect((firstDelta!.metadata!.fileDelta as Record<string, { text?: string }>)[file].text).toBe("a\nB\nc")
        yield* Effect.promise(() => fs.writeFile(file, "a\nB\nC"))
        yield* Effect.promise(() => fs.utimes(file, 2000, 2000))
        const assistant = yield* createAssistantMessage(info.id, user.id)
        const second = yield* loaded(info.id)
        yield* FileDelta.apply({
          msgs: second,
          sessionID: info.id,
          user: second.findLast((m) => m.info.id === user.id)!,
          userSystem: undefined,
          step: 2,
          compactingPrompt: false,
        })

        const parts = (yield* loaded(info.id)).find((m) => m.info.id === assistant.id)!.parts
        const deltas = parts.filter((p) => p.type === "text" && p.metadata?.fileDelta)
        expect(deltas).toHaveLength(1)
        const entry = (deltas[0]!.metadata!.fileDelta as Record<string, { text?: string }>)[file]
        // The reported window becomes the next delta's baseline.
        expect(entry.text).toBe("a\nB\nC")
      }),
    ),
  )
})
