import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from "node:fs"
import { resolve, dirname, basename, join } from "node:path"
import z from "zod"

const BACKUP_DIR = "/tmp/opencode/file-edit-backup"
const BACKUP_MAX_AGE_MINUTES = 60

export default {
  description: `Line-based file transforms for refactoring. Avoids re-outputting large code blocks that the built-in edit tool requires as exact oldString matches.

OPERATIONS (all in a single call, applied bottom-up by descending line number so earlier ops don't shift later line numbers):
- read: return line range with line numbers (no write). Use to verify line numbers before transforming.
- insert: insert content AFTER line N (line N preserved, new content goes after). 0=prepend, -1=append. insertAfterLine accepted as alias. For inserting BEFORE line N, use insertBeforeLine:N (line N preserved, new content goes before).
- append: alias for insert atLine=-1 (appends to end of file).
- delete: delete line range (start, end inclusive)
- replace: replace line range with content
- move: move block within same file (start, end, insertAfterLine)
- moveToFile: move block to another file (start, end, targetFile, insertAfterLine for mid-file insertion)
- extractToFile: copy block to a new file (source unchanged; optional content header prepended)

PER-TYPE REQUIRED fields (validated before any file is written):

| type | required | optional |
|------|----------|----------|
| read | start, end | — |
| insert | atLine (or insertAfterLine alias) | content, insertBeforeLine |
| append | — | content |
| delete | start, end | startAnchor, endAnchor |
| replace | start, end, content | startAnchor, endAnchor |
| move | start, end, insertAfterLine | startAnchor, endAnchor |
| moveToFile | start, end, targetFile, insertAfterLine | startAnchor, endAnchor |
| extractToFile | start, end, targetFile (or extractToFile alias) | content (header prepended), startAnchor, endAnchor |

ANCHOR VERIFICATION (OPTIONAL, PRE-WRITE): For delete/replace/move/moveToFile/extractToFile ops, pass \`startAnchor\` and/or \`endAnchor\` as short substrings expected at the boundary lines (lines[start-1] and lines[end-1] respectively). The tool verifies each anchor is a substring of the actual boundary line before any file is written. On mismatch, it throws with the actual line content so you can see the offset. Cost: ~10-15 input tokens per anchor; catches line-number miscounting at zero rollback cost.

BOUNDARY PREVIEW (ALWAYS-ON, POST-WRITE): Diff output for every delete/replace/move/moveToFile/extractToFile hunk is prefixed with the first and last line content of the affected range, e.g. \`[delete lines 65-72]\nfirst (65): filePath: z.string()...\nlast  (72): extractToFile:...\`. Inspect these against your intent when verifying the diff post-edit.

DESTINATION ANCHOR VERIFICATION (OPTIONAL, PRE-WRITE): For move/insert ops, pass \`destAnchor\` as a short substring expected at the destination line (the line at \`insertAfterLine\`/\`atLine\`/\`insertBeforeLine\`). The tool verifies the destAnchor is a substring of the actual destination line before committing. On mismatch, throws with the actual line content so you can see the miscounted target. Catches wrong-destination errors that startAnchor/endAnchor (source-side) cannot catch.

TERMINATOR WARNING (OPT-IN via \`warnOnTerminator: true\`): When \`atLine\`/\`insertAfterLine\`/\`insertBeforeLine\` targets a line matching common block terminator patterns (\`;;\`, \`}\`, \`esac\`, \`fi\`, \`done\`, \`end\`), emits a warning: "Inserting adjacent to a terminator line (;;) may place content outside the block — consider insertBeforeLine:N-1 or replace the terminator with content that includes new line + old terminator." Suppress with \`suppressTerminatorWarning: true\`.

MULTI-FILE BATCH: Pass \`files: [{filePath, operations}, ...]\` instead of top-level filePath+operations to apply transforms across multiple files atomically (all validated before any write). Useful for bulk edits like skill description updates across many files.

LINE NUMBER RULES:
- All line numbers are 1-indexed (first line = 1)
- start/end are inclusive ranges
- atLine/insertAfterLine: 0 = prepend, -1 = append, N = AFTER line N (line N preserved, new content goes after)
- insertBeforeLine: N = BEFORE line N (line N preserved, new content goes before). Use for inserting before a terminator line without replacing it.
- Operations use original line numbers (before any transforms). Bottom-up sorting ensures higher line numbers processed first.
- Overlapping ranges in the same file are rejected (validation error)

CROSS-FILE:
- moveToFile: reads block from source, deletes from source, inserts at insertAfterLine in target. Target created if it doesn't exist.
- extractToFile: reads block from source, writes to target (source unchanged). Optional content header prepended.

OUTPUT: unified diff with line count header per file. Multiple scattered edits produce distinct hunks with accurate line numbers.

SAFETY (NON-NEGOTIABLE): Wrong line numbers = wrong content deleted/modified. Multiple incidents of cascading damage.
1. Always Read target lines before editing — confirm content at specified lines matches expectations. Line numbers shift after earlier edits in same session.
2. Batch related changes into single multi-operation call — avoids line-shift accumulation between sequential edits. If batching isn't possible, re-read file between operations.
3. Verify with \`bash -n\` after bash script edits — catch syntax errors before testing.

BACKUPS: auto-created for all write operations (delete/replace/insert/move/moveToFile/extractToFile) by the tool-refine plugin. Backup path reported in output. Kept for 1 hour in /tmp/opencode/file-edit-backup/. To roll back: cp /tmp/opencode/file-edit-backup/<timestamp>/<file> <original_path>.

USE FOR: extracting functions, moving code blocks between files, replacing large line ranges, bulk multi-operation refactoring. Use a read op first to verify line numbers, then transform.

WORKFLOW:
1. Read target lines: file_edit({ filePath: "/path", operations: [{ type: "read", start: 50, end: 80 }] })
2. Apply transform: file_edit({ filePath: "/path", operations: [{ type: "replace", start: 50, end: 80, content: "..." }] })
3. For large refactors, batch multiple ops in one call to avoid line-shift accumulation.

All operations validated before any file is written (atomic). If any fails, no files are modified. LCS-based diff for files <~7000 lines, simple add/remove-all for larger.`,
  args: {
    filePath: z.string().optional().describe("Primary file path (absolute or relative to cwd). Omit when using multi-file batch mode (files: [...])."),
    operations: z.array(z.object({
      type: z.enum(["read", "insert", "append", "delete", "replace", "move", "moveToFile", "extractToFile"]),
      start: z.number().optional().describe("Start line (1-indexed). Required for read/delete/replace/move/moveToFile/extractToFile."),
      end: z.number().optional().describe("End line (1-indexed, inclusive). Required for read/delete/replace/move/moveToFile/extractToFile."),
      atLine: z.number().optional().describe("Insert AFTER line N (line N preserved, new content goes after). 0=prepend, -1=append. Required for insert (or insertAfterLine alias). For BEFORE line N use insertBeforeLine."),
      insertAfterLine: z.number().optional().describe("Insert position for move/moveToFile (also accepted as atLine alias for insert). Required for move/moveToFile."),
      insertBeforeLine: z.number().optional().describe("Insert BEFORE line N (line N preserved, new content goes before). Optional for insert; use when inserting before a terminator line without replacing it."),
      content: z.string().optional().describe("Content for insert/append/replace/extractToFile (header prepended before extracted block). Required for replace."),
      targetFile: z.string().optional().describe("Target file path for moveToFile/extractToFile. Required for moveToFile/extractToFile. Created if it does not exist."),
      extractToFile: z.string().optional().describe("Alias for targetFile when type is extractToFile. Use targetFile or this field interchangeably."),
      startAnchor: z.string().optional().describe("Optional substring expected at lines[start-1] for delete/replace/move/moveToFile/extractToFile. Pre-write check; throws on mismatch with actual line content."),
      endAnchor: z.string().optional().describe("Optional substring expected at lines[end-1] for delete/replace/move/moveToFile/extractToFile. Pre-write check; throws on mismatch with actual line content."),
      destAnchor: z.string().optional().describe("Optional substring expected at the destination line for move/insert ops. Verifies insertAfterLine/atLine/insertBeforeLine target line contains destAnchor before commit. Catches wrong-destination miscounting."),
      warnOnTerminator: z.boolean().optional().describe("Opt-in: warn when atLine/insertAfterLine/insertBeforeLine targets a terminator line (;;, }, esac, fi, done, end). Helps catch insert-after-terminator placement outside block."),
      suppressTerminatorWarning: z.boolean().optional().describe("Suppress the terminator warning even when warnOnTerminator is true. Use when intentionally inserting adjacent to a terminator."),
    })).optional().describe("Operations to apply. Processed bottom-up by descending line number within each file. Required when not using multi-file batch."),
    files: z.array(z.object({
      filePath: z.string().describe("File path for this batch entry."),
      operations: z.array(z.object({
        type: z.enum(["read", "insert", "append", "delete", "replace", "move", "moveToFile", "extractToFile"]),
        start: z.number().optional(),
        end: z.number().optional(),
        atLine: z.number().optional(),
        insertAfterLine: z.number().optional(),
        insertBeforeLine: z.number().optional(),
        content: z.string().optional(),
        targetFile: z.string().optional(),
        extractToFile: z.string().optional(),
        startAnchor: z.string().optional(),
        endAnchor: z.string().optional(),
        destAnchor: z.string().optional(),
        warnOnTerminator: z.boolean().optional(),
        suppressTerminatorWarning: z.boolean().optional(),
        suppressInvertedNestingWarning: z.boolean().optional().describe("Suppress inverted-nesting warning when inserting a higher-level header after a sub-header target."),
      })).describe("Operations for this file."),
    })).optional().describe("Multi-file batch mode: apply operations across multiple files atomically. All files validated before any write. Mutually exclusive with top-level filePath+operations."),
    backup: z.boolean().optional().describe("Create backup in /tmp before writing. Kept for 1 hour. Path reported in output for rollback."),
    summaryOnly: z.boolean().optional().describe("Force summary-only output (per-op status table + line-count deltas, no full diff body). Auto-triggers when total diff body would exceed ~25KB. Override with full_diff=true to force full inline diff regardless of size."),
    fullDiff: z.boolean().optional().describe("Force full inline unified diff output regardless of size. Overrides summaryOnly auto-trigger. Use for deep inspection of every changed line."),
  },
  async execute(args, ctx) {
    cleanOldBackups()
    const wantBackup = args.backup === true

    const batchEntries = args.files
      ? args.files.map(e => ({ filePath: resolve(e.filePath), operations: e.operations || [] }))
      : [{ filePath: resolve(args.filePath), operations: args.operations || [] }]

    if (!args.files && !args.filePath) throw new Error("Either filePath+operations (single file) or files: [...] (multi-file batch) is required")
    if (args.files && args.filePath) throw new Error("Cannot mix filePath and files — pick single-file or multi-file batch mode")

    for (const entry of batchEntries) {
      if (entry.operations.length === 0) throw new Error(`No operations provided for ${entry.filePath}`)
      if (!existsSync(entry.filePath)) throw new Error(`File not found: ${entry.filePath}`)
      for (let i = 0; i < entry.operations.length; i++) {
        const op = entry.operations[i]
        const req = (field) => {
          if (op[field] === undefined || op[field] === null) throw new Error(`${field} is required for type=${op.type} (op ${i}, ${entry.filePath})`)
        }
        switch (op.type) {
          case "read": case "delete": req("start"); req("end"); break
          case "replace": req("start"); req("end"); req("content"); break
          case "insert":
            if (op.atLine === undefined && op.insertAfterLine === undefined && op.insertBeforeLine === undefined) throw new Error(`atLine (or insertAfterLine alias, or insertBeforeLine) is required for type=insert (op ${i}, ${entry.filePath}). 0=prepend, -1=append, N=after line N (atLine/insertAfterLine) or before line N (insertBeforeLine).`)
            if (op.insertBeforeLine !== undefined && op.insertBeforeLine < 1) throw new Error(`insertBeforeLine must be >= 1 (op ${i}, ${entry.filePath}). Line 0 does not exist in 1-indexed files; use atLine:0 for prepend.`)
            break
          case "move": req("start"); req("end"); req("insertAfterLine"); break
          case "moveToFile": req("start"); req("end"); req("targetFile"); req("insertAfterLine"); break
          case "extractToFile": req("start"); req("end"); if (!op.targetFile && !op.extractToFile) throw new Error(`targetFile (or extractToFile alias) is required for type=extractToFile (op ${i}, ${entry.filePath})`); break
          case "append": break
        }
      }
    }

    const allFileOps = {}
    for (const entry of batchEntries) {
      const { fileOps } = planOperations(entry.filePath, entry.operations)
      for (const [fPath, ops] of Object.entries(fileOps)) {
        const lineOps = ops.filter(o => o.kind !== "read")
        if (lineOps.length > 1) {
          validateNoOverlap(lineOps.map(o => ({
            start: o.start, end: o.end, atLine: o.atLine, insertAfterLine: o.insertAfterLine, type: o.kind
          })), fPath)
        }
        allFileOps[fPath] = ops
      }
    }

    const allResults = []
    const fileDiffs = []
    const filesToWrite = []
    let backupDir = null

    for (const [fPath, ops] of Object.entries(allFileOps)) {
      const resolvedPath = resolve(fPath)
      const writeOps = ops.filter(o => o.kind !== "read")
      if (writeOps.length === 0 && !ops.some(o => o.kind === "read")) continue

      const originalContent = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf-8") : ""
      const originalLines = originalContent ? originalContent.split("\n") : []
      const hadTrailingNewline = originalContent.endsWith("\n")
      if (hadTrailingNewline && originalLines[originalLines.length - 1] === "") originalLines.pop()

      const { modified, results } = applyOps(originalLines, ops)
      allResults.push(...results)

      if (writeOps.length === 0) {
        const readResults = results.filter(r => r.type === "read")
        if (readResults.length > 0) return readResults.map(r => r.lines).join("\n...\n")
        continue
      }

      const newContent = modified.join("\n") + (hadTrailingNewline || modified.length === 0 ? "\n" : "")
      const diff = generateDiff(resolvedPath, originalContent, newContent, ops)
      if (diff) fileDiffs.push({ path: resolvedPath, diff, oldLines: originalLines.length, newLines: modified.length })
      filesToWrite.push({ path: resolvedPath, content: newContent, originalContent })

      if (wantBackup) {
        if (!backupDir) backupDir = createBackupDir()
        const backupPath = join(backupDir, basename(resolvedPath).replace(/[^a-zA-Z0-9._-]/g, "_"))
        writeFileSync(backupPath, originalContent, "utf-8")
      }
    }

    for (const f of filesToWrite) {
      mkdirSync(dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content, "utf-8")
    }

    return formatOutput(fileDiffs, allResults, Object.values(allFileOps).flat().length, wantBackup, backupDir, args.summaryOnly, args.fullDiff)
  },
}

