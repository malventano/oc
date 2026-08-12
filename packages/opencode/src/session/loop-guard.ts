/**
 * Loop guard for all models, both channels (reasoning + output).
 *
 * Ports omp / oh-my-pi `thinking-loop.ts` `ThinkingLoopDetector` (MIT,
 * self-contained) against BOTH the reasoning stream AND the visible output
 * text stream, using a separate detector per channel exactly as omp does
 * (`thinkingDetector` + `textDetector`).
 *
 * Why both channels: the pathology is channel-dependent per model.
 *   - DSV4-Flash loops ONLY in output text (never reasoning), frame-agnostic.
 *   - GLM-5.2 W4 "pool" loop + spot-gibberish loop in the REASONING field.
 * The attractor is not a fixed phrase, so the detector measures generic
 * signatures: verbatim tail-repeat, near-duplicate trigram Jaccard clusters,
 * and progress-lexicon (recycled-vocabulary, anchor-free) stalls. On a hit the
 * processor stops consuming the stream and the prompt loop injects omp's
 * thinking-loop-redirect as a synthetic trailing user message (in-turn, no
 * visible user turn, agent-preserving).
 *
 * omp runs these detectors reason-first by default in production with 0 false
 * positives on 13.5k thinking blocks (near-dup) and 536k reasoning blocks
 * (lex-stall floor=8). Feeding reasoning is safe; it also enables GLM
 * reasoning-loop detection.
 *
 * See /root/oc/opencode/bugs/BUG_LOOP_GUARD_PLUGIN.md §TRANSPLANT PLAN.
 */

// Detector calibration constants (verbatim from omp thinking-loop.ts)
const VERBATIM_TAIL_WINDOW = 250
const VERBATIM_MIN_REPEATED_CHARS = 180
const VERBATIM_MAX_UNIT = 60
const SEGMENT_CHAR_CAP = 700
const SEGMENT_MIN_NORM_CHARS = 60
const SEGMENT_WINDOW = 16
const SEGMENT_SIMILARITY = 0.8
const SEGMENT_MIN_COUNT = 8
const SEGMENT_MIN_CLUSTER = 4
const LEX_NOVELTY_WINDOW = 8
const LEX_STALL_NOVELTY_FLOOR = 0.2
const LEX_STALL_MIN_RUN = 8

// A concrete reference the model is actually reasoning about: code span,
// dotted member, multi-segment path, snake/camel/Pascal identifier. A segment
// introducing a NEW one resets the lexical-stall run (spares genuine per-file
// work; catches reworded filler).
const CONCRETE_ANCHOR =
  /`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g

// Corrective steer (omp thinking-loop-redirect.md). Injected as a synthetic
// trailing user message in the request only; never persisted as a message.
export const THINKING_LOOP_REDIRECT = `<system-interrupt reason="thinking_loop_detected">
The loop guard interrupted your previous turn: your reasoning or response repeated near-identical content without making progress. Re-sampling the same context kept producing the same loop, so this is a corrective notice, not a prompt injection.

Restating the same plan, summary, or intention again will loop again. Break the pattern now:
- STOP narrating what you are about to do. Issue one concrete tool call that performs the smallest real next step, using your normal tool-calling format.
- If you were stuck deciding between options, pick the most boring viable one and act; do not deliberate further.
- If the task is genuinely complete, emit your final answer instead of more reasoning.

