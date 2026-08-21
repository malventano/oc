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
 * New signatures (2026-08-15, evidence in /root/oc/opencode/bugs/evidence/):
 *   - low-diversity tail: the last 250 raw chars use <= LOW_DIVERSITY_MAX_UNIQUE
 *     distinct characters. Catches the U+2580 symbol loop (2026-08-14, 93,300
 *     of 97,126 reasoning chars were "block") and the character-noise loop
 *     (2026-08-15, 9 unique chars in the final window) - both previously
 *     invisible because symbol-only units fail the letter/emoji verbatim gate
 *     and normalize to below SEGMENT_MIN_NORM_CHARS.
 *   - U+FFFD burst: >= FFFD_BURST_THRESHOLD replacement chars in the tail.
 *     Decode-garbage marker; legit output contains none (2026-08-15 case had
 *     216 total, 52 in the final window).
 *   - Whitespace-collapse before verbatim unit stepping: a newline inside an
 *     "ok ok ok" run breaks unit alignment (longest pure run 165 chars < 180);
 *     collapsing \s+ to a single space counts the 86-token run as 258 chars.
 *
 * Every hit reports trimAt - the character offset (in the channel's own text)
 * where the looped region starts - so the prompt loop can preserve the
 * pre-loop content instead of dropping the whole message.
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

// New trigger calibrations (evidence 2026-08-14/15):
// Distinct characters in the last 250 raw chars at or below which the tail is
// degenerate. Legit prose/code runs 30-48 unique; both loop cases bottomed at
// 1-9. Binary/hex dumps ("0 1 0 1...") can sit near this - a rare false
// positive costs one steer round-trip.
const LOW_DIVERSITY_MAX_UNIQUE = 10
// Replacement chars (U+FFFD) in the tail window: decode-garbage marker. The
// 2026-08-15 case hit 26-52 per window; legit output has zero.
const FFFD_BURST_THRESHOLD = 10

// Short-frame "let me" intent recycling (2026-08-21, evidence msg_01af49bbe...):
// a loop whose frames are UNDER the 60-char segment floor escapes every other
// signature (verified-replay miss in the 2026-08-19 "let me" loop - 600
// segments all < 60 chars, alternating 4 phrasings, 15,207 chars, guard silent
// until a manual abort). The tell is the recycled INTENT DECLARATION framing
// ("Let me check / look / inspect / ..."), not trigram similarity (alternating
// frames share a prefix, not trigrams) nor raw-letter diversity (17 > 10).
const SHORT_FRAME_MIN_NORM = 12 // "let me check" -> 12 normalized chars
const SHORT_FRAME_MAX_NORM = 59 // just under SEGMENT_MIN_NORM_CHARS
const SHORT_FRAME_WINDOW = 12 // rolling short-segments window
const SHORT_FRAME_DENSITY = 0.75 // >= 9 of 12 short frames start with intent
const SHORT_FRAME_MAX_DISTINCT = 12 // how many phrase-shapes may recycle
const SHORT_FRAME_MAX_SPAN = 16 // the intent frames must be CONTIGUOUS (window
// spans <= 16 segments of the stream). Discriminates a real recycling loop
// (frames back-to-back, span ~11-12) from legit interspersed "let me X" that
// alternates with tool output / prose (research message: frames span 134
// segments; code-use narration: dozens apart). Without this, legit work that
// uses "let me look at X / let me read Y / let me grep Z" as running narration
// over real tool actions would fire.
const INTENT_PREFIX = /^let me\b/

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

// Tool-argument-stream loop steer: the model was generating a tool call whose
// argument text itself looped. The call never completed - re-emit it cleanly.
export const TOOL_INPUT_LOOP_REDIRECT = `<system-interrupt reason="tool_input_loop_detected">
The loop guard interrupted your previous turn: the argument stream of your tool call repeated near-identical content without progressing. The partial call was aborted and not executed. This is a corrective notice, not a prompt injection.

Re-emit the tool call now, with the full correct arguments - or, if the call itself is the problem, pick a different, simpler approach. Do not regenerate or restate anything else.
</system-interrupt>`

export type LoopHit = {
  hit: string
  /** Character offset in the channel's own text where the looped region starts. */
  trimAt: number
}

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

/**
 * Verbatim tail-repeat detection with whitespace-collapse: the tail's
 * whitespace runs are collapsed to single spaces before unit stepping, so a
 * newline inside a repeated phrase no longer breaks unit alignment. Returns
 * the unit, its count, and the collapsed-index of the counted run start.
 */
function detectVerbatimRepetition(
  text: string,
): { unit: string; count: number; runStart: number } | null {
  if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null
  const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW)
  const searchSpace = text.slice(-windowSize).replace(/\s+/g, " ")
  if (searchSpace.length < VERBATIM_MIN_REPEATED_CHARS) return null
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
    if (count >= 4 && len * count >= VERBATIM_MIN_REPEATED_CHARS) {
      return { unit, count, runStart: pos }
    }
  }
  return null
}