function generateDiff(filePath, oldContent, newContent, ops = []) {
  const oldLines = oldContent.split("\n")
  const newLines = newContent.split("\n")
  const diffs = computeLCS(oldLines, newLines)
  if (diffs.length === 0) return ""
  const fileName = basename(filePath)
  let diff = `--- a/${fileName}\n+++ b/${fileName}\n`
  for (const op of ops) {
    if (op.kind === "read" || op.kind === "insert") continue
    const s = op.start, e = op.end
    if (s === undefined || e === undefined) continue
    const first = oldLines[s - 1] || ""
    const last = oldLines[e - 1] || ""
    diff += `[${op.kind} lines ${s}-${e}]\nfirst (${s}): ${first}\nlast  (${e}): ${last}\n`
  }
  const contextSize = 3
  const hunks = []
  let currentHunk = null
  let oldLineNum = 0
  let newLineNum = 0
  for (const d of diffs) {
    if (d.type === "equal") {
      if (currentHunk && (oldLineNum - currentHunk.oldEnd > contextSize)) { hunks.push(currentHunk); currentHunk = null }
      oldLineNum++; newLineNum++
    } else {
      if (!currentHunk) {
        const contextStart = Math.max(0, oldLineNum - contextSize)
        currentHunk = { oldStart: contextStart + 1, newStart: (newLineNum - (oldLineNum - contextStart)) + 1, oldEnd: oldLineNum - 1, lines: [] }
        for (let i = contextStart; i < oldLineNum; i++) currentHunk.lines.push({ type: "equal", line: oldLines[i] })
        currentHunk.oldStart = contextStart + 1
        currentHunk.newStart = newLineNum - (oldLineNum - contextStart) + 1
        currentHunk.oldEnd = oldLineNum - 1
      }
      if (d.type === "removed") { currentHunk.lines.push({ type: "removed", line: d.line }); currentHunk.oldEnd = oldLineNum; oldLineNum++ }
      else if (d.type === "added") { currentHunk.lines.push({ type: "added", line: d.line }); currentHunk.oldEnd = oldLineNum - 1; newLineNum++ }
    }
  }
  if (currentHunk) hunks.push(currentHunk)
  for (const hunk of hunks) {
    hunk.oldLen = hunk.lines.filter(l => l.type !== "added").length
    hunk.newLen = hunk.lines.filter(l => l.type !== "removed").length
  }
  for (const hunk of hunks) {
    let oldStart = hunk.oldStart, newStart = hunk.newStart
    let oldCount = 0, newCount = 0
    const formattedLines = []
    for (const l of hunk.lines) {
      if (l.type === "equal") { formattedLines.push(" " + l.line); oldCount++; newCount++ }
      else if (l.type === "added") { formattedLines.push("+" + l.line); newCount++ }
      else if (l.type === "removed") { formattedLines.push("-" + l.line); oldCount++ }
    }
    diff += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
    diff += formattedLines.join("\n") + "\n"
  }
  return diff.trimEnd()
}

