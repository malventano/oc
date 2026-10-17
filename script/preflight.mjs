// Pre-push/pre-build gate.
// Steps: check:patches -> verify:patches --strict -> patch-series-check
//        (with --require-ancestor) -> tsc against the known 11-error baseline.
// Non-fast also greps the installed/built binary for the patched-core markers
// (oc-feed-watchdog, hl.heal) and reports OC_PUMP_PROBE as a warning.
// Usage:
//   bun script/preflight.mjs [--fast]
import { existsSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

const root = new URL("..", import.meta.url).pathname.replace(/\/+$/, "")
const fast = process.argv.includes("--fast")
const TSC_BASELINE = 11
const results = []

function run(label, command, args, cwd = root) {
  console.log(`\n== ${label} ==`)
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd()
  if (output) console.log(output)
  const ok = result.status === 0
  results.push({ label, ok, required: true })
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`)
  return { ok, output }
}

run("check:patches", process.execPath, ["run", "check:patches"])
run("verify:patches --strict", process.execPath, ["run", "verify:patches", "--strict"])
run("patch-series-check", process.execPath, ["script/patch-series-check.mjs", "--require-ancestor"])

// -- tsc baseline ------------------------------------------------------------
{
  const cwd = path.join(root, "packages/opencode")
  console.log("\n== tsc (baseline 11) ==")
  const hasBunx = spawnSync("bunx", ["--version"], { encoding: "utf8" }).status === 0
  const result = hasBunx
    ? spawnSync("bunx", ["tsc", "--noEmit"], { cwd, encoding: "utf8", env: process.env })
    : spawnSync(process.execPath, ["x", "tsc", "--noEmit"], { cwd, encoding: "utf8", env: process.env })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "")
  const errors = output
    .split("\n")
    .map(strip)
    .filter((line) => /error TS\d+/.test(line))
  if (errors.length > TSC_BASELINE) {
    console.error(`tsc: ${errors.length} errors (baseline ${TSC_BASELINE})`)
    const fresh = errors.filter((line) => !line.includes("dialog-move-session.tsx"))
    for (const line of fresh.length ? fresh : errors) console.error(`  ${line}`)
    results.push({ label: "tsc", ok: false, required: true })
    console.log("FAIL tsc")
  } else {
    console.log(`tsc: ${errors.length} error(s) (baseline ${TSC_BASELINE})`)
    results.push({ label: "tsc", ok: true, required: true })
    console.log("PASS tsc")
  }
}

// -- binary markers ----------------------------------------------------------
{
  console.log("\n== binary markers ==")
  if (fast) {
    console.log("SKIP binary markers (--fast)")
  } else {
    const binary = findBinary()
    if (!binary) {
      console.log("SKIP binary markers (no built artifact found)")
    } else {
      const has = (marker) => spawnSync("grep", ["-aFq", marker, binary]).status === 0
      const required = ["oc-feed-watchdog", "hl.heal"]
      const missing = required.filter((marker) => !has(marker))
      let ok = missing.length === 0
      console.log(`binary: ${binary} (${statSync(binary).size} bytes)`)
      for (const marker of required) console.log(`  ${has(marker) ? "PASS" : "FAIL"} ${marker}`)
      if (missing.length) console.error(`  missing patched-core marker(s): ${missing.join(", ")}`)
      if (has("OC_PUMP_PROBE")) {
        console.log("  WARN OC_PUMP_PROBE present (probe build; warning only for now)")
      } else {
        console.log("  PASS OC_PUMP_PROBE absent")
      }
      results.push({ label: "binary markers", ok, required: true })
      console.log(`${ok ? "PASS" : "FAIL"} binary markers`)
    }
  }
}

// -- summary -----------------------------------------------------------------
console.log("\n== preflight summary ==")
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.label}`)
const failed = results.some((result) => result.required && !result.ok)
console.log(failed ? "FAIL preflight" : "PASS preflight")
process.exit(failed ? 1 : 0)

function findBinary() {
  if (process.env.OC_BINARY && existsSync(process.env.OC_BINARY)) return process.env.OC_BINARY
  if (existsSync("/usr/local/bin/oc")) return "/usr/local/bin/oc"
  const dist = path.join(root, "packages/opencode/dist")
  const candidates = []
  if (existsSync(dist)) {
    for (const entry of readdirSync(dist).sort()) {
      for (const name of ["oc", "oc.exe"]) {
        const candidate = path.join(dist, entry, "bin", name)
        if (existsSync(candidate)) candidates.push(candidate)
      }
    }
  }
  if (!candidates.length) return null
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}
