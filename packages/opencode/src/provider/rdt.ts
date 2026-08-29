// packages/opencode/src/provider/rdt.ts
// RDT: Responses Delta Transport - lean v1 (oc-spec 17 section 12).
//
// A LanguageModelV3 wrapper that, when the provider has
// options.deltaTransport === "responses", transports requests over
// /v1/responses instead of /v1/chat/completions. Sequential turns chain via
// previous_response_id (the wire win); a content hash over the already-sent
// messages decides delta vs full-send. Any change to already-sent context
// (compaction, squash-output, epoch advance, external mutation) changes the
// hash and breaks the chain -> full-send + re-seed. Appended drift does not
// touch the prefix hash -> the chain survives.
//
// v1 scope (deliberate): chain state is in-memory per session (a process
// restart loses it -> one full-send, which is the fallback path anyway);
// undo always full-sends (it rewrites the list -> hash mismatch); no DB
// migration, no SSC coupling, no anchor table. Failure ladder: an expired
// previous_response_id (4xx) clears the chain and retries the same turn once
// full; persistent failures disable delta for the session.

import { createHash } from "node:crypto"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import { APICallError } from "@ai-sdk/provider"
import type { Provider } from "@/provider/provider"

// ---------------------------------------------------------------------------
// Chain state (in-memory, per session)
// ---------------------------------------------------------------------------

type ChainState = {
  responseId: string
  /** Number of non-system messages the server holds (the chain length).
   *  This is the count of REQUEST input messages (N). Every completed response
   *  adds its full assistant output row to the server chain; `advanceBy` is
   *  always 1 so the next delta slice starts at the tool result / next user
   *  turn (hwm/prefixHash stay at the N known items - the +1 row's bytes aren't
   *  stable here). */
  hwm: number
  /** sha256 over the first hwm non-system messages (what the server holds). */
  prefixHash: string
  /** Always 1 (2026-08-20 deep-dive finding): the server reconstructs the FULL
   *  previous output (reasoning + text + tool calls) in construct_input_messages,
   *  so the client's next delta starts at the tool result / next user turn and
   *  never re-sends the assistant row. Re-sending it would double-count the
   *  assistant turn against the server's own re-add. */
  advanceBy: number
  /**
   * Chain identity: sha256 of the newest compaction summary's output (the
   * assistant summary text+reasoning), or sha256 of the session id when no
   * compaction exists yet. A compaction boundary therefore changes this value
   * and forces a fresh seed (new previous_response_id chain) instead of
   * chaining deltas onto the stale pre-compaction server chain. This is what
   * makes the post-compaction first prompt re-seed with the id of the
   * compacted context (oc-spec 17: content-derived chain identity).
   */
  chainId: string
  /** Model id the chain was built under; a model change breaks the chain. */
  modelID: string
  failures: number
  /** maxConsecutiveFailures reached: force full-sends for this session. */
  disabled: boolean
}

const states = new Map<string, ChainState>()

// Per-session debug/metrics introspection (oc-spec 17 B5): compact, not the
// full request body. Underscore-prefixed; not part of the API.
type RequestDebug = {
  mode: "chained" | "seed"
  previousResponseId: string | undefined
  itemCount: number
  bytes: number
  /** Per-item-type composition of the request body input (diagnostic). */
  comp: Record<string, { n: number; chars: number }>
  toolNames: string[] | undefined
  toolChoice: unknown
  /** canChain gate diagnostics (BUG_TURN_TIME abort/resubmit investigation). */
  chainBasis?: string
  hwm?: number
  msgLen?: number
  /** Per-message digest of the chained delta window: "role:contentBytes:r<reasoningBytes>". */
  windowDigest?: string[]
}
const lastRequests = new Map<string, RequestDebug>()
export const _testState = (sessionID: string): ChainState | undefined => states.get(sessionID)
export const _testLastRequest = (sessionID: string): RequestDebug | undefined => lastRequests.get(sessionID)

