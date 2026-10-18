import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import { DEFAULT_THEMES, addTheme, allThemes, generateSyntax, hasTheme, resolveTheme, terminalMode } from "../src/theme"
import { discoverThemes } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("alternate capture vocabularies resolve to theme colors", () => {
  const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  const syntax = generateSyntax(theme)
  const channels = (color?: { r: number; g: number; b: number; a: number }) =>
    color ? [color.r, color.g, color.b, color.a] : undefined
  const fg = (scope: string) => channels(syntax.getStyle(scope)?.fg)

  // Existing intentional scheme: tags red, attributes orange.
  expect(fg("tag")).toEqual(channels(theme.error))
  expect(fg("attribute")).toEqual(channels(theme.warning))
  expect(fg("namespace")).toEqual(channels(theme.syntaxType))
  expect(fg("field")).toEqual(channels(theme.syntaxVariable))
  expect(fg("label")).toEqual(channels(theme.markdownLinkText))
  expect(fg("float")).toEqual(channels(theme.syntaxNumber))
  // 0430 aliases for the alternate capture families.
  expect(fg("conditional")).toEqual(channels(theme.syntaxKeyword))
  expect(fg("method")).toEqual(channels(theme.syntaxFunction))
  expect(fg("delimiter")).toEqual(channels(theme.syntaxPunctuation))
  expect(fg("identifier")).toEqual(channels(theme.syntaxVariable))
  expect(fg("cImport")).toEqual(channels(theme.syntaxKeyword))
  expect(fg("error")).toEqual(channels(theme.error))
  expect(fg("warning")).toEqual(channels(theme.warning))
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.opencode)
  const two = structuredClone(DEFAULT_THEMES.opencode)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