function computeLCS(oldLines, newLines) {
  const n = oldLines.length, m = newLines.length
  if (n * m > 50000000) return simpleDiff(oldLines, newLines)
  const dp = []
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { result.push({ type: "equal", line: oldLines[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: "removed", line: oldLines[i] }); i++ }
    else { result.push({ type: "added", line: newLines[j] }); j++ }
  }
  while (i < n) result.push({ type: "removed", line: oldLines[i++] })
  while (j < m) result.push({ type: "added", line: newLines[j++] })
  return result
}

function simpleDiff(oldLines, newLines) {
  const result = []
  for (const line of oldLines) result.push({ type: "removed", line })
  for (const line of newLines) result.push({ type: "added", line })
  return result
}

function cleanOldBackups() {
  try {
    if (!existsSync(BACKUP_DIR)) return
    const now = Date.now()
    const maxAge = BACKUP_MAX_AGE_MINUTES * 60 * 1000
    for (const entry of readdirSync(BACKUP_DIR)) {
      const entryPath = join(BACKUP_DIR, entry)
      try { if (now - statSync(entryPath).mtimeMs > maxAge) rmSync(entryPath, { recursive: true }) } catch {}
    }
  } catch {}
}

function createBackupDir() {
  const dir = join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, "-"))
  mkdirSync(dir, { recursive: true })
  return dir
}

