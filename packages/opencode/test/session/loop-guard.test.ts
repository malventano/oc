import { describe, expect, test } from "bun:test"
import { LoopGuard } from "@/session/loop-guard"

const SEP = "\n\n"

// ~80-char segment, well above the 60 normalized-char floor.
const NEAR_DUP = "The configuration service loads provider settings from the local filesystem on startup"
const NEAR_DUP_VARIANT = "The configuration service loads provider settings from the local filesystem during boot"


// 4+ identical segments within the 16-segment window trip the cluster bar at
// count 8 (the identical ones accumulate while the variants stay below the
// 0.8 Jaccard bar).
const NEAR_DUP_SEQUENCE = [
  NEAR_DUP,
  NEAR_DUP,
  NEAR_DUP,
  NEAR_DUP,
  NEAR_DUP_VARIANT,
  NEAR_DUP,
  NEAR_DUP_VARIANT,
  NEAR_DUP,
]

// Words recycled across segments in different orders: identical vocabulary
// (novelty 0) but trigram Jaccard well under 0.8, and no concrete anchors.
const POOL = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"]
function shuffled(): string {
  const words = [...POOL]
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[words[i], words[j]] = [words[j], words[i]]
  }
  return words.join(" ")
}

const TOPICS = [
  "zebra migration patterns across the savanna plains",
  "quantum entanglement correlations in superconducting circuits",
  "medieval trade routes connecting distant coastal ports",
  "glacial sediment layers under the antarctic ice sheet",
  "urban beekeeping yields across rooftop gardens",
  "volcanic basalt columns along the northern coastline",
  "seasonal plankton blooms in the eastern pacific current",
  "ancient irrigation canals of the southern highlands",
  "coral reef biodiversity around the indonesian archipelago",
  "wind erosion cycles shaping desert sandstone arches",
  "nocturnal pollination networks in alpine meadows",
  "tidal energy potential of narrow fjord channels",
]

function distinctParagraph(n: number): string {
  return `Paragraph ${n} discusses ${TOPICS[n % TOPICS.length]} with entirely different supporting detail`
}

describe("LoopGuard verbatim tail-repeat", () => {
  test("detects back-to-back unit repetition at 180+ chars", () => {
    const guard = LoopGuard.make()
    const unit = "obsolete content repeating itself "
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 6; i++) {
      hit = guard.pushText(unit)
    }
    expect(hit?.hit).toContain('repeated "obsolete')
    expect(hit?.hit).toContain("6x")
  })

  test("does not fire on short or non-repeating tails", () => {
    const guard = LoopGuard.make()
    for (const delta of ["short", "different", "words", "here"]) {
      expect(guard.pushText(delta)).toBeNull()
    }
  })
})

