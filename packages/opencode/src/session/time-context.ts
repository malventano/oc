import { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * Local ISO timestamp with UTC offset, derived from the instant's own timezone
 * rules. Position-independent across DST boundaries: getTimezoneOffset() is
 * evaluated on the message's own instant, so a re-derived stamp is
 * byte-identical whether the message is the current or a prior one.
 */
export function localIso(t: number): string {
  const d = new Date(t)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const abs = Math.abs(off)
  const local = new Date(d.getTime() + off * 60000)
  return `${local.toISOString().slice(0, 23)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

/** Append a local timestamp reminder to every user message that lacks one. */
export function stampUserMessages(msgs: SessionV1.WithParts[]): void {
  for (const msg of msgs) {
    if (msg.info.role !== "user") continue
    const part = msg.parts.find((p): p is SessionV1.TextPart => p.type === "text" && !p.synthetic)
    if (!part || part.text.includes("<system-reminder>")) continue
    part.text += `\n\n<system-reminder>${localIso(msg.info.time.created)}</system-reminder>`
  }
}

/** Append a UTC timestamp reminder to a tool output that lacks one. */
export function stampToolOutput(output: { output?: string; [key: string]: unknown }): void {
  if (typeof output.output !== "string") return
  if (output.output.includes("<system-reminder>")) return
  output.output += `\n\n<system-reminder>${new Date().toISOString()}</system-reminder>`
}

export * as TimeContext from "./time-context"
