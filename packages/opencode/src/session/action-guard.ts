/**
 * Action guard: a cross-step ledger of repeated tool actions and identical
 * tool results.
 *
 * LoopGuard.reset() fires on every tool call (a new call means the model is
 * making progress inside the stream). That reset cannot see a model that
 * alternates steps while issuing the exact same call - the loop is at the
 * ACTION layer, not the token layer. This guard keeps its own consecutive
 * streaks across steps:
 *
 *   - consecutive identical keys (tool + normalized arguments) -> advisory at
 *     3 and 5;
 *   - consecutive identical (key, result-hash) -> advisory at 3, and a
 *     model-visible stub from the second byte-identical repeat for results
 *     >= 512 chars (the full result stays in the session log);
 *   - read-like tools get a read-specific hint appended after 3 identical
 *     results.
 *
 * Advisories ride the existing steer channel in prompt.ts (request-only
 * synthetic trailing user message); they never abort the turn. Poll/wait
 * style tools are exempt because a legitimate poller repeats by design.
 */

import { createHash } from "node:crypto"

export const ENV_DISABLE = "OC_DISABLE_ACTION_GUARD"
// Bounded result hashing: enough to distinguish real outputs, small enough to
// stay cheap on multi-megabyte tool results.
const HASH_INPUT_MAX = 4096
// Model-visible stub threshold: short outputs are cheap to repeat; long ones
// are what actually burn context.
export const STUB_MIN_CHARS = 512
const PREVIEW_MAX = 500
const READ_TOOLS = new Set(["read", "grep", "glob"])
const WAIT_TOOL = /(^|[._-])(poll|pollfirst|poll_first|wait|waitfor|wait_for)([._-]|$)/i
const SLEEP_ONLY = /^(?:sleep\s+[0-9.]+[smhd]?\s*)+$/i

export type AdvisoryKind = "repeat" | "result"

export type Advisory = {
  kind: AdvisoryKind
  key: string
  count: number
  message: string
}

export type ResultDecision = {
  advisory: Advisory | null
  /** Replacement shown to the model; state.output keeps the full result. */
  stub: string | null
  /** Append-only hint (read-repeat); applied to the model-visible output. */
  suffix: string | null
}

export interface State {
  recordCall(tool: string, input: unknown): Advisory | null
  recordResult(tool: string, result: string, key: string): ResultDecision
  takeAdvisory(): string | null
}

export function guardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_DISABLE] !== "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Strip shell pipe/redirection tails for bash so `cat file | head`,
 * `cat file > out`, `cat file 2>&1` and plain `cat file` share one key.
 * Quote-aware: a `|` inside a quoted argument is data, not a pipe.
 */
function stripBashTails(command: string): string {
  const text = command.replace(/\s+/g, " ").trim()
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "|" || ch === ">" || ch === "<") {
      // `2>&1` / `&>` / `2>`: walk back over the fd/amp prefix so the
      // numeric descriptor is not left dangling in the key.
      let cut = i
      while (cut > 0 && /[0-9&]/.test(text[cut - 1])) cut--
      return text.slice(0, cut).trim()
    }
  }
  return text
}

function canonical(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`
  }
  if (typeof value === "string") return JSON.stringify(value.replace(/\s+/g, " ").trim())
  if (value === undefined) return "undefined"
  return JSON.stringify(value) ?? String(value)
}

function bashCommand(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (isRecord(input) && typeof input.command === "string") return input.command
  return undefined
}

/** True for poll/wait style calls and sleep-only bash commands. */
export function isExempt(tool: string, input: unknown): boolean {
  const name = tool.toLowerCase()
  if (WAIT_TOOL.test(name)) return true
  if (name === "tmux" && isRecord(input) && typeof input.op === "string") {
    if (/^(poll|pollfirst|poll_first|wait|waitfor|wait_for)$/i.test(input.op)) return true
  }
  if (name === "bash") {
    const command = bashCommand(input)
    if (command && SLEEP_ONLY.test(command.trim())) return true
  }
  return false
}

/** Stable key for one tool action: tool name + normalized arguments. */
export function keyFor(tool: string, input: unknown): string {
  if (tool === "bash") {
    const command = bashCommand(input)
    if (command !== undefined) return `bash:${stripBashTails(command)}`
  }
  return `${tool}:${canonical(input)}`
}

/** Bounded result hash (truncated input, SHA-1 hex). */
export function hashResult(result: string): string {
  return createHash("sha1").update(result.slice(0, HASH_INPUT_MAX)).digest("hex")
}

function preview(key: string): string {
  return key.length <= PREVIEW_MAX ? key : `${key.slice(0, PREVIEW_MAX - 3)}...`
}

function repeatMessage(key: string, count: number): string {
  return `<system-reminder source="action-guard">
The same tool action has been issued ${count} consecutive times with no change in arguments: ${preview(key)}
If this action already produced the answer, stop repeating it and either report the result or take a different concrete step. Do not re-run the same call again.
</system-reminder>`
}

function resultMessage(key: string, count: number): string {
  return `<system-reminder source="action-guard">
A tool has returned the identical result ${count} consecutive times for the same action: ${preview(key)}
Re-running it will not change the result. Read the result you already have, then act on it or explain what is blocking progress.
</system-reminder>`
}

export const STUB_NOTICE =
  "[action guard: identical result repeated; re-reading will not change it. The full result remains in the session log.]"

export const READ_HINT =
  "\n\n[action guard: this read returned an identical result 3 times; re-reading will not change it.]"

class Guard implements State {
  #repeatKey: string | null = null
  #repeatCount = 0
  #resultKey: string | null = null
  #resultHash: string | null = null
  #resultCount = 0
  #pending: string | null = null

  recordCall(tool: string, input: unknown): Advisory | null {
    if (isExempt(tool, input)) {
      this.#repeatKey = null
      this.#repeatCount = 0
      return null
    }
    const key = keyFor(tool, input)
    if (key === this.#repeatKey) this.#repeatCount++
    else {
      this.#repeatKey = key
      this.#repeatCount = 1
    }
    if (this.#repeatCount !== 3 && this.#repeatCount !== 5) return null
    const message = repeatMessage(key, this.#repeatCount)
    this.#pending = message
    return { kind: "repeat", key, count: this.#repeatCount, message }
  }

  recordResult(tool: string, result: string, key: string): ResultDecision {
    const hash = hashResult(result)
    if (key === this.#resultKey && hash === this.#resultHash) this.#resultCount++
    else {
      this.#resultKey = key
      this.#resultHash = hash
      this.#resultCount = 1
    }

    const stub = result.length >= STUB_MIN_CHARS && this.#resultCount >= 2 ? STUB_NOTICE : null
    const suffix = !stub && this.#resultCount >= 3 && READ_TOOLS.has(tool) ? READ_HINT : null
    const advisory =
      this.#resultCount === 3
        ? (() => {
            const message = resultMessage(key, this.#resultCount)
            this.#pending = message
            return { kind: "result" as const, key, count: this.#resultCount, message }
          })()
        : null
    return { advisory, stub, suffix }
  }

  takeAdvisory(): string | null {
    const pending = this.#pending
    this.#pending = null
    return pending
  }
}

class Disabled implements State {
  recordCall(): Advisory | null {
    return null
  }
  recordResult(): ResultDecision {
    return { advisory: null, stub: null, suffix: null }
  }
  takeAdvisory(): string | null {
    return null
  }
}

export function make(env: NodeJS.ProcessEnv = process.env): State {
  return guardEnabled(env) ? new Guard() : new Disabled()
}

export * as ActionGuard from "./action-guard"
