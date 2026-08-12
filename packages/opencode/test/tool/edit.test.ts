import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { hashlineRef } from "../../src/tool/hashline"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
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
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Config } from "../../src/config/config"
import { clearSnapshots, fileTag, recordSnapshot } from "../../src/tool/hashline-store"

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

afterEach(async () => {
  clearSnapshots()
  await disposeAllInstances()
})

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

// Render legacy JSON payloads to the patch grammar so behavior tests exercise the
// parser + engine path end-to-end (the schema now takes only { input }).
const PATCH_TAG = "A1B2"
function toRows(text: string | string[]): string[] {
  return Array.isArray(text) ? text : [text]
}
function renderOp(op: any): string {
  switch (op.type) {
    case "set_line":
      return `SET ${op.line}:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "replace_lines":
      return `REPLACE ${op.start_line} ${op.end_line}:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "insert_after":
      return `AFTER ${op.line}:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "insert_before":
      return `BEFORE ${op.line}:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "insert_between":
      return `BETWEEN ${op.after_line} ${op.before_line}:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "append":
      return `APPEND:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "prepend":
      return `PREPEND:\n${toRows(op.text).map((r) => (r === "" ? "+" : `+ ${r}`)).join("\n")}`
    case "cut":
      return `CUT ${op.start_line} ${op.end_line}${op.register ? ` @${op.register}` : ""}`
    case "paste":
      return `PASTE @${op.register} ${op.insert_after_line ? `AFTER ${op.insert_after_line}` : `BEFORE ${op.insert_before_line}`}`
    default:
      throw new Error(`grammar has no op: ${op.type}`)
  }
}
function renderPatch(args: any): string {
  const secs = args.files ?? [{ filePath: args.filePath, edits: args.edits, delete: args.delete, rename: args.rename }]
  const out = ["*** Begin Patch"]
  for (const s of secs) {
    out.push(`[${s.filePath}#${PATCH_TAG}]`)
    if (s.rename) out.push(`RENAME ${s.rename}`)
    if (s.delete) out.push("DELETE")
    for (const op of s.edits ?? []) out.push(renderOp(op))
  }
  out.push("*** End Patch")
  return out.join("\n")
}
function toParams(args: any): Tool.InferParameters<typeof EditTool> {
  return typeof args.input === "string" ? args : { input: renderPatch(args) }
}
const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool> | Record<string, any>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(toParams(args), next)
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

// Write content and record a full-read snapshot (as if the read tool showed
// every line), simulating read-before-edit.
const putSnap = Effect.fn("EditToolTest.putSnap")(function* (p: string, content: string) {
  yield* put(p, content)
  const stripped = content.startsWith("\uFEFF") ? content.slice(1) : content
  const count = stripped === "" ? 0 : stripped.endsWith("\n") ? stripped.split("\n").length - 1 : stripped.split("\n").length
  recordSnapshot(p, stripped, Array.from({ length: count }, (_, i) => i + 1))
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* FSUtil.Service
  yield* fs.makeDirectory(p)
})

