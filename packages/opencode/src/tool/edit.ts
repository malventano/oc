// hashline edit tool: content-hash anchored file edits.
// Adapted from anomalyco/opencode feat/hashline-edit-experimental-v2 (hashline.ts,
// edit.ts rewrite), which was inspired by can1357/oh-my-pi hashline (MIT).
// Merged from the oc file_edit plugin tool (retired 2026-08-11): multi-file
// batch, cut/paste registers, boundary previews, summary mode, and
// insert-position warnings. Backups were intentionally NOT merged (hashline
// prevents corruption at the gate; omp ships none).

import * as NFS from "fs/promises"
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
import { diffLineRuns, remapEditsToCurrent, remappedAnchorsValidate, substituteSameLineAnchors } from "./hashline-recovery"
import {
  fileTag,
  hashlineHeaderPath,
  invalidateSnapshot,
  mergeSeenLines,
  recordSnapshot,
  relocateSnapshot,
  snapshotOf,
} from "./hashline-store"
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

// Strip the common leading indent of the unified diff body so the content
// is byte-identical to file content: annotateDiff hashes the lines to build
// LINE#ID refs, so any indent residue would yield wrong anchors.
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
          const indentHint = conf.experimental?.hashline_indent_hint !== false
          const indentAutofix = conf.experimental?.hashline_indent_autofix !== false
          // aggressiveAutocorrect (echo-stripping + rewrap restore) is env-
          // gated, not config-gated: it rewrites the model's payload and
          // must stay opt-in per-launch; basic autocorrect is the safe,
          // configurable default.

          const instance = yield* InstanceState.context
          const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(instance.directory, p))

        // Basename fallback: headers render `[PATH#TAG]` (relative to the
        // instance dir, or absolute for files outside it). Bare basenames
        // still occur in legacy/model-written headers - resolve them by
        // walking the worktree; the `#TAG` disambiguates collisions.
        const resolveSourcePath = (section: GrammarSectionT): Effect.Effect<string> =>
          Effect.gen(function* () {
            const direct = resolvePath(section.filePath)
            const info = yield* afs.stat(direct).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const bare = !section.filePath.includes("/") && !section.filePath.includes("\\")
            if (info && !section.tag) return direct
            let directTag: string | undefined
            if (info && section.tag) {
              const text = yield* afs.readFileStringSafe(direct).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (text !== undefined) {
                directTag = fileTag(text)
                if (directTag === section.tag) return direct
              }
            }
            if (!bare) {
              // Non-bare paths name a specific location; a tag mismatch here
              // means stale content (file changed since the read) - the
              // snapshot/remap and on-the-fly validation paths handle that.
              return direct
            }
            const matches: string[] = []
            const walk = (dir: string, depth: number): Effect.Effect<void> => {
              if (depth > 12 || matches.length >= 32) return Effect.void
              // Walk caps: 12 levels and 32 matches bound worst-case cost -
              // beyond them, ambiguity is unresolved and the caller errors.
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
            if (info && section.tag && directTag !== undefined) {
              // Bare basename + tag mismatch on the direct hit: the header
              // probably names a DIFFERENT file with the same basename (e.g.
              // a read of a file outside the project). Walk for the file
              // that actually carries the header tag.
              for (const m of matches) {
                const text = yield* afs.readFileStringSafe(m).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (text !== undefined && fileTag(text) === section.tag) return m
              }
              // The agent's own read of this exact path (snapshot present)
              // still means stale content, not a wrong file - the remap
              // machinery handles that.
              if (snapshotOf(direct)) return direct
              throw new Error(
                `Section header [${section.filePath}#${section.tag}] does not match ${direct} (tag #${directTag}), ` +
                  `and no file named ${section.filePath} under ${instance.directory} carries tag #${section.tag}. ` +
                  `The read that produced this header targeted a different path - copy the [PATH#TAG] header verbatim from a fresh read of that file.`,
              )
            }
            if (matches.length === 0) return direct
            if (matches.length === 1) {
              if (!section.tag) return matches[0]
              const text = yield* afs.readFileStringSafe(matches[0]).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (text !== undefined && fileTag(text) === section.tag) return matches[0]
              if (snapshotOf(matches[0])) return matches[0]
              throw new Error(
                `Section header [${section.filePath}#${section.tag}] resolves by name to ${matches[0]}, ` +
                  `but that file's tag is #${text === undefined ? "(unreadable)" : fileTag(text)} - it changed since the read that produced this header. ` +
                  `Re-read it for fresh anchors.`,
              )
            }
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
            changedLines: Map<number, string>
          }

          const planned: Planned[] = []
          // Chain later sections of the same path onto the previous section's
          // result. At preflight time nothing has been written yet, so each
          // section would otherwise re-read the original from disk and the
          // earlier sections would silently be discarded (last write wins).
          const plannedByPath = new Map<string, Planned>()
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
                  changedLines: new Map(),
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

              const prev = plannedByPath.get(sourcePath)
              const diskParsed = exists
                ? parseHashlineContent(Buffer.from(yield* afs.readFile(sourcePath)))
                : {
                    bom: false,
                    eol: "\n" as const,
                    trailing: false,
                    lines: [] as string[],
                    text: "",
                    raw: "",
                  }
              const parsed = prev ? parseHashlineContent(Buffer.from(prev.after)) : diskParsed

              // Hint-normalize BEFORE register expansion: paste content must
              // never be rewritten (cut/paste ops carry no text and are
              // skipped here). Anchor refs at this point match the read
              // output the model saw; chained sections are remapped later.
              if (indentHint) normalizeIndentToHint(edits, parsed.lines)

              const expanded = expandRegisters(edits, parsed.lines, registers, anonymousRegister)
              if (expanded.anonymous) anonymousRegister = expanded.anonymous
              for (const [name, content] of expanded.registers) registers.set(name, content)
              const expandedEdits = expanded.edits

              let appliedEdits = expandedEdits
              let recoveryWarning = ""
              if (section.parseNotes?.length) {
                recoveryWarning = `\n\n${section.parseNotes.join("\n")}`
              }

              if (exists) {
                const snapshot = snapshotOf(sourcePath)
                if (prev) {
                  // Chained section: the model's anchors refer to the read
                  // output (original content); remap them onto the previous
                  // section's result.
                  const oldLines = snapshot ? splitTextLines(snapshot.content) : diskParsed.lines
                  const remapped = remapEditsToCurrent(appliedEdits, oldLines, parsed.lines)
                  if (remapped) {
                    appliedEdits = remapped
                    recoveryWarning =
                      "\n\nWarning: section anchors were remapped onto the result of an earlier section of this patch."
                  }
                } else if (snapshot && snapshot.tag === fileTag(diskParsed.text)) {
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
                // 0113 stale-anchor recovery: the model's anchors can refer
                // to a state that is neither the current snapshot nor disk
                // (its own prior edit, or a parallel session's change).
                // Tier 1: line-shift remap from the PREVIOUS snapshot -
                // preserves content-position intent when lines MOVED (the
                // anchored line now lives elsewhere; same-line substitution
                // would hit whatever happens to sit there now). Accepted
                // only when every remapped anchor validates against live
                // content - fresh anchors from a post-shift read fail the
                // gate and fall through untouched.
                // Tier 2: same-line fresh-ID substitution (in-place content
                // changes at the same line number).
                // Anchors matching NO candidate (fabricated/guessed) keep
                // the mismatch error below; substituted/remapped IDs are
                // re-validated by applyHashlineEdits against live content
                // before any splice.
                if (snapshot) {
                  const prevLines = snapshot.previous ? splitTextLines(snapshot.previous.content) : undefined
                  let recovered = false
                  if (prevLines) {
                    const remapped = remapEditsToCurrent(appliedEdits, prevLines, parsed.lines)
                    if (remapped && remappedAnchorsValidate(remapped, parsed.lines)) {
                      appliedEdits = remapped
                      recoveryWarning +=
                        "\n\nWarning: anchors were remapped onto the current file (lines shifted since your read)."
                      recovered = true
                    }
                  }
                  if (!recovered) {
                    const sub = substituteSameLineAnchors(appliedEdits, [
                      parsed.lines,
                      splitTextLines(snapshot.content),
                      prevLines,
                    ])
                    if (sub && sub.substituted.length > 0) {
                      appliedEdits = sub.edits
                      recoveryWarning +=
                        `\n\nWarning: stale anchor${sub.substituted.length > 1 ? "s" : ""} substituted against current content (file changed since your read): ${sub.substituted.join(", ")}`
                    }
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
              // 0113 indent auto-fix: correct ±1 folds on lines the edit
              // actually changed (the separator-fold signature) at plan time
              // so the applied content, diff, and snapshot all carry the
              // corrected indent and the post-apply validator stays silent.
              if (indentAutofix) {
                const fixed = fixIndentFolds([...next.lines], before, next.changedLines, { filePath: sourcePath })
                if (fixed.fixed.length > 0) {
                  next.lines = fixed.lines
                  recoveryWarning += `\n\nIndent corrected (applied): ${fixed.fixed.join(", ")}`
                }
              }
              // 0117 duplicate-block detector: an edit that echoes existing
              // lines into a SET/REPLACE body duplicates adjacent content
              // (mangled replaces - the leading-echo strip only fires on
              // byte-equal prefixes). Compare the changed region against
              // `before`: a run of >= 2 adjacent identical lines that
              // existed in `before` and now appears twice in a row in the
              // result is the echo signature. High precision: only exact
              // multi-line runs, only when the run existed in before, and
              // only when the second copy sits in the edit's changed lines.
              const dupWarn = findEchoDuplicateRuns(
                before ? splitTextLines(before) : undefined,
                next.lines,
                next.changedLines,
              )
              if (dupWarn.length > 0) {
                recoveryWarning += `\n\nWarning: block duplicated at ${dupWarn
                .map((d) => `lines ${d.start + 1}-${d.end + 1} ("${d.pattern.trim()}" repeated)`)
                  .join(", ")} - the body echoed existing content; use CUT or narrow the range.`
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
              // noop implies before === after, so one tag covers both branches.
              const freshTag = fileTag(after)
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
                changedLines: next.changedLines,
              })
            }).pipe(Effect.orDie)

            planned.push(plan)
            if (!plan.deleted && plan.sourcePath === plan.targetPath) plannedByPath.set(plan.sourcePath, plan)
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

          // Post-write stat per written path, backing fileDelta staleness
          // detection: session self-edits are never re-reminded (the walk
          // treats the post-edit stat as the reported state), and external
          // changes after the edit diff against it. Stat AFTER the commit
          // phase so format re-writes are included.
          const writtenStats = new Map<string, { mtimeMs: number; size: number }>()
          for (const plan of planned) {
            if (plan.deleted || !plan.changed) continue
            const target = plan.targetPath
            if (writtenStats.has(target)) continue
            const st = yield* Effect.tryPromise(() => NFS.stat(target)).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (st) writtenStats.set(target, { mtimeMs: st.mtimeMs, size: st.size })
          }

          const diagnostics = yield* lsp.diagnostics()
          let additions = 0
          let deletions = 0

          // Group edit-type sections by source path so the TUI renders ONE
          // block per file even when a patch touches the same file in
          // multiple sections (e.g. a CUT+PASTE move or scattered
          // APPENDs). Sections still apply sequentially in patch order via
          // `planned`; the merged display view = first section's before,
          // last section's after, net line counts, final fresh tag.
          // File-level ops (delete/rename) stay per-section.
          const displayPlans: Planned[] = []
          {
            const byPath = new Map<string, Planned[]>()
            for (const p of planned) {
              if (p.deleted || p.section.rename) {
                displayPlans.push(p)
                continue
              }
              const g = byPath.get(p.sourcePath)
              if (g) g.push(p)
              else byPath.set(p.sourcePath, [p])
            }
            for (const g of byPath.values()) {
              if (g.length === 1) {
                displayPlans.push(g[0])
                continue
              }
              const first = g[0]
              const last = g[g.length - 1]
              displayPlans.push({
                ...first,
                after: last.after,
                freshTag: last.freshTag,
                changed: g.some((p) => p.changed),
                noop: !g.some((p) => p.changed),
                diff: trimDiff(
                  createTwoFilesPatch(
                    first.sourcePath,
                    first.targetPath,
                    normalizeLineEndings(first.before),
                    normalizeLineEndings(last.after),
                  ),
                ),
                lineCounts: { old: first.lineCounts.old, new: last.lineCounts.new },
              })
            }
          }

          const file = displayPlans[0]
          const firstChanged = displayPlans.find((p) => p.changed) ?? displayPlans[0]
          const diffs = planned.map((p) => p.diff).filter((d) => d.length > 0)
          for (const change of diffLines(
            displayPlans.map((p) => p.before).join("\n"),
            displayPlans.map((p) => p.after).join("\n"),
          )) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: firstChanged.targetPath,
            patch: diffs.join("\n"),
            additions,
            deletions,
          }

          const fileDiffs = displayPlans
            .map((p) => ({
              filePath: p.sourcePath,
              relativePath: path.relative(instance.directory, p.targetPath).replaceAll("\\", "/"),
              type: p.deleted ? "delete" : p.section.rename ? "move" : "edit",
              changed: !p.noop && p.before !== p.after,
              patch: p.diff,
              additions: Math.max(0, p.lineCounts.new - p.lineCounts.old),
              deletions: Math.max(0, p.lineCounts.old - p.lineCounts.new),
              movePath: p.section.rename ? p.targetPath : undefined,
              // Post-write stat backing fileDelta staleness detection: session
              // self-edits are never re-reminded; the walk treats this stat as
              // the reported state. Deletes/moves carry a { deleted: true }
              // sentinel so the missing source path is not re-reminded.
              stat: p.deleted || p.section.rename
                ? { deleted: true }
                : writtenStats.get(p.targetPath) ?? undefined,
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
          const anyRename = planned.some((p) => p.section.rename)
          const body = buildOutputBody(planned)
          let output = ""
          if (anyDeleted || anyRename) {
            const deleted = planned.filter((p) => p.deleted).length
            const renamed = planned.filter((p) => p.section.rename).length
            const parts: string[] = []
            if (deleted > 0) parts.push(`deleted ${deleted} file${deleted > 1 ? "s" : ""}`)
            if (renamed > 0) parts.push(`renamed ${renamed} file${renamed > 1 ? "s" : ""}`)
            output = `Edit applied successfully. (${parts.join(", ")}.)`
          } else {
            const header = file.freshTag
              ? `[${hashlineHeaderPath(instance.directory, file.sourcePath)}#${file.freshTag}]`
              : `[${hashlineHeaderPath(instance.directory, file.sourcePath)}#${fileTag(file.after || file.before)}]`
            if (anyChanged) {
              output = `${header}\n${body}\n\nEdit applied successfully.`
            } else if (planned.every((p) => p.section.delete)) {
              // Delete of a missing file: the goal state (file absent) is
              // already achieved - report success, not an error.
              output = `${header}\nNo changes applied: file does not exist (nothing to delete).`
            } else {
              // No content changed: the edit was a no-op. This is an error
              // back to the agent (not a success), because a no-op usually
              // means the intended change was already present or the anchor
              // hit the wrong region - silently reporting success would let
              // the agent believe it modified the file when it did not.
              throw new Error(
                `${header}\nNo changes applied: the edit produced no content change (before == after). ` +
                  `The intended change was likely already present, or the anchors targeted the wrong region. ` +
                  `Re-read the file for fresh anchors and retry with the actual change.`,
              )
            }
          }
          // Post-apply validator: flag the one-short indent fold (comments
          // AND code) so the model can fix it on the next call (the applied
          // edit is valid; this is a hint, not a rejection).
          const warnings = displayPlans.flatMap((p) => (p.changed && !p.deleted ? findIndentWarnings(p.after, p.before, p.changedLines, { filePath: p.targetPath }) : []))
          if (warnings.length > 0) {
            output += `\n\n<system-reminder>Edit applied, but the indentation validator flags ${warnings.length} line${warnings.length > 1 ? "s" : ""} that appear${warnings.length > 1 ? "" : "s"} one space short (the '+' separator was likely folded into the content):\n- ${warnings.join("\n- ")}\nIf the offset was not intentional, you may wish to re-issue a small edit to adjust it.</system-reminder>`
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
    section: { filePath: sourcePath, edits: [] as EditOp[], delete: true },
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
    changedLines: new Map(),
  }
}

/**
 * Post-apply indentation validator: scan the final file content for lines
 * (comments AND code) whose indent is exactly one LESS than an adjacent real
 * code line's indent - the signature of the separator-fold error (the model
 * wrote K spaces where K+1 were needed, the parser stripped the separator,
 * content landed K-1). SET/REPLACE lines additionally compare against the
 * original line they overwrote via the op-derived changed-lines map, which
 * catches both the fold AND the symmetric one-over shift even when the patch
 * changed the line count (uniformly shifted blocks sit 2+ spaces from their
 * enclosing braces and escape the adjacent checks). The applied edit is
 * CORRECT as written; this only warns the model so it can fix the indent on
 * the next call. Conservative by design: only the one-short/one-over
 * signatures are flagged, never dangling block-end comments or
 * intentionally misaligned markers. Blank lines are skipped when finding
 * the adjacent code line (a lone linefeed is not a real neighbor).
 */
export function findIndentWarnings(after: string, before?: string, changedLines?: Map<number, string>, opts?: { filePath?: string }): string[] {
  const lines = after.split("\n")
  // When the pre-edit content is available, only consider lines the edit
  // actually ADDED or CHANGED - never nudge about pre-existing lines the
  // patch did not touch. The filter is position-aware: a line counts as
  // pre-existing only when it sits at the SAME index in the pre-edit
  // content. The former string-Set membership misclassified changed lines
  // whose new text byte-matches a line elsewhere in the file (0089
  // Set-collision: the fixed comment lines byte-matched the identical
  // loop-guard block and were wrongly skipped). Index equality is exact
  // for equal line counts (REPLACE/SET) and covers the common
  //  insert-below/above cases; a preserved line shifted by an insert is
  //  byte-equal to its changedLines entry - skipped below (0113), since a
  //  warning on a shifted pre-existing fold sent the model on multi-turn
  //  fix chases for content it never broke (vllm-start 582 proof).
  const beforeLinesArr = before ? splitTextLines(before) : undefined
  const beforeLen = beforeLinesArr?.length ?? 0
  const warnings: string[] = []
  // Content-context exemptions: lines that live INSIDE a literal context
  // carry arbitrary indentation that is not a fold, so the ±1 checks must
  // never see them (sweep 2026-08-13: 90%+ of flags on real content were
  // these two classes):
  // - markdown code fences (``` / ~~~): diff blocks (context lines at 1
  //   vs fence at 0), pasted terminal output, ASCII art, code samples
  // - template-literal interiors (TS/JS): string content between
  //   unescaped backticks (e.g. a diff fixture inside a `...` literal)
  const exempt = new Set<number>()
  const ext = opts?.filePath?.split(".").pop() ?? ""
  if (["md", "markdown"].includes(ext)) {
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i]!)) { inFence = !inFence; exempt.add(i) }
      else if (inFence) exempt.add(i)
    }
    // Unbalanced fence markers (stray ``` in prose - found a real one in
    // BUILD.md 2026-08-13) invert the state for every later fence; don't
    // trust the exemption on such files - fall back to full checking
    // (a noisy hint beats silently skipping real folds).
    if (inFence) exempt.clear()
  } else if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    let inTemplate = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      let odd = false
      for (let j = 0; j < line.length; j++) {
        if (line[j] === "\\") { j++; continue }
        if (line[j] === "`") odd = !odd
      }
      if (inTemplate && !odd) exempt.add(i)
      if (odd) inTemplate = !inTemplate
    }
  }
  // (template parity is heuristic: backticks inside regexes/interpolations
  // can mis-toggle, which only ever suppresses a warning - never invents one)
  const isCommentOrInterior = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l)
  // Block-comment interior/close lines (`*` continuation, `*/`) are
  // decorative: they sit at opener-indent + 1 BY DESIGN, so the fold
  // checks must never see them (a `*` at 3 next to code at 2 is the
  // correct style, not an over-fold). Openers (`/*`) stay checked.
  const isInterior = (l: string) => /^\s*\*/.test(l)
  const shiftMap = shiftedIndexMap(beforeLinesArr ?? [], lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue
    if (isInterior(line)) continue
    if (exempt.has(i)) continue
    if (beforeLinesArr && i < beforeLen && beforeLinesArr[i] === line) continue // pre-existing line, not ours
    const lineIndent = line.match(/^\s*/)![0].length
    const kind = /^\s*(\/\/|\/\*)/.test(line) ? "comment" : "code line"
    const orig =
      changedLines?.get(i) ??
      (beforeLinesArr && shiftMap.has(i + 1) ? beforeLinesArr[shiftMap.get(i + 1)! - 1] : undefined) ??
      (beforeLinesArr && beforeLinesArr.length === lines.length ? beforeLinesArr[i] : undefined)
    if (orig !== undefined && orig === line) continue // shifted pre-existing, untouched by the edit
    // Adjacent real code in EITHER direction (skip blanks and other
    // comments): the fold can sit against the line below (usual) or above
    // (a BEFORE-insert landing one short, or a tail-of-block line).
    const adjacentIndents: number[] = []
    let j = i + 1
    while (j < lines.length && (lines[j]!.trim() === "" || isCommentOrInterior(lines[j]!))) j++
    if (j < lines.length) adjacentIndents.push(lines[j]!.match(/^\s*/)![0].length)
    let k = i - 1
    while (k >= 0 && (lines[k]!.trim() === "" || isCommentOrInterior(lines[k]!))) k--
    if (k >= 0) adjacentIndents.push(lines[k]!.match(/^\s*/)![0].length)
    // Body-aligned suppression (0113): when the line's indent matches a real
    // code neighbor, it aligns with the block convention - a ±1 difference
    // from the ORIGINAL is then a deliberate re-indent (e.g. the model
    // fixing a misindented line), not a fold. Only warn on orig when the
    // line floats outside every neighbor indent (the fold signature).
    const bodyAligned = adjacentIndents.includes(lineIndent)
    // Original-line check: prefer the op-derived changed-lines map
    // (after-index -> replaced original), which stays valid when the patch
    // changed the line count - the index-based fallback (equal counts only)
    // goes blind the moment any insert lands in the same patch, so a
    // uniformly shifted block escapes. A SET/REPLACE landing one space short
    // (or over) of the line it replaced is caught even when neither neighbor
    // sits at the expected indent (the neighbors straddle it). The replaced
    // line's own indent is the strongest reference; skip the adjacent scan
    // when it fires.
    if (!bodyAligned && orig !== undefined && orig.trim() !== "") {
      const origIndent = orig.match(/^\s*/)![0].length
      if (origIndent === lineIndent + 1 && origIndent > 0) {
        warnings.push(
          `line ${i + 1}: ${kind} indented ${lineIndent} space${lineIndent === 1 ? "" : "s"}, original line at ${origIndent} - likely one space short (the content row needs one MORE space after the '+' separator).`,
        )
        continue
      }
      if (origIndent === lineIndent - 1) {
        warnings.push(
          `line ${i + 1}: ${kind} indented ${lineIndent} space${lineIndent === 1 ? "" : "s"}, original line at ${origIndent} - likely one space OVER (the previous fix added one space too many).`,
        )
        continue
      }
    }
    // 0113: the adjacent ±1 checks are also suppressed when the body aligns
    // with a real-code neighbor - the deeper neighbor is then the anomaly
    // (e.g. a pre-existing misaligned line below), not the body. Without
    // this, a correctly-aligned line next to a misindented pre-existing
    // line gets flagged "one space short" and the model "fixes" the wrong
    // line (t41 live proof: line 5 at 2, neighbor at 3, flagged).
    if (!bodyAligned) {
      const hit = adjacentIndents.find((ind) => ind === lineIndent + 1 && ind > 0)
      if (hit !== undefined) {
        warnings.push(
          `line ${i + 1}: ${kind} indented ${lineIndent} space${lineIndent === 1 ? "" : "s"}, adjacent code at ${hit} - likely one space short (the content row needs one MORE space after the '+' separator).`,
        )
        continue
      }
      // Symmetric one-OVER check (0090 class: the fix loop overcorrected the
      // -1 fold to +1). Fires on the boundary lines of a uniformly
      // over-indented block (interior lines have no non-uniform neighbor).
      const over = adjacentIndents.find((ind) => ind === lineIndent - 1)
      if (over !== undefined) {
        warnings.push(
          `line ${i + 1}: ${kind} indented ${lineIndent} space${lineIndent === 1 ? "" : "s"}, adjacent code at ${over} - likely one space OVER (the previous fix added one space too many; content should align at ${over}).`,
        )
      }
    }
  }
  return warnings
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

