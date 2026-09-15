// Validates bun patchfiles for the failure classes that break `bun install`
// for anyone building from source:
//  - hunk headers must match their bodies (old/new counts) and the inter-hunk
//    gap must match on both sides. Bun >= 1.4 validates this at PARSE time
//    (hunk_header_integrity_check_failed) and refuses to install; bun < 1.4
//    parses leniently, so drift is invisible locally (0348).
//  - diff headers must be git-style (`diff --git` + `--- a/...` + `+++ b/...`)
//    with NO tab+timestamp suffix - bun's patcher ENOENTs on those (0357).
//  - a hunk that is all context with old == new and zero +/- is a no-op;
//    bun tolerates it but GNU patch rejects all-context hunks as malformed.
//    Always delete the degenerate hunk (0348 left one behind).
// Run after ANY hand-edit of a patchfile, and via .husky/pre-commit:
//   bun script/check-patchfiles.mjs [patchfile...]
// With no args, checks every file in patches/.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const patchesDir = new URL("../patches", import.meta.url).pathname
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(patchesDir).filter((f) => f.endsWith(".patch"))

let failed = false
for (const file of files) {
  const path = file.includes("/") ? file : join(patchesDir, file)
  const lines = readFileSync(path, "utf8").split("\n")
  let cur = null // {oldStart,oldCount,newStart,newCount,gotOld,gotNew,at,plus,minus}
  let n = 0
  const mismatch = (msg) => {
    failed = true
    console.error(`${path}:${cur ? cur.at : n}: ${msg}`)
  }
  const close = (hunk) => {
    if (hunk.oldCount !== hunk.gotOld)
      mismatch(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}: old side has ${hunk.gotOld} lines`,
      )
    if (hunk.newCount !== hunk.gotNew)
      mismatch(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}: new side has ${hunk.gotNew} lines`,
      )
    if (hunk.oldCount === hunk.newCount && hunk.plus === 0 && hunk.minus === 0)
      mismatch(
        `degenerate no-op hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} (all context, no +/-) - delete it; bun tolerates it but GNU patch rejects all-context hunks`,
      )
  }
  for (const line of lines) {
    n++
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (h) {
      if (cur) {
        close(cur)
        const oldGap = Number(h[1]) - (cur.oldStart + cur.oldCount)
        const newGap = Number(h[3]) - (cur.newStart + cur.newCount)
        if (oldGap !== newGap)
          mismatch(
            `hunk start gap mismatch: old-side gap ${oldGap} vs new-side gap ${newGap} before @@ -${h[1]} +${h[3]}`,
          )
      }
      cur = {
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        gotOld: 0,
        gotNew: 0,
        plus: 0,
        minus: 0,
        at: n,
      }
      continue
    }
    if (!cur) {
      // Outside a hunk body: diff header lines and inter-file junk. Bun's
      // patcher ENOENTs when --- / +++ carry a tab+timestamp suffix
      // (GNU diff style) - git style has none.
      if ((line.startsWith("--- ") || line.startsWith("+++ ")) && line.includes("\t"))
        mismatch(`tab+timestamp in diff header line - bun's patcher ENOENTs on these: ${JSON.stringify(line.slice(0, 80))}`)
      continue
    }
    const remaining = cur.oldCount - cur.gotOld + (cur.newCount - cur.gotNew)
    if (remaining === 0) {
      // A completed hunk ends at the next @@ OR at the next file section
      // header (patches without diff --git lines, e.g. @dnd-kit/dom).
      close(cur)
      cur = null
      if ((line.startsWith("--- ") || line.startsWith("+++ ")) && line.includes("\t"))
        mismatch(`tab+timestamp in diff header line - bun's patcher ENOENTs on these: ${JSON.stringify(line.slice(0, 80))}`)
      continue
    }
    if (line.startsWith(" ")) {
      cur.gotOld++
      cur.gotNew++
    } else if (line.startsWith("-")) {
      cur.gotOld++
      cur.minus++
    } else if (line.startsWith("+")) {
      cur.gotNew++
      cur.plus++
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" - no line content
    } else {
      // Anything else inside an unfinished hunk body is malformed.
      mismatch(`unexpected line inside hunk body: ${JSON.stringify(line.slice(0, 60))}`)
      cur = null
    }
  }
  if (cur) close(cur)
  if (!failed) console.log(`${path}: all hunks consistent, headers git-style`)
}
process.exit(failed ? 1 : 0)
