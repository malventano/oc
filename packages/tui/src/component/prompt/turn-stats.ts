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
    input,
    output,
    tokens: input + output,
    providerID: last.providerID,
    modelID: last.modelID,
  }
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