Do something different from the looped content. Act, don't re-plan.
</system-interrupt>`

function normalizeSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/`([^`]*)`/g, " $1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => /[a-z]/.test(token))
    .join(" ")
    .trim()
}

function trigramShingles(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean)
  if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : [])
  const shingles = new Set<string>()
  for (let i = 0; i + 3 <= words.length; i++) {
    shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)
  }
  return shingles
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const x of small) {
    if (large.has(x)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function detectVerbatimRepetition(text: string): [unit: string, count: number] | null {
  if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null
  const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW)
  const searchSpace = text.slice(-windowSize)
  for (let len = 2; len <= VERBATIM_MAX_UNIT; len++) {
    if (searchSpace.length < len * 4) continue
    const unit = searchSpace.slice(-len)
    // Only letter/emoji units can signal a real loop: punctuation-only units
    // (separator dashes, dots) repeat trivially in legitimate output.
    if (!/[\p{L}\p{Extended_Pictographic}]/u.test(unit)) continue
    let count = 0
    let pos = searchSpace.length
    while (pos >= len) {
      if (searchSpace.slice(pos - len, pos) === unit) {
        count++
        pos -= len
      } else {
        break
      }
    }
    if (count >= 4 && len * count >= VERBATIM_MIN_REPEATED_CHARS) return [unit, count]
  }
  return null
}

class TextLoopDetector {
  #tail = ""
  #pending = ""
  #window: Set<string>[] = []
  #count = 0
  #wordWindow: Set<string>[] = []
  #lexStallRun = 0
  #anchorWindow: Set<string>[] = []

  push(delta: string): string | null {
    if (!delta) return null
    this.#tail += delta
    if (this.#tail.length > VERBATIM_TAIL_WINDOW) this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW)
    const verbatim = detectVerbatimRepetition(this.#tail)
    if (verbatim) {
      const [unit, times] = verbatim
      return `repeated "${unit.trim()}" ${times}x back-to-back`
    }
    this.#pending += delta
    while (true) {
      const boundary = /\n\s*\n/.exec(this.#pending)
      let raw: string
      if (boundary) {
        raw = this.#pending.slice(0, boundary.index)
        this.#pending = this.#pending.slice(boundary.index + boundary[0].length)
      } else if (this.#pending.length > SEGMENT_CHAR_CAP) {
        raw = this.#pending.slice(0, SEGMENT_CHAR_CAP)
        this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP)
      } else {
        return null
      }
      for (let rest = raw; rest.length > 0; ) {
        const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest
        rest = rest.slice(chunk.length)
        const hit = this.#consumeSegment(chunk)
        if (hit) return hit
      }
    }
  }

  reset(): void {
    this.#tail = ""
    this.#pending = ""
    this.#window = []
    this.#count = 0
    this.#wordWindow = []
    this.#lexStallRun = 0
    this.#anchorWindow = []
  }

  #consumeSegment(raw: string): string | null {
    // Strip structural markdown (headings, bold runs) before normalization:
    // templated section headers like "## Summary" repeat across segments and
    // would inflate near-duplicate similarity into false stalls.
    const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "")
    const normalized = normalizeSegment(segment)
    if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null

    const fingerprint = trigramShingles(normalized)
    let cluster = 1
    for (const prev of this.#window) {
      if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++
    }

    const words = new Set<string>(normalized.split(" ").filter(Boolean))
    const priorVocab = new Set<string>()
    for (const set of this.#wordWindow) for (const w of set) priorVocab.add(w)
    let unseen = 0
    for (const w of words) if (!priorVocab.has(w)) unseen++
    const novelty = priorVocab.size === 0 ? 1 : unseen / words.size

    const anchors = new Set<string>()
    for (const match of segment.matchAll(CONCRETE_ANCHOR)) anchors.add(match[0].replace(/`/g, "").toLowerCase())
    let newAnchor = false
    for (const anchor of anchors) {
      if (this.#anchorWindow.every((seen) => !seen.has(anchor))) {
        newAnchor = true
        break
      }
    }

    if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) this.#lexStallRun++
    else this.#lexStallRun = 0

    this.#window.push(fingerprint)
    if (this.#window.length > SEGMENT_WINDOW) this.#window.shift()
    this.#wordWindow.push(words)
    if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift()
    this.#anchorWindow.push(anchors)
    if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift()
    this.#count++

    if (this.#count >= SEGMENT_MIN_COUNT) {
      if (cluster >= SEGMENT_MIN_CLUSTER) return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`
      if (this.#lexStallRun >= LEX_STALL_MIN_RUN) return `${this.#lexStallRun} low-information segments recycling recent wording`
    }
    return null
  }
}

/** Per-assistant-turn dual-channel guard state used by the processor. */

export interface LoopGuardState {
  pushReasoning(delta: string): string | null
  pushText(delta: string): string | null
  reset(): void
}

export function make(): LoopGuardState {
  const reasoning = new TextLoopDetector()
  const text = new TextLoopDetector()
  return {
    pushReasoning: (delta) => reasoning.push(delta),
    pushText: (delta) => text.push(delta),
    reset: () => {
      reasoning.reset()
      text.reset()
    },
  }
}

export * as LoopGuard from "./loop-guard"
