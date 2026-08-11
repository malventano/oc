import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { hashlineRef } from "../../src/tool/hashline"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
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
import { clearSnapshots, recordSnapshot } from "../../src/tool/hashline-store"

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

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
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
        ).toContain("Missing file can only be created with append/prepend")
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

    it.instance("applies string replacement via the replace op", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* putSnap(filepath, "foo bar foo baz foo")

        yield* run({
          filePath: filepath,
          edits: [{ type: "replace", old_text: "foo", new_text: "qux", all: true }],
        })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    it.instance("rejects ambiguous replace without all=true", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* putSnap(filepath, "foo foo")

        expect(
          (yield* fail({
            filePath: filepath,
            edits: [{ type: "replace", old_text: "foo", new_text: "qux" }],
          })).message,
        ).toContain("matched multiple times")
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

    it.instance("requires edits in the payload", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath })).message).toContain("requires edits")
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

    it.instance("detects no-op edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        const lines = ["alpha"]
        yield* putSnap(filepath, lines.join("\n"))

        const result = yield* run({
          filePath: filepath,
          edits: [{ type: "replace", old_text: "alpha", new_text: "alpha" }],
        })

        expect(result.output).toContain("No changes applied")
        expect(result.metadata.noop).toBe(1)
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

    it.instance("treats delete of missing file as no-op", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "missing.txt")

        const result = yield* run({ filePath: filepath, edits: [], delete: true })

        expect(result.output).toContain("No changes applied")
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
        ).toContain("cannot be combined")
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

    it.instance("rejects batch sections with no edits/delete/rename", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        yield* putSnap(a, "alpha")

        expect(
          (yield* fail({
            files: [{ filePath: a }],
          })).message,
        ).toContain("at least one of edits/delete/rename")
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
        expect(message).toContain("files:")
        expect(message).toContain("@x")
      }),
    )

    it.instance("hints the files-form when a section-shaped object lands in the edits position", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const a = path.join(test.directory, "a.txt")
        yield* putSnap(a, "alpha")
        const message = (yield* fail({
          filePath: a,
          edits: [{ filePath: path.join(test.directory, "b.txt"), edits: [] }] as never,
        })).message
        expect(message).toContain("files:")
        expect(message).toContain("filePath")
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