const fileExists = Effect.fn("EditToolTest.fileExists")(function* (p: string) {
  return yield* Effect.promise(() => fs.access(p).then(() => true, () => false))
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof Watcher.Event.Updated) {
  const events = yield* EventV2Bridge.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* events.listen((event) => {
    if (event.type === def.type) Deferred.doneUnsafe(deferred, Effect.void)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsub)
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file with append edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "append", text: "new content" }],
        })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("creates new file with prepend edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        yield* run({
          filePath: filepath,
          edits: [{ type: "prepend", text: "header" }],
        })

        expect(yield* load(filepath)).toBe("header")
      }),
    )

    it.instance("rejects creating missing file with line-anchored edits and leaves nothing behind", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "missing.txt")

        expect(
          (yield* fail({
            filePath: filepath,
            edits: [{ type: "set_line", line: "1#ZZ", text: "x" }],
          })).message,
        ).toContain("can only be created with append/prepend")
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, edits: [{ type: "append", text: "nested file" }] })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({
          filePath: path.join(test.directory, "new.txt"),
          edits: [{ type: "append", text: "content" }],
        })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces a single line via set_line", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["alpha", "beta", "gamma"]
        yield* putSnap(filepath, lines.join("\n"))

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(2, lines[1]), text: "BETA" }],
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(result.output).toMatch(/\+2#[A-Z]{2}:BETA/)
        expect(result.output).toMatch(/\[#C2E5\]/)
        expect(result.metadata.edit_mode).toBe("hashline")

        expect(yield* load(filepath)).toBe("alpha\nBETA\ngamma")
      }),
    )

    it.instance("replaces a line range via replace_lines", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["alpha", "beta", "gamma", "delta"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [
            {
              type: "replace_lines",
              start_line: hashlineRef(2, lines[1]),
              end_line: hashlineRef(3, lines[2]),
              text: ["B", "C"],
            },
          ],
        })

        expect(yield* load(filepath)).toBe("alpha\nB\nC\ndelta")
      }),
    )

    it.instance("inserts after a line with insert_after", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["a", "b"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [{ type: "insert_after", line: hashlineRef(1, lines[0]), text: "a1" }],
        })

        expect(yield* load(filepath)).toBe("a\na1\nb")
      }),
    )

    it.instance("inserts before a line with insert_before", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["a", "b"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [{ type: "insert_before", line: hashlineRef(2, lines[1]), text: "b0" }],
        })

        expect(yield* load(filepath)).toBe("a\nb0\nb")
      }),
    )

    it.instance("inserts between two lines with insert_between", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["a", "c"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [
            {
              type: "insert_between",
              after_line: hashlineRef(1, lines[0]),
              before_line: hashlineRef(2, lines[1]),
              text: "b",
            },
          ],
        })

        expect(yield* load(filepath)).toBe("a\nb\nc")
      }),
    )

    it.instance("appends to the end of a file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* putSnap(filepath, "a\nb")

        yield* run({ filePath: filepath, edits: [{ type: "append", text: "c" }] })

        expect(yield* load(filepath)).toBe("a\nb\nc")
      }),
    )

    it.instance("prepends to the start of a file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* putSnap(filepath, "b\nc")

        yield* run({ filePath: filepath, edits: [{ type: "prepend", text: "a" }] })

        expect(yield* load(filepath)).toBe("a\nb\nc")
      }),
    )

    it.instance("applies a full-line replacement via replace_lines", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["foo bar foo baz foo"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [
            {
              type: "replace_lines",
              start_line: hashlineRef(1, lines[0]),
              end_line: hashlineRef(1, lines[0]),
              text: ["qux bar qux baz qux"],
            },
          ],
        })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )


    it.instance("rejects mismatched anchors with retry hints and leaves content unchanged", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const original = "alpha\nbeta\ngamma"
        yield* putSnap(filepath, original)

        const wrongRef = "2#ZZ"
        const message = (yield* fail({
          filePath: filepath,
          edits: [{ type: "set_line", line: wrongRef, text: "BETA" }],
        })).message

        expect(message).toContain("anchor mismatch")
        expect(message).toContain("retry with")
        expect(yield* load(filepath)).toBe(original)
      }),
    )

    it.instance("errors on an empty patch section (no content change)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "content")

        const message = (yield* fail({ filePath: filepath })).message
        expect(message).toContain("No changes applied")
        expect(message).toContain("no content change")
      }),
    )

    it.instance("throws error when path is a directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect(
          (yield* fail({
            filePath: dirpath,
            edits: [{ type: "append", text: "x" }],
          })).message,
        ).toContain("directory")
      }),
    )

    it.instance("preserves BOM on existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        const lines = ["using System;", "class Test {}"]
        yield* putSnap(filepath, `${bom}${lines.join("\n")}\n`)

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(1, lines[0]), text: "using Up;" }],
        })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("preserves CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["line1", "old", "line3"]
        yield* putSnap(filepath, lines.join("\r\n") + "\r\n")

        yield* run({
          filePath: filepath,
          edits: [{ type: "replace_lines", start_line: hashlineRef(2, lines[1]), end_line: hashlineRef(2, lines[1]), text: "new" }],
        })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3\r\n")
      }),
    )

    it.instance("rejects same-content replace_lines as ambiguous", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["alpha"]
        yield* putSnap(filepath, lines.join("\n"))

        const message = (yield* fail({
          filePath: filepath,
          edits: [{ type: "replace_lines", start_line: hashlineRef(1, lines[0]), end_line: hashlineRef(1, lines[0]), text: ["alpha"] }],
        })).message
        expect(message).toContain("ambiguous")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["original"]
        yield* putSnap(filepath, lines.join("\n"))
        const updated = yield* onceBus(Watcher.Event.Updated)

        yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(1, lines[0]), text: "modified" }],
        })
        yield* Deferred.await(updated)
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["line1", "line2", "line3"]
        yield* putSnap(filepath, lines.join("\n"))

        const result = yield* run({
          filePath: filepath,
          edits: [
            {
              type: "replace_lines",
              start_line: hashlineRef(2, lines[1]),
              end_line: hashlineRef(2, lines[1]),
              text: ["new line a", "new line b"],
            },
          ],
        })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )

    it.instance("emits per-file files metadata for multi-file patches", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const first = path.join(test.directory, "first.txt")
        const second = path.join(test.directory, "second.txt")
        yield* putSnap(first, "alpha\nbeta")
        yield* putSnap(second, "gamma")

        const result = yield* run({
      input: [
        "*** Begin Patch",
        `[${first}#A1B2]`,
        `SET ${hashlineRef(2, "beta")}:`,
        "+ BETA",
        `[${second}#A1B2]`,
        "APPEND:",
        "+ delta",
        "*** End Patch",
      ].join("\n"),
    })
        expect(result.metadata.files).toBeDefined()
        const files = result.metadata.files as Array<Record<string, unknown>>
        expect(files.length).toBe(2)
      expect(files[0]).toMatchObject({ type: "edit", filePath: first, changed: true })
      expect(files[1]).toMatchObject({ type: "edit", filePath: second, changed: true })
      expect(files[0].patch).toContain("+BETA")
      expect(files[1].patch).toContain("+delta")
      }),
    )

    it.instance("emits delete and move types in files metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const doomed = path.join(test.directory, "doomed.txt")
        const moved = path.join(test.directory, "moved.txt")
        yield* putSnap(doomed, "bye")
        yield* putSnap(moved, "hello")

        const result = yield* run({
          input: [
            "*** Begin Patch",
            `[${doomed}#A1B2]`,
            "DELETE",
            `[${moved}#A1B2]`,
            "RENAME renamed.txt",
            "*** End Patch",
          ].join("\n"),
        })

        const files = result.metadata.files as Array<Record<string, unknown>>
        expect(files.length).toBe(2)
      expect(files[0]).toMatchObject({ type: "delete", filePath: doomed, changed: true })
        expect(files[1]).toMatchObject({
        type: "move",
        filePath: moved,
        changed: false,
        movePath: path.join(test.directory, "renamed.txt"),
      })
      }),
    )
  })

  describe("delete and rename", () => {
    it.instance("deletes a file without an edits array", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "noedits.txt")
        yield* put(filepath, "content")

        const result = yield* run({ filePath: filepath, delete: true })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* fileExists(filepath)).toBe(false)
      }),
    )

    it.instance("deletes a file and emits unlink event", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "doomed.txt")
        yield* put(filepath, "content")
        const updated = yield* onceBus(Watcher.Event.Updated)

        const result = yield* run({ filePath: filepath, edits: [], delete: true })
        yield* Deferred.await(updated)

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* fileExists(filepath)).toBe(false)
      }),
    )

    it.instance("treats delete of missing file as a satisfied no-op", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "missing.txt")

        const result = yield* run({ filePath: filepath, edits: [], delete: true })

        expect(result.output).toContain("No changes applied")
        expect(result.output).toContain("file does not exist")
        expect(result.metadata.noop).toBe(1)
      }),
    )

    it.instance("renames a file and emits events", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "source.txt")
        const target = path.join(test.directory, "target.txt")
        const lines = ["alpha", "beta"]
        yield* putSnap(source, lines.join("\n"))

        const result = yield* run({
          filePath: source,
          edits: [{ type: "set_line", line: hashlineRef(2, lines[1]), text: "BETA" }],
          rename: target,
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* fileExists(source)).toBe(false)
        expect(yield* load(target)).toBe("alpha\nBETA")
      }),
    )

    it.instance("renames with a relative target into the source file's own directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "source.txt")
        yield* putSnap(source, "alpha\nbeta")

        const result = yield* run({
          filePath: source,
          edits: [],
          rename: "target.txt",
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* fileExists(source)).toBe(false)
        expect(yield* load(path.join(test.directory, "target.txt"))).toBe("alpha\nbeta")
      }),
    )

    it.instance("reports deleted and renamed counts separately in the output message", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const doomed = path.join(test.directory, "doomed.txt")
        const moved = path.join(test.directory, "moved.txt")
        yield* putSnap(doomed, "bye")
        yield* putSnap(moved, "hello")

        const result = yield* run({
          input: [
            "*** Begin Patch",
            `[${doomed}#A1B2]`,
            "DELETE",
            `[${moved}#A1B2]`,
            "RENAME renamed.txt",
            "*** End Patch",
          ].join("\n"),
        })

        expect(result.output).toContain("deleted 1 file")
        expect(result.output).toContain("renamed 1 file")
        expect(yield* fileExists(doomed)).toBe(false)
        expect(yield* fileExists(moved)).toBe(false)
        expect(yield* load(path.join(test.directory, "renamed.txt"))).toBe("hello")
      }),
    )

    it.instance("rejects delete combined with edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect(
          (yield* fail({
            filePath: filepath,
            edits: [{ type: "append", text: "x" }],
            delete: true,
          })).message,
        ).toContain("cannot be combined")
      }),
    )

    it.instance("rejects delete combined with rename", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect(
          (yield* fail({
            filePath: filepath,
            edits: [],
            delete: true,
            rename: path.join(test.directory, "other.txt"),
          })).message,
        ).toContain("file-level")
      }),
    )

    it.instance("rejects rename of a missing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "missing.txt")

        expect(
          (yield* fail({
            filePath: source,
            edits: [],
            rename: path.join(test.directory, "target.txt"),
          })).message,
        ).toContain("rename requires an existing source file")
      }),
    )
  })

  describe("snapshot gates and recovery", () => {
    it.instance("applies on-the-fly validation to files never read this session", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "never-read.txt")
        yield* put(filepath, "alpha\nbeta\ngamma")

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(2, "beta"), text: "BETA" }],
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("alpha\nBETA\ngamma")
      }),
    )

    it.instance("reports deletion since read and blocks non-recreate edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "deleted.txt")
        yield* putSnap(filepath, "alpha\nbeta")
      yield* Effect.promise(() => fs.rm(filepath))

        const message = (yield* fail({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(1, "alpha"), text: "ALPHA" }],
        })).message
        expect(message).toContain("deleted since your read")
        expect(yield* load(filepath).pipe(Effect.catch(() => Effect.succeed("")))).toBe("")

        yield* run({
          filePath: filepath,
          edits: [{ type: "append", text: "recreated" }],
        })
        expect(yield* load(filepath)).toBe("recreated")
      }),
    )

    it.instance("rejects edits referencing lines never displayed and reveals content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "partial-read.txt")
        const content = "alpha\nbeta\ngamma\ndelta"
        yield* put(filepath, content)
        recordSnapshot(filepath, content, [1, 2])

        const message = (yield* fail({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(3, content.split("\n")[2]), text: "GAMMA" }],
        })).message

        expect(message).toContain("never displayed")
        expect(message).toContain("3: gamma")
        expect(yield* load(filepath)).toBe(content)
      }),
    )

    it.instance("succeeds on retry after the unseen reveal", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "partial-read.txt")
        const content = "alpha\nbeta\ngamma\ndelta"
        yield* put(filepath, content)
        recordSnapshot(filepath, content, [1, 2])

        yield* fail({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(3, content.split("\n")[2]), text: "GAMMA" }],
        })

        yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(3, content.split("\n")[2]), text: "GAMMA" }],
        })

        expect(yield* load(filepath)).toBe("alpha\nbeta\nGAMMA\ndelta")
      }),
    )

    it.instance("remaps anchors when the file drifted with a uniform insertion", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "drift.txt")
        const original = "alpha\nbeta\ngamma"
        yield* put(filepath, original)
        recordSnapshot(filepath, original)

        yield* put(filepath, "preamble\nalpha\nbeta\ngamma")

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(2, "beta"), text: "BETA" }],
        })

        expect(result.output).toContain("remapped")
        expect(yield* load(filepath)).toBe("preamble\nalpha\nBETA\ngamma")
      }),
    )

    it.instance("rejects when the anchored line itself changed (ambiguous drift)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "drift.txt")
        yield* put(filepath, "alpha\nbeta\ngamma")
        recordSnapshot(filepath, "alpha\nbeta\ngamma")

        yield* put(filepath, "alpha\nBETA-CHANGED\ngamma")

        const message = (yield* fail({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(2, "beta"), text: "beta2" }],
        })).message

        expect(message).toContain("anchor mismatch")
        expect(yield* load(filepath)).toBe("alpha\nBETA-CHANGED\ngamma")
      }),
    )

    it.instance("emits a fresh tag header on success for sequential edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "seq.txt")
        const lines = ["a", "b"]
        yield* putSnap(filepath, lines.join("\n"))

        const first = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(1, lines[0]), text: "A" }],
        })
        expect(first.output).toMatch(/^\[seq\.txt#[0-9A-F]{4}\]/)

        const next = yield* run({
          filePath: filepath,
          edits: [{ type: "set_line", line: hashlineRef(2, lines[1]), text: "B" }],
        })
        expect(next.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("A\nB")
      }),
    )
  })

  describe("batch mode and registers", () => {
    it.instance("applies edits across multiple files atomically", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        yield* putSnap(a, "alpha")
        yield* putSnap(b, "beta")

        const result = yield* run({
          files: [
            { filePath: a, edits: [{ type: "set_line", line: hashlineRef(1, "alpha"), text: "ALPHA" }] },
            { filePath: b, edits: [{ type: "set_line", line: hashlineRef(1, "beta"), text: "BETA" }] },
          ],
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(a)).toBe("ALPHA")
        expect(yield* load(b)).toBe("BETA")
      }),
    )

    it.instance("errors on empty batch sections (no content change)", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        yield* putSnap(a, "alpha")

        const message = (yield* fail({ files: [{ filePath: a }] })).message
        expect(message).toContain("No changes applied")
        expect(message).toContain("no content change")
      }),
    )

    it.instance("aborts the whole batch when one file fails validation", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        yield* putSnap(a, "alpha")
        yield* putSnap(b, "beta")

        const message = (yield* fail({
          files: [
            { filePath: a, edits: [{ type: "set_line", line: hashlineRef(1, "alpha"), text: "ALPHA" }] },
            { filePath: b, edits: [{ type: "set_line", line: "9#ZZ", text: "BETA" }] },
          ],
        })).message
        expect(message).toContain("rejected")
        expect(yield* load(a)).toBe("alpha")
        expect(yield* load(b)).toBe("beta")
      }),
    )

    it.instance("moves lines within a file via cut/paste registers", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "move.txt")
        const lines = ["a", "b", "c", "d", "e"]
        yield* putSnap(filepath, lines.join("\n"))

        yield* run({
          filePath: filepath,
          edits: [
            { type: "cut", start_line: hashlineRef(2, lines[1]), end_line: hashlineRef(3, lines[2]), register: "fn" },
            { type: "paste", insert_after_line: hashlineRef(5, lines[4]), register: "fn" },
          ],
        })

        expect(yield* load(filepath)).toBe("a\nd\ne\nb\nc")
      }),
    )

    it.instance("hints the files-form when a paste anchor is missing from its section's file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        yield* putSnap(a, "alpha")
        yield* putSnap(b, "beta")
        const message = (yield* fail({
          files: [
            {
              filePath: a,
              edits: [{ type: "cut", start_line: hashlineRef(1, "alpha"), end_line: hashlineRef(1, "alpha"), register: "x" }],
            },
            { filePath: b, edits: [{ type: "paste", insert_after_line: hashlineRef(1, "gamma"), register: "x" }] },
          ],
        })).message
        expect(message).toContain("anchor mismatch")
        expect(message).toContain("[PATH]")
        expect(message).toContain("@x")
      }),
    )


    it.instance("moves lines across files via batch cut/paste", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        const aLines = ["a1", "a2", "a3"]
        yield* putSnap(a, aLines.join("\n"))
        yield* putSnap(b, "b1")

        yield* run({
          files: [
            {
              filePath: a,
              edits: [
                { type: "cut", start_line: hashlineRef(2, aLines[1]), end_line: hashlineRef(2, aLines[1]), register: "fn" },
              ],
            },
            {
              filePath: b,
              edits: [
                { type: "paste", insert_after_line: hashlineRef(1, "b1"), register: "fn" },
              ],
            },
          ],
        })

        expect(yield* load(a)).toBe("a1\na3")
        expect(yield* load(b)).toBe("b1\na2")
      }),
    )

    it.instance("rejects paste without a matching cut", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "paste.txt")
        yield* putSnap(filepath, "a\nb")

        expect(
          (yield* fail({
            filePath: filepath,
            edits: [{ type: "paste", insert_after_line: hashlineRef(1, "a"), register: "missing" }],
          })).message,
        ).toContain("no matching cut")
      }),
    )

    it.instance("includes boundary annotations in the output", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "ann.txt")
        const lines = ["alpha", "beta", "gamma"]
        yield* putSnap(filepath, lines.join("\n"))

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "replace_lines", start_line: hashlineRef(2, lines[1]), end_line: hashlineRef(2, lines[1]), text: "BETA" }],
        })

        expect(result.output).toContain("[replace_lines lines 2-2]")
        expect(result.output).toContain("first (2): beta")
        expect(result.output).toContain("last  (2): beta")
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        const lines = ["top = 0", "middle = keep", "bottom = 0"]
        yield* putSnap(filepath, lines.join("\n") + "\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        const delayedCtx = {
          ...ctx,
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            edits: [{ type: "set_line", line: hashlineRef(1, lines[0]), text: "top = 1" }],
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run({
            filePath: filepath,
            edits: [{ type: "set_line", line: hashlineRef(3, lines[2]), text: "bottom = 2" }],
          }),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })
})
describe("grammar parser + legacy hints", () => {
  it.instance("rejects unknown op lines with a grammar error naming the line", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      yield* putSnap(filepath, "one\ntwo\n")
      const err = yield* fail({
        input: ["*** Begin Patch", `[${filepath}#A1B2]`, "SET 1#AB:", "+ x", "BOGUS 2#CD:", "*** End Patch"].join("\n"),
      })
      expect(err.message).toContain("Patch grammar error")
      expect(err.message).toContain("line 5")
      expect(err.message).toContain("BOGUS")
    }),
  )

  it.instance("rejects legacy JSON payloads with the migration hint", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      yield* putSnap(filepath, "one\n")
      const err = yield* fail({
        input: "",
        filePath: filepath,
        edits: [{ type: "set_line", line: hashlineRef(1, "one"), text: "x" }],
      })
      expect(err.message).toContain("Legacy JSON edit payload has been removed")
    }),
  )

  it.instance("rejects pre-hashline payloads with the migration hint", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      yield* putSnap(filepath, "one\n")
      const err = yield* fail({ input: "", oldString: "one", newString: "two" })
      expect(err.message).toContain("Legacy edit payload has been removed")
    }),
  )

  it.instance("allows whitespace-only line changes (byte-exact echo detection)", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const lines = ["def f():", "    return 1"]
      yield* putSnap(filepath, lines.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [
          {
            type: "set_line",
            line: hashlineRef(2, lines[1]),
            text: ["      return 1"],
          },
        ],
      })
      expect(yield* load(filepath)).toBe("def f():\n      return 1\n")
      expect(result.output).not.toContain("repeats the anchor line")
    }),
  )

  it.instance("still treats a verbatim anchor copy as echoed first line", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const lines = ["def f():", "    return 1"]
      yield* putSnap(filepath, lines.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [
          {
            type: "set_line",
            line: hashlineRef(2, lines[1]),
            text: ["    return 1", "    return 2"],
          },
        ],
      })
      expect(yield* load(filepath)).toBe("def f():\n    return 1\n    return 2\n")
      expect(result.output).toContain("stripped echoed first line")
    }),
  )

  it.instance("warns on the one-short comment-indent fold via the validator", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: [" // one space short"] }],
      })
      // The edit applies (the fold is a warning, not a rejection)...
      expect(yield* load(filepath)).toContain(" // one space short")
      // ...but the validator flags it for the model to fix on the next call.
      expect(result.output).toContain("indentation validator")
      expect(result.output).toContain("one space short")
    }),
  )
 
  it.instance("does not warn on correctly indented comments", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: ["  // two spaces, correct"] }],
      })
      expect(yield* load(filepath)).toContain("  // two spaces, correct")
      expect(result.output).not.toContain("indentation validator")
    }),
  )

  it.instance("warns on a one-short block-comment opener via the validator", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: [" /* one space short", "  * continuation", "  */"] }],
      })
      expect(yield* load(filepath)).toContain(" /* one space short")
      expect(result.output).toContain("indentation validator")
      expect(result.output).toContain("one space short")
    }),
  )
  
  it.instance("does not warn on a correctly indented block comment", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: ["  /* two spaces", "   * continuation", "   */"] }],
      })
      expect(yield* load(filepath)).toContain("  /* two spaces")
      expect(result.output).not.toContain("indentation validator")
    }),
  )

  it.instance("warns when the fold is against the line ABOVE the comment", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(2, body[1]), text: [" // one space short"] }],
      })
      // Inserted after line 2: the comment at 1 space sits against the code
      // above at 2 (the closing brace below is at 0) - the above check fires.
      expect(yield* load(filepath)).toContain(" // one space short")
      expect(result.output).toContain("indentation validator")
    }),
  )
  
  it.instance("does not warn about pre-existing comments the edit did not touch", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      // The file ALREADY has a one-space-short comment before the edit runs.
      const body = ["function outer() {", " // pre-existing fold", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(3, body[2]), text: ["  // correct new comment"] }],
      })
      expect(result.output).not.toContain("indentation validator")
    }),
  )
  it.instance("warns on the one-short CODE-line fold via the validator", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: [" const beta = 2"] }],
      })
      expect(yield* load(filepath)).toContain(" const beta = 2")
      expect(result.output).toContain("indentation validator")
      expect(result.output).toContain("one space short")
      expect(result.output).toContain("code line")
    }),
  )

  it.instance("does not warn on correctly indented code lines", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: ["  const beta = 2"] }],
      })
      expect(yield* load(filepath)).toContain("  const beta = 2")
      expect(result.output).not.toContain("indentation validator")
    }),
  )

  it.instance("skips a blank line when finding the adjacent code (LF-only neighbor)", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      // The folded line sits one space short of the code BELOW it, with a
      // blank line in between - the blank must not break the adjacency scan.
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(1, body[0]), text: ["", " const beta = 2"] }],
      })
      expect(result.output).toContain("indentation validator")
    }),
  )

  it.instance("does not warn about pre-existing folded CODE lines the edit did not touch", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const body = ["function outer() {", " const pre-existing-fold", "  const alpha = 1", "}"]
      yield* putSnap(filepath, body.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [{ type: "insert_after", line: hashlineRef(3, body[2]), text: ["  // correct new comment"] }],
      })
      expect(result.output).not.toContain("indentation validator")
    }),
  )
  
  it.instance("auto-strips echoed first line end-to-end and notes it", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      const lines = ["pairs = []", "for k in items:", "    use(k)"]
      yield* putSnap(filepath, lines.join("\n") + "\n")
      const result = yield* run({
        filePath: filepath,
        edits: [
          {
            type: "replace_lines",
            start_line: hashlineRef(1, lines[0]),
            end_line: hashlineRef(3, lines[2]),
            text: [lines[0], "for k in items:", "    use(k, 1)", "    log(k)"],
          },
        ],
      })
      expect(yield* load(filepath)).toBe("pairs = []\nfor k in items:\n    use(k, 1)\n    log(k)\n")
      expect(result.output).toContain("stripped echoed first line")
    }),
  )
})