// Env-gated JSONL debug trail (RDT_DEBUG_FILE=/path). Writes one compact
// RequestDebug per request; used for headless verification (oc run).
const debugFile = process.env.RDT_DEBUG_FILE
const logDebug = (sessionID: string, d: RequestDebug) => {
  lastRequests.set(sessionID, d)
  if (debugFile) {
    try {
      const fs = require("node:fs") as typeof import("node:fs")
      fs.appendFileSync(debugFile, JSON.stringify({ sessionID, ...d }) + "\n")
    } catch {
      // debug trail is best-effort
    }
  }
}

export const MAX_CONSECUTIVE_FAILURES = 3

/** Provider opt-in: options.deltaTransport === "responses"; env override off. */
export const enabled = (info: Provider.Info): boolean =>
  info.options?.["deltaTransport"] === "responses" &&
  process.env.OC_DELTA_TRANSPORT !== "off"

const getState = (sessionID: string) => states.get(sessionID)
const setState = (sessionID: string, state: ChainState) => states.set(sessionID, state)
const clearState = (sessionID: string) => states.delete(sessionID)

// ---------------------------------------------------------------------------
// Content hashing (the lean prefix validator)
// ---------------------------------------------------------------------------

type V3Message = LanguageModelV3Prompt[number]
type V3Part = { type: string; [k: string]: unknown }

const toolResultString = (output: unknown): string => {
  if (output == null) return ""
  if (typeof output === "string") return output
  if (typeof output !== "object") return String(output)
  const o = output as { type?: string; value?: unknown }
  if (o.type === "text") return String(o.value ?? "")
  // error-text results must render as their PLAIN value string - the
  // completions transport sends the value verbatim as the tool message content
  // (a failed tool's error text, e.g. "No completed tool output found..."),
  // so emitting the JSON object {"type":"error-text","value":...} diverges the
  // responses seed render from the cached completions prefix (~71K tokens in on
  // the oc-test-9 run, pcap-confirmed 2026-08-20 - a second full ~659K-token
  // miss after the tool-dropping fix). Same shape as the "text" branch.
  if (o.type === "error-text") return String(o.value ?? "")
  if (o.type === "json") return JSON.stringify(o.value ?? "")
  if (o.type === "content") {
    const parts = Array.isArray(o.value) ? (o.value as V3Part[]) : []
    return parts
      .map((p) => (typeof p.text === "string" ? p.text : JSON.stringify(p)))
      .join("")
  }
  return JSON.stringify(output)
}

const messageDigest = (msg: V3Message): string => {
  const content = Array.isArray(msg.content) ? (msg.content as unknown as V3Part[]) : []
  const parts = content.map((p) => {
    switch (p.type) {
      case "text":
        return `t:${p.text ?? ""}`
      case "reasoning":
        return `r:${p.text ?? ""}`
      case "tool-call":
        return `c:${p.toolCallId ?? ""}:${p.toolName ?? ""}:${JSON.stringify(p.input ?? {})}`
      case "tool-result":
        return `o:${p.toolCallId ?? ""}:${p.toolName ?? ""}:${toolResultString(p.output)}`
      case "file":
        return `f:${p.mediaType ?? ""}:${typeof p.data === "string" ? p.data.length : 0}`
      default:
        return `p:${p.type}`
    }
  })
  return `${msg.role}:${parts.join("|")}`
}

const hashInput = (msgs: V3Message[]): string =>
  createHash("sha256").update(msgs.map(messageDigest).join("\x1e")).digest("hex")

const COMPACTION_PLACEHOLDER = "[Compacted summary of the prior conversation]"

