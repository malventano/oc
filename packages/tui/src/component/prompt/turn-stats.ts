import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

export type TurnStats = {
  /** True while the turn has an in-flight step (fast signal; the live-vs-idle
   *  decision ALSO consults the session status to cover tool-execution gaps
   *  where no step is mid-stream). */
  active: boolean
  /** The user message that started the turn (elapsed reference point). */
  start: number
  /** The turn's assistant steps, in order (each LLM call = one step). */
  steps: AssistantMessage[]
  /** Running reasoning + output token totals across the turn's steps. */
  reasoning: number
  output: number
  /** Tool call parts in the turn (any state). */
  tools: number
  /** The turn's root user message id. */
  parentID: string | undefined
}

const isAssistant = (m: UserMessage | AssistantMessage): m is AssistantMessage => m.role === "assistant"
const isToolPart = (p: Part) => p.type === "tool"

// Rough chars-per-token for the live estimate: real endpoint tokens replace it
// at step end, so this only needs to make the counter tick up as text streams.
const CHARS_PER_TOKEN = 4

/**
 * The last agent turn, rooted at the newest assistant message's parent user
 * message: every assistant step with that parentID belongs to the turn (earlier
 * steps may already be completed - their tokens still count), including during
 * tool-execution gaps where no step is currently streaming. `active` is true
 * only while a step is in flight; callers combine it with the session status to
 * cover the gaps.
 *
 * `getParts` resolves the per-step parts (for the tool-call count); omit it
 * (or pass () => undefined) to skip tool counting.
 */
export function computeTurn(
  messages: Array<UserMessage | AssistantMessage>,
  getParts?: (messageID: string) => Part[] | undefined,
): TurnStats {
  const last = messages.findLast((m): m is AssistantMessage => isAssistant(m))
  if (!last) {
    return { active: false, start: 0, steps: [], reasoning: 0, output: 0, tools: 0, parentID: undefined }
  }
  const rootID = last.parentID
  const steps = messages.filter((m): m is AssistantMessage => isAssistant(m) && m.parentID === rootID)
  const root = messages.find((m) => m.role === "user" && m.id === rootID)
  const start = root?.time.created ?? last.time.created

  let reasoning = 0
  let output = 0
  let tools = 0
  for (const step of steps) {
    reasoning += step.tokens.reasoning
    output += step.tokens.output
    if (getParts) tools += (getParts(step.id) ?? []).filter(isToolPart).length
  }
  return { active: steps.some((s) => !s.time.completed), start, steps, reasoning, output, tools, parentID: rootID }
}

/**
 * Token estimate for a step. Steps with real endpoint usage report it exactly;
 * in-flight steps estimate from the streamed part text (reasoning chars ->
 * reasoning, text + tool-call JSON chars -> output) so the counters count up
 * live instead of jumping at step boundaries.
 */
export function estimateStepTokens(step: AssistantMessage, parts: Part[] | undefined) {
  if (step.tokens.input > 0 || step.tokens.output > 0 || step.tokens.reasoning > 0) {
    return { reasoning: step.tokens.reasoning, output: step.tokens.output }
  }
  let reasoningChars = 0
  let outputChars = 0
  for (const p of parts ?? []) {
    if (p.type === "reasoning") reasoningChars += p.text.length
    else if (p.type === "text") outputChars += p.text.length
    else if (p.type === "tool") {
      const s = p.state
      // The streamed tool-call JSON lives in `raw` while pending; landed
      // steps carry structured input (and real tokens replace the estimate).
      if (s.status === "pending") outputChars += s.raw.length
      else outputChars += JSON.stringify(s.input ?? {}).length
    }
  }
  return {
    reasoning: Math.round(reasoningChars / CHARS_PER_TOKEN),
    output: Math.round(outputChars / CHARS_PER_TOKEN),
  }
}

/**
 * Live reasoning/output across a set of steps: real tokens for completed
 * steps, streamed estimates for the in-flight step, so counters count up
 * continuously instead of jumping at step boundaries.
 */
export function liveTokensForSteps(steps: AssistantMessage[], getParts?: (messageID: string) => Part[] | undefined) {
  let reasoning = 0
  let output = 0
  for (const step of steps) {
    const est = estimateStepTokens(step, getParts?.(step.id))
    reasoning += est.reasoning
    output += est.output
  }
  return { reasoning, output }
}