describe("LoopGuard near-duplicate segments", () => {
  test("detects a cluster of near-identical segments within the window", () => {
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (const segment of NEAR_DUP_SEQUENCE) {
      hit = guard.pushText(segment + SEP)
    }
    expect(hit?.hit).toContain("near-identical segments")
  })

  test("does not fire on distinct paragraphs", () => {
    const guard = LoopGuard.make()
    for (let i = 0; i < 12; i++) {
      expect(guard.pushText(distinctParagraph(i) + SEP)).toBeNull()
    }
  })

  test("does not fire when near-identical segments are scattered across the window (quote-replay, 2026-09-06)", () => {
    // Question-tool FP (msg_07516e9c/07525e183/07526efa4): legit reasoning that
    // re-quotes a pasted transcript matched 4 near-identical segments (the
    // user's quoted text) at DEEP slots 10-14 + one recent slot, so the old
    // 16-window cluster hit the floor. The RECENT_NEAR_DUP_WINDOW gate counts
    // only matches within the newest 8 slots - a genuine loop's frames are
    // back-to-back (offsets 1-8), the quote-replay's are spread far apart, so
    // the scattered cluster stays under the bar. Structure: 3 near-identical
    // segments buried under 8+ distinct paragraphs, then the final hit lands
    // right after them (only the offset-1 match is recent).
    const guard = LoopGuard.make()
    const buried = Array.from({ length: 3 }, () => NEAR_DUP)
    // 9 distinct paragraphs separate the buried trio from the final same-text
    // segment: 3 (buried) + 9 (gap) + 1 (final) = 13 segments, so the buried
    // trio sits at offsets 10-12 when the final one lands - outside the recent
    // 8-slot gate. Without the gate (any-window cluster) the trio + slot-1
    // final = 4 near-identical = the old fire.
    const expr = [
      ...buried,
      ...Array.from({ length: 9 }, (_, i) => distinctParagraph(1 + i)),
      NEAR_DUP,
    ]
    let hit: LoopGuard.LoopHit | null = null
    for (const segment of expr) {
      hit = guard.pushText(segment + SEP)
      if (hit) break
    }
    expect(hit).toBeNull()
  })

  test("a post-compaction re-loop still fires on a fresh detector (0214 keeps the loop guard active on compaction-continue)", () => {
    // 0214 exempts the STALL guard for compaction-continue steps only - its
    // endpoint signatures fire on every normal resume. The loop guard's
    // repetition detectors must NOT be exempted: a model that re-loops after
    // the auto-compaction resume is exactly the pathology the guard exists for,
    // and its detector state resets at the message boundary (processor.ts), so
    // this exercises the post-resume re-loop on that fresh state.
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (const segment of NEAR_DUP_SEQUENCE) {
      hit = guard.pushText(segment + SEP)
    }
    expect(hit?.hit).toContain("near-identical segments")
  })
})

describe("LoopGuard lexical stall", () => {
  test("detects low-novelty segments recycling recent wording", () => {
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 9; i++) {
      hit = guard.pushText(shuffled() + SEP)
    }
    expect(hit?.hit).toContain("low-information segments")
  })
})

describe("LoopGuard channels and disarm", () => {
  test("routes reasoning and text deltas to independent detectors", () => {
    const guard = LoopGuard.make()
    const unit = "obsolete content repeating itself "
    for (let i = 0; i < 6; i++) guard.pushText(unit)
    expect(guard.pushText(unit)?.hit).toContain("repeated")
    expect(guard.pushReasoning(unit)).toBeNull()
  })

  test("fires on a reasoning-channel near-dup loop (GLM pool case)", () => {
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (const segment of NEAR_DUP_SEQUENCE) {
      hit = guard.pushReasoning(segment + SEP)
    }
    expect(hit?.hit).toContain("near-identical segments")
  })

  test("reset clears all state", () => {

    const guard = LoopGuard.make()
    for (const segment of NEAR_DUP_SEQUENCE) guard.pushText(segment + SEP)
    guard.reset()
    // After a reset the counters restart: a partial re-feed cannot fire.
    for (const segment of NEAR_DUP_SEQUENCE.slice(0, 4)) {
      expect(guard.pushText(segment + SEP)).toBeNull()
    }
  })
})

describe("LoopGuard new signatures (2026-08-15 evidence)", () => {
  test("fires on a symbol-only tail (U+2580 block loop, evidence case 1)", () => {
    const guard = LoopGuard.make()
    const hit = guard.pushText("\u2580".repeat(250))
    expect(hit?.hit).toContain("distinct characters")
    expect(hit?.trimAt).toBe(0)
  })

  test("fires on a U+FFFD decode-garbage burst (evidence case 2)", () => {
    const guard = LoopGuard.make()
    const hit = guard.pushText("\uFFFD".repeat(100))
    expect(hit?.hit).toContain("replacement characters")
  })

  test("whitespace-collapse: newline inside an ok-run still fires verbatim", () => {
    const guard = LoopGuard.make()
    const run = "ok ".repeat(40) + "\n" + "ok ".repeat(46)
    const hit = guard.pushText(run)
    expect(hit?.hit).toContain('repeated "ok"')
  })

  test("trimAt points at the loop start when the run fills the tail window", () => {
    const guard = LoopGuard.make()
    const prefix = "real analysis about the prompt bar and the duplicated answer text. ".repeat(3)
    const hit = guard.pushText(prefix + "\u2580".repeat(250))
    expect(hit?.hit).toContain("distinct characters")
    expect(hit?.trimAt).toBe(prefix.length)
  })

  test("does not fire on diverse prose tails", () => {
    const guard = LoopGuard.make()
    for (let i = 0; i < 12; i++) {
      expect(guard.pushText(distinctParagraph(i) + SEP)).toBeNull()
    }
  })
})

