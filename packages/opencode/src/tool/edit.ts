// Fence edit tool: OLD/NEW content-block editing (the 2026-08-14 reversion).
// Rebuilt from the upstream v1.18.16 edit.ts skeleton (lock / ctx.ask / Bom /
// format / events / LSP / metadata) with the fence grammar + multi-file +
// the 0116/0120 fileDelta stat contract on top. See
// docs/edit_format_investigation_20260814.md for the full writeup.
import { FOLDERS } from "@opencode-ai/core/filesystem/ignore"
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
import { parseFencePatch } from "./grammar-fence"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
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
  input: Schema.String.annotate({
    description:
      "The patch text: *** Begin Patch, [path] sections, OLD:/NEW: content blocks, *** End Patch",
  }),
})

// Split file text into lines, tracking whether the original ended with a
// newline (the trailing empty element of a plain split is dropped).
function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const trailing = text.endsWith("\n")
  const lines = text.split("\n")
  if (trailing && lines[lines.length - 1] === "") lines.pop()
  return { lines, trailing }
}

/** Find all exact-match start offsets of `needle` in `haystack` lines. */
function findMatches(haystack: string[], needle: string[]): number[] {
  const hits: number[] = []
  outer: for (let idx = 0; idx <= haystack.length - needle.length; idx++) {
    for (let k = 0; k < needle.length; k++) {
      if (haystack[idx + k] !== needle[k]) continue outer
    }
    hits.push(idx)
  }
  return hits
}

