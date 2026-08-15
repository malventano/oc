export * as SessionV1 from "./session"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"
import { NamedError } from "../util/error"

export {
  AgentPart,
  AgentPartInput,
  Assistant,
  CompactionPart,
  Event,
  FilePart,
  FilePartInput,
  FilePartSource,
  FileSource,
  Format,
  Info,
  MessageID,
  OutputFormatJsonSchema,
  OutputFormatText,
  Part,
  PartID,
  PatchPart,
  Range,
  ReasoningPart,
  ResourceSource,
  RetryPart,
  SessionInfo,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SubtaskPart,
  SubtaskPartInput,
  SymbolSource,
  TextPart,
  TextPartInput,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
  User,
  WithParts,
} from "@opencode-ai/schema/session-v1"

export const OutputLengthError = NamedError.create("MessageOutputLengthError", {})
export const AuthError = NamedError.create("ProviderAuthError", { providerID: Schema.String, message: Schema.String })
export const AbortedError = NamedError.create("MessageAbortedError", { message: Schema.String })
export const StallGuardError = NamedError.create("StallGuardError", { message: Schema.String })
// Loop-guard trim: the message was truncated at the loop start and KEEPS its
// preserved prefix in the model request (exempted from the toModelMessage
// error-skip alongside StallGuardError). Red banner like the full drop, but
// the model continues from its own pre-loop text.
export const LoopGuardTrimError = NamedError.create("LoopGuardTrimError", { message: Schema.String })
export const StructuredOutputError = NamedError.create("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const APIError = NamedError.create("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = Schema.Schema.Type<typeof APIError.Schema>
export const ContextOverflowError = NamedError.create("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})
export const ContentFilterError = NamedError.create("ContentFilterError", { message: Schema.String })
