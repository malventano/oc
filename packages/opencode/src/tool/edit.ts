// hashline edit tool: content-hash anchored file edits.
// Adapted from anomalyco/opencode feat/hashline-edit-experimental-v2 (hashline.ts,
// edit.ts rewrite), which was inspired by can1357/oh-my-pi hashline (MIT).
// Merged from the oc file_edit plugin tool (retired 2026-08-11): multi-file
// batch, cut/paste registers, boundary previews, summary mode, and
// insert-position warnings. Backups were intentionally NOT merged (hashline
// prevents corruption at the gate; omp ships none).

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
import { Config } from "../config/config"
import {
  HashlineEdit as HashlineEditZ,
  HashlineEditInput as HashlineEditInputZ,
  applyHashlineEdits,
  hashlineOnlyCreates,
  parseHashlineContent,
  serializeHashlineContent,
} from "./hashline"
import { remapEditsToCurrent } from "./hashline-recovery"
import { fileTag, invalidateSnapshot, mergeSeenLines, recordSnapshot, relocateSnapshot, snapshotOf } from "./hashline-store"
import { hashlineRef, parseHashlineRef } from "./hashline"

const MAX_DIAGNOSTICS_PER_FILE = 20
const HASHLINE_EDIT_MODE = "hashline"
const LEGACY_KEYS = ["oldString", "newString", "replaceAll"] as const
const UNSEEN_REVEAL_CAP = 20
const SUMMARY_DIFF_BYTES = 25 * 1024

const HashlineText = Schema.Union([Schema.String, Schema.Array(Schema.String)])

const HashlineEditSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("set_line"),
    line: Schema.String,
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("replace_lines"),
    start_line: Schema.String,
    end_line: Schema.String,
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("insert_after"),
    line: Schema.String,
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("insert_before"),
    line: Schema.String,
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("insert_between"),
    after_line: Schema.String,
    before_line: Schema.String,
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("append"),
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("prepend"),
    text: HashlineText,
  }),
  Schema.Struct({
    type: Schema.Literal("replace"),
    old_text: Schema.String,
    new_text: HashlineText,
    all: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("cut"),
    start_line: Schema.String,
    end_line: Schema.String,
    register: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("paste"),
    insert_after_line: Schema.optional(Schema.String),
    insert_before_line: Schema.optional(Schema.String),
    register: Schema.optional(Schema.String),
  }),
])

const SectionSchema = Schema.Struct({
  filePath: Schema.String,
  edits: Schema.optional(Schema.Array(HashlineEditSchema)),
  delete: Schema.optional(Schema.Boolean),
  rename: Schema.optional(Schema.String),
})

export const Parameters = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({
    description: "The absolute path to the file to modify (omit when using files: batch mode)",
  }),
  edits: Schema.optional(Schema.Array(HashlineEditSchema)).annotate({
    description:
      "Hashline edit operations. Use strict LINE#ID anchor references from Read output. Required per file (use [] when only delete or rename is intended).",
  }),
  delete: Schema.optional(Schema.Boolean).annotate({ description: "Delete the file (cannot be combined with edits or rename)" }),
  rename: Schema.optional(Schema.String).annotate({ description: "Rename/move the file to this path (edits land on the source first)" }),
  files: Schema.optional(Schema.Array(SectionSchema)).annotate({
    description:
      "Multi-file batch mode: apply edits across multiple files atomically (all validated before any write). Registers captured with cut in one section can be pasted in later sections. Mutually exclusive with filePath/edits.",
  }),
})

type EditOp = Schema.Schema.Type<typeof HashlineEditSchema>
type CutOp = Extract<EditOp, { type: "cut" }>
type PasteOp = Extract<EditOp, { type: "paste" }>

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = FSUtil.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
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

/**
 * Annotate the added lines of a unified diff with their post-edit LINE#ID
 * refs so the model can chain the next edit from the response without
 * re-reading. Metadata diffs stay clean for the TUI; only the output body
 * is annotated.
 */
