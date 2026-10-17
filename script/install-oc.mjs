// Install a freshly built oc binary and its provenance manifest.
//
// The swap stages a copy in the DESTINATION filesystem and renames it over the
// target: /tmp is tmpfs here while /usr/local/bin is zfs, so the documented
// `cp /tmp/... && mv` relied on GNU mv's internal cross-device staging rather
// than on the command as written. A same-directory rename is atomic and needs
// no such assumption. Running processes keep their held inode, so this never
// kills or interrupts a session.
//
// Usage:
//   bun script/install-oc.mjs [--from <path/to/oc>] [--target /usr/local/bin/oc]
//                             [--manifest-dir /usr/local/share/oc]
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")
const args = process.argv.slice(2)
function flag(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

const from = resolve(flag("--from", join(root, "packages/opencode/dist/opencode-linux-x64/bin/oc")))
const target = resolve(flag("--target", "/usr/local/bin/oc"))
const manifestDir = resolve(flag("--manifest-dir", "/usr/local/share/oc"))
const manifestCandidates = [join(dirname(from), "build-manifest.json"), join(dirname(dirname(from)), "build-manifest.json")]
const manifestPath = manifestCandidates.find((candidate) => existsSync(candidate))

if (!existsSync(from)) {
  console.error(`artifact not found: ${from}`)
  process.exit(1)
}
if (!statSync(from).isFile()) {
  console.error(`artifact is not a file: ${from}`)
  process.exit(1)
}

const staged = join(dirname(target), `.oc-new.${process.pid}`)
mkdirSync(dirname(target), { recursive: true })
try {
  copyFileSync(from, staged)
  // rename(2) within the target directory: atomic, and the executing inode is
  // untouched (the old path name is simply rebound).
  renameSync(staged, target)
} finally {
  rmSync(staged, { force: true })
}

let manifest = null
if (manifestPath) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  mkdirSync(manifestDir, { recursive: true })
  copyFileSync(manifestPath, join(manifestDir, `build-manifest-${manifest.version}.json`))
  copyFileSync(manifestPath, join(manifestDir, "build-manifest.json"))
  writeJson(join(manifestDir, "current.json"), {
    version: manifest.version,
    gitHead: manifest.gitHead,
    gitBranch: manifest.gitBranch,
    dirty: manifest.dirty,
    binarySha256: manifest.binary?.sha256,
    installedAt: new Date().toISOString(),
    target,
  })
} else {
  console.error(`warning: no build-manifest.json near the artifact (checked ${manifestCandidates.join(", ")})`)
}

const version = spawnSync(target, ["--version"], { encoding: "utf8" })
if (version.status !== 0) {
  console.error(`installed binary failed to run: ${(version.stderr ?? "").trim()}`)
  process.exit(1)
}
console.log(`installed ${version.stdout.trim()} -> ${target}`)
if (manifest) {
  console.log(`  git ${manifest.gitHead.slice(0, 10)} (${manifest.gitBranch}${manifest.dirty ? ", dirty" : ""})`)
  console.log(`  manifest ${join(manifestDir, "current.json")}`)
}
console.log("running sessions keep their old inode; restart them to pick this build up")

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
}
