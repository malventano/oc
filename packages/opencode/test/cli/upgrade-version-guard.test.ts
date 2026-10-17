import { describe, expect, test } from "bun:test"

// The guard lives in the exported `isOcBuild` constant derived from the
// build-time `OPENCODE_VERSION`. Both update-check call sites
// (cli/upgrade.ts and cli/cmd/upgrade.ts) import it directly, so exercising the
// constant's real contract covers them without mocking the guard itself.
//
// The query-string imports force a fresh module evaluation after the globals
// are set; a plain import would be cached from earlier test files as "local".
// The specifier stays a variable so tsc does not try to resolve the query
// string as a module path (bun resolves it at runtime).
function versionModule(tag: string) {
  return import("@opencode-ai/core/installation/version?guard=" + tag)
}

function setVersion(version: string) {
  ;(globalThis as { OPENCODE_VERSION?: string }).OPENCODE_VERSION = version
  ;(globalThis as { OPENCODE_CHANNEL?: string }).OPENCODE_CHANNEL = "local"
}

function restoreVersion() {
  delete (globalThis as { OPENCODE_VERSION?: string }).OPENCODE_VERSION
  delete (globalThis as { OPENCODE_CHANNEL?: string }).OPENCODE_CHANNEL
}

describe("oc update-check version guard", () => {
  test("matches the numbered fork convention", async () => {
    setVersion("1.18.32-oc-0411")
    try {
      const mod = await versionModule("fork-0411")
      expect(mod.InstallationVersion).toBe("1.18.32-oc-0411")
      expect(mod.isOcBuild).toBe(true)
    } finally {
      restoreVersion()
    }
  })

  test("matches the legacy bare -oc suffix", async () => {
    setVersion("1.18.32-oc")
    try {
      const mod = await versionModule("legacy-oc")
      expect(mod.isOcBuild).toBe(true)
    } finally {
      restoreVersion()
    }
  })

  test("matches a fork version with an upstream preview suffix", async () => {
    setVersion("1.18.32-oc-0411-preview.2")
    try {
      const mod = await versionModule("fork-preview")
      expect(mod.isOcBuild).toBe(true)
    } finally {
      restoreVersion()
    }
  })

  test("does not block an upstream release", async () => {
    setVersion("1.18.32")
    try {
      const mod = await versionModule("upstream")
      expect(mod.isOcBuild).toBe(false)
    } finally {
      restoreVersion()
    }
  })

  test("does not block an upstream preview release", async () => {
    // Preview is an upstream channel, not a custom build: only an "-oc"
    // segment marks a fork that must stay off the release channel.
    setVersion("1.18.32-preview.2")
    try {
      const mod = await versionModule("upstream-preview")
      expect(mod.isOcBuild).toBe(false)
    } finally {
      restoreVersion()
    }
  })
})
