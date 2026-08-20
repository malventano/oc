// rdt-chain-diff.ts
// Investigate: does the RDT (responses delta transport) wire body render
// byte-identically for identical DB message input?
//
// Replicates, from the opencode source (verbatim copies where possible):
//   1. MessageV2.stream()   (packages/opencode/src/session/message-v2.ts:517)
//      + a time_created <= T "as of" filter (messages are append-only, so the
//      chain at request time T is the message set with time_created <= T).
//   2. MessageV2.filterCompacted()  (message-v2.ts:613)
//   3. MessageV2.toModelMessagesEffect (message-v2.ts:134) - UIMessage build
//      + the REAL convertToModelMessages from the `ai` SDK.
//   4. ProviderTransform.message interleaved transform (transform.ts:322) -
//      DSV4-Flash: capabilities.interleaved.field = "reasoning_content".
//   5. RDT lowerMessage + toolResultString (packages/opencode/src/provider/rdt.ts:210/124).
//
// Then byte-diffs the JSON.stringify of the full item arrays.

import { Database } from "bun:sqlite"
import { convertToModelMessages, type UIMessage } from "ai"

const DB_PATH = "/root/.local/share/opencode/opencode.db"
const SESS = "ses_003cd9989ffeOWxdzi5gwDWFin"
const MODEL = { providerID: "vllm-local", id: "DSV4-Flash" } // vllm-local/DSV4-Flash
const INTERLEAVED_FIELD = "reasoning_content"

// As-of timestamps (local, 2026-08-13):
//  T0 = 20:07:27 (chain includes msg_ffd98566f  - message BEFORE the pair)
//  T1 = 20:07:32 (request A - chain includes msg_ffd9863d4)
//  T2 = 20:07:37 (request B - chain includes msg_ffd9863d4)
//  T3 = 20:07:38 (chain includes msg_ffd9883ee  - message AFTER the pair)
const T0 = 1786666047000
const T1 = 1786666052000
const T2 = 1786666057000
const T3 = 1786666058000

const db = new Database(DB_PATH, { readonly: true })

// ---------------------------------------------------------------------------
// 1. stream() replication (message-v2.ts:517) with "as of" filter
// ---------------------------------------------------------------------------
type Info = Record<string, any>
type Part = Record<string, any>
type WithParts = { info: Info; parts: Part[] }

function hydrate(rows: any[]): WithParts[] {
  const ids = rows.map((r) => r.id)
  const partByMessage = new Map<string, Part[]>()
  if (ids.length > 0) {
    const partRows = db
      .query(
        `SELECT * FROM part WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, id`,
      )
      .all(...ids) as any[]
    for (const row of partRows) {
      const next = { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id, messageID: row.message_id }
      const list = partByMessage.get(row.message_id)
      if (list) list.push(next)
      else partByMessage.set(row.message_id, [next])
    }
  }
  return rows.map((row) => ({
    info: { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id } as Info,
    parts: partByMessage.get(row.id) ?? [],
  }))
}

const cursorEncode = (c: { id: string; time: number }) =>
  Buffer.from(JSON.stringify(c)).toString("base64url")

function page(sessionID: string, asOf: number, limit: number, before: { id: string; time: number } | undefined) {
  const where = before
    ? `session_id = ? AND time_created <= ? AND (time_created < ? OR (time_created = ? AND id < ?))`
    : `session_id = ? AND time_created <= ?`
  const args = before ? [sessionID, asOf, before.time, before.time, before.id] : [sessionID, asOf]
  const rows = db
    .query(
      `SELECT * FROM message WHERE ${where} ORDER BY time_created DESC, id DESC LIMIT ${limit + 1}`,
    )
    .all(...args) as any[]
  const more = rows.length > limit
  const slice = more ? rows.slice(0, limit) : rows
  const items = hydrate(slice)
  items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursorEncode({ id: tail.id, time: tail.time_created }) : undefined,
  }
}

function stream(sessionID: string, asOf: number) {
  const size = 50
  const result = [] as WithParts[]
  let before: { id: string; time: number } | undefined
  let compactionMarkers = 0
  const completed = new Set<string>()
  while (true) {
    const next = page(sessionID, asOf, size, before)
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      const item = next.items[i]!
      result.push(item)
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
        compactionMarkers < 2 &&
        item.info.role === "user" &&
        item.parts.some((p) => p.type === "compaction") &&
        completed.has(item.info.id)
      ) {
        compactionMarkers++
      }
    }
    if (compactionMarkers >= 2) break
    if (!next.more || !next.cursor) break
    before = JSON.parse(Buffer.from(next.cursor, "base64url").toString("utf8"))
  }
  return result
}