export function turnLiveTokens(turn: TurnStats, getParts?: (messageID: string) => Part[] | undefined) {
  return liveTokensForSteps(turn.steps, getParts)
}

/**
 * The steps of one agent turn, rooted at a user message (every assistant
 * message parented to it, including completed mid-turn steps and tool calls).
 */
export function turnSteps(messages: Array<UserMessage | AssistantMessage>, parentID: string): AssistantMessage[] {
  return messages.filter((m): m is AssistantMessage => isAssistant(m) && m.parentID === parentID)
}

/**
 * Estimated tokens of a user message's text parts (the prompt just
 * submitted) - the input sent to the endpoint the instant the turn starts.
 */
export function promptTokenEstimate(
  prompt: UserMessage | undefined,
  getParts?: (messageID: string) => Part[] | undefined,
): number {
  if (!prompt) return 0
  let chars = 0
  for (const p of getParts?.(prompt.id) ?? []) {
    if (p.type === "text") chars += p.text.length
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

/**
 * Estimated tokens of the completed tool results across a turn's steps -
 * the conversation content added between tool calls that becomes part of the
 * next request's (assumed cached) input.
 */
export function toolResultTokens(steps: AssistantMessage[], getParts?: (messageID: string) => Part[] | undefined): number {
  let chars = 0
  for (const step of steps) {
    for (const p of getParts?.(step.id) ?? []) {
      if (p.type === "tool" && p.state.status === "completed") chars += p.state.output?.length ?? 0
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

/**
 * The settled report for the last turn: the final assistant step with ANY
 * usage (input/output/reasoning). `findLast(tokens.output > 0)` skips
 * reasoning-only or tool-call final steps, leaving stale values on screen -
 * the fix is any-usage selection.
 */
export function settledReport(messages: Array<UserMessage | AssistantMessage>) {
  const last = messages.findLast((m): m is AssistantMessage => {
    if (!isAssistant(m)) return false
    const t = m.tokens
    return t.input > 0 || t.output > 0 || t.reasoning > 0
  })
  if (!last) return
  const t = last.tokens!
  const input = t.input + t.cache.read + t.cache.write
  const output = t.output + t.reasoning
  return {
    // The context actually sent to the model (input + cached prefix/writes),
    // NOT the full request sum (which also includes the generated tokens).
    // `id` lets a caller detect a NEWER report than the one a frozen tally
    // base was captured from.
    id: last.id,
    input,
    output,
    tokens: input + output,
    providerID: last.providerID,
    modelID: last.modelID,
  }
}

export type ContextPending = {
  /** The latest completed step report's full wire input (input + cache.read +
   *  cache.write): the endpoint's exact reported context, adopted the instant
   *  each step-finish lands. 0 before the first report of a fresh session.
   *  Fresh session, mid-turn re-anchor, compaction shrink, model switch are
   *  all just re-anchors to the reported truth - no frozen turn-start base. */
  anchored: number
  /** Transcript content entered the conversation since the anchor that a
   *  future request must re-send (billed at the cache rate): the anchor step's
   *  own completion (real output + reasoning, not in its own report) + its
   *  tool result, plus the turn's root prompt estimate while the anchor
   *  predates the prompt (fresh turn / fresh session - no report of this turn
   *  carries the prompt yet). */
  inputPending: number
  /** Tokens being GENERATED this instant: the in-flight step's streamed
   *  estimate (its request is in flight, so new text is billed at the output
   *  rate and counted up here until the next report adopts it). */
  streamedPending: number
}

/**
 * The anchor + pending split for the running total context/cost (spec 13).
 * The counter ADOPTS every step-finish report the instant it lands (so each
 * semi-turn completion snaps to the endpoint's exact input), and adds only the
 * content since the anchor that no report carries yet. When the anchor is a
 * step of the current turn its own completion + tool result are pending (its
 * report covered the conversation up to, not including, them); a prior-turn or
 * absent anchor contributes only the root prompt estimate (everything else is
 * already inside the anchored continuation).
 */
export function pendingTally(
  messages: Array<UserMessage | AssistantMessage>,
  turn: TurnStats,
  getParts?: (messageID: string) => Part[] | undefined,
): ContextPending {
  const settled = settledReport(messages)
  const anchored = settled?.input ?? 0

  let inputPending = 0
  let streamedPending = 0

  // The anchor step when it is a step of the CURRENT turn (its content is the
  // only not-yet-reported transcript since it). A prior-turn or absent anchor
  // has nothing pending except the prompt.
  const anchorStep = turn.parentID === undefined ? undefined : turn.steps.find((s) => s.id === settled?.id)

  if (anchorStep === undefined) {
    const root = messages.find((m): m is UserMessage => m.role === "user" && m.id === turn.parentID)
    inputPending += promptTokenEstimate(root, getParts)
  } else {
    inputPending += anchorStep.tokens.output + anchorStep.tokens.reasoning
    inputPending += toolResultTokens([anchorStep], getParts)
  }

  const inFlight = turn.steps.find((s) => !s.time.completed)
  if (inFlight) {
    const est = estimateStepTokens(inFlight, getParts?.(inFlight.id))
    streamedPending = est.reasoning + est.output
  }

  return { anchored, inputPending, streamedPending }
}

/**
 * Counter format: 999 and below as-is, then x.xK with no M branch (so
 * 1,000,000 renders 1,000.0K). Shared by the token counters and the usage
 * slot so they can never disagree.
 */
export function formatCount(num: number): string {
  if (num >= 1000) {
    return (num / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "K"
  }
  return num.toString()
}

/**
 * The full prior-turn DB walk result: every stat the footer shows for a
 * completed turn, resolved from the DB in ONE paginated pass (the store
 * window caps at 100 messages, so long turns' early steps and their root
 * prompt fall outside it). `tools` = tool-call parts, `reasoning`/`output` =
 * the assistant steps' real endpoint token totals, `start` = the root user
 * message's created time (the elapsed clock's anchor).
 */
export type TurnDbWalk = { tools: number; reasoning: number; output: number; start?: number }

/** Per-page state of the turn DB walk across pages. */
export type TurnWalkPageState = TurnDbWalk & { reachedRoot: boolean }

/**
 * Accumulate a turn's stats from one page of the messages API (chronological,
 * oldest first). The turn's root user message PRECEDES its steps in the page,
 * so reaching it flips `reachedRoot` and every following item is one of the
 * turn's steps; before it, only items whose parentID matches count (a page
 * that omits the root holds only steps, all newer than it). Returning at the
 * root instead of continuing would skip the steps and report 0. Pure -
 * unit-tested.
 */
export function countTurnWalkParts(
  items: Array<{
    info: {
      id: string
      role: string
      parentID?: string | null
      time?: { created: number }
      tokens?: { reasoning?: number; output?: number }
    }
    parts: Part[]
  }>,
  parentID: string,
  state: TurnWalkPageState,
): TurnWalkPageState {
  let { tools, reachedRoot, start, reasoning, output } = state
  for (const item of items) {
    if (item.info.id === parentID) {
      reachedRoot = true
      // The turn's root user message anchors the elapsed clock. Capture its
      // created time while the walk passes it - the store window (capped at
      // 100) prunes the parent away on long turns, and the footer's elapsed
      // reads it from here instead.
      start = item.info.time?.created ?? start
      continue
    }
    if (item.info.role === "assistant" && (reachedRoot || item.info.parentID === parentID)) {
      tools += item.parts.filter((p) => p.type === "tool").length
      reasoning += item.info.tokens?.reasoning ?? 0
      output += item.info.tokens?.output ?? 0
    }
  }
  return { tools, reachedRoot, start, reasoning, output }
}

/**
 * Streamed text chars of a step - reasoning + text parts plus the tool-call
 * payload (the streamed JSON in `raw` while pending, the structured input
 * after landing), so ANY streaming input counts toward the tokens/s window
 * regardless of where it is going. Growing for the in-flight step, final for
 * completed ones; summed across a turn's steps this is the turn's cumulative
 * streamed text, the source for the live streaming tokens/s.
 */
export function streamedChars(parts: Part[] | undefined): number {
  let chars = 0
  for (const p of parts ?? []) {
    if (p.type === "reasoning") chars += p.text.length
    else if (p.type === "text") chars += p.text.length
    else if (p.type === "tool") {
      const s = p.state
      if (s.status === "pending") chars += s.raw.length
      else chars += JSON.stringify(s.input ?? {}).length
    }
  }
  return chars
}

/**
 * In-memory accumulator for a LIVE turn's footer stats. Each completed step
 * folds its real endpoint values in exactly ONCE (the `folded` set makes the
 * fold idempotent), so the footer never re-scans the store per part delta nor
 * walks the DB mid-turn. `start` is the turn's root user message created
 * time (the elapsed clock anchor), kept next to the counters. Keyed by
 * `${sessionID}:${parentID}` at the call site; superseded by the completed
 * turn's DB walk (the walk result wins once it lands).
 */
export type TurnLiveAccum = {
  reasoning: number
  output: number
  tools: number
  chars: number
  start?: number
  folded: Set<string>
}

/** A fresh per-turn accumulator. `start` seeds the clock from the store. */
export function newTurnLiveAccum(start?: number): TurnLiveAccum {
  return { reasoning: 0, output: 0, tools: 0, chars: 0, start, folded: new Set() }
}

/**
 * Fold a turn's completed steps into the accumulator exactly once: real
 * reasoning/output tokens, tool-call part count, and streamed chars (the
 * tokens/s window's source). Steps already in `folded` are skipped, so the
 * fold is idempotent across re-runs and remounts (a remount folds every
 * completed step back from the store). Returns whether anything was folded.
 * Pure - unit-tested.
 */
export function foldTurnSteps(
  acc: TurnLiveAccum,
  steps: AssistantMessage[],
  getParts?: (messageID: string) => Part[] | undefined,
): boolean {
  let changed = false
  for (const step of steps) {
    if (!step.time.completed || acc.folded.has(step.id)) continue
    acc.reasoning += step.tokens.reasoning
    acc.output += step.tokens.output
    const parts = getParts?.(step.id) ?? []
    acc.tools += parts.filter((p) => p.type === "tool").length
    acc.chars += streamedChars(parts)
    acc.folded.add(step.id)
    changed = true
  }
  return changed
}

/**
 * The live footer token totals: the folded accumulator (completed steps' real
 * values) plus the in-flight step's estimate. O(1) over the completed turn -
 * the caller resolves the single in-flight step's parts.
 */
export function turnLiveFromAccum(
  acc: TurnLiveAccum | undefined,
  inFlight: AssistantMessage | undefined,
  getParts?: (messageID: string) => Part[] | undefined,
): { reasoning: number; output: number } {
  const reasoning = acc?.reasoning ?? 0
  const output = acc?.output ?? 0
  if (inFlight) {
    const est = estimateStepTokens(inFlight, getParts?.(inFlight.id))
    return { reasoning: reasoning + est.reasoning, output: output + est.output }
  }
  return { reasoning, output }
}

type StreamRateState = {
  cumulative: number
  samples: Array<[number, number]>
  lastRate: number
  lastTime: number
  smoothed: number
  streamKey: string
}

// EMA time constant for the smoothed tokens/s: the display chases the raw
// window rate with a ~300ms 63%-converge time of STREAMING (alpha per sample
// = 1 - exp(-dt/tau), so the smoothing is independent of chunk density).
// Single-chunk wobble damps; a sustained rate change still moves the display
// within ~300ms; a stall freezes it (no samples -> no EMA update).
const STREAM_RATE_TAU_MS = 300


// The streaming-rate window state is SHARED across every footer instance:
// each mid-turn LLM call is a NEW assistant message with its OWN footer
// component, and a per-component tracker would reset on every step swap
// (a fresh tracker anchored at the turn's accumulated chars computes dc=0 and
// hides the rate through the whole tool call). Keyed by the turn's root user
// message id (globally unique); the map is insertion-ordered and capped so
// stale turns prune themselves.
const streamRateStates = new Map<string, StreamRateState>()

/**
 * Streaming tokens/s for a turn: a rolling 1-second window over the turn's
 * streamed text chars (4 chars/token), sampled ONLY when the char count
 * grows - i.e. while text is actually arriving. Between samples the last
 * computed rate is returned unchanged, so the display FREEZES during
 * tool-call and TTFT stalls (no output arriving) instead of decaying. The
 * freeze is keyed to the STREAMING STATE, not time: each mid-turn LLM call is
 * one streaming episode (a new assistant message), and passing the current
 * in-flight step id as `streamKey` means any episode change - a step
 * completing or a new one beginning - drops the window and freezes the EMA
 * through the change. The FIRST sample of an episode ANCHORS it (zero
 * streaming elapsed time for the EMA, no delta for the window) - a new
 * stream's slow-start raw would otherwise drag the value down with a near-1
 * alpha over the TTFT. Tracking resumes from the second sample, with real
 * inter-chunk elapsed time, moving from the frozen value. The EMA spans the
 * WHOLE agent turn (shared state); only a new turn key starts fresh. The rate
 * is the tokens received over the trailing ~1s: before the window fills it is
 * the average since streaming started.
 */
export function streamRateFor(
  turnKey: string,
  streamKey: string,
  chars: number,
  now: number = Date.now(),
): number {
  let st = streamRateStates.get(turnKey)
  if (!st) {
    st = { cumulative: 0, samples: [], lastRate: 0, lastTime: 0, smoothed: 0, streamKey: "" }
    streamRateStates.set(turnKey, st)
    if (streamRateStates.size > 64) streamRateStates.delete(streamRateStates.keys().next().value as string)
  }
  // A new streaming episode (a step completed, or a new one began): the old
  // window belongs to a stream that ended. Drop it and freeze the EMA through
  // the change - the value holds across tool-call / TTFT gaps regardless of
  // their length. The change itself SEEDS the anchor sample so the very next
  // growth chunk counts a real delta instead of eating an extra frozen sample
  // (BUG_FOOTER_LIVE_STATS_STALE: the old [] seed forced TWO samples after
  // each episode change before the rate moved - on short streams with wide
  // batching that reads as "frozen per semi-turn").
  if (streamKey !== st.streamKey) {
    st.streamKey = streamKey
    const anchored: [number, number][] = st.cumulative === 0 && st.samples.length === 0 ? [] : [[now, chars]]
    st.samples = anchored
    st.cumulative = chars
    st.lastTime = now
    return st.smoothed
  }
  if (chars > st.cumulative) {
    // STALL RE-ANCHOR (BUG_FOOTER_LIVE_STATS_STALE): more than a second
    // passed since the last MEASURED growth chunk - a real pause (tool call
    // / TTFT / user thinking) happened. Without this check
    // the first post-gap chunk measures dt across the ENTIRE stall and drags
    // smoothed toward 0, so the rate "climbs back up from 0" after every tool
    // call. Re-anchor the window so the resume measures from the resume, not
    // across the gap. Batch delivery stays sub-second (the window widens to
    // 1024ms only while frames are actually rendering), so live streaming
    // never reads as a stall. (The first-ever turn has no samples yet - the
    // anchor branch below handles it.)
    if (st.samples.length > 0 && now - st.lastTime > 1000) {
      st.samples = [[now, chars]]
      st.cumulative = chars
      st.lastTime = now
      return st.smoothed
    }
    // The first sample of an episode anchors the window: no delta to measure
    // and zero streaming elapsed time, so it must not move the value (the new
    // stream's slow-start raw + near-1 alpha over the TTFT would drag the EMA
    // down). Tracking resumes on the second sample.
    if (st.samples.length === 0) {
      st.samples = [[now, chars]]
      st.cumulative = chars
      st.lastTime = now
      return st.smoothed
    }
    st.cumulative = chars
    st.samples.push([now, chars])
    const cutoff = now - 1000
    while (st.samples.length > 2 && st.samples[0][0] <= cutoff) st.samples.shift()
    const [t0, c0] = st.samples[0]
    const dt = (now - t0) / 1000
    const dc = st.cumulative - c0
    st.lastRate = dt > 0 ? dc / dt / CHARS_PER_TOKEN : 0
    if (st.smoothed === 0) {
      // first real measurement of the turn: snap (no cold-start ramp from 0)
      st.smoothed = st.lastRate
    } else {
      const alpha = 1 - Math.exp(-(now - st.lastTime) / STREAM_RATE_TAU_MS)
      st.smoothed += alpha * (st.lastRate - st.smoothed)
    }
    st.lastTime = now
  }
  return st.smoothed
}
