import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  assertUnchanged,
  atomicWrite,
  canonicalPath,
  withFileLock,
  verifyWritten,
} from "../../src/tool/edit-write"

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-edit-write-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("edit-write safety", () => {
  test("rejects a stale edit when the file changed since read", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "stale.txt")
    await fs.writeFile(file, "original")

    await assertUnchanged(file, "original")
    await fs.writeFile(file, "external change")

    await expect(assertUnchanged(file, "original")).rejects.toThrow(/stale edit/i)
  })

  test("expects absence on the create path", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "new.txt")

    await assertUnchanged(file, null)
    await fs.writeFile(file, "created elsewhere")

    await expect(assertUnchanged(file, null)).rejects.toThrow(/stale edit/i)
  })

  test("serializes concurrent edits to the same canonical path", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "serialized.txt")

    const order: string[] = []
    let active = 0
    let peak = 0

    await Promise.all(
      [1, 2, 3].map((n) =>
        withFileLock(file, async () => {
          active++
          peak = Math.max(peak, active)
          order.push(`start${n}`)
          await new Promise((resolve) => setTimeout(resolve, 15))
          order.push(`end${n}`)
          active--
        }),
      ),
    )

    expect(peak).toBe(1)
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.replace("start", "end")).toBe(order[i + 1]!)
    }
  })

  test("acquireFileLock keys symlinks to the same canonical target", async () => {
    const dir = await tempDir()
    const target = path.join(dir, "target.txt")
    const link = path.join(dir, "link.txt")
    await fs.writeFile(target, "x")
    await fs.symlink(target, link)

    expect(await canonicalPath(link)).toBe(await canonicalPath(target))
  })

  test("atomic write leaves no temp file on success", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "file.txt")

    await atomicWrite(file, "content")

    expect(await fs.readFile(file, "utf8")).toBe("content")
    const entries = await fs.readdir(dir)
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false)
  })

  test("atomic write cleans up its temp file when the rename fails", async () => {
    const dir = await tempDir()
    const target = path.join(dir, "target")
    await fs.mkdir(target)

    await expect(atomicWrite(target, "content")).rejects.toThrow()
    const entries = await fs.readdir(dir)
    expect(entries.some((entry) => entry.includes(".tmp-"))).toBe(false)
  })

  test("atomic write preserves the existing mode", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "mode.txt")
    await fs.writeFile(file, "old")
    await fs.chmod(file, 0o600)

    await atomicWrite(file, "new")

    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    }
  })

  test("atomic write resolves symlinks and replaces the target content", async () => {
    const dir = await tempDir()
    const target = path.join(dir, "target.txt")
    const link = path.join(dir, "link.txt")
    await fs.writeFile(target, "old")
    await fs.symlink(target, link)

    await atomicWrite(link, "new")

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, "utf8")).toBe("new")
    expect(await fs.readFile(link, "utf8")).toBe("new")
  })

  test("verification failure is loud", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "verify.txt")
    await fs.writeFile(file, "expected")

    await verifyWritten(file, "expected")
    await expect(verifyWritten(file, "different")).rejects.toThrow(/write verification failed/i)
  })
})