describe("0055 escape-payload hardening", () => {
  it.instance("applies an escape-heavy replace payload cleanly", () =>
    Effect.gen(function* () {
      const filepath = path.join((yield* TestInstance).directory, "a.txt")
      yield* putSnap(filepath, "one\ntwo\nthree\n")
      const rows = Array.from({ length: 40 }, (_, i) => `line ${i} with "quotes" and \`ticks\` and ${i}${i} and \${x} content`)
      const input = [
        "*** Begin Patch",
        `[${filepath}#A1B2]`,
        `REPLACE ${hashlineRef(1, "one")} ${hashlineRef(3, "three")}:`,
        ...rows.map((r) => `+ ${r}`),
        "*** End Patch",
      ].join("\n")
      const result = yield* run({ input })
      expect(result.output).toContain("Edit applied successfully")
      expect(yield* load(filepath)).toBe(rows.join("\n") + "\n")
    }),
  )
})

describe("basename fallback resolution", () => {
  it.instance("resolves a bare basename to the unique file in the tree", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nested", "dir", "file.txt")
      yield* putSnap(filepath, "one\n")
      const result = yield* run({
        input: ["*** Begin Patch", "[file.txt#A1B2]", `SET ${hashlineRef(1, "one")}:`, "+ two", "*** End Patch"].join("\n"),
      })
      expect(result.output).toContain("Edit applied successfully")
      expect(yield* load(filepath)).toBe("two\n")
    }),
  )

  it.instance("resolves a bare basename to the tag-matching file when ambiguous", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const alpha = path.join(test.directory, "alpha", "shared.txt")
      const beta = path.join(test.directory, "beta", "shared.txt")
      yield* putSnap(alpha, "alpha-content\n")
      yield* putSnap(beta, "beta-content\n")
      const headerTag = fileTag("alpha-content\n")
      const result = yield* run({
        input: ["*** Begin Patch", `[shared.txt#${headerTag}]`, "APPEND:", "+ done", "*** End Patch"].join("\n"),
      })
      expect(result.output).toContain("Edit applied successfully")
      expect(yield* load(alpha)).toBe("alpha-content\ndone\n")
      expect(yield* load(beta)).toBe("beta-content\n")
    }),
  )

  it.instance("rejects an ambiguous basename without a disambiguating tag", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* putSnap(path.join(test.directory, "alpha", "shared.txt"), "alpha\n")
      yield* putSnap(path.join(test.directory, "beta", "shared.txt"), "beta\n")
      const err = yield* fail({
        input: ["*** Begin Patch", "[shared.txt#A1B2]", "APPEND:", "+ done", "*** End Patch"].join("\n"),
      })
      expect(err.message).toContain("is ambiguous")
      expect(err.message).toContain("shared.txt")
    }),
  )

  it.instance("keeps the missing-file guard for basenames with no match", () =>
    Effect.gen(function* () {
      const err = yield* fail({
        input: ["*** Begin Patch", "[ghost.txt#A1B2]", "SET 1#AB:", "+ x", "*** End Patch"].join("\n"),
      })
    expect(err.message).toContain("can only be created with append/prepend")
    }),
  )
})

