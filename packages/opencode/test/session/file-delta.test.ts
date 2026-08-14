import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { FileStat, ReconstructedRead } from "../../src/session/file-delta"
import {
  buildFileDeltaText,
  computeFileDeltas,
  integrateFileReads,
} from "../../src/session/file-delta"

// ---------------------------------------------------------------------------
// Fixture builders (plain object shapes, cast to the session part/message types
// - the walk only reads type/tool/state/synthetic/metadata).
// ---------------------------------------------------------------------------

const FILE = "/project/src/foo.ts"
const STAT_1: FileStat = { mtimeMs: 1000, size: 10 }
const STAT_2: FileStat = { mtimeMs: 2000, size: 12 }

function readPart(path: string, text: string, stat: FileStat, lineStart = 1, lineEnd = 3): SessionV1.Part {
  return {
    id: "p-read",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: path },
      output: `<path>${path}</path>`,
      metadata: {
        display: { type: "file", path, text, lineStart, lineEnd, totalLines: lineEnd, truncated: false },
        stat,
      },
    },
  } as unknown as SessionV1.Part
}

function deltaPart(path: string, stat: FileStat | { deleted: true }): SessionV1.Part {
  return {
    id: "p-delta",
    sessionID: "s",
    messageID: "m",
    type: "text",
    text: "<system-reminder>file drift</system-reminder>",
    synthetic: true,
    metadata: { fileDelta: { [path]: stat } },
  } as unknown as SessionV1.Part
}

function editPart(filePath: string, stat: FileStat | { deleted: true } | undefined, type = "edit"): SessionV1.Part {
  return {
    id: "p-edit",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "edit",
    state: {
      status: "completed",
      input: { input: "*** Begin Patch" },
      metadata: { files: [{ filePath, relativePath: filePath, type, patch: "x", stat }] },
    },
  } as unknown as SessionV1.Part
}

function writePart(filePath: string, content: string, stat: FileStat | undefined): SessionV1.Part {
  return {
    id: "p-write",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "write",
    state: {
      status: "completed",
      input: { filePath, content },
      output: "Wrote file.",
      metadata: { filepath: filePath, stat },
    },
  } as unknown as SessionV1.Part
}

function msg(parts: SessionV1.Part[]): SessionV1.WithParts {
  return { info: { id: "m", role: "user" as const, time: { created: 0 } }, parts } as unknown as SessionV1.WithParts
}

const reconstructed = (stat: FileStat | { deleted: true }, oldText: string | null = "a\nb\nc"): ReconstructedRead => ({
  path: FILE,
  stat,
  lineStart: 1,
  lineEnd: 3,
  oldText,
})

// ---------------------------------------------------------------------------