class TextLoopDetector {
  #tail = ""
  #tailStart = 0
  #pending = ""
  #rawLen = 0
  #window: { start: number; fp: Set<string> }[] = []
  #count = 0
  #wordWindow: { start: number; words: Set<string> }[] = []
  #lexStallRun = 0
  #lexRunStart = 0
  #anchorWindow: Set<string>[] = []
  // Short-frame "let me" intent-recycling window (2026-08-21): rolling low of
  // raw offset + normalized form per short segment (12-59 norm chars), so the
  // handler below can measure recycled-intent density over a saturated window.
  #shortFrames: { start: number; norm: string; seg: number }[] = []
  // Monotonic segment counter shared by the short-frame path and the near-dup
  // path, so `seg` puts every emitted segment on one timeline (discriminates
  // contiguous recycling from interspersed legit work).
  #shortSegCount = 0
  // The raw offset where the current contiguous run of intent frames began,
  // so the loop-trim anchor de-posions the WHOLE looped region (not just the
  // oldest window-retained frame). Reset when an intent frame is followed by
  // a non-intent short segment.
  #shortRunStart: number | null = null

  push(delta: string): LoopHit | null {
    if (!delta) return null
    this.#rawLen += delta.length
    this.#tail += delta
    if (this.#tail.length > VERBATIM_TAIL_WINDOW) {
      this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW)
      this.#tailStart = this.#rawLen - this.#tail.length
    }

