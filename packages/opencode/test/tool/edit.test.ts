import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { parseFencePatch } from "../../src/tool/grammar-fence"
import { TestInstance } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { Config } from "../../src/config/config"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = LayerNode.compile(
  LayerNode.group([
    LSP.node,
    CrossSpawnSpawner.node,
    FSUtil.node,
    Ripgrep.node,
    Format.node,
    EventV2Bridge.node,
    Truncate.node,
    Agent.node,
    Config.node,
  ]),
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

type FenceOp = { old?: string[]; new?: string[]; text?: string[] }
type FenceSection = { path: string; ops?: FenceOp[]; delete?: boolean; rename?: string }

// Render a fence patch: OLD:/NEW: content blocks with raw lines.
function fence(sections: FenceSection[]): string {
  const out = ["*** Begin Patch"]
  for (const s of sections) {
    out.push(`[${s.path}]`)
    if (s.rename) out.push(`RENAME ${s.rename}`)
    if (s.delete) out.push("DELETE")
    for (const op of s.ops ?? []) {
      out.push("OLD:")
      if (op.old) out.push(...op.old)
      out.push("NEW:")
      if (op.text) out.push(...op.text)
      else if (op.new) out.push(...op.new)
    }
  }
  out.push("*** End Patch")
  return out.join("\n")
}

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool> | Record<string, any>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  const input = typeof args.input === "string" ? args.input : fence((args as Record<string, any>).files ?? (args as Record<string, any>))
  return yield* tool.execute({ input }, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool> | Record<string, any>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const fileExists = Effect.fn("EditToolTest.fileExists")(function* (p: string) {
  return yield* Effect.promise(() => fs.access(p).then(() => true, () => false))
})

describe("grammar-fence parser", () => {
  test("parses a basic OLD/NEW patch", () => {
    const parsed = parseFencePatch(fence([{ path: "a.txt", ops: [{ old: ["x"], new: ["y"] }] }]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0].filePath).toBe("a.txt")
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["x"], new: ["y"] }])
  })

  test("empty OLD with NEW is an append op", () => {
    const parsed = parseFencePatch(fence([{ path: "a.txt", ops: [{ text: ["tail"] }] }]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "append", text: ["tail"] }])
  })

  test("OLD without NEW is a delete-style replace", () => {
    const parsed = parseFencePatch(fence([{ path: "a.txt", ops: [{ old: ["gone"] }] }]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["gone"], new: [] }])
  })

  test("OLD === NEW is rejected at parse time", () => {
    const parsed = parseFencePatch(fence([{ path: "a.txt", ops: [{ old: ["x"], new: ["x"] }] }]))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain("No changes to apply")
  })

  test("content before any [PATH] section fails", () => {
    const parsed = parseFencePatch("*** Begin Patch\nstray line\n*** End Patch")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain("before any [PATH]")
  })

  test("missing *** End Patch fails", () => {
    const parsed = parseFencePatch("*** Begin Patch\n[a.txt]\nOLD:\nx\nNEW:\ny\n")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain("missing *** End Patch")
  })

  test("DELETE/RENAME must be alone in their section", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:\nx\nNEW:\ny\nDELETE\n*** End Patch",
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain("alone in its section")
  })

  test("RENAME parses the target path", () => {
    const parsed = parseFencePatch("*** Begin Patch\n[a.txt]\nRENAME b.txt\n*** End Patch")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].rename).toBe("b.txt")
  })

  test("envelope-prefixed markers are tolerated (0138)", () => {
    // The model leaks the "*** " envelope prefix onto the block markers;
    // "*** NEW:" used to be silently absorbed into the OLD block (43-line
    // OLD, zero-line NEW - the 2026-08-16 failure class).
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:\nx\n*** NEW:\ny\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["x"], new: ["y"] }])
  })

  test("envelope-prefixed OLD: is tolerated (0138)", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\n*** OLD:\nx\nNEW:\ny\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["x"], new: ["y"] }])
  })

  test("malformed marker-looking lines fail loudly instead of being absorbed (0138)", () => {
    for (const bad of ["**NEW:", "***NEW:"]) {
      const parsed = parseFencePatch(`*** Begin Patch\n[a.txt]\nOLD:\nx\n${bad}\ny\n*** End Patch`)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.errors[0]).toContain("unrecognized block marker")
    }
  })

  test("blank lines inside blocks are real content", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:\na\n\nb\nNEW:\nA\n\nB\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops[0]).toEqual({ kind: "replace", old: ["a", "", "b"], new: ["A", "", "B"] })
  })

  test("inline OLD:/NEW: markers carry their first content row (0234)", () => {
    // The model's compact form glues the first content line to the marker
    // (`OLD:alpha`). Pre-0234 the marker regex required the marker to end the
    // line, so the whole patch failed "content outside of an OLD:/NEW: block".
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:alpha\nbeta\nNEW:ALPHA\nBETA\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["alpha", "beta"], new: ["ALPHA", "BETA"] }])
  })

  test("inline markers preserve content indentation (0234)", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:  local err=99\nNEW:  local err=0\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([
      { kind: "replace", old: ["  local err=99"], new: ["  local err=0"] },
    ])
  })

  test("inline NEW after an empty OLD is an append (0234)", () => {
    const parsed = parseFencePatch("*** Begin Patch\n[a.txt]\nOLD:\nNEW:tail\n*** End Patch")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "append", text: ["tail"] }])
  })

  test("inline marker-looking content inside an open OLD block stays verbatim (0234)", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:\nOLD:echo keep me\nNEW:\nok\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops).toEqual([{ kind: "replace", old: ["OLD:echo keep me"], new: ["ok"] }])
  })

  test("standalone marker inside an open OLD block still fails (unchanged)", () => {
    const parsed = parseFencePatch("*** Begin Patch\n[a.txt]\nOLD:\nx\nOLD:\n*** End Patch")
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain("already open")
  })
})