describe("section header path rendering", () => {
  it.instance("renders in-project paths relative to the instance directory in success output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nested", "file.txt")
      yield* putSnap(filepath, "one\n")
      const result = yield* run({
        input: ["*** Begin Patch", `[${filepath}#A1B2]`, "APPEND:", "+ two", "*** End Patch"].join("\n"),
      })
      expect(result.output).toContain(`[${path.join("nested", "file.txt")}#`)
    }),
  )

  it.instance("renders the absolute path in success output for files outside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outer = yield* tmpdirScoped()
      const filepath = path.join(outer, "global.txt")
      yield* putSnap(filepath, "one\n")
      const result = yield* run({
        input: ["*** Begin Patch", `[${filepath}#A1B2]`, "APPEND:", "+ two", "*** End Patch"].join("\n"),
      })
      expect(result.output).toContain(`[${filepath}#`)
    }),
  )

  it.instance("rejects a bare basename header that resolves to a different file with another tag", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Same basename as the file the header really names, but never read
      // (no snapshot) and carrying a different tag: this is the
      // global-AGENTS.md-vs-project-stub class of collision.
      yield* put(path.join(test.directory, "AGENTS.md"), "project stub\n")
      const err = yield* fail({
        input: ["*** Begin Patch", "[AGENTS.md#FFFF]", "APPEND:", "+ x", "*** End Patch"].join("\n"),
      })
      expect(err.message).toContain("does not match")
      expect(err.message).toContain("copy the [PATH#TAG] header verbatim")
    }),
  )
})

