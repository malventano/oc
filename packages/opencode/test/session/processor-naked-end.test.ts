import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { APICallError } from "ai"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

// A message that is genuinely IN FLIGHT: no finish and no time.completed. The
// processor-effect helper seeds finish="end_turn", which masks the 0409
// reconcile entirely (the check keys on the finish being absent).
const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(msg)
  return msg
})

function input(sessionID: SessionID, parentID: MessageID, model: Provider.Model, text: string) {
  return {
    user: {
      id: parentID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID,
    model,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: text }],
    tools: {},
  } satisfies LLM.StreamInput
}

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// The naked end: the provider stream drains after a partial text delta with
// NO step-finish and NO error. Before 0409 this left the turn spinning
// forever; the retry policy only reacts to errors, never to a quiet close.
const nakedEndLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial answer" }),
      ),
  }),
)
const nakedEndEnv = LayerNode.compile(root, [...replacements, [LLM.node, nakedEndLLM]])
const itNakedEnd = testEffect(nakedEndEnv)

// A loop-guard cut is a BY-DESIGN mid-step end: takeUntil stops the stream as
// soon as the detector fires, so no step-finish is ever delivered. The cut
// message must stay finish-less (the loop re-delivers the user message with
// the steer) and must NOT be converted to a ResponseStreamError.
const LOOP_SEGMENT = "The configuration service loads provider settings from the local filesystem on startup"
const loopGuardLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
        LLMEvent.textDelta({ id: "text-1", text: LOOP_SEGMENT + "\n\n" }),
      ),
  }),
)
const loopGuardEnv = LayerNode.compile(root, [...replacements, [LLM.node, loopGuardLLM]])
const itLoopGuard = testEffect(loopGuardEnv)

// A context overflow is the other BY-DESIGN compaction end: it halts with
// needsCompaction instead of surfacing as a retryable stream failure.
const compactionLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.fail(
        new APICallError({
          message: "Request failed",
          url: "https://example.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 422,
          responseHeaders: { "content-type": "application/json" },
          responseBody: JSON.stringify({
            error: {
              message: "Some message",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
          isRetryable: false,
        }),
      ),
  }),
)
const compactionEnv = LayerNode.compile(root, [...replacements, [LLM.node, compactionLLM]])
const itCompaction = testEffect(compactionEnv)

itNakedEnd.effect(
  "session.processor naked end fails the attempt with a retryable ResponseStreamError",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "naked end")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          // Each retry re-streams the same text; the loop guard accumulates
          // across attempts (it is reset per process, not per retry). Disable
          // it so every attempt reaches the naked-end reconcile.
          loopGuardEnabled: false,
        })

        const fiber = yield* handle
          .process(input(chat.id, parent.id, mdl, "naked end"))
          .pipe(Effect.forkChild)

        // Drive the retry policy's backoff on the TestClock (ResponseStreamError
        // carries no HTTP status, so it takes the long unreachable-endpoint
        // budget). Each 61s step releases the next scheduled retry.
        for (let i = 0; i < 64 && !fiber.pollUnsafe(); i++) {
          yield* TestClock.adjust("61 seconds")
          yield* Effect.yieldNow
        }

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isFailure(exit)) return

        expect(exit.value).toBe("stop")
        expect(fiber.pollUnsafe()).toBeDefined()
        expect(SessionV1.APIError.isInstance(handle.message.error)).toBe(true)
        if (!SessionV1.APIError.isInstance(handle.message.error)) return
        // The naked-end failure was surfaced through the retryable stream-error
        // class, not swallowed and not stamped as a clean finish.
        expect(handle.message.error.data.message).toContain("ended without a step finish")
        expect(handle.message.error.data.isRetryable).toBe(true)
        expect(handle.message.error.data.metadata?.code).toBe("ProviderResponseStreamError")
      }),
      { config: cfg },
    ),
)

itNakedEnd.effect(
  "MessageV2.fromError classifies ResponseStreamError as a retryable APIError",
  () =>
    Effect.gen(function* () {
      const parsed = MessageV2.fromError(
        new ProviderError.ResponseStreamError("Provider stream ended without a step finish (test)"),
        { providerID: ref.providerID },
      )

      expect(SessionV1.APIError.isInstance(parsed)).toBe(true)
      if (!SessionV1.APIError.isInstance(parsed)) return
      expect(parsed.data.isRetryable).toBe(true)
      expect(parsed.data.metadata?.code).toBe("ProviderResponseStreamError")
      // The retry policy reads isRetryable through retryable(); the naked-end
      // contract is "retry the step", never a terminal unknown error.
      expect(SessionRetry.retryable(parsed, ref.providerID)).toBeDefined()
    }),
)

itLoopGuard.effect(
  "session.processor loop-guard cut is a by-design finish-less end (no naked-end failure)",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "loop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(input(chat.id, parent.id, mdl, "loop"))

        expect(handle.loopGuardFired).toBe(true)
        expect(value).toBe("continue")
        // The naked-end reconcile must not fire for the takeUntil cut: the
        // loop-guard path owns the finish-less message and re-delivers the
        // turn; a ResponseStreamError here would halt it instead.
        expect(handle.message.error).toBeUndefined()
      }),
      { config: cfg },
    ),
)

itCompaction.effect(
  "session.processor compaction end is a by-design end (no naked-end failure)",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process(input(chat.id, parent.id, mdl, "compact"))

        expect(value).toBe("compact")
        // Context overflow halts into needsCompaction; it is not retried and
        // not reclassified as a naked end.
        expect(handle.message.error).toBeUndefined()
      }),
      { config: cfg },
    ),
)
