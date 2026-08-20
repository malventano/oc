import { SessionID, MessageID } from "./schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import {
  APIError,
  AbortedError,
  LoopGuardTrimError,
  StallGuardError,
  Assistant,
  AuthError,
  CompactionPart,
  ContextOverflowError,
  Info,
  OutputLengthError,
  Part,
  SubtaskPart,
  User,
  WithParts,
} from "@opencode-ai/core/v1/session"

import { NamedError } from "@opencode-ai/core/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { Effect, Option, Schema } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"
export { isMedia }

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const Event = {
  Updated: SessionV1.Event.MessageUpdated,
  Removed: SessionV1.Event.MessageRemoved,
  PartUpdated: SessionV1.Event.PartUpdated,
  PartDelta: SessionV1.Event.PartDelta,
  PartRemoved: SessionV1.Event.PartRemoved,
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

const part = (row: typeof PartTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  }) as Part

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

function hydrate(db: Database.Interface["db"], rows: (typeof MessageTable.$inferSelect)[]) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, Part[]>()
  return Effect.gen(function* () {
    if (ids.length > 0) {
      const partRows = yield* db
        .select()
        .from(PartTable)
        .where(inArray(PartTable.message_id, ids))
        .orderBy(PartTable.message_id, PartTable.id)
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support that media type in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Some SDKs only support a subset
  // of media in tool results; e.g. Bedrock supports images but not PDFs there.
  //
  // Only apply this workaround if the model actually supports that media input -
  // otherwise unsupportedParts() will turn it into a user-visible error.
  const supportsMediaInToolResult = (attachment: { mime: string }) => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock/mantle") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/xai") return attachment.mime.startsWith("image/")
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  }

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: iife(() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            }),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      for (const part of msg.parts) {
        // User message parts should never be empty
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "[Compacted summary of the prior conversation]",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []

      if (
        msg.info.error &&
        !StallGuardError.isInstance(msg.info.error) &&
        !LoopGuardTrimError.isInstance(msg.info.error) &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      // Anthropic adaptive thinking can persist assistant turns like:
      // step-start, reasoning(signature), text(""), step-start,
      // reasoning(signature). The empty text part is a structural separator,
      // but it does not carry the signature metadata itself. Dropping it shifts
      // signed thinking positions after step-start splitting/provider regrouping;
      // keeping it as "" is filtered by the AI SDK and rejected by Anthropic.
      // It is unclear whether this shape originates in our stream processing,
      // a proxy, or a lower-level library, but preserving a non-empty separator
      // here is the only safe replay point we have.
      // Use a single space so the separator survives replay without changing
      // the neighboring signed reasoning blocks.
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({
            type: "text",
            text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
            if (extractedMedia.length > 0) {
              media.push(...extractedMedia)
            }
            const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            // Strip providerMetadata on model switch to avoid provider-specific
            // leakage (e.g., Bedrock thinking signatures), but preserve the
            // reasoning part type for prefix cache compatibility
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
            })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
                filename: attachment.filename,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(() =>
    convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options))
}

