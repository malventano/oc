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

// Micro-frame recycle (2026-09-01 evidence, B200 profiling session msg
// 05b4a1afd0 / 05ae30d740 / 05ac336c60): the loop TYPE that escapes every
// word-typed gate. The old signatures key on vocabulary (INTENT_PREFIX
// "let me", THRASH_INTENT mouths, SHORT_FRAME_MIN_NORM=12 floor) - a loop
// built from 1-2 word imperative/exclamatory frames ("Now." "Go." "Run."
// "Execute." "Snapshot.") has 0 "let me" and most frames under 12 chars, so
// it falls below ALL of them. The LOOP TYPE is structural, not lexical: a
// dense run of short frames that recycle a tiny repertory with no numerals /
// concrete anchors and no new-named artifact. Detect that directly.
//
// Frame test (word-agnostic "loop-type" shape): 2-14 normalized chars, a
// letter, no digit, no concrete anchor. "Go." "Now." "Run." "Snapshot."
// all pass; "sleep 1200s / 53% / INSTANCE_CONTEXT_B200.md" do not (digits /
// anchors = progress markers).
const MICRO_MIN_NORM = 2
const MICRO_MAX_NORM = 14 // "sleep 1200s" (11) excluded by the digit test
const MICRO_WINDOW = 14 // rolling frame window
const MICRO_MIN_QUAL = 10 // >= 10 of 14 frames must be loop-type (density)
const MICRO_MAX_DISTINCT = 8 // how many distinct loop-type shapes may recycle
const MICRO_MIN_REPEAT = 0.5 // >= half the frames must repeat at least once
const MICRO_MAX_SPAN = 16 // contiguous in the stream (window spans <= 16 segs)
// Non-global copy of the anchor pattern: `.test()` on a `/g` regex is stateless
// only if no /g flag is present (the concurrent matchAll call sites re-clone,
// but MICRO_QUALIFY runs on every short segment and must not share lastIndex).
const MICRO_ANCHOR_TEST =
  /`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/
const MICRO_QUALIFY = (n: string) =>
  n.length >= MICRO_MIN_NORM &&
  n.length <= MICRO_MAX_NORM &&
  /[a-z]/.test(n) &&
  !/\d/.test(n) &&
  !MICRO_ANCHOR_TEST.test(n)

// Intent-frame thrash (2026-08-26 evidence, B200 profiling session): a
// narration burst that ESCAPES the short-frame detector (0215) because the
// frames are fused with no blank-line separation ("Editing now:Let me make the
// edit", "sh:the clean...") - so normalized segments push past the 60-char
// near-dup floor - AND the scope of phrasings exceeds 12 distinct. The tell
// that survives fusing is the RECYCLED GOAL: adjacent pairs of content words
// ("orchestrator tiles", "confirmed survivors") re-appear across many intent
// sentences, while healthy narration names a DIFFERENT artifact every time
// ("transform file" vs "type table" vs "prompt assembly" - no pair repeats).
type ThrashFrame = { start: number; norm: string; words: string[]; pairs: string[] }
const THRASH_WINDOW = 1000 // raw-text channel window scanned per delta
const THRASH_MIN_FRAMES = 6 // intent-tone frames required before judgement
const THRASH_MIN_NORM = 10 // shortest useful intent frame ("let me check")
const THRASH_MAX_NORM = 260 // fused run-ons run long; cap as one sentence
const THRASH_BIGRAM_REPEAT = 3 // a content-bigram in >= this many = recycle
// Fuse-aware split: a zero-width lookahead at each intent MOUTH starts a frame
// even mid-sentence, so ":Let me" / "now:I'll" / "TILES update and launch" all
// fragment out of the fused jam without consuming the mouth itself.
const THRASH_SPLIT =
  /(?=\b(?:let me|let'?s|i'?ll|i'?m (?:going|about|trying|want|hop) to|i'?m? ?(?:need|want|should|will|would|can|have) to|now (?:let me|i|we)|updating|editing|recording|appending|checking|verifying|launching|running|continuing|reviewing|inspecting|monitoring|waiting|prepping|preparing|cleaning|removing|adding|rebuilding|restarting|rechecking|setting up|installing|pushing)\b)/i
// Intent-tone test against the NORMALIZED frame ("I'll update..." ->
// "i ll update..."; apostrophes/punctuation are gone). Gerund openers included:
// the loop re-uses them as the mouth alongside "let me".
const THRASH_INTENT =
  /^(let me|let s|i ll|now (let me|let s|i|we)|i (need|want|should|will|would|can|could|have|am (going|about)|m (going|about))|updating|editing|recording|appending|checking|verifying|launching|running|continuing|reviewing|inspecting|monitoring|waiting|prepping|preparing|cleaning|removing|adding|rebuilding|restarting|rechecking|setting up|installing|pushing)\b/i
// Words that don't count toward a goal: grammar + the intent mouths, so the
// recycled-goal bigrams surface content ("orchestrator tiles") not frame shape.
const THRASH_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "at", "for",
  "with", "from", "it", "its", "this", "that", "these", "those", "now", "just",
  "then", "up", "out", "back", "here", "there", "if", "is", "are", "was", "were",
  "be", "been", "do", "does", "did", "done", "so", "as", "by", "i", "we", "you",
  "me", "my", "our", "your", "it s", "it ll", "yes", "yeah", "no", "ok", "okay",
  "alright", "right", "well", "maybe", "perhaps", "likely", "probably", "please",
  // intent mouths (normalized): let me / i ll / i m / gerunds / need-want
  "let", "me", "let", "let s", "i ll", "i m", "need", "want", "should", "will",
  "would", "can", "could", "may", "might", "have", "has", "had", "go", "going",
  "to", "about", "trying", "hoping", "try", "do", "prep", "prepping", "prepare",
  "preparing", "also", "again", "still", "first", "next", "finally", "then",
  "update", "updating", "edit", "editing", "record", "recording", "append",
  "appending", "check", "checking", "verify", "verifying", "launch", "launching",
  "run", "running", "continue", "continuing", "review", "reviewing", "inspect",
  "inspecting", "monitor", "monitoring", "wait", "waiting", "clean", "cleaning",
  "remove", "removing", "add", "adding", "rebuild", "rebuilding", "restart",
  "restarting", "recheck", "rechecking", "set", "setting", "install", "installing",
  "push", "pushing", "start", "starting", "stop", "stopping", "make", "maker",
  "take", "see", "look", "ensure", "confirm", "confirming", "work", "working",
  "mark", "marker", "get", "getting", "give", "use", "using", "put", "write",
  "writing", "read", "reading", "say", "tell", "proceed", "pressing", "press",
])
// Concrete artifact the model is reasoning about (code spans, dotted members,
// paths, snake/camel/Pascal identifiers) - reuse the near-dup anchor to veto
// recycle when the loop suddenly names something new (progress beats trashing).
const THRASH_ANCHOR =
  /`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g

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
    // Backtick code spans stay ATOMIC (a single underscore-joined token): a
    // quoted command or path is a concrete artifact the model may legitimately
    // reference many times while progressing (e.g. monitoring `hf download` -
    // the GLM-5.3 workflow), NOT recycled prose. Spanning them out as
    // space-separated words made multi-word commands ("hf download",
    // "cacheflow_server.py --port 8090") synthesize recycled content-bigrams
    // and fired thrash on healthy long-running workflows (2026-08-28 GLM MPT
    // FP). The underscore-joined form also matches the snake anchor, so the
    // span doubles as a concrete artifact for the progress veto.
    .replace(/`([^`]*)`/g, (_m: string, inner: string) => "_" + inner.replace(/[^a-z0-9]+/g, "_") + "_")
    .replace(/[^a-z0-9_]+/g, " ")
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
  // Micro-frame recycle window (2026-09-01): rolling record of the last
  // MICRO_WINDOW segments that pass the loop-type shape test, plus every
  // segment's seg offset so the span gate can tell a dense run from recycled
  // frames scattered across real prose (mirrors the short-frame contiguity gate).
  #microFrames: { start: number; norm: string; seg: number }[] = []
  #microRunStart: number | null = null
  // Monotonic segment counter shared by the short-frame path and the near-dup
  // path, so `seg` puts every emitted segment on one timeline (discriminates
  // contiguous recycling from interspersed legit work).
  #shortSegCount = 0
  // The raw offset where the current contiguous run of intent frames began,
  // so the loop-trim anchor de-posions the WHOLE looped region (not just the
  // oldest window-retained frame). Reset when an intent frame is followed by
  // a non-intent short segment.
  #shortRunStart: number | null = null
  // Intent-frame thrash accumulator: raw text-channel tail (THRASH_WINDOW)
  // with its absolute base offset, plus the persistent run-start anchor for
  // the de-poison trim (kept across the window slice so a run longer than
  // THRASH_WINDOW still trims from its true origin).
  #textRaw = ""
  #textBase = 0
  #thrashRunStart: number | null = null

  // Thrash (intent-frame recycled-goal scan) is a TEXT-channel signature:
  // healthy reasoning is intent-framed narration about one artifact, so
  // recycled content bigrams are its NORM, not a loop signal. The original
  // 0217 ran thrash on BOTH channels through the shared push() and cut
  // healthy reasoning mid-investigation (2026-08-26 live FP, reverted then
  // re-landed gated); this flag gates the scan at construction time -
  // reasoning detector off, text on.
  #scanThrashEnabled = false

  constructor(opts?: { thrash?: boolean }) {
    this.#scanThrashEnabled = opts?.thrash === true
  }

  push(delta: string): LoopHit | null {
    if (!delta) return null
    this.#rawLen += delta.length
    // Feed the thrash accumulator (fuse-aware frame scan), keeping a sliding
    // window of the last THRASH_WINDOW raw chars with an absolute base.
    if (this.#scanThrashEnabled) {
      this.#textRaw += delta
      if (this.#textRaw.length > THRASH_WINDOW) {
        const dropped = this.#textRaw.length - THRASH_WINDOW
        this.#textRaw = this.#textRaw.slice(dropped)
        this.#textBase += dropped
      }
    }
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
        // Residue: nothing new segmented for the near-dup / short-frame paths.
        // Fall through to the intent-frame thrash scan (the fused narration
        // loop never yields clean segments, so only this raw-pass catches it).
        if (this.#scanThrashEnabled) {
          const thrash = this.#scanThrash()
          if (thrash) return thrash
        }
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
    this.#microFrames = []
    this.#microRunStart = null
    this.#shortSegCount = 0
    this.#shortRunStart = null
    this.#textRaw = ""
    this.#textBase = 0
    this.#thrashRunStart = null
  }

  #scanThrash(): LoopHit | null {
    const raw = this.#textRaw
    if (raw.length < 300) return null
    const chunks = raw.split(THRASH_SPLIT)
    if (chunks.length < THRASH_MIN_FRAMES + 1) return null
    // Frames: each chunk after the lead-in starts at an intent mouth; the
    // lead-in chunk (index 0) is ordinary prose that precedes the run.
    let off = this.#textBase
    let framesTotal = 0
    const intents: ThrashFrame[] = []
    for (const chunk of chunks) {
      if (chunk === "") continue
      framesTotal++
      const start = off
      off += chunk.length
      const norm = normalizeSegment(chunk)
      if (norm.length < THRASH_MIN_NORM) {
        // Too short to be a goal-statement frame; still counts as a frame so
        // the density gate doesn't get fooled by one-word "let me" noise.
        continue
      }
      if (!THRASH_INTENT.test(norm)) continue
      const words = norm.split(" ").filter((w) => w && !THRASH_STOP.has(w))
      const pairs: string[] = []
      for (let i = 1; i < words.length; i++) pairs.push(`${words[i - 1]} ${words[i]}`)
      intents.push({ start, norm, words, pairs })
      if (intents.length === 4) {
        // Seed the persistent run anchor as soon as an intent run is plausible;
        // extended while the frame continues recycling.
        this.#thrashRunStart = this.#thrashRunStart ?? intents[0].start
      }
    }
    if (intents.length < THRASH_MIN_FRAMES) return null
    // Density: intent frames must dominate the window (>= 1 of 3) - a stray
    // "let me" inside a telemetry dump must not trip the sign.
    if (intents.length * 3 < framesTotal) return null
    // Keep only normable intent frames within the sentence cap; the recycle
    // evidence lives across the WHOLE run (frames reach peak variety early and
    // degenerate to one-liners at the tail, too short to carry pairs), so count
    // pairs over all of them - the anchor veto still guards legitimate work.
    const counted = intents.filter((f) => f.norm.length <= THRASH_MAX_NORM)
    if (counted.length < THRASH_MIN_FRAMES) return null
    const pairCounts = new Map<string, number>()
    const priorAnchors = new Set<string>()
    let recycle: { pair: string; count: number } | null = null
    for (let i = 0; i < counted.length; i++) {
      const f = counted[i]
      if (i < counted.length - 1) for (const a of f.words.join(" ").matchAll(THRASH_ANCHOR)) priorAnchors.add(a[0])
      for (const pair of f.pairs) {
        const n = (pairCounts.get(pair) ?? 0) + 1
        pairCounts.set(pair, n)
        if (n >= THRASH_BIGRAM_REPEAT) recycle = { pair, count: n }
      }
    }
    if (!recycle) return null
    const last = counted[counted.length - 1]
    for (const a of last.words.join(" ").matchAll(THRASH_ANCHOR)) {
      if (!priorAnchors.has(a[0])) return null // new artifact named - progress
    }
    return {
      hit: `intent-frame thrash: "${recycle.pair.trim()}" recycled ${recycle.count}x across ${counted.length} intent sentences (fused narration loop)`,
      trimAt: this.#thrashRunStart ?? counted[0].start,
    }
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
    // Micro-frame recycle (2026-09-01): word-agnostic loop-TYPE detection.
    // Record the segment if it is short enough to be a loop-type frame; a
    // qualifying frame seeds the contiguous run, a non-qualifying one resets
    // it (real prose interleaves and breaks the run). The window holds the
    // last MICRO_WINDOW records regardless of qualification so the density
    // gate can measure recycle vs interspersed work.
    if (normalized.length < SEGMENT_MIN_NORM_CHARS) {
      if (MICRO_QUALIFY(normalized)) {
        if (this.#microRunStart === null) this.#microRunStart = start
        this.#microFrames.push({ start, norm: normalized, seg: this.#shortSegCount })
        if (this.#microFrames.length > MICRO_WINDOW) this.#microFrames.shift()
        if (this.#microFrames.length >= MICRO_MIN_QUAL) {
          // Density gate: >= MICRO_MIN_QUAL of the last MICRO_WINDOW stream
          // positions must be loop-type frames. Non-qualifying segments are
          // NOT in #microFrames (only qualifying ones are pushed), so the
          // span gate (seg diff) is what bounds density: if the qualifying
          // frames span more than MICRO_MAX_SPAN stream segments they are
          // interspersed with real work, not a contiguous loop.
          const last = this.#microFrames[this.#microFrames.length - 1]
          const first = this.#microFrames[0]
          const span = last.seg - first.seg
          if (span <= MICRO_MAX_SPAN) {
            const distinct = new Set(this.#microFrames.map((f) => f.norm)).size
            const counts = new Map<string, number>()
            for (const f of this.#microFrames) counts.set(f.norm, (counts.get(f.norm) ?? 0) + 1)
            const repeats = this.#microFrames.filter((f) => (counts.get(f.norm) ?? 0) >= 2).length
            if (distinct <= MICRO_MAX_DISTINCT && repeats / this.#microFrames.length >= MICRO_MIN_REPEAT) {
              return {
                hit: `${this.#microFrames.length} consecutive short frames recycle only ${distinct} phrasings (micro-frame loop)`,
                trimAt: this.#microRunStart ?? this.#microFrames[0].start,
              }
            }
          }
        }
      } else {
        // Non-qualifying short segment: break the contiguous micro run (real
        // prose or a progress marker interleaved), keep the window history.
        this.#microRunStart = null
      }
    } else {
      // Long segment: real content, breaks the run.
      this.#microRunStart = null
    }
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
  // Thrash is TEXT-channel-only: healthy reasoning narrates its intent around
  // one artifact (recycled content bigrams are the norm, not a loop signal) -
  // running thrash there was the live 2026-08-26 FP. Reasoning keeps its own
  // signatures (near-dup / lex-stall / short-frame).
  const reasoning = new TextLoopDetector({ thrash: false })
  const text = new TextLoopDetector({ thrash: true })
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
