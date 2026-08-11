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
    let hit: string | null = null
    for (let i = 0; i < 6; i++) {
      hit = guard.pushText(unit)
    }
    expect(hit).toContain('repeated "obsolete')
    expect(hit).toContain("6x")
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
    let hit: string | null = null
    for (const segment of NEAR_DUP_SEQUENCE) {
      hit = guard.pushText(segment + SEP)
    }
    expect(hit).toContain("near-identical segments")
  })

  test("does not fire on distinct paragraphs", () => {
    const guard = LoopGuard.make()
    for (let i = 0; i < 12; i++) {
      expect(guard.pushText(distinctParagraph(i) + SEP)).toBeNull()
    }
  })
})

describe("LoopGuard lexical stall", () => {
  test("detects low-novelty segments recycling recent wording", () => {
    const guard = LoopGuard.make()
    let hit: string | null = null
    for (let i = 0; i < 9; i++) {
      hit = guard.pushText(shuffled() + SEP)
    }
    expect(hit).toContain("low-information segments")
  })
})

describe("LoopGuard channels and disarm", () => {
  test("routes reasoning and text deltas to independent detectors", () => {
    const guard = LoopGuard.make()
    const unit = "obsolete content repeating itself "
    for (let i = 0; i < 6; i++) guard.pushText(unit)
    expect(guard.pushText(unit)).toContain("repeated")
    expect(guard.pushReasoning(unit)).toBeNull()

  })

  test("fires on a reasoning-channel near-dup loop (GLM pool case)", () => {
    const guard = LoopGuard.make()
    let hit: string | null = null
    for (const segment of NEAR_DUP_SEQUENCE) {
      hit = guard.pushReasoning(segment + SEP)
    }
    expect(hit).toContain("near-identical segments")
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