export const page = Effect.fn("MessageV2.page")(function* (input: {
  sessionID: SessionID
  limit: number
  before?: string
}) {
  const { db } = yield* Database.Service
  const before = input.before ? cursor.decode(input.before) : undefined
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : eq(MessageTable.session_id, input.sessionID)
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(where)
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) {
    const row = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = yield* hydrate(db, slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
})

// Fork-dialog targets: user messages only (chronological), with their parts.
// The TUI sync store keeps only the last 100 messages of a session, so the
// fork dialog cannot list full history from the store - this query skips the
// assistant/tool message rows entirely (the bulk of a large session) and
// returns just what the dialog renders: user prompts + their parts.
export const forkTargets = Effect.fn("MessageV2.forkTargets")(function* (input: { sessionID: SessionID }) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(MessageTable)
    .where(
      and(eq(MessageTable.session_id, input.sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`),
    )
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
    .pipe(Effect.orDie)
  return yield* hydrate(db, rows)
})
// Resume-mode lookup: agent of the session's last user message, one indexed
// row read, uncapped. Clients restore the plan/build mode from this on
// session open; a message-window cap would miss sessions whose final turn
// ran more assistant messages than the window (all newer than the user
// message that parented them).
export const lastUserAgent = Effect.fn("MessageV2.lastUserAgent")(function* (input: { sessionID: SessionID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ agent: sql<string>`json_extract(${MessageTable.data}, '$.agent')` })
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, input.sessionID),
        sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
      ),
    )
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row?.agent ? Option.some(row.agent) : Option.none()
})

export function stream(sessionID: SessionID) {
  const size = 50
  return Effect.gen(function* () {
    const result = [] as WithParts[]
    let before: string | undefined
    // Walkback cap (0188): never page the ENTIRE session - the upstream
    // stream() walked all 14k+ messages per step (278 pages, ~1.2s msgs-load
    // at deep sessions) even though filterCompacted only ever keeps the
    // newest compaction boundary + its tail. Stop once TWO COMPLETED
    // compaction pairs have been loaded AND the newest completed marker's
    // tail_start_id is inside the loaded window, walking newest-first. The
    // window then covers the whole pre-compaction tail (everything newer than
    // the 2nd-newest completed marker) plus one marker of safety margin - the
    // filterCompacted context, the epoch boundary + records, and
    // MessageV2.latest() all operate within it. A session with < 2 completed
    // pairs pages to the start naturally (next.more).
    //
    // Only a marker with a COMPLETED summary counts toward the cap (assistant
    // child with summary + finish + no error - the same criterion as
    // filterCompacted / epoch / 0148). An IN-FLIGHT or ABORTED compaction's
    // marker must NOT shift the window. In particular, the compaction turn's
    // OWN new marker is in flight when its summary request is built: counting
    // it moves the 2nd-newest boundary forward and DROPS every message that
    // fell between the old and new boundaries from the compaction request's
    // chain, breaking the prefix-cache byte identity (witnessed 2026-08-18:
    // the compaction summary request full-missed - its chain lost a 37-message
    // pre-marker block and reordered the tail).
    // The tail-reachability requirement closes the gap the 2-marker rule alone
    // leaves open (witnessed 2026-08-19): a newest completed marker whose
    // tail_start_id sits OLDER than the 2nd-newest completed marker (a tail
    // computed from an earlier truncated window) falls outside the 2-marker
    // window, so filterCompacted's retain cut never fires and the raw sliding
    // walk window is sent verbatim - evicting the oldest messages every turn
    // (pcap-verified: full ~200k re-prefill, cache.read pinned at the system
    // prompt). Without the tail loaded, the wire prefix shifts each request.
    let compactionMarkers = 0
    let retainTarget: MessageID | undefined
    let retainLoaded = true
    const completed = new Set<string>()
    while (true) {
      const next = yield* page({ sessionID, limit: size, before }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () =>
          Effect.succeed({ items: [] as WithParts[], more: false, cursor: undefined }),
        ),
      )
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i]
        if (!item) continue
        result.push(item)
        // Newest-first: a marker's summary (created after it) is seen BEFORE
        // the marker, so the completed set is populated before the check.
        if (
          item.info.role === "assistant" &&
          item.info.summary === true &&
          item.info.finish &&
          !item.info.error &&
          item.info.parentID
        ) {
          completed.add(item.info.parentID)
        }
        if (
          item.info.role === "user" &&
          item.parts.some((p): p is CompactionPart => p.type === "compaction") &&
          completed.has(item.info.id)
        ) {
          if (retainTarget === undefined && compactionMarkers === 0) {
            // Newest completed marker. Its tail_start_id is the boundary
            // filterCompacted must be able to reach for its deterministic
            // retain cut to fire.
            const part = item.parts.find((p): p is CompactionPart => p.type === "compaction")
            retainTarget = part?.tail_start_id
            retainLoaded = retainTarget === undefined
          }
          if (retainTarget !== undefined && item.info.id === retainTarget) retainLoaded = true
          if (compactionMarkers < 2) compactionMarkers++
        }
      }
      if (retainLoaded && compactionMarkers >= 2) break
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
    return result
  })
}

export function parts(messageID: MessageID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(PartTable)
      .where(eq(PartTable.message_id, messageID))
      .orderBy(PartTable.id)
      .all()
      .pipe(Effect.orDie)
    return rows.map(part)
  })
}

export const get = Effect.fn("MessageV2.get")(function* (input: { sessionID: SessionID; messageID: MessageID }) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(MessageTable)
    .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
  return {
    info: info(row),
    parts: yield* parts(input.messageID),
  }
})

export function filterCompacted(msgs: Iterable<WithParts>) {
  const all = [...msgs]
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of all) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()

  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  const ordered = (() => {
    if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
      return [
        ...result.slice(compactionIndex, summaryIndex + 1),
        ...result.slice(tailIndex, compactionIndex),
        ...result.slice(summaryIndex + 1),
      ]
    }
    return result
  })()

  // Virtual compaction markers and their synthetic summaries are TUI
  // artifacts: they must never reach the model request. The retain cut above
  // targets the newest marker's tail; when that tail is newer than the last
  // REAL compaction pair (a virtual compact subtracting another marker), the
  // pair is cut too, so it is re-inserted at the front of the result.
  const virtualIds = new Set<string>()
  for (const msg of all) {
    if (msg.info.role !== "user") continue
    if (msg.parts.some((p): p is CompactionPart => p.type === "compaction" && p.virtual === true))
      virtualIds.add(msg.info.id)
  }
  const isVirtualArtifact = (m: WithParts) =>
    virtualIds.has(m.info.id) || (m.info.role === "assistant" && virtualIds.has(m.info.parentID ?? ""))

  // Find the NEWEST COMPLETED real (non-virtual) compaction pair: stream
  // order is newest-first, so the first real marker WITH a finished summary
  // is the newest completed pair. An in-flight marker (the compaction turn
  // itself - no summary yet) must NOT satisfy the re-insertion: it is always
  // already in the output, so the unshift would never fire and the completed
  // pair dropped by the virtual cut stays dropped - the request then
  // diverges from the cached chain at the first message (full prefix miss on
  // the compaction prompt submission). Only the newest pair can be cut by
  // the retain logic above, so older pairs need no re-insertion.
  let realMarker: WithParts | undefined
  let realSummary: WithParts | undefined
  const chronological = [...all].reverse()
  for (const msg of all) {
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((p): p is CompactionPart => p.type === "compaction" && p.virtual !== true)) {
      continue
    }
    const summary = chronological.find(
      (s) => s.info.role === "assistant" && s.info.summary && s.info.parentID === msg.info.id,
    )
    if (!summary) continue
    realMarker = msg
    realSummary = summary
    break
  }

  const out = ordered.filter((m) => !isVirtualArtifact(m))
  if (realMarker && !out.some((m) => m.info.id === realMarker!.info.id)) {
    out.unshift(...(realSummary ? [realMarker, realSummary] : [realMarker]))
  }

  // Frozen-system epochs: a delta part announces drift against the snapshot
  // of the epoch that created it. A compaction resets the epoch (new
  // snapshot on the next user message), so deltas from superseded epochs are
  // stale - the fresh snapshot already carries the change - and must not
  // reach the model. Render-time filter only: the parts stay in the DB, so
  // undoing past a compaction removes the pair, the boundary reverts, and
  // the deltas resurface naturally. Boundary: the chronologically newest
  // REAL summary (virtual markers and their synthetic summaries are TUI
  // artifacts, excluded here too); deltas on user messages at-or-before it
  // belong to superseded epochs.
  let newestSummaryIndex = -1
  for (let i = 0; i < chronological.length; i++) {
    const m = chronological[i]!
    // Only a COMPLETED summary advances the boundary (same criteria as the
    // walk's completed-set): an aborted compaction (cancelled summary turn
    // or cancelled retain-selection finalize) leaves a summary:true message
    // with an error and no finish. Counting it would jump the boundary past
    // user messages that still carry live epoch deltas, stripping them
    // mid-chain - the request bytes diverge from the cached prefix at that
    // point and the entire remaining chain re-prefills (full prefix miss on
    // the next compaction prompt submission, live 2026-08-16: cache.read
    // dropped from 658K to 8.9K after a cancelled compaction).
    if (
      m.info.role !== "assistant" ||
      m.info.summary !== true ||
      !m.info.finish ||
      m.info.error
    ) {
      continue
    }
    if (virtualIds.has(m.info.parentID ?? "")) continue
    newestSummaryIndex = i
  }
  if (newestSummaryIndex >= 0) {
    const preBoundary = new Set(chronological.slice(0, newestSummaryIndex + 1).map((m) => m.info.id))
    for (const msg of out) {
      if (msg.info.role !== "user" || !preBoundary.has(msg.info.id)) continue
      msg.parts = msg.parts.filter((p) => !(p.type === "text" && p.synthetic && p.metadata?.epochDelta))
    }
  }
  return out
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return filterCompacted(yield* stream(sessionID))
})

// filterCompacted reorders messages for model consumption
// ([compaction-user, summary, ...retained tail..., continue-user]), so array
// position is not chronological. IDs are only a deterministic tie-breaker
// because imported messages do not necessarily have monotonic IDs.
export function latest(msgs: WithParts[]) {
  let user: User | undefined
  let assistant: Assistant | undefined
  let finished: Assistant | undefined
  for (const msg of msgs) {
    const info = msg.info
    if (info.role === "user" && isAfter(info, user)) user = info
    if (info.role === "assistant" && isAfter(info, assistant)) assistant = info
    if (info.role === "assistant" && info.finish && isAfter(info, finished)) finished = info
  }
  const tasks = msgs.flatMap((m) =>
    finished && !isAfter(m.info, finished)
      ? []
      : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
  )
  return { user, assistant, finished, tasks }
}

export function isAfter(info: Info, other?: Info) {
  if (!other) return true
  if (info.time.created !== other.time.created) return info.time.created > other.time.created
  return info.id > other.id
}

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderV2.ID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      return new AbortedError(
        { message: e.message },
        {
          cause: e,
        },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      if (ctx.aborted) {
        return new AbortedError({ message: e.message }, { cause: e }).toObject()
      }
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.HeaderTimeoutError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
            timeoutMs: String(e.ms),
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof ProviderError.ResponseStreamError:
      return new APIError(
        {
          message: e.message,
          isRetryable: true,
          metadata: {
            code: e.name,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

export * as MessageV2 from "./message-v2"
export const node = LayerNode.group([Database.node])