// Chain identity: sha256 over the newest compaction summary's output (the
// assistant summary message that follows the compaction marker). Compaction
// re-bases oc's context (the DB drops pre-compaction history), so the
// server-side responses chain must be re-seeded at the boundary - a stale
// chain would keep deltas chaining onto the pre-compaction server context.
// The summary's OWN bytes are the content-derived identity (oc-spec 17). When
// no compaction exists, the id is a stable session-derived hash (fresh
// sessions have no compaction prompt to hash; the chain is unambiguous).
export const chainIdOf = (msgs: V3Message[], sessionID: string): string => {
  // The compaction marker renders as a user message with the static
  // placeholder text; the ASSISTANT message immediately after it carries the
  // summary output. Find the NEWEST marker and hash its summary assistant's
  // rendered content (text + reasoning + any tool parts) so distinct
  // summaries always differ and same-summary replays stay identical.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.role !== "user" || typeof msg.content === "string") continue
    const content = msg.content as unknown as V3Part[]
    const isMarker = content.some(
      (p) => p.type === "text" && String(p.text ?? "").includes(COMPACTION_PLACEHOLDER),
    )
    if (!isMarker) continue
    // The summary assistant follows immediately (filterCompacted re-inserts
    // the pair [marker, summary] at the front in chronological order).
    const summary = msgs[i + 1]
    if (summary && summary.role === "assistant") {
      return createHash("sha256").update(JSON.stringify(summary)).digest("hex")
    }
    return createHash("sha256").update(JSON.stringify(msg)).digest("hex")
  }
  return createHash("sha256").update(`session:${sessionID}`).digest("hex")
}

// ---------------------------------------------------------------------------
// Request lowering (V3 messages -> responses input items)
// ---------------------------------------------------------------------------

// Lower one V3 message into responses input items. Responses items are FLAT:
// message items carry text content only; reasoning and function_call are
// TOP-LEVEL items (a Message content array accepts only input_text/input_image
// - nesting reasoning or function_call inside it fails validation). An
// assistant message therefore flattens into reasoning item(s) + a message
// item (text) + function_call item(s), matching the server's stored output
// items so a full-send re-renders byte-identically to the chain.
const lowerMessage = (msg: V3Message): Record<string, unknown>[] => {
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
    // A V3 tool message carries an array of tool-result parts - one per
    // completed (possibly concurrent) tool call. The responses wire needs one
    // function_call_output PER result: previously `content.find()` kept only
    // the FIRST part, silently dropping every other result from the seed and
    // diverging the render from the cached completions prefix (~28.9K tokens
    // in on the oc-test-8 run, pcap-confirmed 2026-08-20 - a full ~696K-token
    // miss on the first responses prompt after the completions->responses
    // switch). The chat transport emits one `role:"tool"` message per result,
    // so this must emit one item per part to stay byte-identical.
    const results = content.filter((p) => p.type === "tool-result")
    if (results.length === 0) {
      return [{ type: "function_call_output", call_id: "", output: "" }]
    }
    return results.map((r) => ({
      type: "function_call_output",
      call_id: String(r.toolCallId ?? ""),
      output: toolResultString(r.output),
    }))
  }
  // assistant: flatten into top-level items (reasoning, then message, then
  // function calls - the server's stored output item order).
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
  // Interleaved reasoning persistence: for models that sink reasoning into a
  // providerOptions field (capabilities.interleaved.field, e.g. DSV4
  // `reasoning_content` per transform.ts:322-354), the reasoning text is NOT
  // in `content` - it rides providerOptions.openaiCompatible.<field>. The
  // chat path sends that field verbatim (vLLM re-encodes prior reasoning),
  // so RDT must emit it as a reasoning item or the responses seed silently
  // drops all prior reasoning (a ~128k token context gap at depth). Read the
  // configured interleaved field name; fall back to the common
  // "reasoning_content" / "reasoning_details" names.
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
// Usage + finish mapping
// ---------------------------------------------------------------------------