describe("same-file multi-section patches", () => {
  it.instance("merges sections of one file into a single files entry with the net diff", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "merged.txt")
      yield* putSnap(filepath, "alpha\nbeta\ngamma\n")
      // Section 1 shifts every line down; section 2 anchors on an ORIGINAL
      // line, exercising the chain remap (1#<alpha> -> 2#<alpha>).
      const result = yield* run({
        input: [
          "*** Begin Patch",
          `[${filepath}#A1B2]`,
          "PREPEND:",
          "+ zero",
          `[${filepath}#A1B2]`,
          `SET ${hashlineRef(1, "alpha")}:`,
          "+ ALPHA",
          "*** End Patch",
        ].join("\n"),
      })
      // One block per file: the files metadata has a single entry for
      // merged.txt carrying the net diff (original -> final).
      const files = result.metadata.files as Array<Record<string, unknown>>
      const mine = files.filter((f) => f.filePath === filepath)
      expect(mine.length).toBe(1)
      expect(mine[0].patch).toContain("+zero")
      expect(mine[0].patch).toContain("+ALPHA")
      expect(mine[0].changed).toBe(true)
      expect(yield* load(filepath)).toBe("zero\nALPHA\nbeta\ngamma\n")
    }),
  )

  it.instance("success header carries the final tag after all sections of the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "final-tag.txt")
      yield* putSnap(filepath, "one\n")
      const result = yield* run({
        input: [
          "*** Begin Patch",
          `[${filepath}#A1B2]`,
          "APPEND:",
          "+ two",
          `[${filepath}#A1B2]`,
          "APPEND:",
          "+ three",
          "*** End Patch",
        ].join("\n"),
      })
      const finalTag = fileTag(yield* load(filepath))
      expect(result.output).toMatch(new RegExp(`\\[final-tag\\.txt#${finalTag}\\]`))
    }),
  )
})
