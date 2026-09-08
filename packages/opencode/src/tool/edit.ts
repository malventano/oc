// oc fork of the upstream v1.18.27 JSON edit tool (flat {filePath, oldString,
// newString, replaceAll}), restored by patch 0323 (the JSON switch) with the oc
// railings re-layered on top:
//   - 0213 diffPatch                thin 1-line hunk context for long-line files
//   - 0301 rebaseIndentation        tolerance-match indentation adoption + ladder echo
//   - 0116/0120 post-write stat     fileDelta staleness contract
//   - files[]/paths/noop metadata   the oc TUI per-file diff view + changed-lines echo
// The retired fence text-grammar method is archived at
// /root/oc/opencode/archive/retired-edit-fence/ (recoverable from git 2cd4d1a9a1).

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let rebased = 0
          let tierNote: string | undefined
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              if (params.oldString === "") {
                // New-file create (upstream semantics): oldString empty = the
                // file does not exist yet (or was deleted).
                const existed = yield* afs.existsSafe(filePath)
                if (existed) {
                  throw new Error(
                    "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
                  )
                }
                const next = Bom.split(params.newString)
                const desiredBom = next.bom
                contentOld = ""
                contentNew = next.text
                diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }
                yield* events.publish(FileSystem.Event.Edited, { file: filePath })
                yield* events.publish(Watcher.Event.Updated, {
                  file: filePath,
                  event: "add",
                })
                return
              }

              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              const ending = detectLineEnding(contentOld)
              const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
              const replacement = convertToLineEnding(normalizeLineEndings(params.newString), ending)

              // 0301/0131: replaceOutcome does the upstream tolerance ladder
              // AND rebases NEW's leading whitespace onto the matched file
              // region whenever a non-byte-exact tier matched (the tier
              // ladder cannot see whitespace - without the rebase a model
              // mis-copying the region indent lands its drift verbatim).
              const outcome = replaceOutcome(contentOld, old, replacement, params.replaceAll)
              rebased = outcome.rebased
              if (outcome.tier !== "Simple" && !params.replaceAll) {
                tierNote = `oldString matched via ${outcome.tier} at line ${lineOf(outcome.spanIndex, contentOld)}`
              }

              const next = Bom.split(outcome.text)
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              diff = diffPatch(filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew))
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              diff = diffPatch(filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew))
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const noop = contentOld === contentNew

          // 0116/0120: post-write stat so session self-edits are never
          // re-reminded by the read-staleness walk (integer-ms convention).
          const postStat = yield* Effect.tryPromise(() =>
            import("fs/promises").then((m) => m.stat(filePath)),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)))

          const relativePath = path.relative(instance.worktree, filePath).replaceAll("\\", "/")
          const fileDiff = {
            filePath,
            relativePath,
            type: "edit" as const,
            changed: !noop,
            patch: diff,
            additions,
            deletions,
            movePath: undefined as string | undefined,
            stat: postStat
              ? { mtimeMs: Math.trunc(postStat.mtimeMs), size: postStat.size }
              : undefined,
          }
          const fileDiffs = fileDiff.patch.length > 0 ? [fileDiff] : []

          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          const metadata = {
            diagnostics: {} as Record<string, unknown>,
            diff,
            filediff,
            files: fileDiffs,
            paths: [filePath],
            noop: noop ? 1 : 0,
          }
          yield* ctx.metadata({ metadata })

          let output = "Edit applied successfully."
          // Changed-lines echo (0160/0257): the changed line ranges derived
          // from the actual line diff - the one thing the model needs to
          // know on the success path. A deletion-only change must report the
          // deleted lines' OLD positions, never collapse to "no change".
          if (!noop) {
            const ranges = changedPositions(contentOld, contentNew)
            const counts = `(+${additions}/-${deletions})`
            const label = ranges.length > 0 ? `${ranges.join(", ")} ${counts}` : counts
            output += `\nChanged lines: ${relativePath}: ${label}`
          }
          if (tierNote) {
            output += `\nMatched with tolerance (not byte-exact): ${tierNote}`
            output += `\nApplied change:\n${diff}`
          }
          if (rebased > 0) {
            output += `\nIndentation note: ${rebased} line(s) adopted the file's leading whitespace (the match tolerated a block whose indent differed from the file)`
          }
          if (noop) {
            output += `\nNo net change for ${relativePath}: the edit applied but produced no difference on disk (typically a whitespace-only intent that the indentation note adopted at the file's indent). To change indentation deliberately, change content too, or use a single-line replacement.`
          }

          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
              files: fileDiffs,
              paths: [filePath],
              noop: noop ? 1 : 0,
            },
            title: `${relativePath}`,
            output,
          }
        }),
    }
  }),
)

// ---------------------------------------------------------------------------
// 0213 diffPatch - thin the jsdiff hunk context for long-line files (generated
// bundles, config dumps, single-line tool code) so a small edit is not buried
// under near-full-width context rows.
const LONG_LINE_CONTEXT_CUTOFF = 100

function isLongLineFile(text: string): boolean {
  let longest = 0
  for (const line of text.split("\n")) {
    if (line.length > longest) longest = line.length
  }
  return longest > LONG_LINE_CONTEXT_CUTOFF
}

export function diffPatch(name: string, before: string, after: string): string {
  const old = normalizeLineEndings(before)
  const novo = normalizeLineEndings(after)
  const patch = trimDiff(createTwoFilesPatch(name, name, old, novo))
  if (patch && isLongLineFile(old)) {
    return trimDiff(createTwoFilesPatch(name, name, old, novo, "", "", { context: 1 }))
  }
  return patch
}

