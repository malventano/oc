// 0424: candidate-content syntax gate for structured config edits.
//
// A model edit can leave a config file syntactically broken even when the
// replacement itself looked plausible. The gate parses the ORIGINAL content and
// the candidate NEW content, and rejects only the delta case:
//   original parsed && new fails -> reject before the permission ask / write.
// A file that was already invalid stays editable (models often repair broken
// configs), and new files have no original to compare against.
//
// .json/.jsonc use the project's JSONC parser (comments + trailing commas are
// valid). YAML and TOML parsers are loaded from effect's existing runtime
// dependencies; if that resolution ever fails, the format is skipped and the
// reason is reported in the tool output instead of blocking the edit.

import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import * as path from "path"
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"

type YamlDocument = {
  errors: Array<{ message: string; linePos?: Array<{ line: number; col: number }> }>
}

type YamlModule = {
  parseDocument: (text: string) => YamlDocument
}

type TomlModule = {
  parse: (text: string) => unknown
}

let yamlModule: YamlModule | null | undefined
let tomlModule: TomlModule | null | undefined

/** Resolve a parser the way effect itself does (effect declares both yaml and
 *  toml). createRequire anchored at effect's entry sees effect's nested
 *  node_modules without adding a new direct dependency. */
function anchoredResolve(packageName: string): string | undefined {
  try {
    const require = createRequire(import.meta.resolve("effect"))
    return require.resolve(packageName)
  } catch {
    return undefined
  }
}

async function loadYaml(): Promise<YamlModule | null> {
  if (yamlModule !== undefined) return yamlModule
  const resolved = anchoredResolve("yaml")
  if (!resolved) {
    yamlModule = null
    return null
  }
  try {
    yamlModule = (await import(pathToFileURL(resolved).href)) as YamlModule
  } catch {
    yamlModule = null
  }
  return yamlModule
}

async function loadToml(): Promise<TomlModule | null> {
  if (tomlModule !== undefined) return tomlModule
  const resolved = anchoredResolve("toml")
  if (!resolved) {
    tomlModule = null
    return null
  }
  try {
    tomlModule = (await import(pathToFileURL(resolved).href)) as TomlModule
  } catch {
    tomlModule = null
  }
  return tomlModule
}

function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.substring(0, offset).split("\n")
  return { line: before.length, column: before[before.length - 1]!.length + 1 }
}

function firstLine(message: string): string {
  return message.split("\n")[0]!.trim()
}

function parseJsoncOrThrow(text: string): void {
  const errors: ParseError[] = []
  parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length === 0) return
  const error = errors[0]!
  const position = positionOf(text, error.offset)
  throw new Error(
    `invalid JSON/JSONC at line ${position.line}, column ${position.column}: ${printParseErrorCode(error.error)}`,
  )
}

function parseYamlOrThrow(yaml: YamlModule, text: string): void {
  const document = yaml.parseDocument(text)
  if (document.errors.length === 0) return
  const error = document.errors[0]!
  const position = error.linePos?.[0]
  const where = position ? ` at line ${position.line}, column ${position.col}` : ""
  throw new Error(`invalid YAML${where}: ${firstLine(error.message)}`)
}

function parseTomlOrThrow(toml: TomlModule, text: string): void {
  try {
    toml.parse(text)
  } catch (error: any) {
    const line = typeof error?.line === "number" ? error.line : undefined
    const column = typeof error?.column === "number" ? error.column : undefined
    const where = line !== undefined ? ` at line ${line}${column !== undefined ? `, column ${column}` : ""}` : ""
    const detail = firstLine(String(error?.message ?? error))
    throw new Error(`invalid TOML${where}: ${detail}`)
  }
}

export type SyntaxGateResult = {
  /** True when the original and candidate were both parsed. */
  checked: boolean
  /** Set when the extension has a gate but its parser could not be loaded. */
  skipped?: string
}

/** Validate a candidate edit. Throws when the original parsed and the candidate
 *  does not. Returns a skip note when the parser is unavailable. */
export async function validateEditSyntax(
  filePath: string,
  original: string | null,
  next: string,
): Promise<SyntaxGateResult> {
  if (process.env.OC_DISABLE_EDIT_SYNTAX_GATE === "1") return { checked: false }
  if (original === null) return { checked: false }

  const extension = path.extname(filePath).toLowerCase()
  if (![".json", ".jsonc", ".yaml", ".yml", ".toml"].includes(extension)) return { checked: false }

  const parse = async (text: string): Promise<void> => {
    if (extension === ".json" || extension === ".jsonc") {
      parseJsoncOrThrow(text)
      return
    }
    if (extension === ".yaml" || extension === ".yml") {
      const yaml = await loadYaml()
      if (!yaml) throw new ParserUnavailable("yaml")
      parseYamlOrThrow(yaml, text)
      return
    }
    const toml = await loadToml()
    if (!toml) throw new ParserUnavailable("toml")
    parseTomlOrThrow(toml, text)
  }

  let originalParsed = true
  try {
    await parse(original)
  } catch (error) {
    if (error instanceof ParserUnavailable) {
      return { checked: false, skipped: `${error.packageName} parser unavailable` }
    }
    originalParsed = false
  }
  if (!originalParsed) return { checked: false }

  try {
    await parse(next)
  } catch (error) {
    if (error instanceof ParserUnavailable) {
      return { checked: false, skipped: `${error.packageName} parser unavailable` }
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Edit rejected: it would produce invalid ${extension.slice(1).toUpperCase()} in ${filePath} (${detail}). ` +
        "The original file parsed, so the candidate was checked before writing. Fix the syntax and retry.",
    )
  }

  return { checked: true }
}

class ParserUnavailable extends Error {
  constructor(readonly packageName: string) {
    super(`${packageName} parser unavailable`)
  }
}
