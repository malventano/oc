import { estimateDisplayFromChars } from "@opencode-ai/core/util/token"
import type { AssistantMessage, Message, Part, Provider, Session, UserMessage } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { computeTurn, pendingTally, settledReport } from "../component/prompt/turn-stats"

export type ContextUsage = {
  tokens: number
  percent: number | null
  forecast: boolean
}

type KV = {
  get: (key: string, fallback?: unknown) => unknown
  set: (key: string, value: unknown) => void
}

type CompactionPart = Extract<Part, { type: "compaction" }>
type StepStartPart = Extract<Part, { type: "step-start" }>

type CompactionPair = {
  marker: UserMessage
  summary: AssistantMessage
  markerIndex: number
  summaryIndex: number
  part: CompactionPart
}

type Subject = {
  agent?: string
  providerID: string
  modelID: string
}

export type ContextUsageInput = {
  messages: ReadonlyArray<Message>
  parts: (messageID: string) => ReadonlyArray<Part> | undefined
  session?: Session
  provider: ReadonlyArray<Provider>
  directory: string
  /** Session status busy (covers tool gaps as well as an in-flight step). */
  busy?: boolean
  /** Test hook: skip the shared cache and use this base directly. */
  baseline?: number
}

const BASELINE_PREFIX = "context_baseline_v1:"
const COMPACTION_PLACEHOLDER = "[Compacted summary of the prior conversation]"
const memory = new Map<string, number>()
const [baselineVersion, setBaselineVersion] = createSignal(0)
let kv: KV | undefined

export function bindContextUsageKV(next: KV) {
  kv = next
}

function readBaseline(key: string) {
  baselineVersion()
  const cached = memory.get(key)
  if (cached !== undefined) return cached
  const stored = kv?.get(BASELINE_PREFIX + key)
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) {
    memory.set(key, stored)
    return stored
  }
  return undefined
}

function writeBaseline(key: string, value: number) {
  if (memory.get(key) === value) return
  memory.set(key, value)
  kv?.set(BASELINE_PREFIX + key, value)
  setBaselineVersion((x) => x + 1)
}

function hasUsage(message: AssistantMessage) {
  const t = message.tokens
  return t.input > 0 || t.output > 0 || t.reasoning > 0 || t.cache.read > 0 || t.cache.write > 0
}

// The context view must follow the same revert boundary as the transcript.
// Reverted messages stay in the sync store but are hidden, so an undone
// virtual compaction must not keep driving the forecast.
function visibleMessages(input: ContextUsageInput) {
  const messages = [...input.messages]
  const messageID = input.session?.revert?.messageID
  if (!messageID) return messages
  const index = messages.findIndex((message) => message.id === messageID)
  return index === -1 ? messages : messages.slice(0, index)
}

function partChars(parts: ReadonlyArray<Part> | undefined) {
  let chars = 0
  for (const part of parts ?? []) {
    if (part.type === "text") {
      if (!part.ignored) chars += part.text.length
    } else if (part.type === "reasoning") {
      chars += part.text.length
    } else if (part.type === "tool") {
      chars += JSON.stringify(part.state.input ?? {}).length
      if (part.state.status === "completed") chars += part.state.output.length
      else if (part.state.status === "error") chars += part.state.error.length
      else if (part.state.status === "pending") chars += part.state.raw.length
    } else if (part.type === "file") {
      chars += part.source?.text.value.length ?? 0
    } else if (part.type === "compaction") {
      chars += COMPACTION_PLACEHOLDER.length
    }
  }
  return chars
}

function messageChars(message: Message, parts: (id: string) => ReadonlyArray<Part> | undefined) {
  if (message.role === "assistant" && message.error) return 0
  return partChars(parts(message.id))
}

function transcriptChars(
  messages: ReadonlyArray<Message>,
  parts: (id: string) => ReadonlyArray<Part> | undefined,
  skip?: Set<string>,
) {
  let chars = 0
  for (const message of messages) {
    if (skip?.has(message.id)) continue
    chars += messageChars(message, parts)
  }
  return chars
}

