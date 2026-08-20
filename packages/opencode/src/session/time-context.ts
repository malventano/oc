import { SessionV1 } from "@opencode-ai/core/v1/session"

/**
* ISO 8601 UTC timestamp at second precision (e.g. "2026-08-14T01:18:30Z").
* Timezone-invariant: renders identically regardless of the process TZ env,
* so re-derived stamps are byte-stable across TZ changes and restarts. The
* user's local date and offset live in the env block instead (see system.ts).
*/
export function isoZ(t: number): string {
  return `${new Date(t).toISOString().slice(0, 19)}Z`
}

/** Append a UTC timestamp reminder to every user message that lacks one. */
export function stampUserMessages(msgs: SessionV1.WithParts[]): void {
  for (const msg of msgs) {
    if (msg.info.role !== "user") continue
    const part = msg.parts.find((p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic)
    if (!part || part.text.includes("<system-reminder>")) continue
    part.text += `\n\n<system-reminder>${isoZ(msg.info.time.created)}</system-reminder>`
  }
}

/** Append a UTC timestamp reminder to a tool output that lacks one.
 * Non-string outputs (e.g. code-mode CallToolResult) are left untouched -
 * the retired plugin appended an "undefined..." garbage string to them. */
export function stampToolOutput(output: { output?: string; [key: string]: unknown }): void {
  if (typeof output.output !== "string") return
  if (output.output.includes("<system-reminder>")) return
  output.output += `\n\n<system-reminder>${isoZ(Date.now())}</system-reminder>`
}

/** Threshold for the squash hint: ~6.4K tokens at ~4 chars/token - the
 * truncation ceiling (50 KiB, truncate.ts) caps in-chain outputs, so the
 * hint targets the top of that band (~0.6% of a 1M-token window). */
export const SQUASH_HINT_MIN_CHARS = 25_600

/**
* Append a squash-output hint reminder to very large tool outputs that lack
* one. The hint tag is dropped again by squash-output's extractOutput when
* the output is squashed, so it never outlives the output it describes.
*/
export function stampSquashHint(output: { output?: string; [key: string]: unknown }): void {
  if (typeof output.output !== "string") return
  // Skip only an existing squash hint, not other reminders: stampToolOutput
  // runs first and appends the timestamp, so a generic reminder check would
  // make the hint never fire on any tool output (0065 regression, fixed 0068).
  if (output.output.includes("Very large tool output")) return
  const len = output.output.length
  if (len < SQUASH_HINT_MIN_CHARS) return
  const tokens = Math.round(len / 4)
  output.output += `\n\n<system-reminder>Very large tool output (${len} chars, ~${tokens} tokens). If you won't reference it again, call squash-output NOW, in your very next message, before other tool calls; every future prompt in this session re-reads it.</system-reminder>`
}

export * as TimeContext from "./time-context"