export function annotateDiff(diff: string): string {
  const out: string[] = []
  let newLine = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) newLine = Number(match[2])
      out.push(line)
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1)
      out.push(`+${hashlineRef(newLine, content)}:${content}`)
      newLine += 1
      continue
    }
    if (line.startsWith(" ")) {
      newLine += 1
      out.push(line)
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      formatValidationError: (error: unknown) => {
        const message = String(error)
        const legacy = LEGACY_KEYS.filter((key) => message.includes(key))
        if (legacy.length > 0) {
          return "Legacy edit payload has been removed. Use hashline fields: { filePath, edits, delete?, rename? } or files: [...] for batch mode."
        }
        return `Invalid parameters for tool 'edit': ${message}`
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sections = parseSections(params)

          const conf = yield* config.get()
          const autocorrect = conf.experimental?.hashline_autocorrect !== false || Bun.env.OPENCODE_HL_AUTOCORRECT === "1"
          const aggressiveAutocorrect = Bun.env.OPENCODE_HL_AUTOCORRECT === "1"
          const enforceSeenLines = conf.experimental?.hashline_seen_lines !== false

          const instance = yield* InstanceState.context
          const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(instance.directory, p))

          const registers = new Map<string, string[]>()
          let anonymousRegister: string[] | undefined

          type Planned = {
            section: (typeof sections)[number]
            sourcePath: string
            targetPath: string
            exists: boolean
            before: string
            after: string
            bytes: Uint8Array
            diff: string
            annotations: string[]
            freshTag: string
            recoveryWarning: string
            noop: boolean
            deleted: boolean
            changed: boolean
            lineCounts: { old: number; new: number }
          }

          const planned: Planned[] = []
          for (const section of sections) {
            const sourcePath = resolvePath(section.filePath)
            const targetPath = section.rename ? resolvePath(section.rename) : sourcePath
            const edits = HashlineEditInputZ.array().parse(section.edits)

            yield* assertExternalDirectoryEffect(ctx, sourcePath)
            if (section.rename) yield* assertExternalDirectoryEffect(ctx, targetPath)

            if (section.delete && edits.length > 0) throw new Error("delete=true cannot be combined with edits")
            if (section.delete && section.rename) throw new Error("delete=true cannot be combined with rename")

            const plan = yield* Effect.gen(function* () {
              const info = yield* afs.stat(sourcePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (info?.type === "Directory") throw new Error(`Path is a directory, not a file: ${sourcePath}`)
              const exists = Boolean(info)

              if (section.rename && !exists) throw new Error("rename requires an existing source file")

              if (section.delete) {
                if (!exists) return yield* Effect.succeed(noopPlan(sourcePath, targetPath))
                const source = yield* BomRead(afs, sourcePath)
                const before = source.text
                const diff = trimDiff(createTwoFilesPatch(sourcePath, sourcePath, normalizeLineEndings(before), ""))
                return yield* Effect.succeed({
                  section,
                  sourcePath,
                  targetPath,
                  exists,
                  before,
                  after: "",
                  bytes: new Uint8Array(),
                  diff,
                  annotations: [] as string[],
                  freshTag: "",
                  recoveryWarning: "",
                  noop: false,
                  deleted: true,
                  changed: true,
                  lineCounts: { old: splitTextLines(before).length, new: 0 },
                })
              }

              if (!exists) {
                const gone = snapshotOf(sourcePath)
                if (gone && !hashlineOnlyCreates(edits)) {
                  throw new Error(
                    `File was deleted since your read (tag #${gone.tag}); it can only be recreated with append/prepend hashline edits.`,
                  )
                }
                if (!hashlineOnlyCreates(edits)) {
                  throw new Error("Missing file can only be created with append/prepend hashline edits")
                }
              }

              const parsed = exists
                ? parseHashlineContent(Buffer.from(yield* afs.readFile(sourcePath)))
                : {
                    bom: false,
                    eol: "\n" as const,
                    trailing: false,
                    lines: [] as string[],
                    text: "",
                    raw: "",
                  }

              const expanded = expandRegisters(edits, parsed.lines, registers, anonymousRegister)
              if (expanded.anonymous) anonymousRegister = expanded.anonymous
              for (const [name, content] of expanded.registers) registers.set(name, content)
              const expandedEdits = expanded.edits

              let appliedEdits = expandedEdits
              let recoveryWarning = ""

              if (exists) {
                const snapshot = snapshotOf(sourcePath)
                const liveTag = fileTag(parsed.text)
                if (snapshot && snapshot.tag === liveTag) {
                  if (enforceSeenLines) {
                    const unseen = unseenReferencedLines(appliedEdits, snapshot.seenLines)
                    if (unseen.length > 0) {
                      const reveal = unseen
                        .slice(0, UNSEEN_REVEAL_CAP)
                        .map((n) => ({ line: n, text: parsed.lines[n - 1] ?? "" }))
                      mergeSeenLines(sourcePath, reveal.map((r) => r.line))
                      throw new Error(unseenLinesMessage(sourcePath, snapshot.tag, unseen, reveal))
                    }
                  }
                } else if (snapshot) {
                  const oldLines = splitTextLines(snapshot.content)
                  const remapped = remapEditsToCurrent(appliedEdits, oldLines, parsed.lines)
                  if (remapped) {
                    appliedEdits = remapped
                    recoveryWarning =
                      "\n\nWarning: file changed since your read; anchors were remapped through unchanged lines. Re-read for fresh anchors if you continue editing."
                  }
                }
                // No snapshot (e.g. after a restart): validate anchors against
                // live content on the fly — a matching hash is direct proof the
                // file is unchanged since the agent's read.
              }

              const before = parsed.text
              const next = applyHashlineEdits({
                lines: parsed.lines,
                trailing: parsed.trailing,
                edits: appliedEdits,
                autocorrect,
                aggressiveAutocorrect,
              })
              const output = serializeHashlineContent({
                lines: next.lines,
                trailing: next.trailing,
                eol: parsed.eol,
                bom: parsed.bom,
              })
              const after = output.text.startsWith("\uFEFF") ? output.text.slice(1) : output.text
              const noop = before === after && sourcePath === targetPath

              const diff = trimDiff(
                createTwoFilesPatch(
                  sourcePath,
                  targetPath,
                  normalizeLineEndings(before),
                  normalizeLineEndings(after),
                ),
              )
              const freshTag = noop ? fileTag(after) : fileTag(after)
              const annotations = boundaryAnnotations(appliedEdits, parsed.lines)

              return yield* Effect.succeed({
                section,
                sourcePath,
                targetPath,
                exists,
                before,
                after,
                bytes: output.bytes,
                diff,
                annotations,
                freshTag,
                recoveryWarning,
                noop,
                deleted: false,
                changed: !noop,
                lineCounts: { old: parsed.lines.length, new: next.lines.length },
              })
            }).pipe(Effect.orDie)

            planned.push(plan)
          }

          // All sections preflighted successfully (atomic) — commit phase.
          for (const plan of planned) {
            yield* withPermitsAll([plan.sourcePath, plan.targetPath], () =>
              Effect.gen(function* () {
                if (plan.deleted) {
                  if (plan.noop) return
                  yield* ctx.ask({
                    permission: "edit",
                    patterns: [path.relative(instance.worktree, plan.sourcePath)],
                    always: ["*"],
                    metadata: { filepath: plan.sourcePath, diff: plan.diff },
                  })
                  yield* afs.remove(plan.sourcePath)
                  invalidateSnapshot(plan.sourcePath)
                  yield* events.publish(FileSystem.Event.Edited, { file: plan.sourcePath })
                  yield* events.publish(Watcher.Event.Updated, { file: plan.sourcePath, event: "unlink" })
                  return
                }

                if (!plan.changed) {
                  if (plan.freshTag) recordSnapshot(plan.sourcePath, plan.after, allSeenLines(plan.after))
                  return
                }

                yield* ctx.ask({
                  permission: "edit",
                  patterns: Array.from(
                    new Set([
                      path.relative(instance.worktree, plan.sourcePath),
                      ...(plan.sourcePath !== plan.targetPath
                        ? [path.relative(instance.worktree, plan.targetPath)]
                        : []),
                    ]),
                  ),
                  always: ["*"],
                  metadata: { filepath: plan.sourcePath, diff: plan.diff },
                })

                if (plan.sourcePath === plan.targetPath) {
                  yield* afs.writeWithDirs(plan.sourcePath, plan.bytes)
                  if (yield* format.file(plan.sourcePath)) {
                    plan.after = yield* readTextAfterWrite(afs, plan.sourcePath)
                  }
                  plan.freshTag = fileTag(plan.after)
                  recordSnapshot(plan.sourcePath, plan.after, allSeenLines(plan.after))
                  yield* events.publish(FileSystem.Event.Edited, { file: plan.sourcePath })
                  yield* events.publish(Watcher.Event.Updated, {
                    file: plan.sourcePath,
                    event: plan.exists ? "change" : "add",
                  })
                  return
                }

                const targetExists = yield* afs.existsSafe(plan.targetPath)
                yield* afs.writeWithDirs(plan.targetPath, plan.bytes)
                yield* afs.remove(plan.sourcePath)
                relocateSnapshot(plan.sourcePath, plan.targetPath)
                plan.freshTag = fileTag(plan.after)
                recordSnapshot(plan.targetPath, plan.after, allSeenLines(plan.after))
                yield* events.publish(FileSystem.Event.Edited, { file: plan.sourcePath })
                yield* events.publish(FileSystem.Event.Edited, { file: plan.targetPath })
                yield* events.publish(Watcher.Event.Updated, { file: plan.sourcePath, event: "unlink" })
                yield* events.publish(Watcher.Event.Updated, {
                  file: plan.targetPath,
                  event: targetExists ? "change" : "add",
                })
              }).pipe(Effect.orDie),
            )
          }

          const diagnostics = yield* lsp.diagnostics()
          let additions = 0
          let deletions = 0
          const file = planned[0]
          const firstChanged = planned.find((p) => p.changed) ?? planned[0]
          const diffs = planned.map((p) => p.diff).filter((d) => d.length > 0)
          for (const change of diffLines(planned.map((p) => p.before).join("\n"), planned.map((p) => p.after).join("\n"))) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: firstChanged.targetPath,
            patch: diffs.join("\n"),
            additions,
            deletions,
          }

          const metadata = {
            diagnostics,
            diff: diffs.join("\n"),
            filediff,
            edit_mode: HASHLINE_EDIT_MODE,
            noop: planned.every((p) => p.noop) ? 1 : 0,
          }
          yield* ctx.metadata({ metadata })

          const anyDeleted = planned.some((p) => p.deleted)
          const anyChanged = planned.some((p) => p.changed)
          const body = buildOutputBody(planned)
          let output = ""
          if (anyDeleted) {
            output = `Edit applied successfully. (Deleted ${planned.length} file${planned.length > 1 ? "s" : ""}.)`
          } else {
            const header = file.freshTag
              ? `[${path.basename(file.sourcePath)}#${file.freshTag}]`
              : `[${path.basename(file.sourcePath)}#${fileTag(file.after || file.before)}]`
            output = header
            if (anyChanged) output += `\n${body}\n\nEdit applied successfully.`
            else output += `\nNo changes applied.`
          }
          const normalizedFilePath = FSUtil.normalizePath(firstChanged.targetPath)
          const block = LSP.Diagnostic.report(firstChanged.targetPath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: { ...metadata, diagnostics },
            title: path.relative(instance.worktree, file.sourcePath),
            output,
          }
        }),
    }
  }),
)