function newestCompaction(
  messages: ReadonlyArray<Message>,
  parts: (id: string) => ReadonlyArray<Part> | undefined,
  fromIndex = messages.length - 1,
  realOnly = false,
): CompactionPair | undefined {
  for (let i = fromIndex; i >= 0; i--) {
    const marker = messages[i]
    if (marker?.role !== "user") continue
    const part = (parts(marker.id) ?? []).find((item): item is CompactionPart => item.type === "compaction")
    if (!part) continue
    if (realOnly && part.virtual) continue
    const summaryIndex = messages.findIndex(
      (message, index) =>
        index > i &&
        message.role === "assistant" &&
        message.parentID === marker.id &&
        message.summary === true &&
        Boolean(message.finish) &&
        !message.error,
    )
    if (summaryIndex < 0) continue
    return {
      marker,
      summary: messages[summaryIndex] as AssistantMessage,
      markerIndex: i,
      summaryIndex,
      part,
    }
  }
  return undefined
}

function latestStepStart(
  messages: ReadonlyArray<Message>,
  parts: (id: string) => ReadonlyArray<Part> | undefined,
  afterIndex: number,
) {
  for (let i = messages.length - 1; i > afterIndex; i--) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    const start = (parts(message.id) ?? []).findLast(
      (part): part is StepStartPart =>
        part.type === "step-start" &&
        typeof part.estimated_input_tokens === "number" &&
        part.estimated_input_tokens > 0,
    )
    if (start) return start.estimated_input_tokens
  }
  return undefined
}

function latestStepStartBase(
  messages: ReadonlyArray<Message>,
  parts: (messageID: string) => ReadonlyArray<Part> | undefined,
  afterIndex: number,
  topic: Subject | undefined,
) {
  for (let i = messages.length - 1; i > afterIndex; i--) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    if (topic && (message.providerID !== topic.providerID || message.modelID !== topic.modelID)) continue
    if (topic?.agent && message.agent && message.agent !== topic.agent) continue
    const start = (parts(message.id) ?? []).findLast(
      (part): part is StepStartPart =>
        part.type === "step-start" &&
        typeof part.estimated_base_tokens === "number" &&
        part.estimated_base_tokens > 0,
    )
    if (start) return start.estimated_base_tokens
  }
  return undefined
}

function subject(
  messages: ReadonlyArray<Message>,
  session: Session | undefined,
  pair: CompactionPair | undefined,
): Subject | undefined {
  if (pair) {
    return {
      agent: pair.marker.agent,
      providerID: pair.marker.model.providerID,
      modelID: pair.marker.model.modelID,
    }
  }
  const lastUser = messages.findLast((message): message is UserMessage => message.role === "user")
  if (lastUser) {
    return {
      agent: lastUser.agent,
      providerID: lastUser.model.providerID,
      modelID: lastUser.model.modelID,
    }
  }
  if (session?.model) {
    return {
      agent: session.agent,
      providerID: session.model.providerID,
      modelID: session.model.id,
    }
  }
  return undefined
}

function baselineKey(directory: string, subject: Subject | undefined) {
  if (!subject) return `${directory}|unknown`
  return `${directory}|${subject.agent ?? "default"}|${subject.providerID}/${subject.modelID}`
}

// Rough base fill for a directory that has never been measured - a legacy
// session whose reports predate the step-start base, compacted (virtual or
// real) before any base was stamped on the marker. The system/tools/skills
// overhead is shared across directories for the same agent/model, so the
// nearest ancestor directory's measured baseline is a close approximation and
// far better than the 0 that would otherwise erase the base from the footbar
// (summary-only renders transcript-only, clean-start falls back to the stale
// pre-compaction exact). Display-only: never persisted, so it cannot pollute
// the learned baseline for this directory.
function roughBaseline(subject: Subject | undefined, directory: string) {
  if (!subject) return undefined
  let dir = directory
  while (dir) {
    const value = readBaseline(baselineKey(dir, subject))
    if (value !== undefined && value > 0) return value
    if (dir === "/") break
    const index = dir.lastIndexOf("/")
    dir = index > 0 ? dir.slice(0, index) : "/"
  }
  return undefined
}

function modelFor(provider: ReadonlyArray<Provider>, subject: Subject | undefined) {
  if (!subject) return undefined
  return provider.find((item) => item.id === subject.providerID)?.models[subject.modelID]
}