describe("LoopGuard short-frame intent recycling (2026-08-21 evidence)", () => {
  // The 2026-08-19 evidence loop (msg_01af49bbe001IpZAtqDjZ5iT3H): 15,207 raw
  // chars, ~600 segments all under the 60-char near-dup floor, alternating a
  // handful of "let me check/look/inspect" phrasings. Escaped every other
  // signature (replay-verified null); only the recycled intent-declaration
  // density catches it.
  const INTENT_FRAMES = [
    "Let me check the marker's parts.",
    "Let me look at the marker parts.",
    "Let me check.",
    "Let me look.",
    "Let me inspect the marker.",
    "Let me check the marker message.",
  ]

  test("fires when 9+ of 12 short frames recycle intent-declarations", () => {
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 14; i++) {
      hit = guard.pushText(INTENT_FRAMES[i % INTENT_FRAMES.length] + SEP)
    }
    expect(hit?.hit).toContain("intent declaration")
    expect(hit?.hit).toContain("recycle only")
    // trimAt = the first short frame's offset (0 here, no prefix; the segment
    // math rounds by trailing-boundary whitespace, so a handful of chars is
    // fine) - the loop runs from the very first intent frame, so the de-poison
    // anchor drops the whole looped region while keeping the preserved prefix.
    expect(typeof hit?.trimAt).toBe("number")
    expect(hit!.trimAt).toBeLessThan(8)
  })

  test("does not fire on spaced-out legit short frames (window span gate)", () => {
    const guard = LoopGuard.make()
    // The research-message class: "Let me look at X / Let me read Y / Let me
    // grep Z" used as RUNNING NARRATION over real interspersed tool work. The
    // intent ratio can climb toward the bar, but the frames are spread far
    // apart (each followed by several prose/code segments), so the contiguity
    // gate (span <= 16 segments) refuses to fire. Genuine recycling loops keep
    // the frames back-to-back (span ~11-12) and must NOT be distingushed to
    // silence.
    const spanApart = [
      "Let me look at the transform file.",
      "The transformed payload carries the epoch reference in its metadata.",
      "Verifying the types definition against the schema export.",
      "Let me read the full type table.",
      "The annotation block sits after the model config section.",
      "Let me check the config file layout.",
      "Resolving the provider options from the merged config.",
      "Let me search for the correct entry point.",
      "The bootstrap order handles lazy loading of the services.",
      "Let me read all the files that construct the request.",
      "Cross-referencing with the session store path.",
      "Let me look for the file that owns the prompt assembly.",
    ]
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 3; i++) {
      for (const segment of spanApart) {
        hit = guard.pushText(segment + SEP)
        if (hit) break
      }
      if (hit) break
    }
    expect(hit).toBeNull()
  })

  // loop-209 class frames: ~12 varied "let me check ..." phrasings with
  // recycled "bug folder" - the recycled content-bigram trips the intent-frame
  // thrash (0217) FIRST (fires ~3 frames before the short-frame span gate),
  // which is correct: the loop is caught at the earliest reliable evidence.
  const LOOP209 = [
    "Let me check the subagent artifacts and bug folder structure.",
    "Let me check the rest of the tmp opencode artifacts.",
    "Let me see the tsv dir artifacts and bug folder.",
    "Let me look at the remaining artifacts.",
    "Let me check tmp opencode subdirs and the bug fodder.",
    "Let me see the rest.",
    "Let me check the remaining tmp items and bug dir.",
    "Let me check subagent artifacts and bug folder.",
    "Let me see the rest of tmp opencode artifacts.",
    "Let me get the subagent outputs and bug folder.",
    "Let me list the relevant dirs.",
    "Let me check.",
  ]
  test("contiguity is the discriminator: contiguous frame clusters still fire (loop-209 class)", () => {
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 2; i++) {
      for (const frame of LOOP209) {
        hit = guard.pushText(frame + SEP)
        if (hit) break
      }
      if (hit) break
    }
    expect(hit).not.toBeNull()
    // Either signature may win: short-frame ("intent declaration ... recycle
    // only ...") or the fused-narration thrash ("intent-frame thrash:", fires
    // earliest on the recycled "bug folder" bigram).
    expect(hit!.hit).toMatch(/intent declaration|intent-frame thrash/)
  })

  test("intent-frame thrash: fires on a fused narration loop (0217, B200 evidence msg_03f28149b)", () => {
    const guard = LoopGuard.make()
    const text =
      'Now let me record the tp1pp2 anomaly note and update the clean orchestrator to include the confirmed survivors (tp8, tp4, tp4pp2, tp2pp2 - dropping the borderline tp2/tp1pp2 per the screen threshold). Let me add the anomaly note to the runbook, then launch the clean phase:\n\nLet me add the anomaly note and then proceed. First the anomaly note:\n\nRecord the tp1pp2 double-run anomaly in the runbook, then launch the clean phase on the 4 confirmed survivors.\n\nLet me append the anomaly note:\n\nAppending the anomaly note to the runbook:\n\nRecording the anomaly:</parameter>'
    const hit = guard.pushText(text)
    expect(hit).not.toBeNull()
    expect(hit!.hit).toContain("intent-frame thrash")
    expect(hit!.hit).toContain("anomaly note")
    // run-start anchor: the loop began with the first intent frame (offset 4 =
    // "Now " lead-in), so the whole thrash region leaves context
    expect(hit!.trimAt).toBeLessThanOrEqual(4)
  })

  test("intent-frame thrash: fires on the recycled-goal booster (0217, B200 evidence msg_03f294e9500)", () => {
    const guard = LoopGuard.make()
    const text =
      'Found #65. Now let me add #66-68 (and the spread table), appending after line 353. Let me view the exact line context to append cleanly:\n\nLet me now add the new skill entries #66-68 after #65. I\'ll edit right after the #65 line:\n\nNow adding the new skill learnings. Editing after #65:Adding skill entries #66-68 after line 353 now.\n\nI\'ll insert after the #65 bullet:Let me add the new pitfall IDs to the skill now.\n\nEditing the skill to append #66-68:Let me make the edit now.Inserting the new skill bullets after #65:\n\nMaking the edit now.\n\nI need to invoke the edit tool. Adding entries after #65:Editing the skill file now.\n\nLet me call the edit tool to add #66-68 after #65 now. Invoking it now.'
    const hit = guard.pushText(text)
    expect(hit).not.toBeNull()
    expect(hit!.hit).toContain("intent-frame thrash")
  })

  test("intent-frame thrash: does not fire on healthy single-intent narration (0217)", () => {
    const guard = LoopGuard.make()
    const healthy =
      "That's the MP CPU-offload example (kv_both). Let me find the actual P/D disaggregation examples in the container.\n\n" +
      "Both engines are same-version (all phases vLLM 0.28.0 + LMCache 0.5.4). Let me fix the stale version claims in the docs and record the verified reality.\n\n" +
      "Still in engine-boot. The runner's banner-check window may have expired into the 90s sleep. Let me wait and check the process tree plus screen verdict."
    expect(guard.pushText(healthy)).toBeNull()
  })

  test("intent-frame thrash: fires on text but not reasoning (0217 channel gate)", () => {
    // The fused-narration loop is a TEXT-channel pathology (B200 evidence:
    // "reasoning + tool-arg content stay perfectly coherent"). The detector
    // constructor now gates thrash: text channel on, reasoning channel off -
    // healthy reasoning is intent-framed narration about one artifact, so the
    // recycled "anomaly note" bigram there is normal (the 2026-08-26 live FP:
    // this build's own reasoning was cut by the un-gated 0217).
    const loop =
      'Let me record the tp1 anomaly note and update the runbook to confirm survivors (tp8, tp4). Let me add the anomaly note now. ' +
      'Adding the anomaly note to the runbook. Let me record the anomaly note next. ' +
      'Recording the anomaly note. Let me append the anomaly note after the entry. ' +
      'Appending the anomaly note to the runbook now. Let me record the anomaly note in the status. ' +
      'Recording the anomaly note for the runbook. Let me update the runbook with the anomaly note.'
    const text = LoopGuard.make()
    expect(text.pushText(loop)?.hit).toContain("intent-frame thrash")
    const reasoning = LoopGuard.make()
    expect(reasoning.pushReasoning(loop)).toBeNull()
  })

  test("intent-frame thrash: backtick code spans are atomic, not recycled prose (0223, DSV4-Flash FP)", () => {
    // The long-running download-monitor workflow (ses_0ef150898ffeAOiy - "Optimizing
    // GLM MPT" title, model DSV4-Flash, msg_04c2dd4fd001, 2026-08-29). The
    // narration legitimately references the
    // `hf download` CLI command across 7 intent sentences while PROGRESSING
    // through real steps (let it run, set up a completion check, record state,
    // wait, run the symlink-finalize, verify MODEL). The old normalizeSegment
    // split the backtick span into the plain word pair "hf download",
    // synthesizing a recycled content-bigram that fired thrash on healthy
    // workflow narration. Backtick spans must normalize to a SINGLE
    // underscore-joined token (atomic concrete artifact, same policy as the
    // near-dup anchor), so the pair never forms.
    const healthy =
      "Found it - **the repo's files have a per-file HEAD that advertises an HTTP 3xx redirect chain through r2, and the actual transfer is being served at ~20 MB/s even though we request `--limit-rate 50m`**. The 20-21 MB/s is the remote CDN (Cloudflare/R2) throttling this connection, not our cap. The earlier flat-dir wget hit a full 50.0M/s on the SAME 1040 MB `model-00001`, so this is **connection-specific rate variance from the redirect target** - not our limiter.\n\n" +
      "This is an ambient variance on the HF/R2 side. Our cap is 50; the server is delivering ~21-50 depending on the resolved edge. Nothing to fix in our setup - it just means ETA is ~2x (closer to 2.5h at ~20-50 variable). The throttle guarantee (≤50) holds; the actual achievable is the CDN's give.\n\n" +
      "Let me let it run. When the blob pass completes, the finalize `hf download` then creates symlinks. I'll set up a completion check. Let me record the state and monitor longer-term.\n\n" +
      'Given the variance, the honest ETA is "when the CDN allows" - the hard cap is guaranteed at 50, the floor is the server\'s current edge speed. I\'ll leave the pane running and check back at intervals; the moment all 144 blobs are present I\'ll run the `hf download` symlink-finalize + verify `MODEL` resolves by id.\n\n' +
      "While it cooks, let me verify one thing - that the `hf download"
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < healthy.length; i += 24) {
      hit = guard.pushText(healthy.slice(i, i + 24))
      if (hit) break
    }
    expect(hit).toBeNull()
  })

  test("intent-frame thrash: backtick atomic spans still catch the monitor-loop class (B200 evidence)", () => {
    // The B200 monitor-loop evidence survives the backtick-atomic change: the
    // recycled pair is plain-prose status filler ("campaign continues",
    // "tp1pp8 progress"), NOT a code span - the anchor veto (which would see
    // many distinct code spans as progress) must not swallow these. This pins
    // the 0217 evidence class against the 0223 normalization change.
    const loop =
      "Continuing to monitor. The spread proceeds as scheduled. Next boundary check. Campaign continues. Monitoring. " +
      "Continuing the monitor loop for the remaining tiles. Let me check the next box state now. Campaign continues. " +
      "The runbook tp1pp8 row update done. Let me continue monitoring. Continuing. Check. Monitoring. The campaign continues. " +
      "Let me run the next periodic check. Campaign continues. `tp1pp8 serving` check. Monitoring. Continuing.\n\n"
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 3; i++) {
      hit = guard.pushText(loop)
      if (hit) break
    }
    expect(hit).not.toBeNull()
    expect(hit!.hit).toContain("intent-frame thrash")
    expect(hit!.hit).toContain("campaign continues")
  })
})

