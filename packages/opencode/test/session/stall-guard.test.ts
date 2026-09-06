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

  test("eaten-call signature: stranded DSML closing tags (contiguous)", () => {
    const hit = StallGuard.detect(
      "stop",
      "Let me verify the install is intact and check the new version.</parameter></invoke></tool_calls>",
      false,
    )
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("eaten-call")
    expect(hit!.detail).toBe("stranded tool-call markup in response (eaten tool call)")
  })

  test("eaten-call signature: whitespace-tolerant multi-line stranded chain (0203)", () => {
    // Real eaten-call output carries newlines between the closing tags
    // (2026-08-18 17:10 session msg_015da03410, the parser leaked the closer
    // line-by-line); the contiguous string never matched live output.
    const text =
      "\n\n<tool_calls>\n<invoke name=\"bash\">\n<parameter name=\"command\" string=\"true\">cd /root/oc/opencode/repos/opencode/packages/opencode/src && rg -rn 'restart' tool/ cli/ session/ 2>/dev/null | head</parameter>\n</invoke>\n</tool_calls>"
    const hit = StallGuard.detect("stop", text, false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("eaten-call")
    // trimAt = the outermost opener, so the whole leaked call leaves context
    expect(hit!.trimAt).toBe(text.indexOf("<tool_calls"))
  })

  test("eaten-call / stray-closer: contiguous leaked call trims to the whole block (0216)", () => {
    const text =
      "Let me verify the install.\n\n<tool_calls>\n<invoke name=\"bash\">\n<parameter name=\"command\" string=\"true\">cd /root/oc && cat status.json</parameter>\n</invoke>\n</tool_calls>"
    const hit = StallGuard.detect("stop", text, false)!
    expect(hit.signature).toBe("eaten-call")
    // the openers AND the command leave context; the prose before the block survives
    expect(hit.trimAt).toBe(text.indexOf("<tool_calls"))
    expect(text.slice(0, hit.trimAt!)).toBe("Let me verify the install.\n\n")
    expect(text.slice(0, hit.trimAt!)).not.toContain("<invoke")
    expect(text.slice(0, hit.trimAt!)).not.toContain("status.json")
  })

  test("eaten-call: closers-only (no contiguous opener) falls back to the closer (0216)", () => {
    const text = "coherent busy prose right here</parameter>\n</invoke>\n</tool_calls>"
    const hit = StallGuard.detect("stop", text, false)!
    expect(hit.signature).toBe("eaten-call")
    expect(hit.trimAt).toBe(text.indexOf("</parameter>"))
  })

  test("stray-closer signature: single stranded closing tag", () => {
    const hit = StallGuard.detect("stop", "some garbage text </response>", false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("stray-closer")
  })

  test("stray-closer signature: trimAt points at the stranded block (0216)", () => {
    const text = "meaningful prefix\n\n<garbage tag=\"x\">\n</div>"
    const hit = StallGuard.detect("stop", text, false)!
    expect(hit.signature).toBe("stray-closer")
    // contiguous markup block above the closer: trim to the block start
    expect(hit.trimAt).toBe(text.indexOf("<garbage"))
    expect(text.slice(hit.trimAt!)).toBe("<garbage tag=\"x\">\n</div>")
  })

  test("colon signature: trimAt points at the trailing colon", () => {
    const hit = StallGuard.detect("stop", "Now let me verify the install:\n\n", false)!
    expect(hit.signature).toBe("colon")
    // the trim keeps the sentence prefix, drops only the colon + whitespace
    expect("Now let me verify the install:\n\n".slice(0, hit.trimAt)).toBe("Now let me verify the install")
  })

  test("stray-closer: inline leak (no contiguous markup lines) keeps the closer trim (0216)", () => {
    const text = "check the flag: <tool_calls><invoke name=\"edit\">baseline</invoke>"
    const hit = StallGuard.detect("stop", text, false)!
    expect(hit.signature).toBe("stray-closer")
    // single-line leak: the line does not start with '<', so no block walk
    expect(hit.trimAt).toBe(text.indexOf("</invoke>"))
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

   test("marker-echo signature: output reproduces a system-reminder tag (2026-09-03 cadence case)", () => {
    // Real cadence-stall shape: the model echoed the harness's own
    // <system-reminder> as output ("Cadence. / Continue." one-liners, 1682
    // output tokens, finish=stop). A legitimate reply never emits the tag -
    // the harness writes those, not the model.
    const text = "Cadence.\n\n<system-reminder>V</system-reminder>\n\nContinue."
    const hit = StallGuard.detect("stop", text, false)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("marker-echo")
    expect(hit!.detail).toContain("system-reminder markers")
  })

  test("marker-echo signature: trimAt covers the whitespace run + first tag", () => {
    const text = "Cadence.\n\n<system-reminder>V</system-reminder>\n\nContinue."
    const hit = StallGuard.detect("stop", text, false)!
    // text.search(/\s*<system-reminder>/i) anchors at the leading \s* start,
    // so the whitespace run before the tag is trimmed too (index 8 = the
    // "\n\n" preceding the tag at index 10).
    expect(hit.trimAt).toBe(8)
    expect(text.slice(0, hit.trimAt!)).toBe("Cadence.")
  })

  test("marker-echo: does not fire on ordinary text or tags the model legitimately emits", () => {
    expect(StallGuard.detect("stop", "Done. All arms are at 100%.", false)).toBeNull()
    expect(StallGuard.detect("stop", "handling <reminder>content</reminder> inline", false)).toBeNull()
  })

  test("marker-echo: does NOT fire on a backtick-quoted reference to the tag (0262 misfire)", () => {
    // The 2026-09-06 misfire: a COMPLETE answer explaining the bash guard
    // quoted the tag in backticks ("it appends a `<system-reminder>` to the
    // tool output") - the content check fired marker-echo, the trim deleted
    // the valid tail, and the "Continue." steer re-did the finished work.
    const text =
      "The fix is a passive correction loop keyed to the exact failure mechanism - it doesn't block the command. " +
      "When the command string matches `rg -rn` it appends a `<system-reminder>` to the tool output as feedback. " +
      "The reminder is model-visible text at the point of failure, so the next `rg` drops the `-rn`."
    expect(StallGuard.detect("stop", text, false)).toBeNull()
    // Also fine mid-list / near the end - the reference is quoted, not emitted.
    expect(StallGuard.detect("stop", "covered in oc-spec/11 as class 20 (`<system-reminder>`).", false)).toBeNull()
  })

  test("marker-echo: still fires on a bare emitted tag (cadence shape, 0262)", () => {
    // The negative lookbehind must NOT suppress genuine echoes: the tag
    // preceded by whitespace/start (not a backtick) is a reproduction.
    expect(StallGuard.detect("stop", "Continue.\n<system-reminder>V</system-reminder>\n\nCadence.", false)).not.toBeNull()
    expect(StallGuard.detect("stop", "Continue.\n<system-reminder>V</system-reminder>\n\nCadence.", false)!.signature).toBe(
      "marker-echo",
    )
  })

  test("marker-echo: beats the markup family on a real cadence echo (closing tag present)", () => {
    // Real cadence output carries the closer (</system-reminder>); the
    // end-anchored stray-closer check must NOT win the diagnosis. The redirect
    // is the targeted marker-echo recovery, not the stray-fragment one.
    const text = "Cadence.\n\n<system-reminder>V</system-reminder>\n\nContinue."
    const hit = StallGuard.detect("stop", text, false)!
    expect(hit.signature).toBe("marker-echo")
    expect(hit.redirect).toBe(StallGuard.STALL_REDIRECT_MARKER_ECHO)
  })

  test("marker-echo: still fires on a compaction-continue step (markup-family rule)", () => {
    const text = "Cadence.\n\n<system-reminder>V</system-reminder>"
    const hit = StallGuard.detect("stop", text, false, true)
    expect(hit).not.toBeNull()
    expect(hit!.signature).toBe("marker-echo")
  })

  test("each signature carries the matching redirect", () => {
    const colon = StallGuard.detect("stop", "run it:", false)!
    expect(colon.redirect).toBe(StallGuard.STALL_REDIRECT_COLON)

    const eaten = StallGuard.detect("stop", "x</parameter></invoke></tool_calls>", false)!
    expect(eaten.redirect).toBe(StallGuard.STALL_REDIRECT_EATEN)

    const silent = StallGuard.detect("stop", "", false)!
    expect(silent.redirect).toBe(StallGuard.STALL_REDIRECT_SILENT)

    const echoed = StallGuard.detect("stop", "x\n<system-reminder>V</system-reminder>", false)!
    expect(echoed.redirect).toBe(StallGuard.STALL_REDIRECT_MARKER_ECHO)
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

  test("compaction-continue steps exempt ONLY the ambiguous shapes (0214, tightened 0227)", () => {
    // A normal resume response legitimately ends at stop with a colon /
    // mid-sentence shape: the ambiguous endpoint signatures must be skipped
    // for the continuation step (would otherwise burn the shared fire budget
    // toward needless auto-compaction at the 3rd/6th fire and halt at the 9th).
    expect(StallGuard.detect("stop", "The next step is to check the flag meaning and run it against the old bytes:", false, true)).toBeNull()
    expect(StallGuard.detect("stop", "test test test", false, true)).toBeNull()
    expect(StallGuard.detect("stop", "", false, true)).toBeNull()
    // ... and the non-continuation case still fires for the same text.
    expect(StallGuard.detect("stop", "The next step is to check the flag meaning and run it against the old bytes:", false)).not.toBeNull()
    expect(StallGuard.detect("stop", "", false)).not.toBeNull()
  })

  test("compaction-continue steps still fire the markup-fragment family (0227)", () => {
    // A response ending in stranded tool-call markup is NOT a valid resume
    // shape even on a compaction-continue step - the model was emitting a
    // call and it leaked. 2026-09-01 B200 session: a full <invoke> block
    // serialized as text, finish=stop, parent compaction-continue; the 0214
    // blanket exemption let it through, so the serialized tool call never
    // executed and nobody nudged the model.
    // 2026-09-01 B200 shape: a full <invoke> block serialized as text, ending
    // in the stranded </invoke> closer (stray-closer family).
    const serializedText =
      'Checking ladder/wd state.\n\n<invoke name="bash">\n<parameter name="command">ssh -i ~/.ssh/id_ed25519_farmgpu fgpu@10.100.10.113 \'tail -3 /home/fgpu/trace-sweep-8bfp8-tp2.out\'</parameter>\n</invoke>'
    const serialized = StallGuard.detect("stop", serializedText, false, true)
    expect(serialized).not.toBeNull()
    expect(serialized!.signature).toBe("stray-closer")
    // wholeCallTrimAt extends the trim back to the outermost opener so the
    // whole leaked call leaves context; the prose before it survives.
    expect(serialized!.trimAt).toBe(serializedText.indexOf("<invoke"))
    expect(serializedText.slice(0, serialized!.trimAt!)).not.toContain("<parameter")

    // The full eaten-call chain (</parameter></invoke></tool_calls>) also stays
    // active on the continuation step.
    expect(StallGuard.detect("stop", "resuming x</parameter></invoke></tool_calls>", false, true)).not.toBeNull()
    expect(StallGuard.detect("stop", "resuming x</parameter></invoke></tool_calls>", false, true)!.signature).toBe("eaten-call")

    // Non-markup ambiguous shapes remain exempt.
    expect(StallGuard.detect("stop", "Resume from here:", false, true)).toBeNull()
    expect(StallGuard.detect("stop", "Let me check the flag:", false, true)).toBeNull()
  })
})