// ---------------------------------------------------------------------------
// 2. filterCompacted() replication (message-v2.ts:613) - verbatim
// ---------------------------------------------------------------------------
function filterCompacted(msgs: Iterable<WithParts>) {
  const all = [...msgs]
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: string | undefined
  for (const msg of all) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is any => item.type === "compaction")
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
      msg.parts.some((item): item is any => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is any => item.type === "compaction" && item.tail_start_id !== undefined,
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

  const virtualIds = new Set<string>()
  for (const msg of all) {
    if (msg.info.role !== "user") continue
    if (msg.parts.some((p): p is any => p.type === "compaction" && p.virtual === true))
      virtualIds.add(msg.info.id)
  }
  const isVirtualArtifact = (m: WithParts) =>
    virtualIds.has(m.info.id) || (m.info.role === "assistant" && virtualIds.has(m.info.parentID ?? ""))

  let realMarker: WithParts | undefined
  let realSummary: WithParts | undefined
  const chronological = [...all].reverse()
  for (const msg of all) {
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((p): p is any => p.type === "compaction" && p.virtual !== true)) continue
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

  // epoch-delta render-time filter (only matters if synthetic epochDelta text
  // parts exist before the newest completed summary - deterministic anyway).
  let newestSummaryIndex = -1
  for (let i = 0; i < chronological.length; i++) {
    const m = chronological[i]!
    if (m.info.role !== "assistant" || m.info.summary !== true || !m.info.finish || m.info.error) continue
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

// ---------------------------------------------------------------------------
// 3. toModelMessagesEffect replication (message-v2.ts:134) - UIMessage build,
//    then the REAL convertToModelMessages from the ai SDK.
// ---------------------------------------------------------------------------
const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
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
          data: (() => {
            const commaIndex = attachment.url.indexOf(",")
            return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
          })(),
        })),
      ],
    }
  }
  return { type: "json", value: output as never }
}

const isMediaMime = (mime: string) =>
  mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf"

