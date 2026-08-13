import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { SessionRunState } from "../../src/session/run-state"
import { pollWithTimeout } from "../lib/effect"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), LayerNode.compile(SessionRunState.node), httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session action routes", () => {
  it.instance(
    "session routes expose metadata on create, update, get, and fork",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "Content-Type": "application/json" }

        const created = yield* requestInDirectory("/session", test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "meta-session",
            metadata: { source: "sdk", trace: { id: "abc" } },
          }),
        })
        expect(created.status).toBe(200)

        const session = (yield* created.json) as SessionNs.Info
        expect(session.metadata).toEqual({ source: "sdk", trace: { id: "abc" } })

        const updated = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: { source: "sdk", trace: { id: "def" }, tags: ["one"] } }),
        })
        expect(updated.status).toBe(200)

        const next = (yield* updated.json) as SessionNs.Info
        expect(next.metadata).toEqual({ source: "sdk", trace: { id: "def" }, tags: ["one"] })

        const fetched = yield* requestInDirectory(`/session/${session.id}`, test.directory)
        expect(fetched.status).toBe(200)
        expect(((yield* fetched.json) as SessionNs.Info).metadata).toEqual(next.metadata)

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(200)

        const fork = (yield* forked.json) as SessionNs.Info
        expect(fork.metadata).toEqual(next.metadata)

        const reset = yield* requestInDirectory(`/session/${session.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ metadata: {} }),
        })
        expect(reset.status).toBe(200)
        expect(((yield* reset.json) as SessionNs.Info).metadata).toEqual({})

        yield* SessionNs.Service.use((svc) => svc.remove(fork.id).pipe(Effect.ignore))
        yield* SessionNs.Service.use((svc) => svc.remove(session.id).pipe(Effect.ignore))
      }),
    { git: true },
  )
  it.instance(
    "fork route rejects busy sessions with 409",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const runState = yield* SessionRunState.Service
        // Keep a fake turn running so the source session is busy.
        const fiber = yield* runState
          .ensureRunning(session.id, Effect.never, Effect.never)
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const busy = Exit.isFailure(yield* runState.assertNotBusy(session.id).pipe(Effect.exit))
            return busy ? (true as const) : undefined
          }),
          "session never became busy",
        )

        const forked = yield* requestInDirectory(`/session/${session.id}/fork`, test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(forked.status).toBe(409)

        yield* Fiber.interrupt(fiber)
      }),
    { git: true },
  )

  it.instance(
    "fork targets return only user messages with their parts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({ title: "fork-targets" }), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const user = yield* SessionNs.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: session.id,
            agent: "default",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          } as SessionV1.User),
        )
        yield* SessionNs.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            role: "assistant" as const,
            sessionID: session.id,
            mode: "default",
            agent: "default",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            parentID: user.id,
            time: { created: 2 },
          } as SessionV1.Assistant),
        )
        yield* SessionNs.Service.use((svc) =>
          svc.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "fork me",
          } as SessionV1.Part),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/fork-targets`, test.directory)
        expect(res.status).toBe(200)
        const targets = (yield* res.json) as { info: { id: string; role: string }; parts: { type: string }[] }[]
        expect(targets).toHaveLength(1)
        expect(targets[0]?.info.id).toBe(user.id)
        expect(targets[0]?.parts.some((p) => p.type === "text")).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "abort route returns success",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "experimental background route is a no-op without synchronous subagents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const res = yield* requestInDirectory(`/experimental/session/${session.id}/background`, test.directory, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(yield* res.json).toBe(false)
      }),
    { git: true },
  )
})
