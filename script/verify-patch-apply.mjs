// End-to-end check that every bun patchfile in patches/ still produces the
// package tree that is installed in node_modules - i.e. what a fresh clone +
// `bun install` (bun >= 1.4, which validates patchfiles strictly) will build.
//
// For each patches/<pkg>.patch:
//   1. locate the patched package the way the build resolves it: through the
//      consuming workspace (node_modules/<name> or Bun.resolveSync), then the
//      repo root, then bun's hoisted store (node_modules/.bun/<enc>@<ver>*).
//      Root-only resolution silently skipped every workspace-hoisted package.
//   2. locate the pristine registry copy in bun's cache
//      (~/.bun/install/cache/<name>@<version>@@@<i>, the entry WITHOUT a
//      _patch_hash suffix - the patched siblings are not pristine). Git-sourced
//      entries are stored under a commit-hash directory name; their package.json
//      version is the match in that case.
//   3. copy it to a temp dir and apply the patchfile with `patch -p1`,
//   4. diff the result against the resolved package (the patched copy the build
//      bundles), ignoring bun's own .bun-tag-* bookkeeping files.
// Any mismatch means node_modules is stale relative to the patchfile (a root
// `bun install` re-applies patchedDependencies and is REQUIRED), or the
// patchfile no longer matches the registry tarball (a rebase re-port is needed).
//
// Every patchfile must be checked. A package that cannot be resolved, or whose
// pristine cache entry is missing, FAILS with exit 2. `--allow-skip` is the
// bootstrap-only override; `--strict` also prints a PASS/SKIP line per package
// and still fails on any skip.
// Run after ANY patchfile edit and before pushing a patchfile change:
//   bun script/verify-patch-apply.mjs [--strict|--allow-skip] [patchfile...]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { spawnSync } from "node:child_process"

const root = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")
const patchesDir = join(root, "patches")
const cacheDir = join(homedir(), ".bun", "install", "cache")
const args = process.argv.slice(2)
const flags = args.filter((arg) => arg.startsWith("--"))
const strict = flags.includes("--strict")
const allowSkip = flags.includes("--allow-skip")
const unknown = flags.filter((flag) => flag !== "--strict" && flag !== "--allow-skip")
const named = args.filter((arg) => !arg.startsWith("--"))
const files = named.length ? named : readdirSync(patchesDir).filter((f) => f.endsWith(".patch"))

