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
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { parseFencePatch } from "./grammar-fence"
import { resolveSpan } from "./string-match"

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
  // Accepted and IGNORED (0234): models occasionally mirror the read/write
  // tool signatures and send `filePath`/`path` beside `input`. The [path]
  // section header inside `input` is authoritative, so these add nothing -
  // but hard-rejecting them produced a SchemaError that nudged the model to
  // give up on the edit tool and resort to bash heredoc/cat writes. Accepting
  // the keys makes a trivially-repairable call succeed; a call that relied on
  // filePath with NO [path] header still fails parse ("content before any
  // [PATH] section").
  filePath: Schema.optional(Schema.String).annotate({
    description: "Ignored - the [path] section header in `input` is authoritative.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "Ignored - the [path] section header in `input` is authoritative.",
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

// Rebuild the work array from a content string produced by the fallback
// matchers (which work on the joined string): the work invariant is "no
// trailing empty element" (splitLines drops it for the file's own trailing
// newline; the fallbacks must too, or an empty element would append a
// phantom "\n" to the output).
/** Project-relative display path (mirrors the fileDelta renderer: relative
 *  when inside the worktree, absolute otherwise - keeps the error readable). */
function displayPath(dir: string, p: string): string {
  const rel = path.relative(dir, p)
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p
}

/** Escape a literal line for rg's default (PCRE-ish) regex grammar. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * When an OLD block fails to match its resolved file at all, grep the
 * worktree for the block's first non-empty line and report any OTHER file
 * that holds it - so a wrong [PATH] header (the content lives in a different
 * file) is diagnosed as such instead of leaving the agent guessing. Bounded:
 * limit small, best-effort (any Ripgrep failure returns "").
 */
/** Bounded basename search from a root - the 0226 parallel BFS, factored so
 *  both bare-header resolution and the file-not-found hint share one walk.
 *  `maxDepth` bounds how deep it goes: the hint uses a SHALLOW 2 (workspace
 *  root -> sibling project/dir -> file, ~10-20ms); bare-header resolution uses
 *  12 (full tree). Caps: 32 matches, FOLDERS skip. Returns every file named
 *  `needle` under `root`, or [] when none. */
const findBasename = (
  fs: FSUtil.Interface,
  root: string,
  needle: string,
  maxDepth = 12,
): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const matches: string[] = []
    const walk = (dirs: string[], depth: number): Effect.Effect<void> => {
      if (depth > maxDepth || dirs.length === 0 || matches.length >= 32) return Effect.void
      return Effect.gen(function* () {
        const entries = yield* Effect.all(
          dirs.map((dir) => fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))),
          { concurrency: 32 },
        )
        const children: string[] = []
        for (let i = 0; i < dirs.length; i++) {
          for (const entry of entries[i]!) {
            if (entry.type === "directory") {
              if (!FOLDERS.has(entry.name)) children.push(path.join(dirs[i]!, entry.name))
            } else if (entry.type === "file" && entry.name === needle) {
              matches.push(path.join(dirs[i]!, entry.name))
            }
          }
        }
        if (matches.length < 32) yield* walk(children, depth + 1)
      })
    }
    yield* walk([root], 0)
    return matches
  })

const wrongFileHint = Effect.fn("EditTool.wrongFileHint")(function* (
  ripgrep: Ripgrep.Interface,
  dir: string,
  sourcePath: string,
  block: string[],
) {
  const first = block.find((l) => l.trim().length > 0)
  if (!first) return ""
  try {
    const matches = yield* ripgrep.grep({
      cwd: dir,
      pattern: escapeRegex(first.trim()),
      limit: 4,
    })
    const absSource = path.resolve(sourcePath)
    const others = matches
      .map((m) => {
        const p = path.resolve(dir, m.entry.path.toString())
        return { p, display: displayPath(dir, p) }
      })
      .filter((m) => m.p !== absSource)
      .slice(0, 2)
    if (others.length === 0) return ""
    const plural = others.length > 1 ? "files" : "file"
    return `The OLD block matched "${first.trim().slice(0, 60)}" in ${others
      .map((m) => m.display)
      .join(", ")} instead - wrong [PATH] header (content lives in another ${plural})? `
  } catch {
    return ""
  }
})