// ---------------------------------------------------------------------------
// 0301 rebaseIndentation + leadingWhitespace (ported from string-match.ts,
// which was retired with the fence). On a same-line-count (>=2) replacement,
// each non-empty NEW line adopts the FILE region line's leading whitespace;
// a uniform deliberate whole-block re-indent is preserved.
function leadingWhitespace(line: string): string {
  const m = line.match(/^[ \t]*/)
  return m ? m[0] : ""
}

export function rebaseIndentation(
  matched: string,
  oldText: string,
  newText: string,
): { text: string; rebased: number } {
  const matchedLines = matched.split("\n")
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")

  if (matchedLines.length < 2 || matchedLines.length !== newLines.length) {
    return { text: newText, rebased: 0 }
  }

  const inds: number[] = []
  for (let i = 0; i < newLines.length; i++) {
    if (i < oldLines.length && newLines[i].trim().length > 0) {
      if (matchedLines[i].trim().length > 0 && oldLines[i].trim().length > 0) inds.push(i)
    }
  }
  if (inds.length === 0) return { text: newText, rebased: 0 }

  const deltas = new Set<number>()
  let oldAccurate = true
  for (const i of inds) {
    deltas.add(leadingWhitespace(newLines[i]).length - leadingWhitespace(matchedLines[i]).length)
    if (leadingWhitespace(oldLines[i]) !== leadingWhitespace(matchedLines[i])) oldAccurate = false
  }
  if (deltas.size === 1 && !deltas.has(0) && oldAccurate) return { text: newText, rebased: 0 }

  let rebased = 0
  for (const i of inds) {
    const fileLead = leadingWhitespace(matchedLines[i])
    const newLead = leadingWhitespace(newLines[i])
    if (newLead !== fileLead) {
      newLines[i] = fileLead + newLines[i].slice(newLead.length)
      rebased++
    }
  }
  return { text: newLines.join("\n"), rebased }
}

function lineOf(index: number, content: string): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++
  }
  return line
}

// ---------------------------------------------------------------------------
// The upstream 9-tier matching ladder (v1.18.27 machinery) + 0131
// ladder-fire echo (tier + the applied change) + 0301 rebase.
export type ReplaceOutcome = {
  text: string
  tier: string
  rebased: number
  spanIndex: number
}

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break
      }
    }
  }

  if (candidates.length === 0) {
    return
  }

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    return
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    return
  }

  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

// The enhanced replace: upstream semantics + 0131 ladder-fire echo + 0301
// rebase. `replace` below is the thin upstream-signature wrapper (kept for
// upstream test compatibility); the tool path uses `replaceOutcome`.
export function replaceOutcome(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ReplaceOutcome {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    )
  }

  let notFound = true

  for (const [tier, replacer] of [
    ["Simple", SimpleReplacer],
    ["LineTrimmed", LineTrimmedReplacer],
    ["BlockAnchor", BlockAnchorReplacer],
    ["WhitespaceNormalized", WhitespaceNormalizedReplacer],
    ["IndentationFlexible", IndentationFlexibleReplacer],
    ["EscapeNormalized", EscapeNormalizedReplacer],
    ["TrimmedBoundary", TrimmedBoundaryReplacer],
    ["ContextAware", ContextAwareReplacer],
    ["MultiOccurrence", MultiOccurrenceReplacer],
  ] as Array<[string, Replacer]>) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        )
      }
      // 0301: on a tolerance (non-byte-exact) match, rebase NEW's leading
      // whitespace onto the matched FILE region's indent (the ladder cannot
      // see whitespace - without this a model mis-copying the region indent
      // into OLD+NEW lands its drift verbatim).
      let replacement = newString
      let rebased = 0
      if (search !== oldString) {
        const rb = rebaseIndentation(search, oldString, newString)
        replacement = rb.text
        rebased = rb.rebased
      }
      if (replaceAll) {
        return { text: content.replaceAll(search, replacement), tier, rebased, spanIndex: 0 }
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return {
        text: content.substring(0, index) + replacement + content.substring(index + search.length),
        tier,
        rebased,
        spanIndex: index,
      }
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return replaceOutcome(content, oldString, newString, replaceAll).text
}

function isDisproportionateMatch(search: string, oldString: string) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

// Changed-position walk over the actual line diff (the patch hunks carry diff
// context - a small file renders as one whole-file hunk, which would misreport
// the ranges). Additions report their NEW positions, removals their OLD; a
// removal followed by an addition (before the next context) is a REPLACE and
// the addition reports the location. A pure deletion always reports the
// deleted lines' OLD positions (never collapses to "no change").
function changedPositions(before: string, after: string): string[] {
  const ranges: string[] = []
  const formatRange = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`)
  let newPos = 1
  let oldPos = 1
  const changes = diffLines(before, after)
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!
    const count = change.count ?? 1
    if (change.added) {
      ranges.push(formatRange(newPos, newPos + count - 1))
      newPos += count
    } else if (change.removed) {
      let j = i + 1
      while (j < changes.length && changes[j]!.removed) j++
      if (j < changes.length && changes[j]!.added) {
        oldPos += count
        continue
      }
      ranges.push(formatRange(oldPos, oldPos + count - 1))
      oldPos += count
    } else {
      newPos += count
      oldPos += count
    }
  }
  return ranges
}
