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
import { FOLDERS } from "@opencode-ai/core/filesystem/ignore"
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
import { type GrammarOp as GrammarOpT, type GrammarSection as GrammarSectionT, parsePatch } from "./grammar-patch"
import { remapEditsToCurrent } from "./hashline-recovery"
import { fileTag, invalidateSnapshot, mergeSeenLines, recordSnapshot, relocateSnapshot, snapshotOf } from "./hashline-store"
import { hashlineRef, parseHashlineRef } from "./hashline"

const MAX_DIAGNOSTICS_PER_FILE = 20
const HASHLINE_EDIT_MODE = "hashline"
const LEGACY_KEYS = ["oldString", "newString", "replaceAll"] as const
const UNSEEN_REVEAL_CAP = 20
const SUMMARY_DIFF_BYTES = 25 * 1024

export const Parameters = Schema.Struct({
  input: Schema.String.annotate({
    description:
      "The patch text: `*** Begin Patch` ... `*** End Patch` (see the tool description for the grammar).",
  }),
})

type EditOp = GrammarOpT

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
          return "Legacy edit payload has been removed. The edit tool now takes ONE argument: { input } containing a patch (`*** Begin Patch` ... `*** End Patch`). See the tool description for the grammar."
        }
        if (message.includes('"filePath"') || message.includes('"edits"') || message.includes('"files"')) {
          return "Legacy JSON edit payload has been removed. The edit tool now takes ONE argument: { input } containing a patch (`*** Begin Patch` ... `*** End Patch`). See the tool description for the grammar."
        }
        if (message.includes("Unexpected key")) {
          return `Invalid parameters for tool 'edit': only { input } is accepted - the patch grammar is passed as the input string.`
        }
        const truncated = message.length > 700 ? `${message.slice(0, 400)} ... [payload truncated] ... ${message.slice(-120)}` : message
        return `Invalid parameters for tool 'edit': ${truncated}`
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

         // Basename fallback: the read/success headers render `[basename#TAG]`
         // and models copy them into patch headers verbatim. Resolve a bare
         // basename by walking the worktree; the `#TAG` disambiguates
         // collisions (it is copied verbatim from the read output).
         const resolveSourcePath = (section: GrammarSectionT): Effect.Effect<string> =>
           Effect.gen(function* () {
             const direct = resolvePath(section.filePath)
             const info = yield* afs.stat(direct).pipe(Effect.catch(() => Effect.succeed(undefined)))
             if (info) return direct
             const bare = !section.filePath.includes("/") && !section.filePath.includes("\\")
             if (!bare) return direct
             const matches: string[] = []
             const walk = (dir: string, depth: number): Effect.Effect<void> => {
               if (depth > 12 || matches.length >= 32) return Effect.void
               return Effect.gen(function* () {
                 const entries = yield* afs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
                 for (const entry of entries) {
                   if (entry.type === "directory") {
           if (!FOLDERS.has(entry.name)) yield* walk(path.join(dir, entry.name), depth + 1)
                   } else if (entry.type === "file" && entry.name === section.filePath) {
                     matches.push(path.join(dir, entry.name))
                   }
                 }
               })
             }
             yield* walk(instance.directory, 0)
             if (matches.length === 0) return direct
             if (matches.length === 1) return matches[0]
             if (section.tag) {
               for (const m of matches) {
       const text = yield* afs.readFileStringSafe(m).pipe(Effect.catch(() => Effect.succeed(undefined)))
                 if (text !== undefined && fileTag(text) === section.tag) return m
               }
             }
             throw new Error(
               `Basename ${JSON.stringify(section.filePath)} is ambiguous (${matches.length} files match): ${matches.join(", ")}. Use the full path in the [PATH] section header.`,
             )
           })

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
           const sourcePath = yield* resolveSourcePath(section)
           const targetPath = section.rename
             ? path.isAbsolute(section.rename)
               ? section.rename
               : path.join(path.dirname(sourcePath), section.rename)
             : sourcePath
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
                 throw new Error(`Missing file (resolved to ${sourcePath}) can only be created with append/prepend hashline edits`)
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
                // live content on the fly - a matching hash is direct proof the
                // file is unchanged since the agent's read.
              }

              const before = parsed.text
              let next: ReturnType<typeof applyHashlineEdits>
              try {
                next = applyHashlineEdits({
                  lines: parsed.lines,
                  trailing: parsed.trailing,
                  edits: appliedEdits,
                  autocorrect,
                  aggressiveAutocorrect,
                })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (message.includes("anchor mismatch")) {
                  const hints: string[] = []
                  for (const op of edits) {
                    if (op.type !== "paste") continue
                    const register = op.register ?? ""
                    const cutInPayload = sections.some((s) =>
                      s.edits.some((e) => e.type === "cut" && (e.register ?? "") === register),
                    )
                    if (!cutInPayload) continue
                    const anchor = op.insert_after_line ?? op.insert_before_line ?? ""
                    const position = op.insert_after_line ? "insert_after_line" : "insert_before_line"
                    hints.push(
                      `\npaste (${register === "" ? "anonymous" : `@${register}`}) targets ${section.filePath} but its anchor (${anchor}) does not exist there. A paste lands in the file its section names; when the register was cut in this patch, give the paste its own [PATH] section targeting the destination file.`
                    )
                  }
                  if (hints.length > 0) throw new Error(`${message}${hints.join("")}`)
                }
                throw error
              }
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
              const annotations = [...boundaryAnnotations(appliedEdits, parsed.lines), ...next.notes]

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

          // All sections preflighted successfully (atomic) - commit phase.
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

         const fileDiffs = planned
           .map((p) => ({
             filePath: p.sourcePath,
             relativePath: path.relative(instance.worktree, p.targetPath).replaceAll("\\", "/"),
             type: p.deleted ? "delete" : p.section.rename ? "move" : "edit",
             patch: p.diff,
             additions: p.lineCounts.new - p.lineCounts.old,
             deletions: p.lineCounts.old - p.lineCounts.new,
             movePath: p.section.rename ? p.targetPath : undefined,
           }))
           .filter((f) => f.type === "delete" || f.patch.length > 0)
         const metadata = {
           diagnostics,
           diff: diffs.join("\n"),
           filediff,
           files: fileDiffs,
           edit_mode: HASHLINE_EDIT_MODE,
           noop: planned.every((p) => p.noop) ? 1 : 0,
           paths: planned.map((p) => p.targetPath),
         }
          yield* ctx.metadata({ metadata })

          const anyDeleted = planned.some((p) => p.deleted)
          const anyChanged = planned.some((p) => p.changed)
          const body = buildOutputBody(planned)
          let output = ""
          if (anyDeleted) {
           const deleted = planned.filter((p) => p.deleted).length
           const renamed = planned.filter((p) => p.section.rename).length
           const parts: string[] = []
           if (deleted > 0) parts.push(`deleted ${deleted} file${deleted > 1 ? "s" : ""}`)
           if (renamed > 0) parts.push(`renamed ${renamed} file${renamed > 1 ? "s" : ""}`)
           output = `Edit applied successfully. (${parts.join(", ")}.)`
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
  const parsed = parsePatch(params.input)
  if (!parsed.ok) {
    throw new Error(`Patch grammar error:\n- ${parsed.errors.join("\n- ")}\nFix the offending line and resend the FULL patch.`)
  }
  return parsed.files
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
           ? `paste.register @${edit.register} has no matching cut BEFORE this paste in the payload (registers are forward-only: CUT sections must precede the PASTE that uses them)`
           : "paste requires a prior cut BEFORE it in the payload (registers are forward-only; or use a named register)",
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