if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(" ")}`)
  console.error("usage: bun script/verify-patch-apply.mjs [--strict|--allow-skip] [patchfile...]")
  process.exit(2)
}
if (spawnSync("patch", ["--version"]).status !== 0) {
  console.error("patch(1) not found - install GNU patch to run this check")
  process.exit(2)
}

let failed = false
let checked = 0
let skipped = 0
const skips = []
for (const file of files) {
  const patchPath = file.includes("/") ? file : join(patchesDir, file)
  const spec = basename(file, ".patch")
  const at = spec.lastIndexOf("@")
  const name = at > 0 ? decodeURIComponent(spec.slice(0, at)) : ""
  const version = at > 0 ? spec.slice(at + 1) : ""
  if (!name || !version) {
    skip(`${file}: cannot parse <name>@<version> from the filename`)
    continue
  }
  const target = findTarget(name, version)
  if (!target.path) {
    skip(`${file}: cannot resolve ${name}@${version} - ${target.reason}`)
    continue
  }
  const base = findPristine(name, version)
  if (!base) {
    skip(`${file}: no pristine cache entry for ${name}@${version} (bun install refreshes the cache)`)
    continue
  }
  const work = join(tmpdir(), `oc-patch-verify-${process.pid}`, name.replaceAll("/", "__"))
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  cpSync(base, work, { recursive: true })
  const applied = spawnSync("patch", ["-p1", "--no-backup-if-mismatch"], {
    cwd: work,
    input: readFileSync(patchPath),
    encoding: "utf8",
  })
  const log = `${applied.stdout ?? ""}${applied.stderr ?? ""}`
  if (applied.status !== 0) {
    failed = true
    console.error(`${file}: APPLY FAILED (exit ${applied.status}) against pristine ${base}`)
    console.error(log.trim().split("\n").slice(-4).join("\n"))
    continue
  }
  const fuzz = log.split("\n").filter((l) => /offset|fuzz|FAILED|malformed/.test(l))
  // Resolve the symlink: the raw target path contains "/node_modules/", and
  // the old `!l.includes("/node_modules/")` drift filter matched that prefix,
  // silently dropping EVERY drift line - a stock (unpatched) store passed as
  // byte-identical and shipped in the 0374/0375 builds (0357's feed watchdog
  // absent from the binary; BUG_TUI_FEED_IDLE_RENDER_LATCH repro 2). Only
  // ignore nested node_modules INSIDE the package relative path.
  const targetReal = realpathSync(target.path)
  const diff = spawnSync("diff", ["-rq", work, targetReal], { encoding: "utf8" })
  const drift = (diff.stdout ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".bun-tag-"))
    .filter((l) => {
      const at = l.indexOf(targetReal)
      if (at === -1) return true
      return !l.slice(at + targetReal.length).includes("/node_modules/")
    })
  if (drift.length || fuzz.length) {
    failed = true
    console.error(
      `${file}: ${fuzz.length ? "FUZZ/OFFSET: " + fuzz.join(" | ") + " " : ""}${drift.length} drift line(s) vs ${target.path}`,
    )
    for (const line of drift.slice(0, 6)) console.error(`  ${line}`)
    if (drift.length > 6) console.error(`  ... ${drift.length - 6} more`)
    continue
  }
  checked++
  const via = target.via === "root" ? "" : ` [via ${target.via}]`
  console.log(
    strict
      ? `PASS ${file} -> ${target.path}${via}`
      : `${file}: pristine -> apply (0-fuzz) -> byte-identical to ${target.path}${via}`,
  )
}

function skip(reason) {
  skipped++
  skips.push(reason)
  console.log(strict ? `SKIP ${reason}` : `${reason} - SKIP`)
}

if (skipped > 0 && (!allowSkip || strict)) {
  console.error("")
  console.error(`FAILED - ${skipped} patchfile(s) were NOT verified (a check that skips is not a check)`)
  for (const item of skips) console.error(`  ${item}`)
  console.error("every patchfile must be checked; run bun install so node_modules and the bun cache are current")
  if (!strict) console.error("bootstrap-only override: --allow-skip")
  process.exit(2)
}
if (failed) {
  console.error("FAILED - a fresh clone + bun install would not reproduce node_modules; see above")
  process.exit(1)
}
if (skipped > 0) console.log(`OK - ${checked} checked, ${skipped} skipped (--allow-skip)`)
else console.log(`OK - all ${checked} checked patchfile(s) reproduce node_modules`)
process.exit(0)

function existsSyncDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function packageVersion(p) {
  try {
    return JSON.parse(readFileSync(join(p, "package.json"), "utf8")).version
  } catch {
    return null
  }
}

function packageRoot(entry) {
  let current = dirname(entry)
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

// The consuming workspaces, per the root package.json "workspaces" globs. Root
// is last: a workspace-local link is the copy that workspace actually builds.
function workspaceDirs() {
  const dirs = []
  const add = (rel) => {
    const abs = join(root, rel)
    if (existsSyncDir(abs) && existsSync(join(abs, "package.json"))) dirs.push(abs)
  }
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "node_modules") add(join("packages", entry.name))
  }
  for (const group of ["console", "stats"]) {
    let entries = []
    try {
      entries = readdirSync(join(root, "packages", group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") add(join("packages", group, entry.name))
    }
  }
  add("packages/sdk/js")
  add(".")
  return dirs
}

function findTarget(name, version) {
  const mismatches = []
  const consider = (candidate, via) => {
    let resolved
    try {
      resolved = realpathSync(candidate)
    } catch {
      return null
    }
    const found = packageVersion(resolved)
    if (found === version) return { path: resolved, via }
    if (found) mismatches.push(`${resolved} has ${found}`)
    return null
  }
  for (const workspace of workspaceDirs()) {
    const candidates = []
    try {
      candidates.push(dirname(Bun.resolveSync(`${name}/package.json`, workspace)))
    } catch {
      // packages with an "exports" map may not expose ./package.json; try the
      // entry point and walk up to the package root instead.
      try {
        const entry = Bun.resolveSync(name, workspace)
        const rootp = packageRoot(entry)
        if (rootp) candidates.push(rootp)
      } catch {
        // not installed for this workspace
      }
    }
    const direct = join(workspace, "node_modules", name)
    if (existsSyncDir(direct)) candidates.push(direct)
    for (const candidate of candidates) {
      const hit = consider(candidate, workspace === root ? "root" : workspace.slice(root.length + 1))
      if (hit) return hit
    }
  }
  // Hoisted bun store, for transitive dependencies with no workspace link.
  const encoded = name.startsWith("@") ? name.replace("/", "+") : name
  const prefix = `${encoded}@${version}`
  const store = join(root, "node_modules", ".bun")
  if (existsSyncDir(store)) {
    for (const entry of readdirSync(store).sort()) {
      if (!entry.startsWith(prefix)) continue
      const next = entry[prefix.length]
      if (next && next !== "+") continue
      const candidate = join(store, entry, "node_modules", name)
      if (!existsSyncDir(candidate)) continue
      const hit = consider(candidate, `bun store ${entry}`)
      if (hit) return hit
    }
  }
  const hint = mismatches.length ? ` (found: ${[...new Set(mismatches)].slice(0, 3).join("; ")})` : ""
  return { path: null, reason: `not in any workspace node_modules or node_modules/.bun${hint}` }
}

function findPristine(name, version) {
  const scoped = name.startsWith("@") ? join(cacheDir, name.split("/")[0]) : cacheDir
  if (!existsSyncDir(scoped)) return null
  const base = name.startsWith("@") ? name.split("/")[1] : name
  const prefix = `${base}@${version}`
  const hits = readdirSync(scoped)
    .filter((d) => d.startsWith(`${prefix}@@@`) && !d.includes("_patch_hash"))
    .map((d) => join(scoped, d))
    .filter((d) => existsSyncDir(d))
  if (hits[0]) return hits[0]
  // Git-sourced cache entries are named <name>@<commit-ish>@@@<i>; the
  // package.json version is the registry version the patchfile names.
  for (const entry of readdirSync(scoped).sort()) {
    if (!entry.startsWith(`${base}@`) || entry.includes("_patch_hash")) continue
    const candidate = join(scoped, entry)
    if (!existsSyncDir(candidate)) continue
    if (packageVersion(candidate) === version) return candidate
  }
  return null
}