function parseSections(params: Schema.Schema.Type<typeof Parameters>) {
  const batch = params.files
  const single = params.filePath !== undefined || params.edits !== undefined || params.delete !== undefined || params.rename !== undefined
  if (batch && single) {
    throw new Error("Cannot mix filePath/edits with files: batch mode. Use either single-file or files: [...].")
  }
  if (batch) {
    return batch.map((b) => {
      if (b.edits === undefined && !b.delete && !b.rename) {
        throw new Error(
          `Hashline payload requires at least one of edits/delete/rename per files section (missing for ${b.filePath}). Use edits: [] for delete/rename-only.`,
        )
      }
      return { ...b, edits: b.edits ?? [] }
    })
  }
  if (!params.filePath) throw new Error("filePath is required")
  if (params.edits === undefined && !params.delete && !params.rename) {
    throw new Error(
      "Hashline payload requires edits (use [] when only delete or rename is intended). Legacy oldString/newString payloads are no longer supported; use hashline edit ops with LINE#ID anchors from Read output.",
    )
  }
  return [{ filePath: params.filePath, edits: params.edits ?? [], delete: params.delete, rename: params.rename }]
}

function noopPlan(sourcePath: string, targetPath: string) {
  return {
    section: { filePath: sourcePath, edits: [] as EditOp[] },
    sourcePath,
    targetPath,
    exists: false,
    before: "",
    after: "",
    bytes: new Uint8Array(),
    diff: "",
    annotations: [] as string[],
    freshTag: "",
    recoveryWarning: "",
    noop: true,
    deleted: false,
    changed: false,
    lineCounts: { old: 0, new: 0 },
  }
}

