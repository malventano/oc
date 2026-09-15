// End-to-end check that every bun patchfile in patches/ still produces the
// package tree that is installed in node_modules - i.e. what a fresh clone +
// `bun install` (bun >= 1.4, which validates patchfiles strictly) will build.
//
// For each patches/<pkg>.patch:
//   1. locate the pristine registry copy in bun's cache
//      (~/.bun/install/cache/<name>@<version>@@@<i>, the entry WITHOUT a
//      _patch_hash suffix - the patched siblings are not pristine),
//   2. copy it to a temp dir and apply the patchfile with `patch -p1`,
//   3. diff the result against node_modules/<name> (the patched copy the build
//      bundles), ignoring bun's own .bun-tag-* bookkeeping files.
// Any mismatch means node_modules is stale relative to the patchfile (a root
// `bun install` re-applies patchedDependencies and is REQUIRED), or the
// patchfile no longer matches the registry tarball (a rebase re-port is needed).
// Run after ANY patchfile edit and before pushing a patchfile change:
//   bun script/verify-patch-apply.mjs [patchfile...]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"

const root = new URL("..", import.meta.url).pathname
const patchesDir = join(root, "patches")
const cacheDir = join(homedir(), ".bun", "install", "cache")
const files =
  process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(patchesDir).filter((f) => f.endsWith(".patch"))

if (spawnSync("patch", ["--version"]).status !== 0) {
  console.error("patch(1) not found - install GNU patch to run this check")
  process.exit(2)
}

let failed = false
let skipped = 0
for (const file of files) {
  const patchPath = file.includes("/") ? file : join(patchesDir, file)
  const spec = basename(file, ".patch")
  const at = spec.lastIndexOf("@")
  const name = at > 0 ? decodeURIComponent(spec.slice(0, at)) : ""
  const version = at > 0 ? spec.slice(at + 1) : ""
  if (!name || !version) {
    console.error(`${file}: cannot parse <name>@<version> from the filename - SKIP`)
    skipped++
    continue
  }
  const target = join(root, "node_modules", name)
  if (!existsSyncDir(target)) {
    console.log(`${file}: node_modules/${name} absent - SKIP (run bun install)`)
    skipped++
    continue
  }
  const base = findPristine(name, version)
  if (!base) {
    console.log(`${file}: no pristine cache entry for ${name}@${version} - SKIP (bun install refreshes the cache)`)
    skipped++
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
  const diff = spawnSync("diff", ["-rq", work, target], { encoding: "utf8" })
  const drift = (diff.stdout ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".bun-tag-") && !l.includes("/node_modules/"))
  if (drift.length || fuzz.length) {
    failed = true
    console.error(`${file}: ${fuzz.length ? "FUZZ/OFFSET: " + fuzz.join(" | ") + " " : ""}${drift.length} drift line(s) vs node_modules/${name}`)
    for (const line of drift.slice(0, 6)) console.error(`  ${line}`)
    if (drift.length > 6) console.error(`  ... ${drift.length - 6} more`)
    continue
  }
  console.log(`${file}: pristine -> apply (0-fuzz) -> byte-identical to node_modules/${name}`)
}
if (failed) console.error("FAILED - a fresh clone + bun install would not reproduce node_modules; see above")
else console.log(`OK - all ${files.length - skipped} checked patchfile(s) reproduce node_modules (${skipped} skipped)`)
process.exit(failed ? 1 : 0)

function existsSyncDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
function findPristine(name, version) {
  const scoped = name.startsWith("@") ? join(cacheDir, name.split("/")[0]) : cacheDir
  if (!existsSyncDir(scoped)) return null
  const prefix = name.startsWith("@") ? `${name.split("/")[1]}@${version}` : `${name}@${version}`
  const hits = readdirSync(scoped)
    .filter((d) => d.startsWith(`${prefix}@@@`) && !d.includes("_patch_hash"))
    .map((d) => join(scoped, d))
    .filter((d) => existsSyncDir(d))
  return hits[0] ?? null
}
