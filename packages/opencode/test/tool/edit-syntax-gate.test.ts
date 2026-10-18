import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { validateEditSyntax } from "../../src/tool/edit-validate"

const dirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-edit-syntax-"))
  dirs.push(dir)
  return path.join(dir, name)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  delete process.env.OC_DISABLE_EDIT_SYNTAX_GATE
})

describe("edit syntax gate", () => {
  test("rejects valid -> invalid JSON", async () => {
    const file = await tempFile("config.json")

    await expect(validateEditSyntax(file, '{\n  "a": 1\n}\n', '{\n  "a": \n}\n')).rejects.toThrow(
      /invalid JSON\/JSONC/i,
    )
  })

  test("rejects valid -> invalid YAML", async () => {
    const file = await tempFile("config.yaml")

    await expect(validateEditSyntax(file, "a: 1\n", "a: [1,\n")).rejects.toThrow(/invalid YAML/i)
  })

  test("rejects valid -> invalid TOML", async () => {
    const file = await tempFile("config.toml")

    await expect(validateEditSyntax(file, "a = 1\n", "a = \n")).rejects.toThrow(/invalid TOML/i)
  })

  test("accepts valid JSONC with comments and trailing commas", async () => {
    const file = await tempFile("config.jsonc")
    const next = '{\n  // comment\n  "a": 2,\n}\n'

    const result = await validateEditSyntax(file, '{"a":1}\n', next)

    expect(result.checked).toBe(true)
    expect(result.skipped).toBeUndefined()
  })

  test("allows edits to files that were already invalid (delta rule)", async () => {
    const file = await tempFile("broken.json")

    const result = await validateEditSyntax(file, "{ not json", "{ still not json")

    expect(result.checked).toBe(false)
  })

  test("skips new-file content (no original baseline)", async () => {
    const file = await tempFile("new.json")

    const result = await validateEditSyntax(file, null, "{ not json")

    expect(result.checked).toBe(false)
  })

  test("kill switch disables the gate", async () => {
    process.env.OC_DISABLE_EDIT_SYNTAX_GATE = "1"
    const file = await tempFile("config.json")

    const result = await validateEditSyntax(file, '{"a":1}', '{"a":}')

    expect(result.checked).toBe(false)
  })
})
