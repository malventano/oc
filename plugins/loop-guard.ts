import type { PluginInput, Hooks } from "@opencode-ai/plugin"

// Loop guard for all models, both channels (reasoning + output).
//
// Ports omp / oh-my-pi `thinking-loop.ts` `ThinkingLoopDetector` (MIT, self-contained)
// against BOTH the reasoning stream AND the visible output text stream, using a separate
// detector per channel exactly as omp does (`thinkingDetector` + `textDetector`).
//
// Why both channels: the pathology is channel-dependent per model.
//   - DSV4-Flash loops ONLY in output text (never reasoning), frame-agnostic F1-F5.
//   - GLM-5.2 W4 "pool" loop + spot-gibberish loop in the REASONING field (content empty).
// The attractor is not a fixed phrase, so the detector measures generic signatures:
// verbatim tail-repeat, near-duplicate trigram Jaccard clusters, and progress-lexicon
// (recycled-vocabulary, anchor-free) stalls. On a hit it aborts the session and steers
// the model with omp's thinking-loop-redirect corrective notice.
//
// omp runs these detectors reason-first by default in production with 0 false positives
// on 13.5k thinking blocks (near-dup) and 536k reasoning blocks (lex-stall floor=8).
// DSV4's clean reasoning does not trip the calibrated thresholds, so feeding reasoning
// is safe for it too while enabling GLM reasoning-loop detection.
//
// See /root/oc/opencode/bugs/BUG_LOOP_GUARD_PLUGIN.md §TRANSPLANT PLAN.

// ---------------------------------------------------------------------------
// Detector calibration constants (verbatim from omp thinking-loop.ts)
// ---------------------------------------------------------------------------
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

// A concrete reference the model is actually reasoning about: code span, dotted member,
// multi-segment path, snake/camel/Pascal identifier. A segment introducing a NEW one
// resets the lexical-stall run (spares genuine per-file work; catches reworded filler).
const CONCRETE_ANCHOR =
  /`[^`]+`|\b\w{2,}\.[a-zA-Z]\w{0,4}\b|[\w-]+(?:\/[\w-]+){2,}|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g

// ---------------------------------------------------------------------------
// Corrective steer (omp thinking-loop-redirect.md)
// ---------------------------------------------------------------------------
const THINKING_LOOP_REDIRECT = `<system-interrupt reason="thinking_loop_detected">
The loop guard interrupted your previous turn: your reasoning or response repeated near-identical content without making progress. Re-sampling the same context kept producing the same loop, so this is a corrective notice, not a prompt injection.

Restating the same plan, summary, or intention again will loop again. Break the pattern now:
- STOP narrating what you are about to do. Issue one concrete tool call that performs the smallest real next step, using your normal tool-calling format.
- If you were stuck deciding between options, pick the most boring viable one and act; do not deliberate further.
- If the task is genuinely complete, emit your final answer instead of more reasoning.

