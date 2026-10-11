declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// oc builds version as `<upstream>-oc-<patch id>` (script/build.ts); the
// legacy suffix was bare `-oc`. Any `-oc` segment means this is a custom
// build that must never touch the upstream release channel.
export const isOcBuild = InstallationVersion.includes("-oc")
