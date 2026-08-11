import { describe, expect, test } from "bun:test"
import { clearSnapshots, fileTag, invalidateSnapshot, recordSnapshot, relocateSnapshot, snapshotOf } from "../../src/tool/hashline-store"

describe("tool.hashline-store", () => {
  test("tags are stable across CRLF and trailing whitespace", () => {
    const a = fileTag("alpha\nbeta\n")
    const b = fileTag("alpha\r\nbeta\r\n")
    const c = fileTag("alpha \nbeta\t\n")
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(a).toMatch(/^[0-9A-F]{4}$/)
  })

  test("tags differ when content differs", () => {
    expect(fileTag("alpha")).not.toBe(fileTag("ALPHA"))
    expect(fileTag("a\nb")).not.toBe(fileTag("a\nc"))
  })

  test("records and retrieves snapshots by path", () => {
    clearSnapshots()
    const tag = recordSnapshot("/tmp/x.txt", "one\ntwo", [1])
    const snap = snapshotOf("/tmp/x.txt")
    expect(snap?.tag).toBe(tag)
    expect(snap?.content).toBe("one\ntwo")
    expect([...snap!.seenLines]).toEqual([1])
  })

  test("merges seen lines when content is identical", () => {
    clearSnapshots()
    recordSnapshot("/tmp/y.txt", "one\ntwo", [1])
    const tag = recordSnapshot("/tmp/y.txt", "one\ntwo", [2])
    expect(snapshotOf("/tmp/y.txt")?.seenLines.has(1)).toBe(true)
    expect(snapshotOf("/tmp/y.txt")?.seenLines.has(2)).toBe(true)
    expect(snapshotOf("/tmp/y.txt")?.tag).toBe(tag)
  })

  test("invalidate and relocate", () => {
    clearSnapshots()
    recordSnapshot("/tmp/a.txt", "one")
    invalidateSnapshot("/tmp/a.txt")
    expect(snapshotOf("/tmp/a.txt")).toBeUndefined()

    recordSnapshot("/tmp/b.txt", "two")
    relocateSnapshot("/tmp/b.txt", "/tmp/c.txt")
    expect(snapshotOf("/tmp/b.txt")).toBeUndefined()
    expect(snapshotOf("/tmp/c.txt")?.content).toBe("two")
  })
})
