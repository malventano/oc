export * as Token from "./token"

const CHARS_PER_TOKEN = 4
const DISPLAY_CHARS_PER_TOKEN = 3

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/** Display estimate: the 3 chars/token divisor used by the TUI counters. */
export const estimateDisplay = (input: string) => estimateDisplayFromChars(input.length)

export const estimateDisplayFromChars = (chars: number) =>
  Math.max(0, Math.round(chars / DISPLAY_CHARS_PER_TOKEN))