Do something different from the looped content. Act, don't re-plan.
</system-interrupt>`

// ---------------------------------------------------------------------------
// Detector (ported from omp thinking-loop.ts). One instance per channel:
// reasoning AND assistant output text.
// ---------------------------------------------------------------------------
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

  flush(): string | null {
    if (!this.#pending) return null
    let rest = this.#pending
    this.#pending = ""
    while (rest.length > 0) {
      const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest
      rest = rest.slice(chunk.length)
      const hit = this.#consumeSegment(chunk)
      if (hit) return hit
    }
    return null
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
import fs from "node:fs"

const DEBUG_LOG = "/tmp/opencode/loop-guard-debug.log"
const dbgSeen = new Set<string>()
function dbg(msg: string) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

export default {
  id: "loop-guard",
  server: async (input: PluginInput): Promise<Hooks> => {
    const { client, directory } = input
    dbg(`server() called; directory=${directory} client=${typeof client}`)
    // Per-session state: sessionID -> { modelID, agent, firing, partType }
    // partType: Map<partID, "text" | "reasoning" | "tool" | other> built from
    // message.part.updated (full part objects publish before their deltas).
    // agent: current agent/mode from the most recent user message, so the steer
    // prompt preserves the current mode instead of defaulting to plan.
    const state = new Map<
      string,
      {
        modelID: string | null
        agent: string | null
        reasoningDetector: TextLoopDetector
        textDetector: TextLoopDetector
        firing: boolean
        partType: Map<string, string>
      }
    >()

    function getState(sessionID: string) {
      let s = state.get(sessionID)
      if (!s) {
        s = {
          modelID: null,
          agent: null,
          reasoningDetector: new TextLoopDetector(),
          textDetector: new TextLoopDetector(),
          firing: false,
          partType: new Map(),
        }
        state.set(sessionID, s)
      }
      return s
    }

    function resetDetectors(s: {
      reasoningDetector: TextLoopDetector
      textDetector: TextLoopDetector
    }) {
      s.reasoningDetector.reset()
      s.textDetector.reset()
    }

    async function intercept(client: any, sessionID: string, detail: string) {
      const s = getState(sessionID)
      if (s.firing) return
      s.firing = true
      dbg(`INTERCEPT sessionID=${sessionID} model=${s.modelID} agent=${s.agent} detail=${detail}`)
      try {
        // Abort the current assistant stream (SDK: session.abort, path.id).
        await client.session.abort({ path: { id: sessionID } })
        // Brief wait to let the stream tear down before steering, so the steer is
        // the next continuation rather than racing the aborted step.
        await new Promise((r) => setTimeout(r, 300))
        // Steer: append a user part carrying omp's corrective redirect.
        // Preserve the current agent/mode so the steer does not default to plan.
        const body: any = { parts: [{ type: "text" as const, text: THINKING_LOOP_REDIRECT }] }
        if (s.agent) body.agent = s.agent
        await client.session.prompt({ path: { id: sessionID }, body })
        dbg(`INTERCEPT done sessionID=${sessionID}`)
      } catch (e: any) {
        dbg(`INTERCEPT error sessionID=${sessionID} ${e?.message ?? e}`)
        // swallow: plugin errors must never break the session
      } finally {
        s.firing = false
        resetDetectors(s)
      }
    }

    return {
      event: async (input) => {
        const { type, properties } = input.event as any
        // Log every event at low volume (first occurrence per type) for diagnosis.
        if (!dbgSeen.has(type)) {
          dbgSeen.add(type)
          dbg(`EVENT ${type} keys=${properties ? Object.keys(properties).join(",") : "none"}`)
        }
        if (!properties || typeof properties.sessionID !== "string") return
        const sessionID: string = properties.sessionID
        const s = getState(sessionID)

        try {
          switch (type) {
            case "message.updated": {
              // info is a User or Assistant message. Model gate from assistant's
              // modelID; agent/mode from the most recent user message so the steer
              // inherits the current mode rather than defaulting to plan.
              const info = properties.info
              if (info && typeof info.role === "string") {
                let changed = false
                if (info.role === "assistant") {
                  const id = info.modelID ?? info.provider?.modelID ?? null
                  if (id && id !== s.modelID) {
                    s.modelID = id
                    changed = true
                  }
                } else if (info.role === "user" && typeof info.agent === "string") {
                  if (info.agent !== s.agent) {
                    s.agent = info.agent
                    changed = true
                  }
                }
                if (changed) dbg(`message.updated sessionID=${sessionID} role=${info.role} model=${s.modelID} agent=${s.agent}`)
              }
              break
            }

            case "session.updated": {
              const info = properties.info
              const m = info?.model
              if (m?.id) s.modelID = m.id
              break
            }

            case "message.part.updated": {
              // Full part objects publish BEFORE their deltas: record part type.
              const part = properties.part
              if (part && typeof part.id === "string" && typeof part.type === "string") {
                s.partType.set(part.id, part.type)
              }
              // A tool part is real progress: disarm so we never fire on healthy turns.
              if (part?.type === "tool" || part?.type === "agent") {
                resetDetectors(s)
              }
              break
            }

            case "message.part.delta": {
              if (s.firing) break
              // field "text" is used for BOTH reasoning and assistant output parts;
              // route each to its own detector by the recorded part type.
              if (properties.field !== "text") break
              if (typeof properties.delta !== "string") break
              const ptype = s.partType.get(properties.partID)
              let detail: string | null = null
              if (ptype === "reasoning") {
                detail = s.reasoningDetector.push(properties.delta)
              } else if (ptype === "text") {
                detail = s.textDetector.push(properties.delta)
              }
              if (detail) {
                await intercept(client, sessionID, detail)
              }
              break
            }
          }
        } catch (e: any) {
          dbg(`EVENT error ${type} ${e?.message ?? e}`)
          // swallow: never let a guard error break the session
        }
      },
    }
  },
}