    const verbatim = detectVerbatimRepetition(this.#tail)
    if (verbatim) {
      // Map the counted run's collapsed start back to a raw offset inside the
      // tail window, then to the absolute channel offset.
      const collapsed: { s: string; raw: number[] } = { s: "", raw: [] }
      for (let i = 0; i < this.#tail.length; ) {
        if (/\s/.test(this.#tail[i])) {
          collapsed.s += " "
          collapsed.raw.push(i)
          while (i < this.#tail.length && /\s/.test(this.#tail[i])) i++
        } else {
          collapsed.s += this.#tail[i]
          collapsed.raw.push(i)
          i++
        }
      }
      const runStartRaw = collapsed.raw[verbatim.runStart] ?? 0
      const trimAt = this.#tailStart + runStartRaw
      return { hit: `repeated "${verbatim.unit.trim()}" ${verbatim.count}x back-to-back`, trimAt }
    }

    // Decode-garbage burst: replacement chars in the tail window. Judged from
    // ~100 chars - a burst needs context; short legit messages never contain
    // U+FFFD at all.
    const fffd = (this.#tail.match(/\uFFFD/g) ?? []).length
    if (this.#tail.length >= 100 && fffd >= FFFD_BURST_THRESHOLD) {
      return { hit: `${fffd} replacement characters in the output tail`, trimAt: this.#tailStart }
    }

    // Entropy collapse: the tail draws from a tiny alphabet. Only judged on a
    // SATURATED window - a short tail (1-50 chars) trivially has few distinct
    // characters and would fire on every message start.
    const unique = new Set<string>(this.#tail).size
    if (this.#tail.length >= VERBATIM_TAIL_WINDOW && unique <= LOW_DIVERSITY_MAX_UNIQUE) {
      return { hit: `output tail uses only ${unique} distinct characters`, trimAt: this.#tailStart }
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
      // The extracted segment started at (rawLen - pending.length) BEFORE the
      // extraction removed it.
      let segmentStart = this.#rawLen - this.#pending.length - raw.length
      for (let rest = raw; rest.length > 0; ) {
        const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest
        rest = rest.slice(chunk.length)
        const hit = this.#consumeSegment(chunk, segmentStart)
        if (hit) return hit
        segmentStart += chunk.length
      }
    }
  }

  reset(): void {
    this.#tail = ""
    this.#tailStart = 0
    this.#pending = ""
    this.#rawLen = 0
    this.#window = []
    this.#count = 0
    this.#wordWindow = []
    this.#lexStallRun = 0
    this.#lexRunStart = 0
    this.#anchorWindow = []
    this.#shortFrames = []
    this.#shortSegCount = 0
    this.#shortRunStart = null
  }

  #consumeSegment(raw: string, start: number): LoopHit | null {
    // Strip structural markdown (headings, bold runs) before normalization:
    // templated section headers like "## Summary" repeat across segments and
    // would inflate near-duplicate similarity into false stalls.
    const segment = raw.replace(/^[ \t]*#{1,6}[ \t].*$/gm, "").replace(/^[ \t]*\*{2,3}.+?\*{2,3}[ \t]*$/gm, "")
    const normalized = normalizeSegment(segment)
    // Every consumed chunk is one tick on the shared segment timeline (used by
    // the short-frame contiguity gate to tell back-to-back recycling from
    // interspersed tool work / prose).
    this.#shortSegCount++
    if (normalized.length < SEGMENT_MIN_NORM_CHARS) {
      // Short-frame path: segments under the near-dup floor never enter the
      // cluster window, so loops built from short repeated frames WOULD escape
      // entirely (2026-08-19 evidence: 600 segments, all 12-59 chars, 15,207
      // raw chars, guard silent). Measure recycled intent-declaration density
      // here instead - the tell the phrase-recycling loop shares even though
      // its frames alternate wording and its raw letters stay > 10 distinct.
      if (normalized.length >= SHORT_FRAME_MIN_NORM && normalized.length <= SHORT_FRAME_MAX_NORM) {
        const isIntent = INTENT_PREFIX.test(normalized)
        // Track the contiguous intent run start (the de-poison anchor). Any
        // non-intent short segment inside the run breaks it - the loop signal
        // is intent frames back-to-back, not scattered ones.
        if (!isIntent) this.#shortRunStart = null
        else if (this.#shortRunStart === null) this.#shortRunStart = start
        this.#shortFrames.push({ start, norm: normalized, seg: this.#shortSegCount })
        if (this.#shortFrames.length > SHORT_FRAME_WINDOW) this.#shortFrames.shift()
        if (this.#shortFrames.length >= SHORT_FRAME_WINDOW) {
          const intent = this.#shortFrames.filter((f) => INTENT_PREFIX.test(f.norm)).length
          const distinct = new Set(this.#shortFrames.map((f) => f.norm)).size
          const span = this.#shortFrames[this.#shortFrames.length - 1].seg - this.#shortFrames[0].seg
          if (
            intent >= SHORT_FRAME_DENSITY * SHORT_FRAME_WINDOW &&
            distinct <= SHORT_FRAME_MAX_DISTINCT &&
            span <= SHORT_FRAME_MAX_SPAN
          ) {
            return {
              hit: `${intent} of the last ${SHORT_FRAME_WINDOW} sentence fragments start with an intent declaration, recycle only ${distinct} phrasings, and are contiguous over ${span} segments`,
              // The whole contiguous intent run, not just the oldest window
              // frame, is the looped region - trim from where the run began.
              trimAt: this.#shortRunStart ?? this.#shortFrames[0].start,
            }
          }
        }
      }
      // Non-short or low-density short content: no loop signal.
      return null
    }

    const fingerprint = trigramShingles(normalized)
    let cluster = 1
    let clusterStart = start
    for (const prev of this.#window) {
      if (jaccard(fingerprint, prev.fp) >= SEGMENT_SIMILARITY) {
        cluster++
        clusterStart = Math.min(clusterStart, prev.start)
      }
    }

    const words = new Set<string>(normalized.split(" ").filter(Boolean))
    const priorVocab = new Set<string>()
    for (const set of this.#wordWindow) for (const w of set.words) priorVocab.add(w)
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

    if (novelty <= LEX_STALL_NOVELTY_FLOOR && !newAnchor) {
      if (this.#lexStallRun === 0) this.#lexRunStart = start
      this.#lexStallRun++
    } else {
      this.#lexStallRun = 0
    }

    this.#window.push({ start, fp: fingerprint })
    if (this.#window.length > SEGMENT_WINDOW) this.#window.shift()
    this.#wordWindow.push({ start, words })
    if (this.#wordWindow.length > LEX_NOVELTY_WINDOW) this.#wordWindow.shift()
    this.#anchorWindow.push(anchors)
    if (this.#anchorWindow.length > LEX_NOVELTY_WINDOW) this.#anchorWindow.shift()
    this.#count++

    if (this.#count >= SEGMENT_MIN_COUNT) {
      if (cluster >= SEGMENT_MIN_CLUSTER) {
        return { hit: `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`, trimAt: clusterStart }
      }
      if (this.#lexStallRun >= LEX_STALL_MIN_RUN) {
        return {
          hit: `${this.#lexStallRun} low-information segments recycling recent wording`,
          trimAt: this.#lexRunStart,
        }
      }
    }
    return null
  }
}

/** Per-assistant-turn dual-channel guard state used by the processor. */

export interface LoopGuardState {
  pushReasoning(delta: string): LoopHit | null
  pushText(delta: string): LoopHit | null
  reset(): void
}

/** Standalone detector for non-message streams (e.g. tool-input deltas). */
export function makeDetector(): {
  push(delta: string): LoopHit | null
} {
  return new TextLoopDetector()
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