// Re-exported for write.ts compatibility (upstream exports; ours keeps the
// signature). The hashline anchor annotation is gone - the diff is returned
// as-is.
export function annotateDiff(diff: string): string {
  return diff
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

type Plan = {
  sourcePath: string
  targetPath: string
  deleted: boolean
  renamed: boolean
  before: string
  after: string
  bom: boolean
  diff: string
  additions: number
  deletions: number
  noop: boolean
}

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
          // Parse first - failures here throw BEFORE any metadata is emitted,
          // so the TUI renders a clean red tool call (no ghost success block).
          const parsed = parseFencePatch(params.input)
          if (!parsed.ok) {
            throw new Error(parsed.errors[0] ?? "invalid patch")
          }
          if (parsed.files.length === 0) {
            throw new Error("empty patch (no file sections)")
          }

          const instance = yield* InstanceState.context
          const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(instance.directory, p))

          // Basename resolution: headers render paths relative to the
          // instance dir (or absolute outside it); bare basenames resolve by
          // walking the worktree (12 levels / 32 matches, 0057 caps).
          const resolveSourcePath = (filePath: string): Effect.Effect<string> =>
            Effect.gen(function* () {
              const direct = resolvePath(filePath)
              const info = yield* afs.stat(direct).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const bare = !filePath.includes("/") && !filePath.includes("\\")
              if (info || !bare) return direct
              const matches: string[] = []
              const walk = (dir: string, depth: number): Effect.Effect<void> => {
                if (depth > 12 || matches.length >= 32) return Effect.void
                return Effect.gen(function* () {
                  const entries = yield* afs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
                  for (const entry of entries) {
                    if (entry.type === "directory") {
                      if (!FOLDERS.has(entry.name)) yield* walk(path.join(dir, entry.name), depth + 1)
                    } else if (entry.type === "file" && entry.name === filePath) {
                      matches.push(path.join(dir, entry.name))
                    }
                  }
                })
              }
              yield* walk(instance.directory, 0)
              if (matches.length === 0) return direct
              if (matches.length === 1) return matches[0]
              throw new Error(
                `Basename ${JSON.stringify(filePath)} is ambiguous (${matches.length} files match): ${matches.join(", ")}. Use the full path in the [PATH] section header.`,
              )
            })

          // PHASE 1 - validate everything up front (atomic): resolve paths,
          // load files, match every OLD block uniquely. Any error aborts
          // before a single write.
          const plans: Plan[] = []
          // Chain later sections of the same path onto the previous
          // section's result: at preflight time nothing has been written
          // yet, so each section would otherwise re-read the original from
          // disk and earlier sections would silently be discarded (last
          // write wins).
          const plannedByPath = new Map<string, { after: string; bom: boolean }>()
          for (const section of parsed.files) {
            const sourcePath = yield* resolveSourcePath(section.filePath)
            if (section.delete) {
              plannedByPath.delete(sourcePath)
              plans.push({
                sourcePath,
                targetPath: sourcePath,
                deleted: true,
                renamed: false,
                before: "",
                after: "",
                bom: false,
                diff: "",
                additions: 0,
                deletions: 0,
                noop: false,
              })
              continue
            }
            const targetPath = section.rename ? resolvePath(section.rename) : sourcePath

            const info = yield* afs.stat(sourcePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`File ${sourcePath} not found`)
            if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${sourcePath}`)
            // Same-path sections compose: the next section's OLD blocks
            // reference the ORIGINAL read content, so the previous section's
            // result is the base for chained matching (not disk - nothing has
            // been written yet).
            const chained = plannedByPath.get(sourcePath)
            const source = chained
              ? { text: chained.after, bom: chained.bom }
              : yield* Bom.readFile(afs, sourcePath)
            const { lines, trailing } = splitLines(source.text)

            const work = [...lines]
            for (const op of section.ops) {
              if (op.kind === "append") {
                work.push(...op.text)
                continue
              }
              const hits = findMatches(work, op.old)
              if (hits.length === 0) {
                const first = op.old[0]
                const similar = work.findIndex((l) => l === first)
                throw new Error(
                  similar >= 0
                    ? `no match for the OLD block - the first line matches line ${similar + 1} but the full block does not; copy the OLD block byte-exact from the read output (strip the \`N:\` prefix)`
                    : `no match for \`${first.slice(0, 60)}\` in the file - copy the OLD block byte-exact from the read output (the file may have changed - re-read first)`,
                )
              }
              if (hits.length > 1) {
                throw new Error(
                  `ambiguous - the OLD block matches ${hits.length} places (e.g. lines ${hits
                    .slice(0, 3)
                    .map((h) => h + 1)
                    .join(", ")}); extend the OLD block with surrounding lines to disambiguate`,
                )
              }
              work.splice(hits[0], op.old.length, ...op.new)
            }

            const before = source.text
            const after = work.length > 0 || trailing ? `${work.join("\n")}${trailing ? "\n" : ""}` : ""
            plannedByPath.set(sourcePath, { after, bom: source.bom })
            plans.push({
              sourcePath,
              targetPath,
              deleted: false,
              renamed: !!section.rename,
              before,
              after,
              bom: source.bom,
              diff: "",
              additions: 0,
              deletions: 0,
              noop: false,
            })
          }

          // PHASE 2 - apply. Per file: ask (permission + diff), write, format,
          // events, then the post-write stat backing 0116 fileDelta.
          const writtenStats = new Map<string, { mtimeMs: number; size: number }>()
          for (const plan of plans) {
            if (plan.deleted) {
              const existed = yield* afs.existsSafe(plan.sourcePath)
              if (existed) {
                // Count the removed file's lines so the TUI renders the
                // deletions (the whole file gone), not -0 lines. Same
                // trailing-newline convention as splitLines (a file ending in
                // "\n" splits to a phantom empty line - drop it).
                const text = yield* afs.readFileStringSafe(plan.sourcePath)
                plan.deletions = text ? text.replace(/\n$/, "").split("\n").length : 0
                yield* Effect.tryPromise(() => import("fs/promises").then((m) => m.rm(plan.sourcePath)))
                yield* events.publish(FileSystem.Event.Edited, { file: plan.sourcePath })
                yield* events.publish(Watcher.Event.Updated, {
                  file: plan.sourcePath,
                  event: "change",
                })
              }
              continue
            }

            plan.diff = trimDiff(
              createTwoFilesPatch(
                plan.targetPath,
                plan.targetPath,
                normalizeLineEndings(plan.before),
                normalizeLineEndings(plan.after),
              ),
            )
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, plan.targetPath)],
              always: ["*"],
              metadata: {
                filepath: plan.targetPath,
                diff: plan.diff,
              },
            })

            if (plan.renamed) {
              yield* Effect.tryPromise(() =>
                import("fs/promises").then((m) => m.rename(plan.sourcePath, plan.targetPath)),
              )
            }
            yield* afs.writeWithDirs(plan.targetPath, Bom.join(plan.after, plan.bom))
            if (yield* format.file(plan.targetPath)) {
              plan.after = yield* Bom.syncFile(afs, plan.targetPath, plan.bom)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: plan.targetPath })
            yield* events.publish(Watcher.Event.Updated, {
              file: plan.targetPath,
              event: "change",
            })

            // Post-write stat backing fileDelta staleness detection (0116):
            // session self-edits are never re-reminded; the walk treats this
            // stat as the reported state. Integer-ms convention (0120).
            const postStat = yield* Effect.tryPromise(() =>
              import("fs/promises").then((m) => m.stat(plan.targetPath)),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (postStat) {
              writtenStats.set(plan.targetPath, {
                mtimeMs: Math.trunc(postStat.mtimeMs),
                size: postStat.size,
              })
            }

            // Re-diff after formatting so the rendered diff matches disk.
            plan.diff = trimDiff(
              createTwoFilesPatch(
                plan.targetPath,
                plan.targetPath,
                normalizeLineEndings(plan.before),
                normalizeLineEndings(plan.after),
              ),
            )
            for (const change of diffLines(plan.before, plan.after)) {
              if (change.added) plan.additions += change.count || 0
              if (change.removed) plan.deletions += change.count || 0
            }
          }

          const diffs = plans.filter((p) => !p.deleted).map((p) => p.diff)
          const changedPlans = plans.filter((p) => p.deleted || p.diff.length > 0)

          const fileDiffs = plans
            .map((p) => ({
              filePath: p.sourcePath,
              relativePath: path.relative(instance.directory, p.targetPath).replaceAll("\\", "/"),
              type: p.deleted ? ("delete" as const) : p.renamed ? ("move" as const) : ("edit" as const),
              changed: !p.noop && p.before !== p.after,
              patch: p.diff,
              additions: p.additions,
              deletions: p.deletions,
              movePath: p.renamed ? p.targetPath : undefined,
              // Post-write stat backing fileDelta staleness detection (0116):
              // session self-edits are never re-reminded; the walk treats this
              // stat as the reported state. Deletes/moves carry a
              // { deleted: true } sentinel so the missing source path is not
              // re-reminded.
              stat: p.deleted || p.renamed ? { deleted: true } : writtenStats.get(p.targetPath) ?? undefined,
            }))
            .filter((f) => f.type === "delete" || f.patch.length > 0)

          const metadata = {
            diagnostics: {} as Record<string, unknown>,
            diff: diffs.join("\n"),
            filediff: changedPlans[0]
              ? ({
                  file: changedPlans[0].targetPath,
                  patch: changedPlans[0].diff,
                  additions: changedPlans[0].additions,
                  deletions: changedPlans[0].deletions,
                } satisfies Snapshot.FileDiff)
              : undefined,
            files: fileDiffs,
            paths: plans.map((p) => p.targetPath),
            noop: plans.every((p) => p.noop) ? 1 : 0,
          }
          yield* ctx.metadata({ metadata })

          let output = "Edit applied successfully."
          const touched = plans.filter((p) => !p.deleted)
          for (const plan of touched) {
            yield* lsp.touchFile(plan.targetPath, "document")
          }
          const diagnostics = yield* lsp.diagnostics()
          const blocks: string[] = []
          for (const plan of touched) {
            const normalized = FSUtil.normalizePath(plan.targetPath)
            const block = LSP.Diagnostic.report(plan.targetPath, diagnostics[normalized] ?? [])
            if (block) blocks.push(block)
          }
          if (blocks.length > 0) {
            output += `\n\nLSP errors detected in the edited files, please fix:\n${blocks.join("\n")}`
          }

          return {
            metadata,
            title: touched.length > 0 ? touched.map((p) => path.relative(instance.worktree, p.targetPath)).join(" → ") : "",
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