describe("tool.edit", () => {
  describe("core fence edits", () => {
    it.instance("applies a basic replace", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\ntwo\nthree\n")
        const result = yield* run({ input: fence([{ path: filepath, ops: [{ old: ["two"], new: ["TWO"] }] }]) })
        expect(yield* load(filepath)).toBe("one\nTWO\nthree\n")
        expect(result.metadata.files[0].additions).toBe(1)
        expect(result.metadata.files[0].deletions).toBe(1)
      }),
    )

    it.instance("applies a multi-line indented replace byte-exactly", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "top\n  ind a\n  ind b\n  ind c\nbottom\n")
        yield* run({
          input: fence([
            { path: filepath, ops: [{ old: ["  ind a", "  ind b", "  ind c"], new: ["  ind a", "  ind b edited", "    deeper", "  ind c"] }] },
          ]),
        })
        expect(yield* load(filepath)).toBe("top\n  ind a\n  ind b edited\n    deeper\n  ind c\nbottom\n")
      }),
    )

    it.instance("inserts via context in both blocks", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "head\nbody\n")
        yield* run({
          input: fence([{ path: filepath, ops: [{ old: ["body"], new: ["body", "  inserted after"] }] }]),
        })
        expect(yield* load(filepath)).toBe("head\nbody\n  inserted after\n")
      }),
    )

    it.instance("appends with an empty OLD block", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\n")
        yield* run({ input: fence([{ path: filepath, ops: [{ text: ["appended"] }] }]) })
        expect(yield* load(filepath)).toBe("one\nappended\n")
      }),
    )

    it.instance("deletes a range with OLD only", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "keep a\nremove me\nkeep b\n")
        yield* run({ input: fence([{ path: filepath, ops: [{ old: ["remove me"] }] }]) })
        expect(yield* load(filepath)).toBe("keep a\nkeep b\n")
      }),
    )

    it.instance("preserves the trailing newline", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\ntwo\n")
        yield* run({ input: fence([{ path: filepath, ops: [{ old: ["one"], new: ["ONE"] }] }]) })
        expect(yield* load(filepath)).toBe("ONE\ntwo\n")
      }),
    )

    it.instance("matches multiple pairs in one section in order", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "a\nb\nc\nd\n")
        yield* run({
          input: fence([
            {
              path: filepath,
              ops: [
                { old: ["a"], new: ["A"] },
                { old: ["d"], new: ["D"] },
              ],
            },
          ]),
        })
        expect(yield* load(filepath)).toBe("A\nb\nc\nD\n")
      }),
    )

    it.instance("applies multiple files in one patch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fa = path.join(test.directory, "a.txt")
        const fb = path.join(test.directory, "b.txt")
        yield* put(fa, "a1\na2\n")
        yield* put(fb, "b1\n")
        const result = yield* run({
          input: fence([
            { path: fa, ops: [{ old: ["a2"], new: ["a2 edited"] }] },
            { path: fb, ops: [{ old: ["b1"], new: ["b1 edited"] }] },
          ]),
        })
        expect(yield* load(fa)).toBe("a1\na2 edited\n")
        expect(yield* load(fb)).toBe("b1 edited\n")
        expect(result.metadata.files).toHaveLength(2)
      }),
    )

    it.instance("chains same-path sections (later sections compose onto earlier results)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\ntwo\nthree\n")
        // The delete section follows the append section for the SAME path:
        // without chaining, the delete would be computed against the original
        // disk content and clobber the append (regression 2026-08-14).
        yield* run({
          input: fence([
            { path: filepath, ops: [{ text: ["appended"] }] },
            { path: filepath, ops: [{ old: ["two"] }] },
          ]),
        })
        expect(yield* load(filepath)).toBe("one\nthree\nappended\n")
      }),
    )

    it.instance("reports ambiguity with line numbers and accepts a longer OLD block", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "dup\nx\ndup\n")
        const err = yield* fail({
          input: fence([{ path: filepath, ops: [{ old: ["dup"], new: ["DUP"] }] }]),
        })
        expect(err.message).toContain("ambiguous")
        expect(err.message).toContain("2 places")
        // Disambiguate by extending the block
        yield* run({
          input: fence([{ path: filepath, ops: [{ old: ["x", "dup"], new: ["x", "DUP"] }] }]),
        })
        expect(yield* load(filepath)).toBe("dup\nx\nDUP\n")
      }),
    )

    it.instance("reports no-match naming the first line", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\ntwo\n")
        const err = yield* fail({
          input: fence([{ path: filepath, ops: [{ old: ["one (typo)"], new: ["nope"] }] }]),
        })
        expect(err.message).toContain("no match")
        expect(err.message).toContain("one (typo)")
      }),
    )

    it.instance("rejects OLD === NEW before writing (clean red call)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\n")
        const err = yield* fail({
          input: fence([{ path: filepath, ops: [{ old: ["one"], new: ["one"] }] }]),
        })
        expect(err.message).toContain("No changes to apply")
        // Nothing was written or half-applied
        expect(yield* load(filepath)).toBe("one\n")
      }),
    )

    it.instance("rejects parse errors before any write (multi-file atomicity)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fa = path.join(test.directory, "a.txt")
        const fb = path.join(test.directory, "b.txt")
        yield* put(fa, "a1\n")
        yield* put(fb, "b1\n")
        const err = yield* fail({
          input: fence([
            { path: fa, ops: [{ old: ["a1"], new: ["a1 edited"] }] },
            { path: fb, ops: [{ old: ["b1"], new: ["b1"] }] }, // no-op - fails the whole patch
          ]),
        })
        expect(err.message).toContain("No changes to apply")
        expect(yield* load(fa)).toBe("a1\n")
        expect(yield* load(fb)).toBe("b1\n")
      }),
    )

    it.instance("fails before any write when a later section has no match", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fa = path.join(test.directory, "a.txt")
        const fb = path.join(test.directory, "b.txt")
        yield* put(fa, "a1\n")
        yield* put(fb, "b1\n")
        const err = yield* fail({
          input: fence([
            { path: fa, ops: [{ old: ["a1"], new: ["a1 edited"] }] },
            { path: fb, ops: [{ old: ["does not exist"], new: ["x"] }] },
          ]),
        })
        expect(err.message).toContain("no match")
        expect(yield* load(fa)).toBe("a1\n") // first file untouched
      }),
    )

    it.instance("resolves a unique basename within the worktree", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* put(path.join(test.directory, "target.txt"), "one\n")
        yield* run({ input: fence([{ path: "target.txt", ops: [{ old: ["one"], new: ["ONE"] }] }]) })
        expect(yield* load(path.join(test.directory, "target.txt"))).toBe("ONE\n")
      }),
    )

    it.instance("rejects an ambiguous basename (no direct hit)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // No file at the direct path - the walk must find both matches.
        yield* makeDirectory(path.join(test.directory, "sub"))
        yield* makeDirectory(path.join(test.directory, "sub", "deeper"))
        yield* put(path.join(test.directory, "sub", "one.txt"), "x\n")
        yield* put(path.join(test.directory, "sub", "deeper", "one.txt"), "y\n")
        const err = yield* fail({ input: fence([{ path: "one.txt", ops: [{ old: ["x"], new: ["z"] }] }]) })
        expect(err.message).toContain("ambiguous")
      }),
    )
  })

  describe("fallback matching (fragments + tolerance ladder)", () => {
    it.instance("matches a partial-line fragment within a long line", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "long.txt")
        const line = "This is a very long line containing a unique fragment inside it, plus a lot of other text that makes the line long enough to be risky to reproduce."
        yield* put(filepath, line + "\n")
        const result = yield* run({
          input: fence([{ path: filepath, ops: [{ old: ["unique fragment"], new: ["unique replacement"] }] }]),
        })
        expect(yield* load(filepath)).toBe(
          "This is a very long line containing a unique replacement inside it, plus a lot of other text that makes the line long enough to be risky to reproduce.\n",
        )
        // The ladder-fire echo must tell the agent what happened
        expect(result.output).toContain("Matched with tolerance")
        expect(result.output).toContain("at line 1")
        expect(result.output).toContain("Applied change")
      }),
    )

    it.instance("absorbs whole-line transcription drift via the ladder", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "drift.txt")
        yield* put(filepath, "const alpha = compute(1)\nconst beta = 2\n")
        // The model reproduced line 1 with a drifted double space
        yield* run({
          input: fence([
            { path: filepath, ops: [{ old: ["const  alpha = compute(1)"], new: ["const alpha = compute(2)"] }] },
          ]),
        })
        expect(yield* load(filepath)).toBe("const alpha = compute(2)\nconst beta = 2\n")
      }),
    )

    it.instance("rejects an ambiguous fragment with the fence's ambiguity error", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "amb.txt")
        yield* put(filepath, "shared fragment line one\nshared fragment line two\n")
        const err = yield* fail({
          input: fence([{ path: filepath, ops: [{ old: ["shared fragment"], new: ["X"] }] }]),
        })
        expect(err.message).toMatch(/multiple matches|Could not find|ambiguous/i)
      }),
    )

    it.instance("cuts a partial-line fragment (char-level splice, matched text captured)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cutfrag.txt")
        yield* put(filepath, "line with a removable fragment here\n")
        yield* run({
          input: "*** Begin Patch\n" + `[${filepath}]\nCUT @f:\nremovable fragment\n` + "*** End Patch",
        })
        // The fragment is spliced out of its line; the surrounding text
        // keeps its own spacing (the model includes the space in the block
        // if it wants a clean join).
        expect(yield* load(filepath)).toBe("line with a  here\n")
      }),
    )

    it.instance("pastes after the LINE containing a context fragment", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "pastefrag.txt")
        yield* put(filepath, "alpha\nbeta line with unique marker\n")
        yield* run({
          input:
            "*** Begin Patch\n" +
            `[${filepath}]\nCUT @x:\nalpha\n\n` +
            `[${filepath}]\nPASTE @x AFTER:\nunique marker\n` +
            "*** End Patch",
        })
        // The fragment identifies the second line; the insertion lands after
        // that LINE (not at the fragment's char position)
        expect(yield* load(filepath)).toBe("beta line with unique marker\nalpha\n")
      }),
    )

    it.instance("reports the changed line ranges on the exact path too", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "terse.txt")
        yield* put(filepath, "line one\nexact line\nline three\n")
        const result = yield* run({
          input: fence([{ path: filepath, ops: [{ old: ["exact line"], new: ["exact line edited"] }] }]),
        })
        expect(result.output).toContain("Edit applied successfully")
        expect(result.output).toContain("Changed lines: 2 (+1/-1)")
        expect(result.output).not.toContain("Matched with tolerance")
      }),
    )
  })

  describe("path resolution (oc 0259): filePath-first + not-found hint", () => {
    it.instance("trusts the filePath argument on single-section patches", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // The header uses a bare basename that does NOT resolve at the root;
        // the filePath param carries the authoritative absolute path.
        yield* makeDirectory(path.join(test.directory, "nested"))
        yield* put(path.join(test.directory, "nested", "target.txt"), "alpha\n")
        yield* run({
          filePath: path.join(test.directory, "nested", "target.txt"),
          input: fence([{ path: "target.txt", ops: [{ old: ["alpha"], new: ["ALPHA"] }] }]),
        })
        expect(yield* load(path.join(test.directory, "nested", "target.txt"))).toBe("ALPHA\n")
      }),
    )

    it.instance("falls through to the header when filePath does not resolve", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // Stale filePath + correct header path -> header wins.
        yield* put(path.join(test.directory, "real.txt"), "beta\n")
        yield* run({
          filePath: path.join(test.directory, "stale-nonexistent.txt"),
          input: fence([{ path: path.join(test.directory, "real.txt"), ops: [{ old: ["beta"], new: ["BETA"] }] }]),
        })
        expect(yield* load(path.join(test.directory, "real.txt"))).toBe("BETA\n")
      }),
    )

    it.instance("not-found hint names the file that exists in a sibling workspace project", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // Emulate the pcper_conv.py incident: the real file lives in a
        // sibling project dir (same sub-path wiring, one top-level segment
        // different); the header has the wrong project segment. Use a unique
        // sibling name so the /tmp scan cannot collide with other tests, and
        // clean up after.
        const ws = path.dirname(test.directory) // the code hunts this level
        // Sort FIRST so the 64-entry cap always includes it.
        const sibling = "ac-exclusive-sibling-" + Math.random().toString(36).slice(2)
        const wrongProject = "ac-exclusive-wrong-" + Math.random().toString(36).slice(2)
        const real = path.join(ws, sibling, "scripts", "tool.py")
        yield* makeDirectory(path.join(ws, sibling))
        yield* makeDirectory(path.join(ws, sibling, "scripts"))
        yield* put(real, "tool content\n")
        try {
          const wrongRoot = path.join(ws, wrongProject, "scripts", "tool.py")
          const err = yield* fail({
            input: fence([{ path: wrongRoot, ops: [{ old: ["tool content"], new: ["x"] }] }]),
          })
          expect(err.message).toContain("not found")
          expect(err.message).toContain("tool.py")
          expect(err.message).toContain(sibling)
        } finally {
          yield* Effect.promise(() => fs.rm(path.join(ws, sibling), { recursive: true, force: true }))
        }
      }),
    )
  })

  describe("fail quoting (oc 0257): the error names BOTH lines", () => {
    it.instance("quotes the divergent line on a multi-line OLD mismatch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "mismatch.txt")
        // Line 1 of the block matches the file exactly; line 2 is genuinely
        // ABSENT (not a tolerance-absorbable drift - the ladder's block
        // anchor similarity and line trims all fail), so the exact-first-
        // line branch fires the "not in the file" error. The 0257-motivating
        // incident was the same shape: a continuation line the model
        // reproduced with a wrong leading bullet.
        yield* put(filepath, "alpha exact line one\nfile has this unique beta line\nfile has this unique gamma line\n")
        const err = yield* fail({
          input: fence([
            { path: filepath, ops: [{ old: ["alpha exact line one", "DIFFERENT line not in file at all"], new: ["X"] }] },
          ]),
        })
        expect(err.message).toMatch(/line 2 is not in the file/)
        expect(err.message).toMatch(/file line 2/)
        expect(err.message).toContain("your block:")
        expect(err.message).toContain("unique beta line")
      }),
    )

    it.instance("named the wrong file: OLD block lives in a different file (wrong [PATH])", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // The block content lives in other.txt, not the section's target.
        yield* put(path.join(test.directory, "target.txt"), "some unrelated content here\nanother line\n")
        yield* put(path.join(test.directory, "other.txt"), "shared unique snippet xyz123\n")
        const err = yield* fail({
          input: fence([
            { path: path.join(test.directory, "target.txt"), ops: [{ old: ["shared unique snippet xyz123"], new: ["X"] }] },
          ]),
        })
        expect(err.message).toContain("target.txt")
        expect(err.message).toContain("other.txt")
        expect(err.message).toMatch(/wrong \[PATH\] header/i)
      }),
    )

    it.instance("wrong-file hint is silent when the block exists nowhere else", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* put(path.join(test.directory, "target.txt"), "some unrelated content here\n")
        yield* put(path.join(test.directory, "sibling.txt"), "also unrelated\n")
        const err = yield* fail({
          input: fence([{ path: path.join(test.directory, "target.txt"), ops: [{ old: ["gone forever line"], new: ["X"] }] }]),
        })
        expect(err.message).toContain("target.txt")
        expect(err.message).not.toContain("wrong [PATH] header")
      }),
    )
  })

  describe("register moves (CUT/PASTE)", () => {
    it.instance("cuts and pastes a block within one file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cp.txt")
        yield* put(filepath, "cp 1\ncp 2\ncp 3\ncp 4\ncp 5\ncp 6\ncp 7\ncp 8\ncp 9\n")
        yield* run({
          input:
            "*** Begin Patch\n" +
            `[${filepath}]\nCUT @fn:\ncp 2\ncp 3\ncp 4\n\n` +
            `[${filepath}]\nPASTE @fn AFTER:\ncp 7\n` +
            "*** End Patch",
        })
        expect(yield* load(filepath)).toBe("cp 1\ncp 5\ncp 6\ncp 7\ncp 2\ncp 3\ncp 4\ncp 8\ncp 9\n")
      }),
    )

    it.instance("pastes before the context with BEFORE:", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cp.txt")
        yield* put(filepath, "a\nb\nc\nd\n")
        yield* run({
          input:
            "*** Begin Patch\n" +
            `[${filepath}]\nCUT @x:\nb\n\n` +
            `[${filepath}]\nPASTE @x BEFORE:\nd\n` +
            "*** End Patch",
        })
        expect(yield* load(filepath)).toBe("a\nc\nb\nd\n")
      }),
    )

    it.instance("moves a block across files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fa = path.join(test.directory, "a.txt")
        const fb = path.join(test.directory, "b.txt")
        yield* put(fa, "one\ntarget\nthree\n")
        yield* put(fb, "x\ny\n")
        yield* run({
          input:
            "*** Begin Patch\n" +
            `[${fa}]\nCUT @m:\ntarget\n\n` +
            `[${fb}]\nPASTE @m AFTER:\nx\n` +
            "*** End Patch",
        })
        expect(yield* load(fa)).toBe("one\nthree\n")
        expect(yield* load(fb)).toBe("x\ntarget\ny\n")
      }),
    )

    it.instance("a CUT with no PASTE is a delete", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cp.txt")
        yield* put(filepath, "keep\ngone\nkeep\n")
        yield* run({ input: "*** Begin Patch\n" + `[${filepath}]\nCUT @d:\ngone\n` + "*** End Patch" })
        expect(yield* load(filepath)).toBe("keep\nkeep\n")
      }),
    )

    it.instance("a PASTE with no CUT is an error before any write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cp.txt")
        yield* put(filepath, "a\nb\n")
        const err = yield* fail({
          input: "*** Begin Patch\n" + `[${filepath}]\nPASTE @nope AFTER:\na\n` + "*** End Patch",
        })
        expect(err.message).toContain("no CUT @nope")
        expect(yield* load(filepath)).toBe("a\nb\n")
      }),
    )

    it.instance("an ambiguous CUT block errors with line numbers", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cp.txt")
        yield* put(filepath, "dup\nx\ndup\n")
        const err = yield* fail({
          input: "*** Begin Patch\n" + `[${filepath}]\nCUT @d:\ndup\n` + "*** End Patch",
        })
        expect(err.message).toContain("matches 2 places")
      }),
    )
  })

  describe("file-level ops", () => {
    it.instance("renames a file (content preserved)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const from = path.join(test.directory, "from.txt")
        const to = path.join(test.directory, "to.txt")
        yield* put(from, "body\n")
        const result = yield* run({ input: fence([{ path: from, rename: to }]) })
        expect(yield* fileExists(from)).toBe(false)
        expect(yield* load(to)).toBe("body\n")
        expect(result.metadata.files[0].type).toBe("move")
        expect(result.metadata.files[0].movePath).toBe(to)
      }),
    )

    it.instance("deletes a file and reports its line count", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "gone.txt")
        yield* put(filepath, "a\nb\nc\n")
        const result = yield* run({ input: fence([{ path: filepath, delete: true }]) })
        expect(yield* fileExists(filepath)).toBe(false)
        expect(result.metadata.files[0].type).toBe("delete")
        expect(result.metadata.files[0].deletions).toBe(3)
      }),
    )
  })

  describe("metadata contract (0116 fileDelta)", () => {
    it.instance("emits files[] with stat and relative paths", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "a.txt")
        yield* put(filepath, "one\n")
        const result = yield* run({
          input: fence([{ path: filepath, ops: [{ old: ["one"], new: ["ONE"] }] }]),
        })
        const f = result.metadata.files[0]
        expect(f.filePath).toBe(filepath)
        expect(f.relativePath).toBe("a.txt")
        expect(f.type).toBe("edit")
        expect(f.changed).toBe(true)
        expect(f.additions).toBe(1)
        expect(f.deletions).toBe(1)
        expect(f.patch).toContain("ONE")
        // Post-write stat backing the staleness walk (integer ms)
        const st = f.stat as { mtimeMs: number; size: number } | undefined
        expect(st).toBeTruthy()
        expect(typeof st?.mtimeMs).toBe("number")
        expect(Number.isInteger(st?.mtimeMs)).toBe(true)
      }),
    )

    it.instance("emits a deleted sentinel for deletes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "gone.txt")
        yield* put(filepath, "x\n")
        const result = yield* run({ input: fence([{ path: filepath, delete: true }]) })
        expect(result.metadata.files[0].stat).toEqual({ deleted: true })
      }),
    )
  })
})
