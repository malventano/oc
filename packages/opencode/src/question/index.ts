import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "@/session/message-v2"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
  // Escaped question tool calls whose interrupted state has NOT been written
  // yet: the rejection is lazy - it solidifies only when the user commits the
  // state with a new prompt (Enter on the restored answers text). An
  // undo/redo across it clears the entry so the question turn keeps its
  // answered bytes (byte-identical chain, no prefix miss).
  rejected: Map<SessionID, Tool>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  // Open-ended ask (question tool): registers the pending entry and returns
  // immediately - the asking turn ends with the question pending, and the
  // answers arrive later as a new user prompt (the tool result is written by
  // the reply/reject HTTP handlers).
  readonly askOpen: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<QuestionID>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<{ info: Request; answers: ReadonlyArray<Answer> } | undefined, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<{ info: Request } | undefined, NotFoundError>
  // Runtime-only cancel (undo/redo boundary moves away from the answers):
  // drops the pending entry + publishes the rejected event (the TUI closes
  // the panel) but does NOT write back into the question turn's tool part -
  // the part keeps its answered state so a later redo can re-ask it cleanly.
  readonly cancel: (requestID: QuestionID) => Effect.Effect<void>
  // Lazy rejection: the reject registers the escaped tool call here; the
  // interrupted state is written to the question turn's part only when the
  // user commits the state with a new prompt (applyRejected). Undo/redo
  // across the escape clears the entry (clearRejected) so the chain keeps
  // its answered bytes.
  readonly clearRejected: (sessionID: SessionID) => Effect.Effect<void>
  readonly applyRejected: (sessionID: SessionID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
          rejected: new Map<SessionID, Tool>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const askOpen = Effect.fn("Question.askOpen")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking-open", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return id
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
      return existing.info.tool ? { info: existing.info, answers: input.answers } : undefined
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
      // Lazy rejection: register the escaped tool call; the interrupted write
      // lands on the next prompt (applyRejected), so an undo/redo across the
      // escape keeps the question turn's answered bytes.
      if (existing.info.tool) {
        const all = yield* InstanceState.get(state)
        all.rejected.set(existing.info.sessionID, existing.info.tool)
      }
      return existing.info.tool ? { info: existing.info } : undefined
    })

    const clearRejected = Effect.fn("Question.clearRejected")(function* (sessionID: SessionID) {
      const rejected = (yield* InstanceState.get(state)).rejected
      rejected.delete(sessionID)
    })

    const applyRejected = Effect.fn("Question.applyRejected")(function* (sessionID: SessionID) {
      const all = yield* InstanceState.get(state)
      const tool = all.rejected.get(sessionID)
      if (!tool) return
      all.rejected.delete(sessionID)
      const parts = yield* MessageV2.parts(tool.messageID).pipe(Effect.provideService(Database.Service, database))
      const part = parts.find((p) => p.type === "tool" && p.callID === tool.callID)
      if (!part || part.type !== "tool") return
      const s = part.state
      const start = s.status === "running" || s.status === "completed" || s.status === "error" ? s.time.start : Date.now()
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "error",
          input: part.state.input,
          error: "The user dismissed this question",
          metadata: {
            ...(s.status === "completed" || s.status === "error" ? (s.metadata ?? {}) : {}),
            interrupted: true,
          },
          time: { start, end: Date.now() },
        },
      })
    })

    const cancel = Effect.fn("Question.cancel")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) return
      pending.delete(requestID)
      yield* Effect.logInfo("cancelled", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, askOpen, reply, reject, cancel, clearRejected, applyRejected, list })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Session.node, Database.node],
})

export * as Question from "."