describe("LoopGuard micro-frame recycle (2026-09-01, word-agnostic loop TYPE)", () => {
  // The B200 profiling session's Snapshot/Run/Now/Go loop (msg_05b4a1afd0,
  // 2026-09-01 04:46:18Z): 258 frames, 81 distinct, dominated by 1-2 word
  // imperative/exclamatory frames. It escaped every word-typed gate - zero
  // "let me" (INTENT_PREFIX), 71% of frames under SHORT_FRAME_MIN_NORM=12,
  // most under THRASH_MIN_NORM=10 - because the OLD signatures key on the
  // WORDS ("let me" / intent mouths / min-normalized-length that encodes a
  // "let me check" shape), not the LOOP TYPE. The type is structural: a dense
  // contiguous run of short frames recycling a tiny repertory, no numerals and
  // no new-named artifact (progress markers). This signature detects the type.
  const SEP = "\n\n"

  function saturate(frames: string[], rounds = 2): string {
    return Array.from({ length: rounds }, () => frames.join(SEP)).join(SEP) + SEP
  }

  test("fires on the B200 Snapshot.Run.Now.Go loop (msg_05b4a1afd0 shape)", () => {
    const frames = ["Snapshot.", "Run.", "Now.", "Go.", "Execute.", "Do it.", "Run snapshots.", "Go."]
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 5 && !hit; i++) {
      for (const f of frames) {
        hit = guard.pushText(f + SEP)
        if (hit) break
      }
    }
    expect(hit).not.toBeNull()
    expect(hit!.hit).toContain("micro-frame")
  })

  test("fires on the monitor Check/Continuing/Monitoring loop (B200 msg_03de4e892 shape)", () => {
    const frames = ["Check.", "Continuing.", "Monitoring.", "The spread.", "Campaign continues."]
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 5 && !hit; i++) {
      for (const f of frames) {
        hit = guard.pushText(f + SEP)
        if (hit) break
      }
    }
    expect(hit).not.toBeNull()
  })

  test("trimAt anchors at the looped run start, not the window fill", () => {
    const frames = [
      "All docs updated. The override sits at the top.",
      "Snapshot.", "Run.", "Now.", "Go.", "Execute.", "Do it.", "Run snapshots.",
      "Go.", "Now.", "Execute.", "Run.",
    ]
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 4 && !hit; i++) {
      for (const f of frames) {
        hit = guard.pushText(f + SEP)
        if (hit) break
      }
    }
    expect(hit).not.toBeNull()
    // The leader prose ("All docs updated...") is real content - the looped
    // run (and thus the trim) starts at the first loop-type frame.
    expect(hit!.trimAt).toBeGreaterThan(0)
  })

  test("does not fire on real work: interspersed numbered progress (progress markers veto)", () => {
    // Numeral-carrying frames ("53%", "tp1pp8 4017/23608") are progress
    // markers, not loop frames - a status message that carries real numbers
    // throughout must never read as a loop.
    const frames = [
      "tp1pp8 at 16.1%.",
      "tp2pp2 at 53%.",
      "tp1pp4 at 44%.",
      "tp1pp2 at 87%.",
      "tp4pp2 at 6.68 rps.",
      "tp2pp4 COMPLETE.",
    ]
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < 6 && !hit; i++) {
      for (const f of frames) {
        hit = guard.pushText(f + SEP)
        if (hit) break
      }
    }
    expect(hit).toBeNull()
  })

  test("does not fire on healthy multi-sentence working narration (edit-tool task prose)", () => {
    // Real task prose that names concrete artifacts (paths, file refs) every
    // frame stays below the concrete-anchor threshold: the frames do not
    // recycle (distinct > cap) and progress anchors break the run.
    const healthy =
      "The edit applied cleanly. Let me verify the volatile-persist split in git status shows only the expected three files.\n\n" +
      "Acknowledged - the split landing in core and the win32-handle Windows codepath, need to check the workspace state before proceeding further.\n\n" +
      "Let me continue with the marker update and the compaction check.\n\n" +
      "The upstream README confirms the NPM scoped package and the exact git+ssh install block - mirroring that for our repo."
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < healthy.length; i += 30) {
      hit = guard.pushText(healthy.slice(i, i + 30))
      if (hit) break
    }
    expect(hit).toBeNull()
  })

  test("does not fire when only ONE frame shape repeats with no loop density (brief interspersed 'check.')", () => {
    // A single recycled short frame interspersed across real long prose is not
    // a loop: the window never fills with qualifying frames (density gate).
    const healthy =
      "The box is back up. Checking sweep state via the ssh. The sweep looks healthy here - I pulled the trailing lines of the ladder output and the watchdog tail is stable.\n\n" +
      "Check.\n\n" +
      "The progress markers show od-50 replay at 790 of 23608 completed and the watchdog armed, past boot span.\n\n" +
      "Check.\n\n" +
      "The engine is booting now - the prefill burst danger window passes when the first completions land."
    const guard = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < healthy.length; i += 30) {
      hit = guard.pushText(healthy.slice(i, i + 30))
      if (hit) break
    }
    expect(hit).toBeNull()
  })
})