/**
 * Resolve cut/paste register ops into plain hashline ops. Cut captures the
 * original range (before line shifts) and becomes a replace_lines delete;
 * paste expands to an insert op carrying the captured text. Registers are
 * payload-scoped and persist across batch sections.
 */
function expandRegisters(
  edits: HashlineEditInputZ[],
  lines: string[],
  registers: Map<string, string[]>,
  anonymous: string[] | undefined,
): { edits: HashlineEditZ[]; registers: Map<string, string[]>; anonymous: string[] | undefined } {
  const out: HashlineEditZ[] = []
  const newRegisters = new Map(registers)
  let newAnonymous = anonymous
  for (const edit of edits) {
    if (edit.type === "cut") {
      const start = parseHashlineRef(edit.start_line, "cut.start_line")
      const end = parseHashlineRef(edit.end_line, "cut.end_line")
      if (start.line > end.line) throw new Error("cut.start_line must be less than or equal to cut.end_line")
      const captured = lines.slice(start.line - 1, end.line)
      if (edit.register) newRegisters.set(edit.register, captured)
      else newAnonymous = captured
      out.push({
        type: "replace_lines",
        start_line: edit.start_line,
        end_line: edit.end_line,
        text: [],
      })
      continue
    }
    if (edit.type === "paste") {
      const content = edit.register ? newRegisters.get(edit.register) : newAnonymous
      if (content === undefined) {
        throw new Error(
          edit.register
            ? `paste.register @${edit.register} has no matching cut in this payload (registers are payload-scoped)`
            : "paste requires a prior cut in this payload (or use a named register)",
        )
      }
      const after = edit.insert_after_line
      const before = edit.insert_before_line
      if (after === undefined && before === undefined) {
        throw new Error("paste requires insert_after_line or insert_before_line")
      }
      if (after !== undefined && before !== undefined) {
        throw new Error("paste cannot have both insert_after_line and insert_before_line")
      }
      if (after !== undefined) {
        out.push({ type: "insert_after", line: after, text: [...content] })
      } else {
        out.push({ type: "insert_before", line: before!, text: [...content] })
      }
      continue
    }
    out.push(edit)
  }
  return { edits: out, registers: newRegisters, anonymous: newAnonymous }
}