async function toModelMessages(input: WithParts[]): Promise<any[]> {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // DSV4 is @ai-sdk/openai-compatible: supportsMediaInToolResult = false for
  // ALL mime (per message-v2.ts:150-162) -> media always extracted.
  for (const msg of input) {
    if (msg.parts.length === 0) continue
    if (msg.info.role === "user") {
      const userMessage: UIMessage = { id: msg.info.id, role: "user", parts: [] }
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored && part.text !== "")
          userMessage.parts.push({ type: "text", text: part.text })
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          userMessage.parts.push({
            type: "file",
            url: part.url,
            mediaType: part.mime,
            filename: part.filename,
          })
        }
        if (part.type === "compaction") {
          userMessage.parts.push({ type: "text", text: "[Compacted summary of the prior conversation]" })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({ type: "text", text: "The following tool was executed by the user" })
        }
      }
      if (userMessage.parts.length > 0) result.push(userMessage)
    }
    if (msg.info.role === "assistant") {
      const differentModel = `${MODEL.providerID}/${MODEL.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string; filename?: string }> = []
      // All DB-loaded errors are plain objects; AbortedError.isInstance etc.
      // are all false for plain objects -> any error skips the message.
      if (msg.info.error) continue
      const assistantMessage: UIMessage = { id: msg.info.id, role: "assistant", parts: [] }
      const hasSignedReasoning = msg.parts.some((part) => {
        if (part.type !== "reasoning") return false
        return part.metadata?.anthropic?.signature != null
      })
      for (const part of msg.parts) {
        if (part.type === "text") {
          const text = part.text === "" && hasSignedReasoning ? " " : part.text
          assistantMessage.parts.push({ type: "text", text })
        }
        if (part.type === "step-start") assistantMessage.parts.push({ type: "step-start" })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, undefined)
            const attachments = part.state.time.compacted ? [] : (part.state.attachments ?? [])
            const mediaAttachments = attachments.filter((a) => isMediaMime(a.mime))
            if (mediaAttachments.length > 0) media.push(...mediaAttachments) // all unsupported for openai-compatible
            const finalAttachments = [] // none supported
            const output = finalAttachments.length > 0 ? { text: outputText, attachments: finalAttachments } : outputText
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
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
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
              })
            }
          }
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
            })
        }
        if (part.type === "reasoning") {
          assistantMessage.parts.push({ type: "reasoning", text: part.text })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        if (media.length > 0) {
          result.push({
            id: `msg_media_${assistantMessage.id}`,
            role: "user",
            parts: [
              { type: "text" as const, text: SYNTHETIC_ATTACHMENT_PROMPT },
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
  return await convertToModelMessages(
    result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
    { tools },
  )
}

// ---------------------------------------------------------------------------
// 4. ProviderTransform.message interleaved transform (transform.ts:322)
// ---------------------------------------------------------------------------
function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

function applyInterleaved(msgs: any[]): any[] {
  const field = INTERLEAVED_FIELD
  return msgs.map((msg) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
      const reasoningText = reasoningParts.map((part: any) => part.text).join("")
      const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")
      return {
        ...msg,
        content: filteredContent,
        providerOptions: {
          ...msg.providerOptions,
          openaiCompatible: {
            ...msg.providerOptions?.openaiCompatible,
            [field]: reasoningText,
          },
        },
      }
    }
    return msg
  })
}

// ---------------------------------------------------------------------------
// 5. RDT lowerMessage + toolResultString (rdt.ts:210 / 124) - verbatim
// ---------------------------------------------------------------------------
type V3Part = { type: string; [k: string]: unknown }

const toolResultString = (output: unknown): string => {
  if (output == null) return ""
  if (typeof output === "string") return output
  if (typeof output !== "object") return String(output)
  const o = output as { type?: string; value?: unknown }
  if (o.type === "text") return String(o.value ?? "")
  if (o.type === "json") return JSON.stringify(o.value ?? "")
  if (o.type === "content") {
    const parts = Array.isArray(o.value) ? (o.value as V3Part[]) : []
    return parts
      .map((p) => (typeof p.text === "string" ? p.text : JSON.stringify(p)))
      .join("")
  }
  return JSON.stringify(output)
}

function lowerMessage(msg: any): Record<string, unknown>[] {
  const content = Array.isArray(msg.content) ? (msg.content as unknown as V3Part[]) : []
  if (msg.role === "system") {
    return [{ role: "system", content: [{ type: "input_text", text: String(msg.content ?? "") }] }]
  }
  if (msg.role === "user") {
    const items = content.flatMap((p): unknown[] => {
      if (p.type === "text") return [{ type: "input_text", text: p.text ?? "" }]
      if (p.type === "file") {
        const data = typeof p.data === "string" ? p.data : ""
        return [{ type: "input_image", image_url: data }]
      }
      return []
    })
    return [{ role: "user", content: items }]
  }
  if (msg.role === "tool") {
    const first = content.find((p) => p.type === "tool-result")
    if (first) {
      return [
        {
          type: "function_call_output",
          call_id: String(first.toolCallId ?? ""),
          output: toolResultString(first.output),
        },
      ]
    }
    return [{ type: "function_call_output", call_id: "", output: "" }]
  }
  const reasoningItems: Record<string, unknown>[] = []
  const textParts: unknown[] = []
  const callItems: Record<string, unknown>[] = []
  for (const p of content) {
    if (p.type === "reasoning")
      reasoningItems.push({
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: p.text ?? "" }],
      })
    else if (p.type === "text") textParts.push({ type: "input_text", text: p.text ?? "" })
    else if (p.type === "tool-call")
      callItems.push({
        type: "function_call",
        call_id: String(p.toolCallId ?? ""),
        name: String(p.toolName ?? ""),
        arguments: JSON.stringify(p.input ?? {}),
      })
  }
  {
    const poi = (msg as unknown as { providerOptions?: Record<string, unknown> }).providerOptions
    const oc = poi?.openaiCompatible as Record<string, unknown> | undefined
    const interleavedText =
      typeof oc?.reasoning_content === "string"
        ? oc.reasoning_content
        : typeof oc?.reasoning_details === "string"
          ? oc.reasoning_details
          : typeof oc?.reasoning === "string"
            ? oc.reasoning
            : undefined
    if (interleavedText && interleavedText.length > 0) {
      reasoningItems.push({
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: interleavedText }],
      })
    }
  }
  const out: Record<string, unknown>[] = [...reasoningItems]
  if (textParts.length > 0) out.push({ role: "assistant", content: textParts })
  out.push(...callItems)
  return out
}

// ---------------------------------------------------------------------------
// renderChain: WithParts -> items (the responses `input` field array)
// ---------------------------------------------------------------------------
async function renderChain(asOf: number) {
  const msgs = stream(SESS, asOf)
  const filtered = filterCompacted(msgs)
  const modelMsgs = await toModelMessages(filtered)
  const transformed = applyInterleaved(modelMsgs)
  const inputMsgs = transformed.filter((m) => m.role !== "system")
  const items = inputMsgs.flatMap(lowerMessage)
  return { msgs, filtered, modelMsgs, items, inputMsgs }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function firstDiff(a: string, b: string) {
  const max = Math.min(a.length, b.length)
  for (let i = 0; i < max; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i
  return a.length === b.length ? -1 : max
}

const comp = (items: any[]) => {
  const m: Record<string, { n: number; chars: number }> = {}
  for (const it of items) {
    const type = String(it.type ?? it.role ?? "?")
    const c = m[type] ?? { n: 0, chars: 0 }
    c.n++; c.chars += JSON.stringify(it).length
    m[type] = c
  }
  return m
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("=== Render chain @20:07:32 and @20:07:37 ===")
const c1 = await renderChain(T1)
const c2 = await renderChain(T2)
const s1 = JSON.stringify(c1.items)
const s2 = JSON.stringify(c2.items)
console.log("chain A raw:", c1.msgs.length, "filtered:", c1.filtered.length, "modelMsgs:", c1.modelMsgs.length, "items:", c1.items.length)
console.log("chain B raw:", c2.msgs.length, "filtered:", c2.filtered.length, "modelMsgs:", c2.modelMsgs.length, "items:", c2.items.length)
console.log("A items bytes:", Buffer.byteLength(s1, "utf8"))
console.log("B items bytes:", Buffer.byteLength(s2, "utf8"))

if (s1 === s2) {
  console.log("RESULT: chains @20:07:32 and @20:07:37 render IDENTICAL item arrays")
} else {
  const d = firstDiff(s1, s2)
  console.log("RESULT: chains DIFFER. first byte diff at item-array offset", d)
  let acc = 0
  for (let i = 0; i < c1.items.length; i++) {
    const seg = JSON.stringify(c1.items[i]) + (i < c1.items.length - 1 ? "," : "")
    if (acc + seg.length > d) {
      console.log("  diff inside item idx", i, JSON.stringify(c1.items[i]).slice(0, 120))
      console.log("  A item:", seg.slice(0, 200))
      console.log("  B item:", (JSON.stringify(c2.items[i] ?? "MISSING") ?? "").slice(0, 200))
      break
    }
    acc += seg.length
  }
  console.log("  A bytes around diff:", JSON.stringify(s1.slice(Math.max(0, d - 60), d + 60)))
  console.log("  B bytes around diff:", JSON.stringify(s2.slice(Math.max(0, d - 60), d + 60)))
}
console.log("A comp:", JSON.stringify(comp(c1.items)))
console.log("B comp:", JSON.stringify(comp(c2.items)))

// Determinism: same chain rendered twice
console.log("\n=== Determinism: render chain @20:07:32 twice ===")
const c1b = await renderChain(T1)
const s1b = JSON.stringify(c1b.items)
console.log("identical:", s1 === s1b, "bytes:", Buffer.byteLength(s1, "utf8"))

// Key-order stability
console.log("\n=== Key order stability ===")
const objStable = { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"x":1}' }
const objReordered = { type: "function_call", call_id: "call_1", arguments: '{"x":1}', name: "bash" }
const sStable = JSON.stringify(objStable)
const sReordered = JSON.stringify(objReordered)
console.log("stable:", sStable)
console.log("reordered:", sReordered)
console.log("JSON.stringify preserves insertion order:", sStable !== sReordered ? "YES (order matters, but is stable per construction)" : "no diff")
console.log("lowerMessage function_call literal, rendered twice identical:",
  JSON.stringify(lowerMessage({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "n", input: { a: 1 } }] })) ===
  JSON.stringify(lowerMessage({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "n", input: { a: 1 } }] })))
console.log("toolResultString branches:")
console.log("  text:", JSON.stringify(toolResultString({ type: "text", value: "hello" })))
console.log("  json:", JSON.stringify(toolResultString({ type: "json", value: { b: 1, a: 2 } })))
console.log("  content:", JSON.stringify(toolResultString({ type: "content", value: [{ type: "text", text: "ab" }, { type: "media", mediaType: "image/png", data: "AA" }] })))

// Append-only growth: T0 (before) -> T1 -> T3 (after)
console.log("\n=== Append-only growth: T0=20:07:27 -> T1=20:07:32 -> T3=20:07:38 ===")
const c0 = await renderChain(T0)
const c3 = await renderChain(T3)
const s0 = JSON.stringify(c0.items)
const s3 = JSON.stringify(c3.items)
const msgDiffs = db.query(
  `SELECT id, time_created, json_extract(data,'$.role') role FROM message WHERE session_id=? AND time_created > ? AND time_created <= ? ORDER BY time_created`,
).all(SESS, T0, T3) as any[]
console.log("DB messages created in (T0, T3]:", JSON.stringify(msgDiffs.map((b) => `${b.id}@${new Date(b.time_created).toISOString()}(${b.role})`)))

const compare = (label: string, a: any, b: any, sa: string, sb: string) => {
  const ia = a.filtered.map((m: any) => m.info.id)
  const ib = b.filtered.map((m: any) => m.info.id)
  const p = Math.min(ia.length, ib.length)
  let pref = p
  for (let i = 0; i < p; i++) if (ia[i] !== ib[i]) { pref = i; break }
  console.log(`--- ${label}: A=${a.filtered.length}msgs/${a.items.length}items(${Buffer.byteLength(sa, "utf8")}B) B=${b.filtered.length}msgs/${b.items.length}items(${Buffer.byteLength(sb, "utf8")}B)`)
  if (pref !== p) {
    console.log("  PREFIX MISMATCH at msg idx", pref, ia[pref], "vs", ib[pref])
    return
  }
  console.log("  shared message-id prefix:", pref, "of", p)
  // JSON array serialization: appending items changes the closing "]" of the
  // shorter render into "," + extra items + "]". So the correct append-only
  // check is sb.startsWith(sa minus its final "]"), OR byte-identity.
  const d = firstDiff(sa, sb)
  const appendOnly = d >= sa.length - 1 && sb.startsWith(sa.slice(0, -1))
  console.log("  item strings: byte-identical:", d === -1, "| append-only:", appendOnly)
  if (d !== -1) {
    console.log("  first byte diff at offset", d, "(saLen", sa.length, "sbLen", sb.length, ")")
    console.log("  A around diff:", JSON.stringify(sa.slice(Math.max(0, d - 40), d + 40)))
    console.log("  B around diff:", JSON.stringify(sb.slice(Math.max(0, d - 40), d + 40)))
  }
  console.log("  A-only tail msgs:", ia.slice(p).map((id: string) => id.slice(0, 18)).join(", "))
  console.log("  B-only tail msgs:", ib.slice(p).map((id: string) => id.slice(0, 18)).join(", "))
}

await compare("T0->T1", c0, c1, s0, s1)
await compare("T1->T3", c1, c3, s1, s3)
await compare("T0->T3", c0, c3, s0, s3)

// In-flight tool state caveat: the boundary message's tool output was finalized
// AFTER both T1 and T2 (reminder ts 00:07:38Z). Check which boundary tool parts
// carry a completion timestamp later than T2 (i.e. were RUNNING at request time).
console.log("\n=== In-flight tool parts (finalized after T2, running at request time) ===")
const boundIds = ["msg_ffd9863d4001BGwy7enxQfnEBs", "msg_ffd9883ee001AGx0QqjgsfxgO8", "msg_ffd98566f001q7tqKp8YRpuxKY"]
for (const id of boundIds) {
  const parts = db.query(`select data from part where message_id=? and json_extract(data,'$.type')='tool'`).all(id) as any[]
  for (const p of parts) {
    const d = JSON.parse(p.data)
    const m = d.state?.time?.end
    const outEnd = d.state?.output?.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g)?.pop()
    console.log(id.slice(0, 18), d.tool, "status:", d.state?.status, "time.end:", m ? new Date(m).toISOString() : "-", "outTailTs:", outEnd)
  }
}