function promptTokens(
  messages: ReadonlyArray<Message>,
  parts: (id: string) => ReadonlyArray<Part> | undefined,
  afterIndex: number,
) {
  let chars = 0
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message?.role === "user") chars += partChars(parts(message.id))
  }
  return estimateDisplayFromChars(chars)
}

function fallbackCompactionTranscript(
  pair: CompactionPair,
  messages: ReadonlyArray<Message>,
  parts: (id: string) => ReadonlyArray<Part> | undefined,
) {
  if (pair.part.virtual) {
    // A virtual compact writes only a synthetic note; the model chain is the
    // newest REAL summary pair plus the tail starting at the virtual marker's
    // (newer) boundary. This is why a virtual compact must lower the estimate.
    if (pair.part.clean_start) {
      return estimateDisplayFromChars(
        transcriptChars(
          messages.slice(pair.markerIndex + 1),
          parts,
          new Set([pair.marker.id, pair.summary.id]),
        ),
      )
    }
    const real = newestCompaction(messages, parts, pair.markerIndex - 1, true)
    if (!real) return undefined
    let chars = messageChars(real.summary, parts) + COMPACTION_PLACEHOLDER.length
    const start = pair.part.tail_start_id
      ? messages.findIndex((message) => message.id === pair.part.tail_start_id)
      : 0
    if (start >= 0) {
      chars += transcriptChars(
        messages.slice(start, pair.markerIndex),
        parts,
        new Set([pair.marker.id, pair.summary.id, real.marker.id, real.summary.id]),
      )
    }
    return estimateDisplayFromChars(chars)
  }
  // clean_start carries no summary or retained tail; any post-summary user
  // prompt is added by promptTokens.
  if (pair.part.clean_start) return 0

  let chars = messageChars(pair.summary, parts) + COMPACTION_PLACEHOLDER.length
  if (!pair.part.no_tail) {
    const start = pair.part.tail_start_id
      ? messages.findIndex((message) => message.id === pair.part.tail_start_id)
      : 0
    if (start >= 0) {
      // Stop at the marker: messages after the summary are post-compaction
      // continuation and are added by promptTokens, never counted twice.
      chars += transcriptChars(
        messages.slice(start, pair.markerIndex),
        parts,
        new Set([pair.marker.id, pair.summary.id]),
      )
    }
  }
  return estimateDisplayFromChars(chars)
}

/**
 * Pure context selection shared by the footbar and the sidebar.
 *
 * Exact reports win. When the next request is structurally different from the
 * last report, use the server-published preflight/compaction estimate instead:
 * - a current turn with a step-start estimate but no report yet
 * - a completed compaction with no post-compaction report
 * - a new session with no report at all
 *
 * Baseline is the measured system+tools+environment overhead for the
 * directory/agent/model key.
 */