function boundaryAnnotations(edits: HashlineEditZ[], lines: string[]) {
  const out: string[] = []
  for (const edit of edits) {
    if (edit.type === "set_line") {
      const ref = parseHashlineRef(edit.line, "set_line.line")
      const text = lines[ref.line - 1] ?? ""
      out.push(`[set_line lines ${ref.line}-${ref.line}]\nfirst (${ref.line}): ${text}\nlast  (${ref.line}): ${text}`)
    } else if (edit.type === "replace_lines") {
      const start = parseHashlineRef(edit.start_line, "start_line")
      const end = parseHashlineRef(edit.end_line, "end_line")
      out.push(
        `[replace_lines lines ${start.line}-${end.line}]\nfirst (${start.line}): ${lines[start.line - 1] ?? ""}\nlast  (${end.line}): ${lines[end.line - 1] ?? ""}`,
      )
    }
  }
  return out
}

function buildOutputBody(planned: Array<{ diff: string; annotations: string[]; recoveryWarning: string; noop: boolean; lineCounts: { old: number; new: number }; sourcePath: string; freshTag: string }>) {
  const parts: string[] = []
  let bytes = 0
  for (const plan of planned) {
    const header = `*** ${plan.sourcePath} (${plan.lineCounts.old} \u2192 ${plan.lineCounts.new} lines)` + (plan.freshTag ? ` [#${plan.freshTag}]` : "")
    parts.push(header)
    bytes += header.length
    if (plan.annotations.length > 0 && !plan.noop) {
      parts.push(plan.annotations.join("\n"))
      bytes += plan.annotations.join("\n").length
    }
    if (!plan.noop && plan.diff) {
      const annotated = annotateDiff(plan.diff)
      parts.push(annotated)
      bytes += annotated.length
    }
    if (plan.recoveryWarning) {
      parts.push(plan.recoveryWarning.trim())
    }
  }
  if (bytes > SUMMARY_DIFF_BYTES) {
    return (
      parts
        .filter((p) => p.startsWith("***"))
        .join("\n") +
      `\n(diff body ${bytes} bytes > ${SUMMARY_DIFF_BYTES} byte summary threshold; full diffs omitted. Re-run a targeted edit for details.)`
    )
  }
  return parts.join("\n")
}

