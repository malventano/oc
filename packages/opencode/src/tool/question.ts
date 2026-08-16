import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import { ToolJsonSchema } from "./json-schema"

// The MoE models stringify the questions payload ~30% of the time
// (measured on Qwen3.6-35B). The WIRE schema (Parameters, what the LLM
// sees and what the snapshot pins) stays array-only - byte-identical to
// pre-0134, no prefix-cache change, no union exposure. Tool-call DECODING
// uses the lenient DecodeParameters twin instead: a stringified payload
// is parsed back into a real array; malformed strings fail with a
// JSON.parse hint, not a generic SchemaError.
const Questions = Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" })

export const Parameters = Schema.Struct({
  questions: Questions,
})

/** @internal Exported for tests - the lenient decode twin. */
export const DecodeParameters = Schema.Struct({
  questions: Schema.Union([Schema.String, Questions]).pipe(
    Schema.decodeTo(Questions, {
      decode: SchemaGetter.transformOrFail((value) => {
        if (typeof value !== "string") return Effect.succeed(value)
        try {
          return Effect.succeed(JSON.parse(value) as (typeof Questions)["Type"])
        } catch (error) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(Option.some(value), {
              message: `questions was sent as a string that failed JSON.parse (${error instanceof Error ? error.message : String(error)}); send a native JSON array instead`,
            }),
          )
        }
      }),
      encode: SchemaGetter.transform((value) => value),
    }),
  ),
})

type Metadata = {
  requestID: string
}

export const QuestionTool = Tool.define<typeof DecodeParameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: DecodeParameters,
      jsonSchema: ToolJsonSchema.fromSchema(Parameters),
      execute: (params: Schema.Schema.Type<typeof DecodeParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // Open-ended ask: register the pending question and return
          // immediately - the turn ends with the question asked, and the
          // answers arrive later as the user's next prompt (the reply
          // handler writes this tool's result part).
          const requestID = yield* question.askOpen({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: "Question pending: the user's answers arrive in a follow-up prompt.",
            metadata: {
              requestID,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