export function resolveContextUsage(input: ContextUsageInput, baseline = 0): ContextUsage | undefined {
  const messages = visibleMessages(input)
  const pair = newestCompaction(messages, input.parts)
  const settled = settledReport(messages)
  const exactIndex = settled ? messages.findIndex((message) => message.id === settled.id) : -1
  const topic = subject(messages, input.session, pair)
  // A measured base for this exact directory wins; otherwise borrow the
  // nearest measured ancestor (same agent/model) so a legacy compaction does
  // not drop the base to 0.
  const fallbackBase = baseline > 0 ? baseline : (roughBaseline(topic, input.directory) ?? 0)
  const model = modelFor(input.provider, topic)
  const exactModel = settled
    ? input.provider.find((item) => item.id === settled.providerID)?.models[settled.modelID]
    : undefined
  const percent = model?.limit.context
    ? Math.round(((settled?.input ?? 0) / model.limit.context) * 100)
    : null
  const getParts = (id: string) => input.parts(id) as Part[] | undefined
  const turn = computeTurn(messages, getParts)
  const pending = pendingTally(messages, turn, getParts)
  const live = Boolean(input.busy) || turn.active

  if (settled && (!pair || exactIndex > pair.summaryIndex)) {
    const tokens = pending.anchored + (live ? pending.inputPending + pending.streamedPending : 0)
    return {
      tokens,
      percent: exactModel?.limit.context
        ? Math.round((tokens / exactModel.limit.context) * 100)
        : null,
      forecast: false,
    }
  }

  const start = latestStepStart(messages, input.parts, pair?.summaryIndex ?? -1)
  if (start !== undefined) {
    const tokens = start + (live ? pending.streamedPending : 0)
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      forecast: true,
    }
  }

  if (pair) {
    const transcript =
      pair.part.estimated_next_transcript_tokens ?? fallbackCompactionTranscript(pair, messages, input.parts)
    if (transcript !== undefined) {
      const contextBase =
        latestStepStartBase(messages, input.parts, -1, topic) ??
        pair.part.estimated_context_base_tokens ??
        fallbackBase
      const tokens =
        contextBase +
        transcript +
        promptTokens(messages, input.parts, pair.summaryIndex) +
        (live ? pending.streamedPending : 0)
      if (tokens > 0) {
        return {
          tokens,
          percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
          forecast: true,
        }
      }
    }
  }

  if (!settled) {
    const tokens = fallbackBase + promptTokens(messages, input.parts, -1) + (live ? pending.streamedPending : 0)
    if (tokens > 0) {
      return {
        tokens,
        percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
        forecast: true,
      }
    }
  }

  // A completed compaction without a usable estimate keeps the old exact
  // value rather than hiding the counter. New compactions always carry the
  // estimate; this is only the legacy fallback.
  if (settled) {
    return {
      tokens: settled.input,
      percent,
      forecast: false,
    }
  }
  return undefined
}

function measureBaseline(input: ContextUsageInput) {
  const messages = visibleMessages(input)
  const pair = newestCompaction(messages, input.parts)

  // First post-compaction report: exact input minus the compacted transcript
  // and the prompt is the system/tools/environment base. Use the FIRST report
  // after the pair (not the newest) so a restart can still learn the base
  // after several later turns. This is what lets a long pre-existing session
  // learn the base without ever starting fresh.
  if (pair) {
    let firstIndex = -1
    let first: AssistantMessage | undefined
    for (let i = pair.summaryIndex + 1; i < messages.length; i++) {
      const message = messages[i]
      if (message?.role !== "assistant" || message.summary || !hasUsage(message)) continue
      firstIndex = i
      first = message
      break
    }
    if (!first || firstIndex < 0) return undefined
    const transcript =
      pair.part.estimated_next_transcript_tokens ?? fallbackCompactionTranscript(pair, messages, input.parts)
    if (transcript === undefined) return undefined
    const prompt = promptTokens(messages.slice(0, firstIndex), input.parts, pair.summaryIndex)
    const exactInput = first.tokens.input + first.tokens.cache.read + first.tokens.cache.write
    const base = exactInput - transcript - prompt
    return base > 0 ? base : undefined
  }

  // Fresh session: the first report's input minus its prompt is the base.
  const settled = settledReport(messages)
  if (!settled) return undefined
  const exactIndex = messages.findIndex((message) => message.id === settled.id)
  if (messages.length > 2 || exactIndex !== 1) return undefined
  const exact = messages[exactIndex]
  if (!exact || exact.role !== "assistant" || exact.summary) return undefined
  const rootIndex = messages.findIndex((message) => message.id === exact.parentID)
  if (rootIndex !== 0) return undefined
  if (messages.slice(0, exactIndex).some((message) => message.role === "assistant" && hasUsage(message))) return undefined
  const root = messages[rootIndex]
  if (!root || root.role !== "user") return undefined
  return Math.max(0, settled.input - estimateDisplayFromChars(partChars(input.parts(root.id))))
}

export function contextUsage(input: ContextUsageInput): ContextUsage | undefined {
  const messages = visibleMessages(input)
  const pair = newestCompaction(messages, input.parts)
  const topic = subject(messages, input.session, pair)
  const key = baselineKey(input.directory, topic)

  if (input.baseline !== undefined) return resolveContextUsage(input, input.baseline)

  const current = readBaseline(key)
  const measured = measureBaseline(input)
  if (
    measured !== undefined &&
    (current === undefined || Math.abs(measured - current) > Math.max(500, current * 0.1))
  ) {
    writeBaseline(key, measured)
  }
  return resolveContextUsage(input, readBaseline(key) ?? 0)
}