function withPermitsAll(paths: string[], fn: () => Effect.Effect<void>) {
  const unique = Array.from(new Set(paths.map((p) => FSUtil.resolve(p)))).sort((a, b) => a.localeCompare(b))
  const recurse = (idx: number): Effect.Effect<void> => {
    if (idx >= unique.length) return fn()
    return lock(unique[idx]).withPermits(1)(recurse(idx + 1))
  }
  return recurse(0)
}

function BomRead(afs: FSUtil.Interface, filePath: string) {
  return Effect.gen(function* () {
    const bytes = yield* afs.readFile(filePath)
    const raw = Buffer.from(bytes).toString("utf8")
    const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw
    return { text, bom: raw.startsWith("\uFEFF") }
  })
}

function readTextAfterWrite(afs: FSUtil.Interface, filePath: string) {
  return Effect.gen(function* () {
    const bytes = yield* afs.readFile(filePath)
    return Buffer.from(bytes).toString("utf8")
  })
}

function splitTextLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split(/\r?\n/)
  if (text.endsWith("\n")) lines.pop()
  return lines
}

function allSeenLines(text: string): number[] {
  const count = splitTextLines(text).length
  return Array.from({ length: count }, (_, i) => i + 1)
}

function unseenReferencedLines(edits: HashlineEditZ[], seenLines: Set<number>): number[] {
  const referenced = new Set<number>()
  for (const edit of edits) {
    if (edit.type === "replace" || edit.type === "append" || edit.type === "prepend") continue
    if (edit.type === "set_line" || edit.type === "insert_after" || edit.type === "insert_before") {
      const ref = parseHashlineRef(edit.line, "line")
      referenced.add(ref.line)
    } else if (edit.type === "replace_lines") {
      referenced.add(parseHashlineRef(edit.start_line, "start_line").line)
      referenced.add(parseHashlineRef(edit.end_line, "end_line").line)
    } else {
      referenced.add(parseHashlineRef(edit.after_line, "after_line").line)
      referenced.add(parseHashlineRef(edit.before_line, "before_line").line)
    }
  }
  return [...referenced].filter((line) => !seenLines.has(line)).sort((a, b) => a - b)
}

function unseenLinesMessage(
  filePath: string,
  tag: string,
  unseen: number[],
  reveal: Array<{ line: number; text: string }>,
): string {
  const ranges: string[] = []
  let start = unseen[0]
  let prev = unseen[0]
  for (let i = 1; i <= unseen.length; i++) {
    const current = unseen[i]
    if (current === prev + 1) {
      prev = current
      continue
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = current
    prev = current
  }
  const linesOut = [
    `Hashline edit rejected: lines ${ranges.join(", ")} were never displayed by your latest read/search of ${filePath} (tag #${tag}).`,
    `Only displayed lines are editable. Re-read the range, or retry with the actual content below:`,
    ...reveal.map((r) => `  ${r.line}: ${r.text}`),
  ]
  if (reveal.length < unseen.length) {
    linesOut.push(`  ... and ${unseen.length - reveal.length} more lines`)
  }
  return linesOut.join("\n")
}
