import { describe, expect, test } from "bun:test"
import parsers from "../src/parsers-config"
import { LANGUAGE_EXTENSIONS, coalesceFiletype, filetype, hasGrammar, isNoGrammar } from "../src/util/filetype"

// Languages with no usable tree-sitter wasm/query pair (validated 2026-10-18).
// They render unstyled on both the streaming and completed sides - never
// colored-then-white. Adding a grammar for one of these means removing it
// here and adding the parser entry.
const KNOWN_NO_GRAMMAR = new Set([
  "abap",
  "coffeescript",
  "git-commit",
  "objective-cpp",
  "perl6",
  "sass",
  "shaderlab",
  "text",
])

describe("filetype grammar coverage", () => {
  test("ps1 and psm1 resolve to a colorable powershell grammar", () => {
    expect(filetype("script.ps1")).toBe("powershell")
    expect(filetype("module.psm1")).toBe("powershell")
    expect(hasGrammar("powershell")).toBe(true)
    expect(isNoGrammar("powershell")).toBe(false)
  })

  test("every mapped language is colorable or explicitly known-plain", () => {
    const missing = new Set<string>()
    for (const language of Object.values(LANGUAGE_EXTENSIONS)) {
      const resolved = coalesceFiletype(language)!
      if (!hasGrammar(resolved)) missing.add(resolved)
    }
    expect([...missing].sort()).toEqual([...KNOWN_NO_GRAMMAR].sort())
  })

  test("known-plain languages have no parser entry", () => {
    for (const language of KNOWN_NO_GRAMMAR) {
      expect(hasGrammar(language)).toBe(false)
      expect(isNoGrammar(language)).toBe(true)
    }
  })

  test("parser filetypes and aliases are unique", () => {
    const seen = new Set<string>()
    for (const parser of parsers.parsers) {
      const names = [parser.filetype, ...((parser as { aliases?: string[] }).aliases ?? [])]
      for (const name of names) {
        expect(seen.has(name)).toBe(false)
        seen.add(name)
      }
    }
  })

  test("every parser entry has an https wasm and at least one https query", () => {
    for (const parser of parsers.parsers) {
      expect(parser.wasm.startsWith("https://")).toBe(true)
      expect(parser.queries.highlights.length).toBeGreaterThan(0)
      for (const query of parser.queries.highlights) expect(query.startsWith("https://")).toBe(true)
    }
  })
})