/**
 * Engine-side indent-fold correction (hint-normalize). The read output
 * annotates each line with its indent hint `[N]` (block-openers hint the
 * body indent, others their own). The model tends to write the hint as the
 * TOTAL spaces after `+` (separator fold: content lands one short) or to
 * use the anchor's own depth for opener lines (two short). This corrects
 * each text op's rows against its anchor line's hint:
 * - insert_after an opener (`{` line): content can never legitimately sit
 *   shallower than the body indent -> MIN-rule: shift the whole block by
 *   the delta of its minimum row (fold -1 pad, own-depth -2 pad, one-over
 *   +1 trim). Mixed-depth blocks (O) shift as a unit.
 * - insert_before a closer (`}` line) mirrors the opener: the inserted
 *   block belongs to the closed block's body, so the same MIN-rule
 *   applies with hint = closer indent + 2 (mixed blocks like a whole
 *   test inserted before the closing `})` of a describe shift as a
 *   unit instead of escaping the fold correction).
 * - all other anchors (BEFORE/SET/REPLACE content is a SIBLING of the
 *   anchor line - own indent even when the line ends with `{`): only
 *   uniform single-depth blocks are corrected (mixed copy blocks like
 *   I_spacing_sweep are untouched).
 * - `*`-prefixed rows (docblock/block-comment bodies) sit at hint + 1 BY
 *   DESIGN (JSDoc opener at K, body at K+1), so the one-over trim never
 *   fires on an all-star block - they are decorative, not folds.
 * Runs BEFORE register expansion so paste content (captured verbatim from
 * a CUT) is never rewritten - cut/paste ops carry no text and are skipped.
 */