const mapUsage = (u: Record<string, unknown> | undefined): LanguageModelV3Usage => {
  const inputTotal = u && typeof u.input_tokens === "number" ? u.input_tokens : undefined
  const outputTotal = u && typeof u.output_tokens === "number" ? u.output_tokens : undefined
  const details = ((u?.input_tokens_details ?? {}) as Record<string, unknown>) ?? {}
  const outDetails = ((u?.output_tokens_details ?? {}) as Record<string, unknown>) ?? {}
  const cached = typeof details.cached_tokens === "number" ? details.cached_tokens : undefined
  const reasoning = typeof outDetails.reasoning_tokens === "number" ? outDetails.reasoning_tokens : undefined
  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal != null && cached != null ? inputTotal - cached : inputTotal,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTotal,
      text: outputTotal != null && reasoning != null ? outputTotal - reasoning : outputTotal,
      reasoning,
    },
    raw: (u ?? undefined) as LanguageModelV3Usage["raw"],
  }
}

// ---------------------------------------------------------------------------
// SSE stream parser -> LanguageModelV3 stream parts
// ---------------------------------------------------------------------------

const makeStreamParser = (
  finalize: (responseId: string | undefined) => void,
): TransformStream<Uint8Array, LanguageModelV3StreamPart> => {
  let buffer = ""
  let inReasoning = false
  let inText = false
  let sawToolCall = false
  let responseId: string | undefined
  /** Streaming tool-call accumulation keyed by call_id. The server emits
   *  response.function_call_arguments.delta events (incremental JSON
   *  fragments) then a .done (full assembled arguments); output_item.done
   *  re-carries the full arguments. RDT previously ignored the deltas and
   *  emitted everything at output_item.done - functionally correct (the done
   *  blob is complete) but the TUI never saw live tool-argument streaming.
   *  Track both so the tool-input stream starts on the first delta and the
   *  tool-call emission happens exactly once (on output_item.done). */
  const toolCalls = new Map<
    string,
    { name: string; callID: string; args: string; started: boolean; completed: boolean }
  >()

  const handleEvent = (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    ev: Record<string, any>,
  ) => {
    switch (ev.type) {
      case "response.output_item.added": {
        const item = ev.item ?? {}
        if (item.type === "reasoning") {
          inReasoning = true
          controller.enqueue({ type: "reasoning-start", id: "reasoning-0" })
        } else if (item.type === "function_call") {
          // Function-call items arrive here WITH their item_id + call_id +
          // name; the incremental argument deltas reference the item_id.
          const itemID = String(item.id ?? "")
          if (itemID && !toolCalls.has(itemID)) {
            toolCalls.set(itemID, {
              name: String(item.name ?? ""),
              callID: String(item.call_id ?? ""),
              args: "",
              started: false,
              completed: false,
            })
          }
        }
        break
      }
      case "response.reasoning_text.delta":
        if (inReasoning)
          controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: String(ev.delta ?? "") })
        break
      case "response.reasoning_text.done":
      case "response.reasoning_part.done":
        if (inReasoning) {
          controller.enqueue({ type: "reasoning-end", id: "reasoning-0" })
          inReasoning = false
        }
        break
      case "response.content_part.added":
        if (!inText) {
          inText = true
          controller.enqueue({ type: "text-start", id: "txt-0" })
        }
        break
      case "response.output_text.delta":
        controller.enqueue({ type: "text-delta", id: "txt-0", delta: String(ev.delta ?? "") })
        break
      case "response.output_text.done":
        if (inText) {
          controller.enqueue({ type: "text-end", id: "txt-0" })
          inText = false
        }
        break
      case "response.function_call_arguments.delta": {
        const itemID = String(ev.item_id ?? "")
        if (!itemID) break
        let tc = toolCalls.get(itemID)
        if (!tc) {
          tc = { name: "", callID: "", args: "", started: false, completed: false }
          toolCalls.set(itemID, tc)
        }
        tc.args += String(ev.delta ?? "")
        const streamID = tc.callID || itemID
        if (!tc.started) {
          tc.started = true
          controller.enqueue({ type: "tool-input-start", id: streamID, toolName: tc.name })
        }
        controller.enqueue({ type: "tool-input-delta", id: streamID, delta: String(ev.delta ?? "") })
        break
      }
      case "response.function_call_arguments.done": {
        const itemID = String(ev.item_id ?? "")
        const tc = toolCalls.get(itemID)
        if (tc) {
          // The done event carries the FULL assembled arguments (the server
          // re-sends the whole blob, not a suffix) - authoritative over any
          // accumulated delta fragments in case a delta was lost.
          tc.args = String(ev.arguments ?? tc.args)
          if (ev.name) tc.name = String(ev.name)
        }
        break
      }
      case "response.output_item.done": {
        const item = ev.item ?? {}
        if (item.type === "function_call") {
          sawToolCall = true
          const callID = String(item.call_id ?? "")
          const itemID = String(item.id ?? "")
          const name = String(item.name ?? "")
          const args = String(item.arguments ?? "{}")
          // Resolve the accumulation record by item_id (the delta/done events
          // key on it); fall back to call_id for lean-server compat.
          const key = toolCalls.has(itemID) ? itemID : callID
          let tc = toolCalls.get(key)
          const firstTime = !tc || !tc.started
          if (!tc) {
            tc = { name, callID, args: "", started: false, completed: false }
            toolCalls.set(key, tc)
          }
          // The done blob is the authoritative assembled arguments.
          tc.args = args
          tc.name = name
          if (!tc.callID && callID) tc.callID = callID
          // Stream identity: the TUI keys tool-input parts on the call id.
          const streamID = tc.callID || key
          if (firstTime) {
            // No function_call_arguments.delta seen for this call: emit the
            // whole blob at done exactly as the original lean path did.
            tc.started = true
            controller.enqueue({ type: "tool-input-start", id: streamID, toolName: name })
            controller.enqueue({ type: "tool-input-delta", id: streamID, delta: args })
          }
          if (!tc.completed) {
            tc.completed = true
            controller.enqueue({ type: "tool-input-end", id: streamID })
            controller.enqueue({ type: "tool-call", toolCallId: callID, toolName: name, input: tc.args })
          }
        }
        break
      }
      case "response.completed": {
        responseId = (ev.response ?? {}).id
        // advanceBy is 1 for ALL responses (2026-08-20, deep-dive finding):
        // the server's chained reconstruction (construct_input_messages) re-adds
        // the FULL previous output - reasoning + text + tool calls - via
        // construct_chat_messages_with_tool_call, so the client must NOT re-send
        // the assistant row for ANY turn (tool-call rows included). Re-sending it
        // would double-count the assistant turn against the server's own re-add.
        // The delta after any completed response is therefore just
        // [tool result (if any), new user turn]. Verified: with the server full
        // re-add, the chained reconstruction is byte-identical to a full-send.
        // (Previously advanceBy was 0 for tool-call responses - resubmit
        // semantics - because the server's OLD text-only re-add dropped the
        // reasoning + function_call rows and the client had to re-send them.)
        finalize(responseId)
        const finishReason: LanguageModelV3FinishReason = sawToolCall
          ? { unified: "tool-calls", raw: undefined }
          : { unified: "stop", raw: undefined }
        controller.enqueue({
          type: "finish",
          finishReason,
          usage: mapUsage((ev.response ?? {}).usage),
          providerMetadata: {},
        })
        break
      }
      case "response.failed":
        controller.enqueue({ type: "error", error: new Error("responses stream failed") })
        break
    }
  }

  return new TransformStream<Uint8Array, LanguageModelV3StreamPart>({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        if (payload === "[DONE]") continue
        if (!payload) continue
        try {
          handleEvent(controller, JSON.parse(payload))
        } catch {
          // malformed SSE line: skip
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Model wrapper
// ---------------------------------------------------------------------------

export type RDTContext = {
  sessionID: string
  modelID: string
  baseURL: string
  apiKey?: string
  /** providerOptions key under which the variant body is flattened (for
   *  openai-compatible: model.providerID.split(".")[0]). Used to read
   *  chat_template_kwargs.reasoning_effort from the merged variant body. */
  providerKey: string
  headers?: Record<string, string | undefined>
}

const lowerTool = (tool: { name: string; description?: string; inputSchema?: unknown }) => ({
  type: "function" as const,
  name: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  ...(tool.inputSchema ? { parameters: tool.inputSchema } : {}),
})

const lowerToolChoice = (choice: unknown): unknown => {
  if (typeof choice === "string") return choice === "none-by-sender" ? "none" : choice
  if (typeof choice === "object" && choice !== null) {
    const o = choice as { type?: string; toolName?: string }
    if (o.type === "tool") return { type: "function", name: o.toolName }
    // {type: "auto"|"none"|"required"|"none-by-sender"} -> the bare string
    return o.type === "none-by-sender" ? "none" : o.type
  }
  return undefined
}

export const wrap = (language: LanguageModelV3, ctx: RDTContext): LanguageModelV3 => ({
  modelId: language.modelId,
  provider: language.provider,
  specificationVersion: "v3",
  supportedUrls: language.supportedUrls,
  doGenerate: (options) => language.doGenerate(options),
  async doStream(options: LanguageModelV3CallOptions) {
    // v1: structured-output (responseFormat) falls back to the chat transport.
    if (options.responseFormat !== undefined) {
      return language.doStream(options)
    }

    const prompt = options.prompt as LanguageModelV3Prompt
    const system = prompt
      .filter((m): m is Extract<V3Message, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n")
    const inputMsgs = prompt.filter((m): m is Extract<V3Message, { role: "user" | "tool" | "assistant" }> => {
      return m.role !== "system"
    })
    const state = getState(ctx.sessionID)
    const chainId = chainIdOf(inputMsgs, ctx.sessionID)

    // Extract the effort/thinking from the variant's chat_template_kwargs
    // (which reach us flattened under the provider key in providerOptions).
    // Map to the responses `reasoning` field: the DSV4 encoder reads
    // chat_template_kwargs.reasoning_effort as built by the responses
    // protocol's `reasoning.effort` (oc-spec 17 §12.2a). Requires the P6
    // fork enum patch for the "adaptive" value; standard levels pass as-is.
    const providerOpts = options.providerOptions as Record<string, any> | undefined
    const ctk = providerOpts?.[ctx.providerKey]?.chat_template_kwargs as
      | Record<string, any>
      | undefined
    const effort = (ctk?.reasoning_effort as string | undefined) ?? "high"
    const thinkingMode = ctk?.thinking_mode as string | undefined
    // Responses accepts only the OpenAI standard enum. The custom "adaptive"
    // level requires the P6 fork enum patch server-side, which is now live
    // (vllm-start DSV4_REFF mount, applied 2026-08-18). Any future custom
    // level still maps to "high" so the request never 400s.
    const RESPONSES_EFFORT_ALLOWED = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"])
    const safeEffort = RESPONSES_EFFORT_ALLOWED.has(effort) ? effort : "high"
    const reasonField: Record<string, unknown> | undefined =
      (safeEffort !== "none" && (thinkingMode ?? "enabled") !== "disabled" && {
        effort: safeEffort,
      }) ||
      undefined

    // Chain decision: valid if the server's chain (first hwm messages) is
    // byte-identical to ours, the model id matches, and the chain identity
    // (compaction summary content) is unchanged. A compaction boundary
    // changes chainIdOf() -> the stale pre-compaction server chain is
    // abandoned and the turn re-seeds with the compacted context.
    // `chainBasis` records WHY the decision failed, so a post-abort/resubmit
    // mystery seed can be attributed to a gate (or a content drift visible in
    // the delta digest) instead of guessed from cache numbers.
    const prefixSlice = state !== undefined ? inputMsgs.slice(0, Math.min(state.hwm, inputMsgs.length)) : []
    const prefixLen = prefixSlice.reduce(
      (acc, m) => acc + JSON.stringify(m).length,
      0,
    )
    const chainBasis =
      state === undefined
        ? "noState"
        : state.disabled
          ? "disabled"
          : state.modelID !== ctx.modelID
            ? "model"
            : state.chainId !== chainId
              ? "chainId"
              : state.hwm > inputMsgs.length
                ? `hwm(${state.hwm} > ${inputMsgs.length})`
                : state.prefixHash === hashInput(inputMsgs.slice(0, state.hwm))
                  ? "ok"
                  : "prefixHash"
    const canChain =
      state !== undefined &&
      !state.disabled &&
      state.modelID === ctx.modelID &&
      state.chainId === chainId &&
      state.hwm <= inputMsgs.length &&
      state.prefixHash === hashInput(inputMsgs.slice(0, state.hwm))

    const tools =
      options.tools === undefined
        ? undefined
        : options.tools
            .filter((t) => t.type === "function")
            .map((t) => lowerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

    // Build the responses body. full: true drops previous_response_id.
    // On a chained request the delta re-sends everything after the last
    // ACCEPTED response (state.hwm), INCLUDING assistant rows: an assistant
    // in the [hwm..) window is by construction a cancelled/unaccepted
    // generation (accepted ones finalized past hwm), and the partial output
    // must be re-submitted so the server chain catches up to a full-send
    // (BUG_TURN_TIME resubmit-after-abort). Sending the aborted partial is
    // byte-required for any later full resend to match the chain.
    const buildBody = (previousResponseId: string | undefined, full: boolean) => {
      const items =
        previousResponseId !== undefined && !full
          ? inputMsgs.slice(state!.hwm + state!.advanceBy).flatMap(lowerMessage)
          : inputMsgs.flatMap(lowerMessage)
      const body: Record<string, unknown> = {
        model: ctx.modelID,
        ...(system ? { instructions: system } : {}),
        input: items,
        ...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(options.toolChoice ? { tool_choice: lowerToolChoice(options.toolChoice as never) } : {}),
        ...(reasonField ? { reasoning: reasonField } : {}),
        stream: true,
        ...(options.maxOutputTokens != null ? { max_output_tokens: options.maxOutputTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
        ...(options.topP != null ? { top_p: options.topP } : {}),
        store: true,
      }
      return body
    }

    const url = `${ctx.baseURL.replace(/\/+$/, "")}/responses`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
      ...(ctx.headers as Record<string, string> | undefined),
    }

    // Failure ladder: attempt 0 = chained (if canChain), attempt 1 = full
    // retry after an expired-id 4xx. Beyond that, surface the error.
    for (let attempt = 0; attempt < 2; attempt++) {
      const chained = attempt === 0 && canChain
      const body = buildBody(chained ? state!.responseId : undefined, !chained)
      const inputItems = (body.input as unknown[]) ?? []
      // Per-item-type composition of the wire body. chars = the item's full
      // serialized JSON length (captures function_call arguments, reasoning
      // content, function_call_output payloads), so a chat-vs-responses render
      // diff at the same session can attribute the token gap to item types.
      const comp: Record<string, { n: number; chars: number }> = {}
      for (const item of inputItems) {
        const rec = item as Record<string, unknown>
        const type = String(rec.type ?? rec.role ?? "?")
        const chars = JSON.stringify(item).length
        const cur = comp[type] ?? { n: 0, chars: 0 }
        cur.n++
        cur.chars += chars
        comp[type] = cur
      }
      // Diagnostic digest of the delta window: per-message role + content
      // byte-lengths (and the interleaved reasoning_content length, which is
      // the suspected post-abort drift source). Lets a repeated-trial test
      // detect abort/resubmit content growth that a prefixHash mismatch alone
      // cannot explain.
      const windowDigest = chained
        ? inputMsgs.slice(state!.hwm).map((m) => {
            const mm = m as unknown as {
              role?: string
              content?: unknown
              providerOptions?: Record<string, unknown>
            }
            const s = JSON.stringify(mm.content ?? "")
            const oc = mm.providerOptions?.openaiCompatible as Record<string, unknown> | undefined
            const reas = oc?.reasoning_content ?? oc?.reasoning_details ?? oc?.reasoning
            return `${mm.role ?? "?"}:${s.length}:r${typeof reas === "string" ? reas.length : 0}`
          })
        : []
      logDebug(ctx.sessionID, {
        mode: chained ? "chained" : "seed",
        previousResponseId: chained ? state!.responseId : undefined,
        itemCount: inputItems.length,
        bytes: JSON.stringify(body).length,
        comp,
        toolNames: tools?.length ? tools.map((t) => t.name) : undefined,
        toolChoice: options.toolChoice as unknown,
        // canChain diagnostics: gate reason + the boundary lengths + the
        // delta-window digest (role:contentBytes:reasoningBytes per message).
        chainBasis,
        hwm: state?.hwm,
        msgLen: inputMsgs.length,
        windowDigest,
      })

      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.abortSignal,
        })
      } catch (err) {
        // Network error OR user abort. A user abort (AbortError family,
        // raised when the caller cancels the request) is an intentional
        // stop - NOT a transport failure - so it must not inflate the
        // failure ladder toward the permanent-disable cap. Genuine network
        // errors still count.
        const isAbort =
          err instanceof DOMException
            ? err.name === "AbortError"
            : (err as { name?: string } | null)?.name === "AbortError" ||
              String((err as { cause?: unknown } | null)?.cause ?? "").includes("abort")
        if (state !== undefined && chained && !isAbort) {
          const failures = state.failures + 1
          const disabled = failures >= MAX_CONSECUTIVE_FAILURES
          setState(ctx.sessionID, { ...state, failures, disabled })
        }
        if (isAbort) throw err
        // Wrap the raw fetch failure as a retryable APICallError (parity
        // with the completions path, whose postToApi -> handleFetchError
        // wraps bun connect failures the same way). A bare rethrow feeds
        // MessageV2.fromError's Unknown branch, whose message matches no
        // RETRYABLE_MESSAGE_PATTERNS entry - the session fails IMMEDIATELY
        // instead of retrying with backoff until the model comes back.
        throw new APICallError({
          message: `Cannot connect to API: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
          url,
          requestBodyValues: body,
          isRetryable: true,
        })
      }

      if (res.ok) {
        if (state !== undefined && chained) {
          setState(ctx.sessionID, { ...state, failures: 0 })
        }
        const finalize = (responseId: string | undefined) => {
          if (responseId !== undefined) {
            setState(ctx.sessionID, {
              responseId,
              hwm: inputMsgs.length,
              prefixHash: hashInput(inputMsgs),
              // Always 1 (see the response.completed comment above): the server
              // reconstructs the full assistant row, so the client delta starts
              // at the tool result / next user turn, never the assistant row.
              advanceBy: 1,
              chainId,
              modelID: ctx.modelID,
              failures: 0,
              disabled: false,
            })
          }
        }
        return {
          stream: res.body!.pipeThrough(makeStreamParser(finalize)),
          request: { body: JSON.parse(JSON.stringify(body)) },
          response: { headers: Object.fromEntries(res.headers.entries()) },
        }
      }

      // Non-OK. Expired/unknown previous_response_id -> clear + retry full.
      if (chained && (res.status === 404 || res.status === 400)) {
        clearState(ctx.sessionID)
        continue
      }
      // Other non-OK (validation, server error): surface to the caller.
      const text = await res.text().catch(() => "")
      throw new Error(
        `responses API ${res.status}: ${text.slice(0, 400)} ` +
          `[mode=${chained ? "chained" : "seed"} tools=${tools?.length ?? 0} toolChoice=${JSON.stringify(options.toolChoice)}]`,
      )
    }

    throw new Error("responses transport: unreachable")
  },
})

export * as RDT from "./rdt"
