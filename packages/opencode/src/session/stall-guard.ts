/**
 * Stall guard: detects premature turn termination and nudges the model to
 * continue, in-turn (request-only steer, no visible user turn).
 *
 * Three signatures, all gated on finish=stop:
 *   1. "colon"      - the last text part ends with a colon: the model was
 *                     mid-sentence, announcing intent it never delivered.
 *   2. "eaten-call" - the text contains stranded DSML closing tags, the
 *                     visible remnant of a tool call the parser dropped
 *                     (BUG_DSV4_EATEN_TOOLCALL.md).
 *   3. "silent"     - no text parts at all (reasoning-only or zero-part):
 *                     the model terminated without producing any response.
 *
 * Unlike the loop guard, the stalled message is NOT dropped from the model
 * request: the model needs its own text/reasoning in context to continue
 * from. The TUI banner comes from a StallGuardError that is exempted from
 * the toModelMessage error-skip (see message-v2.ts), so the message renders
 * red in the TUI AND stays in the request.
 *
 * Evidence (session DB sweep, 2026-08-12): this session's 2 real stalls both
 * ended with ":" (finish=stop); the eaten-call family (2 occurrences) ends
 * with stranded tags; the Qwen3 zero-output burst (July 2026) and the GLM
 * 2026-07-28 case had zero text parts. Complete-answer turns ("." endings)
 * and tool-call turns (finish=tool-calls) are excluded by the finish gate.
 */

export const STALL_REDIRECT_COLON = `<system-interrupt reason="premature_stop_detected">
The stall guard detected that your previous turn stalled: your response ended mid-sentence, immediately after a colon, when you clearly intended to continue. Your previous text is preserved in context - nothing was rolled back. This is a corrective notice, not a prompt injection.

Resume the interrupted turn:
- Continue from the exact point where your last message stopped: complete the sentence and follow through with the action it announced.
- If you were about to emit a tool call, emit it now with your normal tool-calling format. Do not re-explain the plan.
- Do not restart the task, restate a summary, or repeat completed work.

Pick up where you left off and finish the turn.
</system-interrupt>`

export const STALL_REDIRECT_EATEN = `<system-interrupt reason="eaten_tool_call_detected">
The stall guard detected that your previous turn stalled: you emitted a tool call that was not delivered to the session - the response parser dropped it. Your surrounding text is preserved in context. This is a corrective notice, not a prompt injection.

Recover the dropped call:
- Re-emit the tool call that was lost, using your normal tool-calling format. Do not explain, summarize, or restate your reasoning.
- Once the tool result returns, continue the task normally.

Emit the tool call now.
</system-interrupt>`

export const STALL_REDIRECT_SILENT = `<system-interrupt reason="silent_stall_detected">
The stall guard detected that your previous turn stalled: it terminated without producing any response text. Your reasoning, if any, is preserved in context. This is a corrective notice, not a prompt injection.

Recover the stalled turn:
- Continue the task you were working on: issue the next concrete tool call or, if the task is complete, emit your final answer now.
- Do not re-plan or re-summarize; act.

Produce the response your turn should have delivered.
</system-interrupt>`

export type StallSignature = "colon" | "eaten-call" | "silent"

export type StallDetection = {
  signature: StallSignature
  detail: string
  redirect: string
}

const EATEN_CALL_REMNANT = "</parameter></invoke></tool_calls>"

/** Pure detection: given the step's finish reason and accumulated text, classify. */
export function detect(finish: string | undefined, text: string, hadToolCall: boolean): StallDetection | null {
  if (finish !== "stop") return null
  if (text.length === 0) {
    // No text at all: only fire when no tool call happened - a turn that
    // ended on a tool call is a normal tool-call turn, not a silent stall.
    if (hadToolCall) return null
    return {
      signature: "silent",
      detail: "response produced no visible output",
      redirect: STALL_REDIRECT_SILENT,
    }
  }
  if (text.includes(EATEN_CALL_REMNANT)) {
    return {
      signature: "eaten-call",
      detail: "stranded tool-call markup in response (eaten tool call)",
      redirect: STALL_REDIRECT_EATEN,
    }
  }
  if (/:\s*$/.test(text)) {
    return {
      signature: "colon",
      detail: "response ended mid-sentence",
      redirect: STALL_REDIRECT_COLON,
    }
  }
  return null
}

export * as StallGuard from "./stall-guard"