describe("file-delta.integrateFileReads", () => {
  test("empty chain yields nothing", () => {
    expect(integrateFileReads([]).size).toBe(0)
  })

  test("a read establishes the baseline stat", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)])])
    expect(out.get(FILE)).toEqual(reconstructed(STAT_1))
  })

  test("directory reads are not tracked", () => {
    const part = {
      id: "p-read",
      sessionID: "s",
      messageID: "m",
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: FILE },
        metadata: { display: { type: "directory", path: "/project/src", entries: [] } },
      },
    } as unknown as SessionV1.Part
    expect(integrateFileReads([msg([part])]).size).toBe(0)
  })

  test("a read without a recorded stat is not tracked (pre-0116 reads)", () => {
    const part = {
      id: "p-read",
      sessionID: "s",
      messageID: "m",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: FILE }, metadata: { display: { type: "file", path: FILE } } },
    } as unknown as SessionV1.Part
    expect(integrateFileReads([msg([part])]).size).toBe(0)
  })

  test("a post-read delta replaces the reported stat", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([deltaPart(FILE, STAT_2)])])
    expect(out.get(FILE)?.stat).toEqual(STAT_2)
  })

  test("multiple deltas: last wins", () => {
    const out = integrateFileReads([
      msg([readPart(FILE, "a\nb\nc", STAT_1)]),
      msg([deltaPart(FILE, STAT_2)]),
      msg([deltaPart(FILE, STAT_1)]),
    ])
    expect(out.get(FILE)?.stat).toEqual(STAT_1)
  })

  test("a deleted delta marker is carried", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([deltaPart(FILE, { deleted: true })])])
    expect(out.get(FILE)?.stat).toEqual({ deleted: true })
  })

  test("a delta without a prior read is not integrated", () => {
    const out = integrateFileReads([msg([deltaPart(FILE, STAT_2)])])
    expect(out.get(FILE)).toBeUndefined()
  })

  test("two files tracked independently", () => {
    const out = integrateFileReads([
      msg([readPart("/a.ts", "a1", STAT_1)]),
      msg([readPart("/b.ts", "b1", STAT_2)]),
      msg([deltaPart("/a.ts", STAT_2)]),
    ])
    expect(out.get("/a.ts")?.stat).toEqual(STAT_2)
    expect(out.get("/b.ts")?.stat).toEqual(STAT_2)
  })

  test("a session edit's post-edit stat becomes the reported state", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([editPart(FILE, STAT_2)])])
    expect(out.get(FILE)?.stat).toEqual(STAT_2)
  })

  test("a session delete edit records the { deleted: true } sentinel", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([editPart(FILE, { deleted: true }, "delete")])])
    expect(out.get(FILE)?.stat).toEqual({ deleted: true })
  })

  test("an edit touching a different file does not alter the reported state", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([editPart("/other.ts", STAT_2)])])
    expect(out.get(FILE)?.stat).toEqual(STAT_1)
  })

  test("a write after the read replaces the reported stat", () => {
    const out = integrateFileReads([msg([readPart(FILE, "a\nb\nc", STAT_1)]), msg([writePart(FILE, "new", STAT_2)])])
    expect(out.get(FILE)?.stat).toEqual(STAT_2)
  })

  test("a newer read supersedes prior deltas (re-read self-heals)", () => {
    const out = integrateFileReads([
      msg([readPart(FILE, "a\nb\nc", STAT_1)]),
      msg([deltaPart(FILE, STAT_2)]),
      msg([readPart(FILE, "x\ny\nz", STAT_2)]),
    ])
    expect(out.get(FILE)?.stat).toEqual(STAT_2)
    expect(out.get(FILE)?.oldText).toBe("x\ny\nz")
  })
})