function validateNoOverlap(ops, fileName) {
  const ranges = []
  for (const op of ops) {
    if (op.start !== undefined && op.end !== undefined) ranges.push({ start: op.start, end: op.end, type: op.type })
    if (op.atLine !== undefined) ranges.push({ start: op.atLine + 1, end: op.atLine + 1, type: op.type })
    if (op.insertAfterLine !== undefined && op.insertAfterLine > 0) ranges.push({ start: op.insertAfterLine + 1, end: op.insertAfterLine + 1, type: op.type })
  }
  ranges.sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start <= ranges[i - 1].end) throw new Error(`Overlapping line ranges in ${fileName}: [${ranges[i - 1].start}-${ranges[i - 1].end}] (${ranges[i - 1].type}) overlaps [${ranges[i].start}-${ranges[i].end}] (${ranges[i].type})`)
  }
}

function planOperations(filePath, operations) {
  const fileOps = { [filePath]: [] }
  const fileContents = {}
  const getLine = (n) => {
    if (!fileContents[filePath]) fileContents[filePath] = readFileSync(filePath, "utf-8").split("\n")
    return fileContents[filePath][n - 1] || ""
  }
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    const targetPath = (op.targetFile || op.extractToFile) ? resolve(op.targetFile || op.extractToFile) : null
    if (op.startAnchor !== undefined && op.start !== undefined) {
      const actual = getLine(op.start)
      if (!actual.includes(op.startAnchor)) {
        throw new Error(`startAnchor mismatch at op ${i} (${op.type}), line ${op.start}: expected substring "${op.startAnchor}" not found. Actual: "${actual}"`)
      }
    }
    if (op.endAnchor !== undefined && op.end !== undefined) {
      // R5: auto-scan backward from nominal end line to find last non-blank content line (handles trailing blank lines after text blocks)
      let actualEndLine = getLine(op.end)
      let effectiveEnd = op.end
      while (effectiveEnd > op.start && (actualEndLine === "" || actualEndLine.trim() === "") && op.endAnchor !== undefined) {
        effectiveEnd--
        actualEndLine = getLine(effectiveEnd)
      }
      if (!actualEndLine.includes(op.endAnchor)) {
        throw new Error(`endAnchor mismatch at op ${i} (${op.type}), line ${effectiveEnd} (auto-scanned from ${op.end}): expected substring "${op.endAnchor}" not found. Actual: "${actualEndLine}"`)
      }
    }
    // Destination anchor verification + terminator warning (R4 + R2, 2026-07-11 BUG_FILE_EDIT_MANGLING.md)
    if (op.destAnchor !== undefined || (op.warnOnTerminator === true && op.suppressTerminatorWarning !== true)) {
      let destLineNum = null
      let isAfterDirection = false
      if (op.type === "insert" || op.type === "append") {
        if (op.atLine !== undefined) { destLineNum = op.atLine; isAfterDirection = true }
        else if (op.insertAfterLine !== undefined) { destLineNum = op.insertAfterLine; isAfterDirection = true }
        else if (op.insertBeforeLine !== undefined) { destLineNum = op.insertBeforeLine; isAfterDirection = false }
      } else if (op.type === "move" || op.type === "moveToFile") {
        destLineNum = op.insertAfterLine; isAfterDirection = true
      } else if (op.type === "extractToFile") {
        destLineNum = -1
      }
      if (destLineNum !== null && destLineNum >= 1) {
        const destPath = targetPath || filePath
        if (!fileContents[destPath]) fileContents[destPath] = readFileSync(destPath, "utf-8").split("\n")
        const destLine = fileContents[destPath][destLineNum - 1] || ""
        if (op.destAnchor !== undefined && !destLine.includes(op.destAnchor)) {
          throw new Error(`destAnchor mismatch at op ${i} (${op.type}), dest line ${destLineNum}: expected substring "${op.destAnchor}" not found. Actual: "${destLine}"`)
        }
        if (op.warnOnTerminator === true && op.suppressTerminatorWarning !== true && isAfterDirection) {
          const terminatorPatterns = /^(;;|}\s*$|esac|fi|done|end)\s*$/
          if (terminatorPatterns.test(destLine.trim())) {
            throw new Error(`Terminator warning at op ${i} (${op.type}), dest line ${destLineNum}: target line "${destLine.trim()}" is a block terminator. Inserting AFTER a terminator places content outside the block. Use insertBeforeLine:${destLineNum} to insert before the terminator (inside the block), or replace the terminator line with content that includes new line + old terminator, or set suppressTerminatorWarning:true to suppress.`)
          }
        }
      }
    }
    // R7: insert inverted-nesting warning — detects when insert content starts with a header of higher level than the target line (produces inverted nesting)
    if (op.type === "insert" || op.type === "append") {
      const contentFirstLine = (op.content || "").split("\n")[0] || ""
      const targetLineNum = (op.atLine !== undefined) ? op.atLine : (op.insertAfterLine !== undefined) ? op.insertAfterLine : (op.insertBeforeLine !== undefined) ? op.insertBeforeLine : null
      if (targetLineNum !== null && targetLineNum >= 1) {
        const targetPath = filePath
        if (!fileContents[targetPath]) fileContents[targetPath] = readFileSync(targetPath, "utf-8").split("\n")
        const targetLine = fileContents[targetPath][targetLineNum - 1] || ""
        const contentHeaderMatch = contentFirstLine.match(/^(#{1,6})\s/)
        const targetHeaderMatch = targetLine.match(/^(#{1,6})\s/)
        if (contentHeaderMatch && targetHeaderMatch) {
          const contentLevel = contentHeaderMatch[1].length
          const targetLevel = targetHeaderMatch[1].length
          if (contentLevel < targetLevel) {
            // Content has higher-level header (fewer #) than target — inverted nesting
            const warnMsg = `Insert inverted-nesting warning at op ${i} (${op.type}), target line ${targetLineNum}: inserted content starts with "${contentFirstLine.trim()}" (H${contentLevel}) but target line is "${targetLine.trim()}" (H${targetLevel}). Inserting a higher-level header AFTER a sub-header produces inverted nesting. Consider targeting the parent section boundary (the line before the sub-header's parent ## header), or use insertBeforeLine to insert before the sub-header instead. Set suppressInvertedNestingWarning:true to suppress.`
            if (op.suppressInvertedNestingWarning !== true) {
              throw new Error(warnMsg)
            }
          }
        }
      }
    }
    switch (op.type) {
      case "read":
        fileOps[filePath].push({ kind: "read", start: op.start, end: op.end, opIndex: i }); break
      case "insert":
        let insertAt
        let isInsertBefore = false
        if (op.insertBeforeLine !== undefined) {
          insertAt = op.insertBeforeLine - 1
          isInsertBefore = true
        } else if (op.atLine !== undefined) {
          insertAt = op.atLine
        } else if (op.insertAfterLine !== undefined) {
          insertAt = op.insertAfterLine
        }
        fileOps[filePath].push({ kind: "insert", atLine: insertAt, content: op.content || "", opIndex: i, isInsertBefore }); break
      case "append":
        fileOps[filePath].push({ kind: "insert", atLine: -1, content: op.content || "", opIndex: i }); break
      case "delete":
        fileOps[filePath].push({ kind: "delete", start: op.start, end: op.end, opIndex: i }); break
      case "replace":
        fileOps[filePath].push({ kind: "replace", start: op.start, end: op.end, content: op.content || "", opIndex: i }); break
      case "move":
        if (!fileContents[filePath]) fileContents[filePath] = readFileSync(filePath, "utf-8").split("\n")
        const moveContent = fileContents[filePath].slice(op.start - 1, op.end).join("\n")
        fileOps[filePath].push({ kind: "delete", start: op.start, end: op.end, opIndex: i })
        fileOps[filePath].push({ kind: "insert", atLine: op.insertAfterLine, content: moveContent, opIndex: i, isMove: true }); break
      case "moveToFile":
        if (!fileContents[filePath]) fileContents[filePath] = readFileSync(filePath, "utf-8").split("\n")
        const moveToContent = fileContents[filePath].slice(op.start - 1, op.end).join("\n")
        fileOps[filePath].push({ kind: "delete", start: op.start, end: op.end, opIndex: i })
        if (!fileOps[targetPath]) fileOps[targetPath] = []
        fileOps[targetPath].push({ kind: "insert", atLine: op.insertAfterLine, content: moveToContent, opIndex: i, isMove: true }); break
      case "extractToFile":
        if (!fileContents[filePath]) fileContents[filePath] = readFileSync(filePath, "utf-8").split("\n")
        const extractContent = fileContents[filePath].slice(op.start - 1, op.end).join("\n")
        const fullContent = op.content ? op.content + "\n" + extractContent : extractContent
        if (!fileOps[targetPath]) fileOps[targetPath] = []
        fileOps[targetPath].push({ kind: "insert", atLine: -1, content: fullContent, opIndex: i, isExtract: true }); break
      default: throw new Error(`Unknown operation type: ${op.type}`)
    }
  }
  return { fileOps, fileContents }
}

function applyOps(lines, ops) {
  const sorted = [...ops].map((op, idx) => {
    const sortKey = op.kind === "insert" ? (op.atLine === -1 ? Infinity : op.atLine) : op.start
    return { ...op, sortKey, originalIdx: idx }
  }).sort((a, b) => b.sortKey - a.sortKey)
  const results = []
  let modified = [...lines]
  for (const op of sorted) {
    try {
      if (op.kind === "read") {
        const end = Math.min(op.end, modified.length)
        const start = Math.max(0, op.start - 1)
        const readLines = modified.slice(start, end)
        const numbered = readLines.map((line, i) => `${start + i + 1}: ${line}`)
        results.push({ opIndex: op.opIndex, type: "read", status: "success", lines: numbered.join("\n"), count: numbered.length })
      } else if (op.kind === "insert") {
        const contentLines = op.content.split("\n")
        let insertIdx
        if (op.atLine === -1) insertIdx = modified.length
        else if (op.atLine === 0) insertIdx = 0
        else insertIdx = op.atLine
        if (insertIdx < 0 || insertIdx > modified.length) throw new Error(`Insert position ${op.atLine} out of range (0-${modified.length})`)
        modified.splice(insertIdx, 0, ...contentLines)
        results.push({ opIndex: op.opIndex, type: op.isMove ? "move" : op.isExtract ? "extractToFile" : "insert", status: "success", linesAffected: contentLines.length, atLine: op.atLine, insertBeforeLine: op.isInsertBefore ? op.atLine + 1 : undefined })
      } else if (op.kind === "delete") {
        const start = op.start - 1, end = op.end
        if (start < 0 || end > modified.length || start >= end) throw new Error(`Line range ${op.start}-${op.end} out of range (1-${modified.length})`)
        const deleted = modified.splice(start, end - start)
        results.push({ opIndex: op.opIndex, type: op.isMove ? "move" : "delete", status: "success", linesAffected: deleted.length, start: op.start, end: op.end })
      } else if (op.kind === "replace") {
        const start = op.start - 1, end = op.end
        if (start < 0 || end > modified.length || start >= end) throw new Error(`Line range ${op.start}-${op.end} out of range (1-${modified.length})`)
        const contentLines = op.content.split("\n")
        const oldLines = modified.splice(start, end - start, ...contentLines)
        results.push({ opIndex: op.opIndex, type: "replace", status: "success", linesRemoved: oldLines.length, linesAdded: contentLines.length, start: op.start, end: op.end })
      }
    } catch (err) {
      results.push({ opIndex: op.opIndex, type: op.kind, status: "error", error: err.message })
      throw err
    }
  }
  return { modified, results }
}

function formatOutput(fileDiffs, results, totalOps, backupRequested, backupDir, summaryOnlyFlag, fullDiffFlag) {
  // R6: summary mode auto-trigger + manual override
  const diffBody = fileDiffs.map(f => f.diff || "").join("\n")
  const diffBodyBytes = Buffer.byteLength(diffBody, "utf-8")
  const autoSummary = diffBodyBytes > 25000 // ~25KB threshold
  const wantSummary = (summaryOnlyFlag === true) || (autoSummary && fullDiffFlag !== true)

  const lines = []
  if (wantSummary) {
    // Summary mode: per-op status table + line-count deltas, no full diff body
    for (const f of fileDiffs) {
      lines.push(`*** ${f.path} (${f.oldLines} \u2192 ${f.newLines} lines)`)
    }
    lines.push("")
    for (const r of results) {
      if (r.status === "success") {
        const delta = (r.linesAffected || r.linesAdded || 0) - (r.linesRemoved || 0)
        lines.push(`  op${r.opIndex}: ${r.type} \u2192 success, ${r.linesAffected || r.linesAdded || r.linesRemoved || 0} lines changed (delta ${delta >= 0 ? "+" : ""}${delta})`)
      } else {
        lines.push(`  op${r.opIndex}: ${r.type} \u2192 ERROR: ${r.error}`)
      }
    }
    lines.push("")
    const successCount = results.filter(r => r.status === "success").length
    const errorCount = results.filter(r => r.status === "error").length
    lines.push(`Summary: ${totalOps} operation${totalOps !== 1 ? "s" : ""} (${successCount} succeeded, ${errorCount} errored) across ${fileDiffs.length} file${fileDiffs.length !== 1 ? "s" : ""}`)
    if (autoSummary && fullDiffFlag !== true) lines.push(`(auto-summary triggered: diff body ${diffBodyBytes} bytes > 25KB threshold. Use full_diff=true to force full inline diff.)`)
    if (backupDir) lines.push(`Backup: ${backupDir}`)
    return lines.join("\n")
  }

  // Full diff mode (default for small batches, or when fullDiff=true overrides auto-summary)
  for (const f of fileDiffs) {
    lines.push(`*** ${f.path} (${f.oldLines} \u2192 ${f.newLines} lines)`)
    if (f.diff) lines.push(f.diff)
    lines.push("")
  }
  const successCount = results.filter(r => r.status === "success").length
  const errorCount = results.filter(r => r.status === "error").length
  lines.push(`Summary: ${totalOps} operation${totalOps !== 1 ? "s" : ""} (${successCount} succeeded, ${errorCount} errored) across ${fileDiffs.length} file${fileDiffs.length !== 1 ? "s" : ""}`)
  if (backupDir) lines.push(`Backup: ${backupDir}`)
  return lines.join("\n")
}