describe("LoopGuard warning-echo (2026-09-06)", () => {
  // The 09-06 fail class: the model reproduced the harness's OWN
  // `<system-reminder>warning: ...</system-reminder>` catch-up directives as
  // output. Exact text shape from msg_076500525001lfwZtWl9uu (the compaction
  // gate investigation loop). Fires at >=3 standalone warning tag lines.
  test("fires on standalone warning-echo tag lines reproduced as output", () => {
    const guard = LoopGuard.make()
    // Slice the WHOLE stream (lead narration + blank-separated echo tags) at
    // arbitrary boundaries - real SSE deltas split tags mid-token. The
    // detector rescans its accumulated window each push, so the tags complete.
    const full =
      "A stale \"compaction in progress\" state is a concrete lead. Let me find the gate.\n\n" +
      "<system-reminder>warning: tool call now.</system-reminder>\n\n" +
      "<system-reminder>warning: run them.</system-reminder>\n\n" +
      "<system-reminder>warning: do the tool call now.</system-reminder>\n\n"
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < full.length && !hit; i += 17) {
      hit = guard.pushText(full.slice(i, i + 17))
    }
    expect(hit?.hit).toContain("warning-echo")
  })

  test("the text channel fires but reasoning does not (marker-echo is model output, not injected time context)", () => {
    // The time-context harness injects `<system-reminder>2026-08-13T...</system-reminder>`
    // timestamps into reasoning - those never carry `warning:` so they must not
    // trip the echo detector on either channel. Replaying the 08-13 message
    // shape (ffdb3536b001xh4BICFZCX) must stay null.
    const harness =
      "<system-reminder>2026-08-13T20:33:31.900-04:00</system-reminder>\n\n" +
      "<system-reminder>2026-08-13T20:36:55.140-04:00</system-reminder>\n\n" +
      "<system-reminder>2026-08-14T00:29:13.164+00:00</system-reminder>\n\n" +
      "<system-reminder>2026-08-14T00:33:31.900+00:00</system-reminder>\n\n" +
      "<system-reminder>2026-08-14T00:34:49.776+00:00</system-reminder>\n\n" +
      "<system-reminder>2026-08-14T00:40:12.005+00:00</system-reminder>"
    const reasoning = LoopGuard.make()
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < harness.length; i += 40) {
      hit = reasoning.pushReasoning(harness.slice(i, i + 40))
    }
    expect(hit).toBeNull()
  })

  test("a quoted inline reference (line has prose before the tag) is not an echo", () => {
    const guard = LoopGuard.make()
    const ref =
      "explain that the guard appends a `<system-reminder>warning: check for leaks` to tool output in the docs\n\n" +
      "then write the reference as: `` /\\s*<system-reminder>warning: /i `` in the skill\n\n" +
      "confirm the tag appears only when quoted inline, not standalone"
    let hit: LoopGuard.LoopHit | null = null
    for (let i = 0; i < ref.length; i += 20) {
      hit = guard.pushText(ref.slice(i, i + 20))
      if (hit) break
    }
    expect(hit).toBeNull()
  })
})
