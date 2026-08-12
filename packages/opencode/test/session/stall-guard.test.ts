import { describe, expect, test } from "bun:test"
import { StallGuard } from "@/session/stall-guard"

describe("stall-guard detect", () => {
  test("colon signature: finish=stop with trailing colon", () => {
    const hit = StallGuard.detect("stop", "The file parses. Add L to RUNS and run it:", false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("colon")
    expect(hit!.detail).toBe("response ended mid-sentence")
  })

  test("colon signature: trailing colon with trailing whitespace/newline", () => {
    const hit = StallGuard.detect("stop", "Now let me verify the install:\n\n", false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("colon")
  })

  test("colon signature: does not fire on a completed sentence", () => {
    expect(StallGuard.detect("stop", "Everything is done. The build passed.", false)).toBeNull()
  })

  test("colon signature: does not fire on tool-calls finish", () => {
    expect(StallGuard.detect("tool-calls", "Let me fix properly:", false)).toBeNull()
  })

  test("colon signature: does not fire on other finish reasons", () => {
    expect(StallGuard.detect("length", "Let me do the thing:", false)).toBeNull()
    expect(StallGuard.detect("unknown", "Let me do the thing:", false)).toBeNull()
  })

  test("eaten-call signature: stranded DSML closing tags", () => {
    const hit = StallGuard.detect(
      "stop",
      "Let me verify the install is intact and check the new version.</parameter></invoke></tool_calls>",
      false,
    )
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("eaten-call")
    expect(hit!.detail).toBe("stranded tool-call markup in response (eaten tool call)")
  })

  test("silent signature: finish=stop with no text and no tool call", () => {
    const hit = StallGuard.detect("stop", "", false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("silent")
    expect(hit!.detail).toBe("response produced no visible output")
  })

  test("silent signature: does not fire when a tool call happened (normal tool turn)", () => {
    expect(StallGuard.detect("stop", "", true)).toBeNull()
  })

  test("silent signature: does not fire when finish is not stop", () => {
    expect(StallGuard.detect("tool-calls", "", false)).toBeNull()
  })

  test("each signature carries the matching redirect", () => {
    const colon = StallGuard.detect("stop", "run it:", false)!
    expect(colon.redirect).toBe(StallGuard.STALL_REDIRECT_COLON)

    const eaten = StallGuard.detect("stop", "x</parameter></invoke></tool_calls>", false)!
    expect(eaten.redirect).toBe(StallGuard.STALL_REDIRECT_EATEN)

    const silent = StallGuard.detect("stop", "", false)!
    expect(silent.redirect).toBe(StallGuard.STALL_REDIRECT_SILENT)
  })

  test("real stall tails from session DB match the colon signature", () => {
    // msg_ff6353981001wA (13:41:51, 26 tok, finish=stop) - "continue" nudged 20s later
    expect(StallGuard.detect("stop", "L_hint_fix is now inside S and the file parses. Add L to RUNS and run it:", false)).not.toBeNull()
    // msg_ff60d5c5b001YNBm71Yh (12:58:18, 276 tok, finish=stop) - "you stalled" nudged 29s later
    expect(StallGuard.detect("stop", "Let me add a `spacingOnly` flag to the scenario that strips comment text before comparing:", false)).not.toBeNull()
    // complete-answer turns that got user-directed "continue" must NOT fire
    expect(StallGuard.detect("stop", "No code change warranted.", false)).toBeNull()
    expect(StallGuard.detect("stop", "the designed flow.", false)).toBeNull()
  })
})
