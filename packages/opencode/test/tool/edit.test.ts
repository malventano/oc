import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { parseFencePatch } from "../../src/tool/grammar-fence"
import { TestInstance } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
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

  test("blank lines inside blocks are real content", () => {
    const parsed = parseFencePatch(
      "*** Begin Patch\n[a.txt]\nOLD:\na\n\nb\nNEW:\nA\n\nB\n*** End Patch",
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.files[0].ops[0]).toEqual({ kind: "replace", old: ["a", "", "b"], new: ["A", "", "B"] })
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