function toWork(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

// 1-based line number of a character index within a content string.
function lineOf(index: number, content: string): number {
  return content.slice(0, index).split("\n").length
}

// Insertion index after the LINE that contains `from` (the position after
// that line's trailing newline, or content.length for the last line).
function lineEndIdx(content: string, from: number): number {
  const nl = content.indexOf("\n", from)
  return nl === -1 ? content.length : nl + 1
}

// Insertion index before the LINE that contains `from` (0, or the position
// right after the previous line's newline).
function lineStartIdx(content: string, from: number): number {
  return content.lastIndexOf("\n", Math.max(0, from - 1)) + 1
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

// Files whose lines exceed this render jsdiff's default 4-line hunk context
// (diff 8.x) as near-full-width rows above AND below every change (bundles,
// dumps, dense single-line tool code). For those files the extra context rows
// are mostly what the change touches, so thin the hunk to 1 context line each
// side; normal files keep the default.
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
  // Ladder-fire echo: entries recorded when a fallback tier matched (not
  // byte-exact) - the agent must see what actually happened.
  fallbackNotes: string[]
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // exact-op-key hardening (3ddcb6de60): the edit op grammar must be exact
      // so invented anchors (insert_before_line etc.) fail loudly with the
      // targeted hint below instead of being silently dropped. scoped to edit
      // - other tools keep the tolerant upstream default.
      strict: true,
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
          // walking the worktree (12 levels / 32 matches, 0057 caps). The
          // walk is bounded-parallel BFS (0226) - the old serial recursion
          // waited on 38k sequential readdirs (~1.3s here) and made a bare
          // [path] header visible as "patch streams in, 2s pause, diff snaps
          // in" on large worktrees.
          // Resolve a section's target path. Trust order (oc 0259):
          //   1. The `filePath` argument when present (single-section patches
          //      only - it cannot map to multiple headers, and it is almost
          //      always the model's correct absolute path; the header's bare
          //      basename is the lazy echo of the read tool's rendering).
          //   2. The header path itself (absolute, or joined to the project
          //      root - os-root and project-relative are the two forms models
          //      produce correctly).
          //   3. The bare-basename BFS worktree walk (last resort: deep files
          //      whose full path a model cannot know, e.g. archive tmp/).
          //
          // Tiers 1-2 are cheap (one stat). Tier 3 is the expensive walk -
          // reached only when the cheap tiers miss, so ambiguity/scan cost is
          // bounded by how often the model gets a path form entirely wrong
          // from the two it knows. filePath is NOT the header substitute when
          // it stat-fails (it could be stale) - fall through to the header.
          const resolveSourcePath = (headerPath: string, preferPath?: string): Effect.Effect<string> =>
            Effect.gen(function* () {
              // Tier 1: the model's authoritative filePath, when it resolves.
              if (preferPath) {
                const pref = resolvePath(preferPath)
                const pInfo = yield* afs.stat(pref).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (pInfo) return pref
              }
              // Tier 2: the header path (absolute / project-relative).
              const direct = resolvePath(headerPath)
              const info = yield* afs.stat(direct).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const bare = !headerPath.includes("/") && !headerPath.includes("\\")
              if (info || !bare) return direct
              // Tier 3: bare-basename BFS (the factored, bounded-parallel
              // walk - 12 levels / 32 matches / FOLDERS skip). Reached only
              // when the cheap tiers missed.
              const matches = yield* findBasename(afs, instance.directory, headerPath)
              if (matches.length === 0) return direct
              if (matches.length === 1) return matches[0]
              throw new Error(
                `Basename ${JSON.stringify(headerPath)} is ambiguous (${matches.length} files match): ${matches.join(", ")}. Use the full path in the [PATH] section header.`,
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
          // Registers are patch-global: a CUT in any section (any file) can
          // be PASTEd by any later section.
          const registers = new Map<string, string[]>()
          for (const section of parsed.files) {
            // oc 0259: trust the filePath argument on single-section patches
            // (the model's authoritative path; cannot map to multiple headers).
            const preferPath = parsed.files.length === 1 ? params.filePath : undefined
            const sourcePath = yield* resolveSourcePath(section.filePath, preferPath)
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
                fallbackNotes: [],
              })
              continue
            }
            const targetPath = section.rename ? resolvePath(section.rename) : sourcePath

            const info = yield* afs.stat(sourcePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) {
              // oc 0259: on a file-not-found for an absolute/rooted path, hunt
              // for the WRONG-PROJECT transcription. The model's os-root paths
              // usually differ from the real file by ONE segment - the top-
              // level sibling project (opencode vs allyn). The sibling shares
              // the sub-path wiring after that segment, so check the SAME
              // relative sub-path under every workspace child: one stat per
              // sibling (~36 stats for /root/oc, capped), deterministic and
              // cheap on the rare not-found path - not a tree walk.
              let hint: string | undefined
              if (path.isAbsolute(sourcePath)) {
                const workspace = path.dirname(instance.directory)
                const relToWorkspace = path.relative(workspace, sourcePath)
                const segs = relToWorkspace.split(path.sep)
                const firstChild = segs[0] // the sibling project dir in the header
                const rest = segs.slice(1).join(path.sep) // sub-path after it
                if (firstChild && rest) {
                  const siblings = yield* afs
                    .readDirectoryEntries(workspace)
                    .pipe(Effect.catch(() => Effect.succeed([])))
                  const hits: string[] = []
                  // Raw readdir is OS order; sort for a stable scan. Skip
                  // dotfiles - workspace project roots are never hidden, and
                  // a dotfile-heavy root (e.g. /tmp with 1k+ .hm scratch
                  // files) would otherwise push the real sibling past any
                  // positional cap. Cap on hit count (2), not position: the
                  // loop exits after the first couple of matches, so a large
                  // workspace costs at most ~36 stats in practice.
                  const ordered = [...siblings]
                    .filter((e) => !e.name.startsWith("."))
                    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
                  for (const entry of ordered) {
                    if (entry.type !== "directory") continue
                    const cand = path.join(workspace, entry.name, rest)
                    const s2 = yield* afs.stat(cand).pipe(Effect.catch(() => Effect.succeed(undefined)))
                    if (s2 && cand !== sourcePath) hits.push(cand)
                    if (hits.length >= 2) break
                  }
                  if (hits.length > 0) {
                    hint = hits.map((p) => displayPath(instance.directory, p)).join(", ")
                  }
                }
              }
              throw new Error(
                `File ${sourcePath} not found${hint ? `; a file with that name exists at ${hint} - wrong sibling project in the [PATH] header? Use the full path in the [PATH] header.` : ""}`,
              )
            }
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
            // Naming the checked file: every OLD-match failure now says which
            // file the ladder searched, so a wrong [PATH] header (the block
            // lives in another file) is diagnosable instead of a blind
            // 'not in the file'.
            const showPath = displayPath(instance.directory, sourcePath)

            let work = [...lines]
            const fallbackNotes: string[] = []
            for (const op of section.ops) {
              if (op.kind === "append") {
                work.push(...op.text)
                continue
              }
              if (op.kind === "cut") {
                const hits = findMatches(work, op.block)
                if (hits.length === 0) {
                  // Fallback tier: string matching on the joined content
                  // (fragments + tolerance ladder) - the register captures
                  // the ACTUAL matched text, not the model's copy.
                  try {
                    const joined = work.join("\n")
                    const span = resolveSpan(joined, op.block.join("\n"))
                    const matched = joined.slice(span.index, span.index + span.length)
                    registers.set(op.register, matched.split("\n"))
                    work = toWork(joined.slice(0, span.index) + joined.slice(span.index + span.length))
                    fallbackNotes.push(`CUT @${op.register} matched via ${span.tier} at line ${lineOf(span.index, joined)} - captured ${matched.split("\n").length} lines`)
                    continue
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    if (msg.toLowerCase().includes("multiple matches")) {
                      throw new Error(
                        `CUT @${op.register}: the block fragment matches several places - extend it with surrounding text to disambiguate`,
                      )
                    }
                    throw new Error(
                      `CUT @${op.register}: no match for \`${(op.block[0] ?? "").slice(0, 60)}\` in ${showPath} - copy the block byte-exact from the read output`,
                    )
                  }
                }
                if (hits.length > 1) {
                  throw new Error(
                    `CUT @${op.register}: the block matches ${hits.length} places (e.g. lines ${hits
                      .slice(0, 3)
                      .map((h) => h + 1)
                      .join(", ")}); extend it with surrounding lines to disambiguate`,
                  )
                }
                registers.set(op.register, work.slice(hits[0], hits[0] + op.block.length))
                work.splice(hits[0], op.block.length)
                continue
              }
              if (op.kind === "paste") {
                const content = registers.get(op.register)
                if (!content) {
                  throw new Error(`PASTE @${op.register}: no CUT @${op.register} in this patch`)
                }
                const hits = findMatches(work, op.context)
                if (hits.length === 0) {
                  // Fallback tier for the context anchor (fragments +
                  // tolerance ladder). The anchor maps to the LINE containing
                  // the span: "PASTE AFTER: <fragment>" means after that
                  // line, not after the fragment's char position.
                  try {
                    const joined = work.join("\n")
                    const span = resolveSpan(joined, op.context.join("\n"))
                    const lineIdx = lineOf(span.index, joined) - 1
                    work.splice(op.after ? lineIdx + 1 : lineIdx, 0, ...content)
                    fallbackNotes.push(`PASTE @${op.register} context matched via ${span.tier} at line ${lineIdx + 1} - inserted ${content.length} lines`)
                    continue
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    if (msg.toLowerCase().includes("multiple matches")) {
                      throw new Error(
                        `PASTE @${op.register}: the context fragment matches several places - extend it with surrounding text to disambiguate`,
                      )
                    }
                    throw new Error(
                      `PASTE @${op.register}: no match for the context block \`${(op.context[0] ?? "").slice(0, 60)}\` in ${showPath} - copy it byte-exact from the read output`,
                    )
                  }
                }
                if (hits.length > 1) {
                  throw new Error(
                    `PASTE @${op.register}: the context block matches ${hits.length} places (e.g. lines ${hits
                      .slice(0, 3)
                      .map((h) => h + 1)
                      .join(", ")}); extend it with surrounding lines to disambiguate`,
                  )
                }
                work.splice(op.after ? hits[0] + op.context.length : hits[0], 0, ...content)
                continue
              }
              const hits = findMatches(work, op.old)
              if (hits.length === 0) {
                // Fallback tier: string matching on the joined content -
                // partial-line fragments (the kv-offload class) and
                // transcription drift (the tolerance ladder) both resolve
                // here. Fail-closed: unique candidates only.
                try {
                  const joined = work.join("\n")
                  const span = resolveSpan(joined, op.old.join("\n"))
                  const before = joined.slice(0, span.index)
                  const after = joined.slice(span.index + span.length)
                  work = toWork(before + op.new.join("\n") + after)
                  fallbackNotes.push(`OLD matched via ${span.tier} at line ${lineOf(span.index, joined)}`)
                  continue
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e)
                  if (msg.toLowerCase().includes("multiple matches")) {
                    throw new Error(
                      `ambiguous - the OLD block fragment matches several places; extend it with surrounding text to disambiguate`,
                    )
                  }
                  const first = op.old[0]
                  const similar = work.findIndex((l) => l === first)
                  if (similar >= 0) {
                    // The first line matched but the full block did not.
                    // Distinguish the two mechanisms: STALE content (the
                    // file changed since the block was current - the quoted
                    // lines no longer exist at/after the match) vs DRIFT
                    // (the lines exist but differ by whitespace or bytes
                    // invisible in the read display). The guidance differs:
                    // stale -> re-read and quote the CURRENT content;
                    // drift -> copy byte-exact or shorten.
                    const i = op.old.findIndex((l, idx) => l !== work[similar + idx])
                    const mismatch = i >= 0 ? i : 0
                    const fileLine = work[similar + mismatch]
                    const oldLine = op.old[mismatch]!
                    // Surface BOTH lines in the failure message: the tool has
                    // them in scope here, and quoting the file's actual line
                    // turns a drift/whitespace failure into an immediately
                    // visible mismatch (the agent can see HOW its block
                    // differs and fix it) instead of a line-number-only
                    // "doesn't match" that invites a blind resubmit of the
                    // same typo.
                    const show = (line: string | undefined) => {
                      const s = (line ?? "").trim()
                      return s.length > 120 ? `${s.slice(0, 120)}...` : s
                    }
                    if (fileLine === undefined) {
                      throw new Error(
                        `no match for the OLD block in ${showPath} - line ${mismatch + 1} extends past the end of the file (line ${similar + mismatch + 1} does not exist); the file changed since this content was current - re-read or quote the current content`,
                      )
                    }
                    if (oldLine.trim() === fileLine.trim()) {
                      throw new Error(
                        `no match for the OLD block in ${showPath} - line ${mismatch + 1} differs from file line ${similar + mismatch + 1} by whitespace only (invisible in the read output):\n  your block: '${show(oldLine)}'\n  file:       '${show(fileLine)}'\nCopy it byte-exact, or use a shorter unique block`,
                      )
                    }
                    const elsewhere = work.findIndex((l) => l === oldLine)
                    throw new Error(
                      elsewhere >= 0
                        ? `no match for the OLD block in ${showPath} - line ${mismatch + 1} of your block is at file line ${elsewhere + 1}, not ${similar + mismatch + 1}:\n  your block: '${show(oldLine)}'\n  file line ${elsewhere + 1}: '${show(work[elsewhere])}'\n  file line ${similar + mismatch + 1}: '${show(fileLine)}'\nThe file changed since this content was current - re-read or quote the current content`
                        : `no match for the OLD block in ${showPath} - line ${mismatch + 1} is not in the file:\n  your block: '${show(oldLine)}'\n  file line ${similar + mismatch + 1}: '${show(fileLine)}'\nThe file changed since this content was current - re-read or quote the current content`,
                    )
                  }
                  // Nothing matched in this file at all. The block may live
                  // in ANOTHER file (a wrong [PATH] header) - a bounded grep
                  // over the worktree for the block's first meaningful line
                  // surfaces the real home when it exists, so the agent sees
                  // 'you wrote foo.ts but this content is bar.ts'.
                  const hint = yield* wrongFileHint(ripgrep, instance.directory, sourcePath, op.old)
                  throw new Error(
                    hint + `no match for \`${first.slice(0, 60)}\` in ${showPath} - copy the OLD block byte-exact from the read output (the file may have changed - re-read first)`,
                  )
                }
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
              fallbackNotes: [...fallbackNotes],
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

            plan.diff = diffPatch(plan.targetPath, plan.before, plan.after)
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
            plan.diff = diffPatch(plan.targetPath, plan.before, plan.after)
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
          // Location echo on EVERY path: the changed line ranges derived from
          // the diff hunks, so the agent knows what actually changed even on
          // byte-exact matches (where the fallback echo does not fire). The
          // one-line summary is the cheap close of the exact-path feedback
          // gap (upstream's feedback is the TUI + the next read; the model
          // sees only the output text).
          // Changed-position walk over the actual line diff (the patch
          // hunks carry diff context - a small file renders as one whole-
          // file hunk, which would misreport the ranges).
          const changedPositions = (plan: Plan): string[] => {
            const ranges: string[] = []
            const formatRange = (a: number, b: number) => (a === b ? `${a}` : `${a}-${b}`)
            // Track positions in BOTH files: additions live at their NEW
            // positions, removals at their OLD positions (the lines the
            // agent saw in its last read). A removal followed by an
            // addition (before the next context) is a REPLACE - the
            // addition reports the merged NEW-space location, the removal
            // is skipped. A PURE removal (deletion-only edit) reports the
            // deleted lines' OLD positions - it must never collapse to
            // "no change" (the 2026-08-17 misreport: a 5-line deletion
            // walked to an empty range list and was summarized as
            // "no change" while the file DID change).
            let newPos = 1
            let oldPos = 1
            const changes = diffLines(plan.before, plan.after)
            for (let i = 0; i < changes.length; i++) {
              const change = changes[i]!
              const count = change.count ?? 1
              if (change.added) {
                ranges.push(formatRange(newPos, newPos + count - 1))
                newPos += count
              } else if (change.removed) {
                // Skip to the next non-removed change: if it is an
                // addition, this removal is the delete side of a replace
                // and the addition reports the location.
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
          const lineSummary = (plan: Plan): string => {
            const rel = path.relative(instance.worktree, plan.targetPath)
            const counts = `(+${plan.additions}/-${plan.deletions})`
            // changedPlansOut only holds plans with a NON-EMPTY diff - a
            // "no change" verdict here would be a lie (the 2026-08-17
            // deletion-only misreport). The walk reports deletion-only
            // edits at their OLD positions; if it ever finds no range, fall
            // back to the counts alone rather than claiming no change.
            const ranges = changedPositions(plan)
            const label = ranges.length > 0 ? `${ranges.join(", ")} ${counts}` : counts
            return `${rel}: ${label}`
          }
          const changedPlansOut = plans.filter((p) => !p.deleted && p.diff.length > 0)
          if (changedPlansOut.length > 0) {
            // Single-file edits omit the path (the title carries it)
            const summaries = changedPlansOut.map(lineSummary)
            output += "\nChanged lines: " + (changedPlansOut.length > 1 ? summaries.join("; ") : summaries[0].split(": ")[1])
          }
          // Ladder-fire echo: when any fallback tier matched (not byte-exact),
          // the agent must also see the tier + the applied change - so a
          // tolerated match on the wrong span is immediately visible and
          // correctable.
          const fallbacks = plans.flatMap((p) => p.fallbackNotes)
          if (fallbacks.length > 0) {
            output += `\nMatched with tolerance (not byte-exact): ${fallbacks.join("; ")}.\nApplied change:\n${diffs.join("\n")}`
          }
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
