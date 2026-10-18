// 0423: edit/write safety primitives.
//
// The edit and write tools used to read, ask permission, and then write
// through the shared FSUtil writer. Two calls racing on the same path could
// interleave between read and write (the last writer silently discarding the
// other's change), and a partial/failed write could truncate the target.
//
// This module supplies the four pieces the tools now use:
//   - withFileLock: process-local promise mutex keyed by canonical realpath,
//     held across the whole read -> permission ask -> write sequence. This is
//     same-process only (other opencode processes and external editors are
//     outside the mutex; assertUnchanged catches those).
//   - assertUnchanged: byte comparison immediately before the write.
//   - atomicWrite: same-directory temp file + fsync + rename + dir fsync.
//   - verifyWritten: read-back byte comparison after the rename.
//
// Symlinks are resolved before writing so the target's content is replaced,
// never the link itself.

import { randomBytes } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

const locks = new Map<string, Promise<void>>()

const STALE_MESSAGE = "File changed since read (stale edit): re-read the file and retry."

/** Canonical lock/IO key: realpath when the file exists, otherwise the
 *  realpath of its parent plus the basename (so a path created between calls
 *  still keys to the same place). */
export async function canonicalPath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath)
  try {
    return await fs.realpath(absolute)
  } catch {
    try {
      return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** Acquire the process-local lock for a path. The returned function releases
 *  it exactly once. Callers that need a callback shape should use
 *  withFileLock. */
export async function acquireFileLock(filePath: string): Promise<() => void> {
  const key = await canonicalPath(filePath)
  const previous = locks.get(key) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  locks.set(key, tail)

  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    release()
    // Only the newest waiter owns map cleanup; earlier lock holders must not
    // delete a successor's tail.
    if (locks.get(key) === tail) locks.delete(key)
  }
}

/** Process-local serialization for all mutations of one file path. Covers the
 *  full read -> permission -> write window. Same process only. */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireFileLock(filePath)
  try {
    return await fn()
  } finally {
    release()
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content
}

async function readOrNull(filePath: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(filePath)
  } catch (error: any) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

/** Verify the target still holds the bytes the tool read before the
 *  permission ask. `null` means the file must still be absent (create path). */
export async function assertUnchanged(filePath: string, expected: string | Uint8Array | null): Promise<void> {
  const current = await readOrNull(filePath)

  if (expected === null) {
    if (current !== null) throw new Error(STALE_MESSAGE)
    return
  }

  if (current === null || !sameBytes(current, bytesOf(expected))) throw new Error(STALE_MESSAGE)
}

/** Replace a file atomically: temp file in the same directory, fsync, mode
 *  preservation, rename over the resolved target, then directory fsync. The
 *  temp file is removed on any failure. */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const target = await canonicalPath(filePath)
  const dir = path.dirname(target)
  await fs.mkdir(dir, { recursive: true })

  let existingMode: number | undefined
  try {
    existingMode = (await fs.stat(target)).mode & 0o777
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }

  const desiredMode = mode ?? existingMode ?? 0o644
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`)
  const data = bytesOf(content)

  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tmp, "wx", desiredMode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined

    await fs.rename(tmp, target)
    await fsyncDir(dir)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(dir, "r")
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems; the rename
    // itself is still atomic. Do not fail a successful write for this.
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** Read-back verification after atomicWrite. A mismatch means another process
 *  changed the file between the rename and the read-back, or the write did not
 *  land as requested. */
export async function verifyWritten(filePath: string, content: string | Uint8Array): Promise<void> {
  const expected = bytesOf(content)
  const actual = await readOrNull(await canonicalPath(filePath))
  if (actual === null) {
    throw new Error(`write verification failed: ${filePath} could not be read back after writing`)
  }
  if (!sameBytes(actual, expected)) {
    throw new Error(
      `write verification failed: ${filePath} does not match the content that was written (re-read the file and retry)`,
    )
  }
}