export function normalizeIndentToHint(edits: HashlineEditInputZ[], lines: string[]) {
  for (const op of edits) {
    if (!("text" in op) || op.text.length === 0) continue
    const anchorRef: string =
      "line" in op
        ? String(op.line)
        : "start_line" in op
          ? String(op.start_line)
          : "insert_after_line" in op
            ? String(op.insert_after_line)
            : "insert_before_line" in op
              ? String(op.insert_before_line)
              : ""
    const anchorNo = anchorRef.split("#")[0]
    const anchorLine = lines[Number(anchorNo) - 1] ?? ""
    if (anchorLine === "") continue
    let aLead = (anchorLine.match(/^ */) ?? [""])[0].length
    // 0113 anchor-convention fallback: when the anchor line itself is ±1 off
    // its real-code neighbors (a pre-existing fold), its own indent is an
    // untrustworthy hint - a correction edit targeting that line would be
    // padded BACK to the wrong indent (observed live during 0113
    // implementation: fixing 5 -> 4 spaces got re-padded to 5 and rejected
    // by the duplicate-anchor guard). Use the neighbor convention instead.
    const aNeighbors: number[] = []
    {
      let j = Number(anchorNo)
      while (j < lines.length && (lines[j]!.trim() === "" || /^\s*(\/\/|\/\*|\*)/.test(lines[j]!))) j++
      if (j < lines.length) aNeighbors.push((lines[j]!.match(/^ */) ?? [""])[0].length)
      let k = Number(anchorNo) - 2
      while (k >= 0 && (lines[k]!.trim() === "" || /^\s*(\/\/|\/\*|\*)/.test(lines[k]!))) k--
      if (k >= 0) aNeighbors.push((lines[k]!.match(/^ */) ?? [""])[0].length)
    }
    const anchorAligned = aNeighbors.includes(aLead)
    if (!anchorAligned && aNeighbors.length > 0) {
      const convention = aNeighbors[0]
      if (convention === aLead + 1 || convention === aLead - 1) {
        // only substitute when the neighbor convention is unambiguous (both
        // sides agree, or the single available side is ±1)
        if (aNeighbors.every((n) => n === convention)) aLead = convention
      }
    }
    // 0117 structural-closer fallback: when the anchor is a block closer
    // (`}`) whose neighbors DISAGREE (inner body above, outer content
    // below), the neighbor convention is ambiguous - but the brace-match
    // scan is not: the closer aligns with its matching opener. Without
    // this, a deliberate closer-indent fix gets padded back to the anchor's
    if (aLead === anchorLine.match(/^ */)![0].length && /^\s*}\s*[,;)\]\.]*$/.test(anchorLine)) {
      for (let p = Number(anchorNo) - 2; p >= 0; p--) {
        const pl = lines[p]!
        if (!pl.trimEnd().endsWith("{")) continue
        const openerIndent = (pl.match(/^ */) ?? [""])[0].length
        if (openerIndent === aLead + 1 || openerIndent === aLead - 1) aLead = openerIndent
        break
      }
    }
    const opener = op.type === "insert_after" && anchorLine.trimEnd().endsWith("{")
    const closer = op.type === "insert_before" && /}[,;)\]\.]*$/.test(anchorLine.trimEnd())
    const rows = Array.isArray(op.text) ? op.text : [op.text]
    const hint = opener || closer ? aLead + 2 : aLead
    const lead = (r: string) => (r.match(/^ */) ?? [""])[0].length
    const nonBlank = rows.map((r, i) => (r === "" ? -1 : i)).filter((i) => i >= 0)
    if (nonBlank.length === 0) continue
    const leads = nonBlank.map((i) => lead(rows[i]))
    let delta = 0
    const minLead = Math.min(...leads)
    if (opener || closer) {
      // 0113: pad ANY uniform block sitting below the structural body indent
      // (the block at 0 where the context is at 4 class), capped to avoid
      // absurd rewrites; one-over (hint + 1) trims, star rows stay exempt.
      if (minLead === hint + 1 && !nonBlank.every((i) => /^\s*\*/.test(rows[i]))) delta = -1
      else if (minLead < hint && hint - minLead <= 8) delta = hint - minLead
    } else {
      const uniform = leads.every((l) => l === leads[0])
      if (uniform && leads[0] === hint - 1) delta = 1
      else if (uniform && leads[0] === hint + 1 && !nonBlank.every((i) => /^\s*\*/.test(rows[i]))) delta = -1
    }
    if (delta !== 0) {
      const fixed = rows.map((r, i) =>
        r === ""
          ? r
          : delta > 0
            ? " ".repeat(delta) + r
            : r.replace(new RegExp(`^ {${-delta}}`), ""),
      )
      op.text = Array.isArray(op.text) ? fixed : fixed[0]
    }
  }
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

