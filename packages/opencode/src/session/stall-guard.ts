/**
 * Stall guard: detects premature turn termination and nudges the model to
 * continue, in-turn (request-only steer, no visible user turn).
 *
 * Five signatures, all gated on finish=stop:
 *   1. "colon"        - the last text part ends with a colon: the model was
 *                       mid-sentence, announcing intent it never delivered.
 *   2. "eaten-call"   - the text ENDS with the full stranded DSML tool-call
 *                       closing chain: the visible remnant of a tool call the
 *                       parser dropped (BUG_DSV4_EATEN_TOOLCALL.md). End-anchored
 *                       since 2026-08-15: a naive includes() false-positived
 *                       twice on replies that merely quoted the signature
 *                       string mid-text (evidence/2026-08-15-stall-stranded-response-tag.txt).
 *   3. "stray-closer" - the text ENDS with any other closing tag (</response>,
 *                       </div>, ...): either a degenerate/gibberish end with a
 *                       stray markup fragment, or a tool call dropped into a
 *                       different remnant shape. Neutral wording - no dropped
 *                       call may exist. (Evidence case 3, 2026-08-15.)
 *   4. "silent"       - no text parts at all (reasoning-only or zero-part):
 *                       the model terminated without producing any response.
 *   5. "let-me"       - the text STARTS with "let me <tool-action-verb>" but
 *                       delivered no tool call: the model stated an intent to
 *                       perform an action and then the turn ended without
 *                       performing it (2026-08-18 evidence: a reply that was
 *                       solely "Let me read the exact region of protocol.py
 *                       ... and check the ReasoningEffort type" with a stop
 *                       finish and no tool call). Since 2026-08-18 the
 *                       stray-closer closing tag is junk-tolerant and
 *                       fullwidth-slash-normalized: the model's slash
 *                       homoglyph U+FF5C is read as a real slash and non-space
 *                       junk is allowed inside the tag, so a degenerate close
 *                       like the fork case (mangled tool_calls tag with DSML
 *                       noise interleaved) is caught too.
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

export const STALL_REDIRECT_STRAY_CLOSER = `<system-interrupt reason="stray_closer_detected">
The stall guard detected that your previous turn ended with a stranded markup fragment (a closing tag with no matching structure). This can mean a tool call was dropped mid-parse, or that the response degenerated into garbage. Your previous text is preserved in context - nothing was rolled back. This is a corrective notice, not a prompt injection.

Recover:
- If you were in the middle of emitting a tool call, re-emit it now with your normal tool-calling format.
- Otherwise, if your previous response was incomplete or degenerate, stop that output pattern and produce your actual answer, or take the smallest next concrete step.

Do not continue the same output pattern.
</system-interrupt>`

export const STALL_REDIRECT_LET_ME = `<system-interrupt reason="intent_without_action">
The stall guard detected that your previous turn ended with a stated intent to perform an action ("Let me ...") but no tool call was delivered and the response produced no result. Your text is preserved in context - nothing was rolled back. This is a corrective notice, not a prompt injection.

Recover:
- If you meant to perform the action you announced, re-emit the tool call now with your normal tool-calling format. Do not restate the plan.
- Otherwise answer the user's request directly instead of announcing what you will do.

Do not repeat the same intent without acting on it.
</system-interrupt>`

export type StallSignature = "colon" | "eaten-call" | "silent" | "stray-closer" | "let-me"

export type StallDetection = {
  signature: StallSignature
  detail: string
  redirect: string
  /**
   * Character offset in the text where the offending tail starts - the
   * de-poison trim point (0203): everything at/after trimAt is removed from
   * the stored text before the turn continues, so the model's context is
   * clean of the stale reminder artifact. null = nothing to trim (silent has
   * no text, let-me has a valid intent statement worth keeping).
   */
  trimAt: number | null
}

// The full DSML tool-call closing chain: only this shape means a real call
// was dropped (parser consumed the opener, the model never finished it).
// Whitespace-tolerant between the tags: real stranded chains carry newlines
// (the parser leaks the closer line-by-line), so the contiguous string never
// matched live output - the 2026-08-18 17:10 eaten-call (full raw DSML block
// as text, `</parameter>\n</invoke>\n</tool_calls>`) fell through to
// stray-closer. `\s*` between the three tags + `\s*$` at the end covers both
// the contiguous and the multi-line shapes.
const EATEN_CALL_END = /<\/parameter>\s*<\/invoke>\s*<\/tool_calls>\s*$/

// Any other closing tag at the very end of the text: degenerate-end family
// (gibberish with a stray fragment) or an unrecognized remnant shape. Since
// 2026-08-18: junk-tolerant (non-space chars allowed inside the tag, so a
// mangled close like the fork case - a tool_calls tag with DSML noise
// interleaved - still matches) and checked on a fullwidth-slash-normalized
// copy (the model's slash homoglyph U+FF5C reads as a real slash).
const STRAY_CLOSER_END = /<\/[^\s<>]{0,40}>\s*$/

// Fullwidth vertical bar: the model's slash homoglyph in degenerate output.
const FULLWIDTH_BAR = "\uff5c"

// let-me intent-without-action: the response is a bare intent statement that
// starts with "let me <tool-action-verb>" but delivered no tool call. Only
// verbs that imply a TOOL action (read/check/verify/...) count - in-text
// verbs (explain/help/clarify) do not, so a complete "Let me explain ..."
// answer is never flagged. Gated on hadToolCall=false at the call site.
const LET_ME_VERBS =
  "read|check|look|verify|query|fetch|inspect|open|run|test|list|get|find|search|see|grep|examine|review|confirm|cat|ls|curl|stat|dig"
const LET_ME_START = new RegExp(`^\\s*let me\\s+(${LET_ME_VERBS})\\b`, "i")

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
      trimAt: null,
    }
  }
  // End-anchored checks only: real remnants end the text, and mid-text
  // matches false-positive on replies that quote the signature (2026-08-15).
  // The full chain also matches STRAY_CLOSER_END, so check it first.
  const norm = text.replaceAll(FULLWIDTH_BAR, "/")
  const eaten = EATEN_CALL_END.exec(norm)
  if (eaten) {
    return {
      signature: "eaten-call",
      detail: "stranded tool-call markup in response (eaten tool call)",
      redirect: STALL_REDIRECT_EATEN,
      // Trim from the chain opener (index 0 of the match) so the whole
      // stranded block leaves the context.
      trimAt: eaten.index,
    }
  }
  const stray = STRAY_CLOSER_END.exec(norm)
  if (stray) {
    return {
      signature: "stray-closer",
      detail: "response ended with a stray markup fragment",
      redirect: STALL_REDIRECT_STRAY_CLOSER,
      trimAt: stray.index,
    }
  }
  const colon = /:\s*$/.exec(text)
  if (colon) {
    return {
      signature: "colon",
      detail: "response ended mid-sentence",
      redirect: STALL_REDIRECT_COLON,
      // Trim the trailing colon + whitespace only; the sentence before is
      // the model's own useful intent (de-poison, keep the prefix).
      trimAt: colon.index,
    }
  }
  // Intent-without-action: announced a tool action but delivered no tool call
  // (the gate lives here: hadToolCall true means the intent was fulfilled).
  if (!hadToolCall && LET_ME_START.test(text)) {
    return {
      signature: "let-me",
      detail: "stated an intent to perform an action but no tool call was delivered",
      redirect: STALL_REDIRECT_LET_ME,
      // The "let me <verb>" intent statement is valid prose worth keeping;
      // the missing action is recovered by the plain continue.
      trimAt: null,
    }
  }
  return null
}

export * as StallGuard from "./stall-guard"
