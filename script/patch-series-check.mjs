// Patch-series hygiene gate:
//  - duplicate patch-ID scan over the whole series (a 4-digit ID in the subject
//    must identify one concern). Known revert/restore no-op pairs are allowed.
//  - ancestry: `main` should be an ancestor of `local`; divergence is reported
//    (and only fails with --require-ancestor, which preflight uses).
//  - probe-marker scan on the tip: no PDBG/ppLog/bootTimed/pump-probe/stream-lab
//    in the TUI, opencode, or patch trees. The shipped markers hl.heal,
//    oc-0402 (the highlight self-heal hook), and oc-feed-watchdog are excluded.
// Usage:
//   bun script/patch-series-check.mjs [--require-ancestor]
import { spawnSync } from "node:child_process"

const root = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")
const requireAncestor = process.argv.includes("--require-ancestor")

function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" })
}

function gitText(args) {
  const result = git(args)
  return result.status === 0 ? (result.stdout ?? "").trim() : ""
}

let failed = false

// -- duplicate patch IDs -----------------------------------------------------
// 0387 and 0388 each landed as a follow-up plus a revert/restore no-op pair
// (docs/REVIEW_2026-10-17.md C3); every other duplicate is debt and fails.
const KNOWN_NOOP_PAIRS = {
  "0387": [
    ["ba88c38ec8", "9e0e45d881"],
  ],
  "0388": [
    ["00b15caf5d", "005c3e95ba"],
  ],
}

// Historical duplicate-ID debt from before this gate existed. Renumbering
// means rewriting published SHAs (another lease-guarded force push), so these
// are reported as WARN with their known count until the next wholesale
// renumber. A NEW reuse of one of these IDs (or a new duplicate ID) still
// fails, and any ID not listed here fails immediately.
const KNOWN_DUP_DEBT = {
  "0146": 2,
  "0322": 4,
  "0342": 2,
  "0351": 3,
  "0390": 2,
}

const commits = gitText(["log", "--format=%H%x09%s"])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const tab = line.indexOf("\t")
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
  })
  .map((commit) => {
    const match = commit.subject.match(/\((\d{4})\)/)
    return { ...commit, id: match ? match[1] : null }
  })
  .filter((commit) => commit.id)

const byId = new Map()
for (const commit of commits) {
  if (!byId.has(commit.id)) byId.set(commit.id, [])
  byId.get(commit.id).push(commit)
}

function allowedNoop(id, group) {
  const pairs = KNOWN_NOOP_PAIRS[id]
  if (!pairs) return false
  if (group.length !== 2) return false
  const shas = group.map((commit) => commit.sha)
  return pairs.some((pair) => pair.every((prefix) => shas.some((sha) => sha.startsWith(prefix))))
}

const duplicates = []
const debt = []
for (const [id, group] of [...byId.entries()].sort()) {
  if (group.length < 2) continue
  if (allowedNoop(id, group)) continue
  const cap = KNOWN_DUP_DEBT[id]
  if (cap && group.length <= cap) {
    debt.push({ id, group })
    continue
  }
  duplicates.push({ id, group })
}

if (debt.length) {
  console.log(`WARN duplicate patch IDs (known historical debt, ${debt.length} ID(s))`)
  for (const { id, group } of debt) {
    console.log(`  (${id}) x${group.length} - renumber at the next wholesale rebase`)
  }
}

if (duplicates.length) {
  failed = true
  console.error(`FAIL duplicate patch IDs: ${duplicates.length} ID(s) used by more than one commit`)
  for (const { id, group } of duplicates) {
    console.error(`  (${id}) x${group.length}`)
    for (const commit of group) console.error(`    ${commit.sha.slice(0, 10)} ${commit.subject}`)
  }
} else {
  console.log("PASS duplicate patch IDs")
}

// -- ancestry ----------------------------------------------------------------
const hasLocal = git(["rev-parse", "--verify", "local"]).status === 0
const hasMain = git(["rev-parse", "--verify", "main"]).status === 0
let ancestryFailed = false
if (!hasLocal || !hasMain) {
  ancestryFailed = requireAncestor
  const missing = [!hasLocal && "local", !hasMain && "main"].filter(Boolean).join(", ")
  console.log(`${requireAncestor ? "FAIL" : "WARN"} ancestry: missing branch ${missing}`)
} else {
  const ancestor = git(["merge-base", "--is-ancestor", "main", "local"]).status === 0
  if (ancestor) {
    console.log("PASS ancestry: main is an ancestor of local")
  } else {
    ancestryFailed = requireAncestor
    const base = gitText(["merge-base", "main", "local"])
    const ahead = gitText(["rev-list", "--count", "main..local"])
    const behind = gitText(["rev-list", "--count", "local..main"])
    console.log(`${requireAncestor ? "FAIL" : "WARN"} ancestry: main is NOT an ancestor of local`)
    console.log(`  merge-base: ${base || "(none)"}`)
    console.log(`  local ahead ${ahead}, behind ${behind}`)
    if (base) console.log(`  inspect: git range-diff ${base}..main ${base}..local`)
  }
}
if (ancestryFailed) failed = true

// -- probe markers on the tip ------------------------------------------------
const rev = git(["rev-parse", "--verify", "local"]).status === 0 ? "local" : "HEAD"
const probe = git([
  "grep",
  "-nE",
  "PDBG|ppLog|bootTimed|pump-probe|stream-lab",
  rev,
  "--",
  "packages/tui/src",
  "packages/opencode/src",
  "patches/",
])
const shipped = ["hl.heal", "oc-0402", "oc-feed-watchdog"]
const hits = (probe.stdout ?? "")
  .split("\n")
  .filter(Boolean)
  .filter((line) => !shipped.some((marker) => line.includes(marker)))
if (probe.status !== 0 && probe.status !== 1) {
  failed = true
  console.error("FAIL probe markers: git grep failed")
  console.error((probe.stderr ?? "").trim())
} else if (hits.length) {
  failed = true
  console.error(`FAIL probe markers: ${hits.length} line(s) on ${rev}`)
  for (const line of hits.slice(0, 20)) console.error(`  ${line}`)
} else {
  console.log(`PASS probe markers (note: 0402's hl.heal / oc-0402 / oc-feed-watchdog are shipped)`)
}

// The solid patchfile carries the pump probe kit, gated off by OC_PUMP_PROBE.
// It changes no default behavior; removal is tracked as deferred debt.
const pump = git(["grep", "-n", "OC_PUMP_PROBE", rev, "--", "patches/"])
if ((pump.stdout ?? "").trim()) {
  console.log("WARN shipped probe kit: OC_PUMP_PROBE present in patches/ (gated off; no default behavior)")
}

console.log(failed ? "FAIL patch-series-check" : "PASS patch-series-check")
process.exit(failed ? 1 : 0)