/**
* 0113 diff-based before->after index map (after-index 1-based -> before-index
* 1-based over equal runs). The changedLines map only covers SET/REPLACE
* replacements; lines SHIFTED by an insert/delete have no entry there, so the
* validator/fixer could not tell them from the edit's own content (the
* phantom-flag class on trailing-newline files, fixed via splitTextLines, had
* a sibling: pre-existing folds next to an insert). With this map, a shifted
* line resolves to its original text, hits the byte-equal skip, and is left
* alone. Degenerates to an empty map beyond the LCS guard (50M cells) -
* identical to the pre-0113 behavior in that case.
*/
function shiftedIndexMap(beforeLines: string[], afterLines: string[]): Map<number, number> {
  const runs = diffLineRuns(beforeLines, afterLines)
  const map = new Map<number, number>()
  for (const run of runs) {
    if (run.type !== "equal") continue
    for (let k = 0; k < run.count; k++) map.set(run.newStart + k + 1, run.oldStart + k + 1)
  }
  return map
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

/**
* 0113 engine-side indent fold correction (plan time, before the diff is
* computed). Mirrors findIndentWarnings' classification but REWRITES the
* flagged lines instead of warning: a line the edit actually changed whose
* indent is exactly ±1 from its original (or from the adjacent real code) is
* the separator-fold signature - correct it to the reference indent. Only
* lines the edit touched are considered (changedLines map / equal-count
* index + byte-equal skip), so pre-existing content is never rewritten.
* Returns the fixed lines plus a compact per-line report ("N (K -> M)").
* Keep the classification in sync with findIndentWarnings.
*/
/**
* 0117: detect blocks the edit accidentally duplicated by echoing existing
* lines into a SET/REPLACE body. A run of >= 2 adjacent identical lines that
* (a) already exists in `before` and (b) appears twice consecutively in the
* result, with the second copy in the edit's changed region, is the echo
* signature (mangled replaces). Returns at most 3 runs (start/end are
* 0-based indices into the result).
*/
export function findEchoDuplicateRuns(
  before: string[] | undefined,
  after: string[],
  changedLines: Map<number, string> | undefined,
  ): { start: number; end: number; pattern: string }[] {
  if (!before || after.length < 4) return []
  const out: { start: number; end: number; pattern: string }[] = []
  const minRun = 2
  const maxRun = 8
  for (let i = 0; i < after.length - minRun * 2 + 1 && out.length < 3; i++) {
    if (after[i]!.trim() === "") continue
    // The second copy must overlap the edit's changed lines (the echo
    // inserted it); pre-existing duplicate blocks elsewhere stay silent.
    const secondStart = i + minRun
    const changedHit = [...(changedLines?.keys() ?? [])].some((k) => k >= secondStart && k <= secondStart + maxRun - 1)
    if (!changedHit) continue
    for (let run = minRun; run <= maxRun && i + run * 2 <= after.length; run++) {
      const pattern = after.slice(i, i + run).join("\n")
      const firstIdx = before.findIndex((_, b) => {
        if (before.slice(b, b + run).length < run) return false
        return before.slice(b, b + run).join("\n") === pattern
    })
      if (firstIdx < 0) continue
      const second = after.slice(i + run, i + run * 2).join("\n") === pattern
      if (!second) continue
      out.push({ start: i, end: i + run * 2 - 1, pattern })
      break
    }
  }
  return out
}
export function fixIndentFolds(
  afterLines: string[],
  before: string | undefined,
  changedLines: Map<number, string> | undefined,
  opts?: { filePath?: string },
): { lines: string[]; fixed: string[] } {
  const lines = [...afterLines]
  const beforeLinesArr = before ? splitTextLines(before) : undefined
  const beforeLen = beforeLinesArr?.length ?? 0
  const fixed: string[] = []
  // Content-context exemptions: identical to findIndentWarnings (fences for
  // md/markdown, template-literal interiors for ts/js).
  const exempt = new Set<number>()
  const ext = opts?.filePath?.split(".").pop() ?? ""
  if (["md", "markdown"].includes(ext)) {
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i]!)) { inFence = !inFence; exempt.add(i) }
      else if (inFence) exempt.add(i)
    }
    if (inFence) exempt.clear()
  } else if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    let inTemplate = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      let odd = false
      for (let j = 0; j < line.length; j++) {
        if (line[j] === "\\") { j++; continue }
        if (line[j] === "`") odd = !odd
      }
      if (inTemplate && !odd) exempt.add(i)
      if (odd) inTemplate = !inTemplate
    }
  }
  const isCommentOrInterior = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l)
  const isInterior = (l: string) => /^\s*\*/.test(l)
  const shiftMap = shiftedIndexMap(beforeLinesArr ?? [], lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "") continue
    if (isInterior(line)) continue
    if (exempt.has(i)) continue
    if (beforeLinesArr && i < beforeLen && beforeLinesArr[i] === line) continue
    const lineIndent = line.match(/^\s*/)![0].length
    const orig =
      changedLines?.get(i) ??
      (beforeLinesArr && shiftMap.has(i + 1) ? beforeLinesArr[shiftMap.get(i + 1)! - 1] : undefined) ??
      (beforeLinesArr && beforeLinesArr.length === lines.length ? beforeLinesArr[i] : undefined)
    if (orig !== undefined && orig === line) continue // shifted pre-existing, untouched
    // Structural alignment (0117): a line whose indent matches its BLOCK
    // STRUCTURE is a deliberate placement, never a separator fold - the
    // auto-fix must not rewrite it. Two shapes:
    //   (a) a closer (`}`) whose nearest preceding block opener (a line
    //       ending with `{`) sits at the SAME indent - the model is
    //       closing the block at the structural position (e.g. a 9 -> 10
    //       closer fix would otherwise be reverted because |10-9| == 1);
    //   (b) a continuation whose nearest preceding real-code line ends
    //       with `(` or `{` and sits at indent + 2 - the prettier
    //       continuation convention (e.g. `.pipe(` at 10 with the
    //       callback at 12, reverted as a "fold" when the original was
    //       the folded 11).
    // The 582-class (a plain statement in a SET/REPLACE body) matches
    // neither shape and still falls through to the orig-+-1 fold rule.
    const isCloserLine = /^\s*}\s*[,;)\]\.]*$/.test(line)
    const structurallyAligned = (() => {
      if (isCloserLine) {
        // Brace-match scan: the closer aligns with its matching opener.
        // Continue past inner blocks at other indents (the nearest
        // `{`-line may be an inner block) until one at the SAME indent is
        // found. A fold writes the closer at opener +- 1, which matches
        // nothing here and falls through to the orig-+-1 rule below.
        for (let p = i - 1; p >= 0; p--) {
          const pl = lines[p]!
          if (pl.trim() === "" || isCommentOrInterior(pl)) continue
          if (!pl.trimEnd().endsWith("{")) continue
          if (pl.match(/^\s*/)![0].length === lineIndent) return true
        }
        return false
      }

      let p = i - 1
      while (p >= 0 && (lines[p]!.trim() === "" || isCommentOrInterior(lines[p]!))) p--
      if (p < 0) return false
      const pl = lines[p]!
      const plIndent = pl.match(/^\s*/)![0].length
      return (pl.trimEnd().endsWith("(") || pl.trimEnd().endsWith("{")) && plIndent + 2 === lineIndent
    })()
    if (structurallyAligned) continue
    const adjacentIndents: number[] = []
    let j = i + 1
    while (j < lines.length && (lines[j]!.trim() === "" || isCommentOrInterior(lines[j]!))) j++
    if (j < lines.length) adjacentIndents.push(lines[j]!.match(/^\s*/)![0].length)
    let k = i - 1
    while (k >= 0 && (lines[k]!.trim() === "" || isCommentOrInterior(lines[k]!))) k--
    if (k >= 0) adjacentIndents.push(lines[k]!.match(/^\s*/)![0].length)
    // Body-aligned guard: only auto-fix when the line floats outside every
    // real-code neighbor's indent (the fold signature). A body that matches
    // a neighbor is a deliberate re-indent (e.g. fixing a misindented line)
    // and must NOT be rewritten - the auto-fix would undo the model's own
    // correction and restart the fix loop.
    const bodyAligned = adjacentIndents.includes(lineIndent)
    const origIndent =
      orig !== undefined && orig.trim() !== "" ? orig.match(/^\s*/)![0].length : undefined
    let target: number | undefined
    if (origIndent !== undefined) {
      if (!bodyAligned && Math.abs(origIndent - lineIndent) === 1 && origIndent > 0) {
        // Body floats outside every neighbor indent and is ±1 from the
        // original - the separator-fold signature. Correct to the original.
        target = origIndent
      } else if (origIndent === lineIndent && !bodyAligned) {
        // Content-only change that kept a misaligned indent (the original
        // was already ±1 off the block convention): the adjacent real code
        // is the reference.
        const hit = adjacentIndents.find((ind) => ind === lineIndent + 1 && ind > 0)
        const over = adjacentIndents.find((ind) => ind === lineIndent - 1)
        const adj = hit ?? over
        if (adj !== undefined) target = adj
      }
    }
    if (target !== undefined && target !== lineIndent) {
      lines[i] = `${" ".repeat(target)}${line.slice(lineIndent)}`
      fixed.push(`${i + 1} (${lineIndent} -> ${target})`)
    }
  }
  return { lines, fixed }
}