describe("file-delta.computeFileDeltas", () => {
  const disk = (mtimeMs: number, size: number) => new Map([[FILE, { mtimeMs, size } as FileStat]])
  const none = () => new Map<string, FileStat | undefined>([[FILE, undefined]])

  test("no entry when the disk stat equals the reported stat", async () => {
    const out = await computeFileDeltas(new Map([[FILE, reconstructed(STAT_1)]]), disk(1000, 10), async () => undefined)
    expect(out).toEqual([])
  })

  test("legacy float stat from a pre-0120 edit tool part is not a change", async () => {
    // Pre-0120 binaries recorded raw float mtimeMs in edit/write metadata;
    // the comparison truncates both sides, so the float compares equal to
    // the truncated disk stat (no spurious drift after the 0120 rollout).
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed({ mtimeMs: 1786655410442.294971, size: 10 })]]),
      disk(1786655410442, 10),
      async () => undefined,
    )
    expect(out).toEqual([])
  })

  test("integer-ms normalization: float disk stat truncated at the source is not a change (0120)", async () => {
    // apply() truncates the NFS.stat float to integer ms (Date.getTime()
    // parity) before comparison; the read tool records the integer already.
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed({ mtimeMs: 1786655410442, size: 10 })]]),
      disk(Math.trunc(1786655410442.294971), 10),
      async () => undefined,
    )
    expect(out).toEqual([])
  })

  test("a real change of at least 1 ms still yields a diff", async () => {
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed({ mtimeMs: 1786655410442, size: 10 })]]),
      disk(1786655410443, 10),
      async () => "a",
    )
    expect(out).toEqual([{ path: FILE, kind: "changed", diff: { lines: ["- b", "- c"], truncated: false } }])
  })

  test("a changed file yields a window diff", async () => {
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed(STAT_1, "a\nb\nc")]]),
      disk(2000, 12),
      async () => "a\nB\nc",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: FILE, kind: "changed" })
    expect(out[0].diff?.lines).toContain("- b")
    expect(out[0].diff?.lines).toContain("+ B")
  })

  test("a file that shrank is still a change", async () => {
    const out = await computeFileDeltas(new Map([[FILE, reconstructed(STAT_1)]]), disk(3000, 5), async () => "a")
    expect(out).toEqual([{ path: FILE, kind: "changed", diff: { lines: ["- b", "- c"], truncated: false } }])
  })

  test("deletion: reported once (not re-reported when the baseline is already deleted)", async () => {
    const out = await computeFileDeltas(new Map([[FILE, reconstructed(STAT_1)]]), none(), async () => undefined)
    expect(out).toEqual([{ path: FILE, kind: "deleted" }])
    const out2 = await computeFileDeltas(new Map([[FILE, reconstructed({ deleted: true })]]), none(), async () => undefined)
    expect(out2).toEqual([])
  })

  test("recreated file diffs from the deleted baseline", async () => {
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed({ deleted: true }, "a\nb\nc")]]),
      disk(5000, 12),
      async () => "a\nB\nc",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ path: FILE, kind: "changed" })
    expect(out[0].diff?.lines).toContain("- b")
    expect(out[0].diff?.lines).toContain("+ B")
  })
  test("generic note when the file is too large to diff", async () => {
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed(STAT_1, "a\nb\nc")]]),
      disk(2000, 5 * 1024 * 1024),
      async () => undefined,
    )
    expect(out).toEqual([{ path: FILE, kind: "changed" }])
  })

  test("generic note when the new window cannot be read", async () => {
    const out = await computeFileDeltas(new Map([[FILE, reconstructed(STAT_1)]]), disk(2000, 12), async () => undefined)
    expect(out).toEqual([{ path: FILE, kind: "changed" }])
  })

  test("external change after a session self-edit diffs against the post-edit stat", async () => {
    // Read at S1, session edit left the file at S2, disk is now S3.
    const out = await computeFileDeltas(
      new Map([[FILE, reconstructed(STAT_2, "a\nb\nc")]]),
      disk(3000, 14),
      async () => "a\nb\nc\nd",
    )
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("changed")
  })
})

describe("file-delta.buildFileDeltaText", () => {
  test("renders the reminder wrapper with per-file diff sections", () => {
    const text = buildFileDeltaText([
      { path: "src/foo.ts", kind: "changed", diff: { lines: ["- old", "+ new"], truncated: false } },
      { path: "src/gone.ts", kind: "deleted" },
    ])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("File context drift")
    expect(text).toContain("src/foo.ts")
    expect(text).toContain("- old")
    expect(text).toContain("+ new")
    expect(text).toContain("src/gone.ts")
    expect(text).toContain("deleted from disk")
    expect(text).toContain("</system-reminder>")
  })

  test("generic note for a changed file without a diff", () => {
    const text = buildFileDeltaText([{ path: "src/foo.ts", kind: "changed" }])
    expect(text).toContain("re-read with the read tool")
  })

  test("truncated diff adds a re-read note", () => {
    const text = buildFileDeltaText([
      { path: "src/foo.ts", kind: "changed", diff: { lines: ["- a", "+ b"], truncated: true } },
    ])
    expect(text).toContain("diff truncated")
    expect(text).toContain("re-read with the read tool")
  })

  test("path cap: beyond 8 entries gets a summary line", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts`, kind: "changed" as const }))
    const text = buildFileDeltaText(entries)
    expect(text).toContain("... and 2 more file(s)")
  })
})
