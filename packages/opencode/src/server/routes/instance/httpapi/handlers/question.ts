import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { QuestionNotFoundError } from "../errors"

// Open-ended question tool: the asking turn ends with the question pending,
// so the tool result part (written by the processor with the "pending"
// placeholder) is updated here with the actual answers once the user replies
// (or marked interrupted on reject) - the answers also re-enter the
// conversation as a new user prompt from the TUI.
function toolResultOutput(info: Question.Request, answers: ReadonlyArray<Question.Answer>) {
  const formatted = info.questions
    .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

function toolStartTime(part: SessionV1.ToolPart): number {
  const s = part.state
  if (s.status === "running" || s.status === "completed" || s.status === "error") return s.time.start
  return Date.now()
}

function toolMetadata(part: SessionV1.ToolPart): Record<string, any> {
  const s = part.state
  if (s.status === "completed" || s.status === "error") return s.metadata ?? {}
  return {}
}

const writeToolResult = Effect.fn("QuestionHttpApi.writeToolResult")(function* (
  info: Question.Request,
  answers: ReadonlyArray<Question.Answer>,
) {
  const session = yield* Session.Service
  const database = yield* Database.Service
  const tool = info.tool
  if (!tool) return
  const parts = yield* MessageV2.parts(tool.messageID).pipe(Effect.provideService(Database.Service, database))
  const part = parts.find((p) => p.type === "tool" && p.callID === tool.callID)
  if (!part || part.type !== "tool") return
  yield* session.updatePart({
    ...part,
    state: {
      status: "completed",
      input: part.state.input,
      output: toolResultOutput(info, answers),
      metadata: { requestID: info.id, answers: answers.map((a) => [...a]) },
      title: `Asked ${info.questions.length} question${info.questions.length > 1 ? "s" : ""}`,
      time: { start: toolStartTime(part), end: Date.now() },
    },
  })
})

const writeToolRejected = Effect.fn("QuestionHttpApi.writeToolRejected")(function* (info: Question.Request) {
  const session = yield* Session.Service
  const database = yield* Database.Service
  const tool = info.tool
  if (!tool) return
  const parts = yield* MessageV2.parts(tool.messageID).pipe(Effect.provideService(Database.Service, database))
  const part = parts.find((p) => p.type === "tool" && p.callID === tool.callID)
  if (!part || part.type !== "tool") return
  yield* session.updatePart({
    ...part,
    state: {
      status: "error",
      input: part.state.input,
      error: "The user dismissed this question",
      metadata: { ...toolMetadata(part), interrupted: true },
      time: { start: toolStartTime(part), end: Date.now() },
    },
  })
})

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    const session = yield* Session.Service
    const database = yield* Database.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          answers: ctx.payload.answers,
        })
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
          Effect.tap((result) =>
            result?.info.tool
              ? writeToolResult(result.info, result.answers).pipe(
                  Effect.provideService(Session.Service, session),
                  Effect.provideService(Database.Service, database),
                  Effect.ignore,
                )
              : Effect.void,
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.reject(ctx.params.requestID).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
        Effect.tap((result) =>
          result?.info.tool
            ? writeToolRejected(result.info).pipe(
                Effect.provideService(Session.Service, session),
                Effect.provideService(Database.Service, database),
                Effect.ignore,
              )
            : Effect.void,
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
