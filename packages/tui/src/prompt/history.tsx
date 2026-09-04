import path from "path"
import { createEffect } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "../context/helper"
import { useRoute } from "../context/route"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

export const MAX_HISTORY_ENTRIES = 50

export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PromptInfo
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const route = useRoute()
    // Per-session history (2026-09-04): one jsonl per session id under
    // state/prompt-history/, so up-arrow recall never leaks prompts from other
    // sessions. The provider is app-scoped and keys off the ACTIVE session
    // route; non-session routes (home/listing) share the "global" bucket. The
    // legacy flat state/prompt-history.jsonl is left untouched (no longer
    // consulted) for safety.
    const historyDir = path.join(paths.state, "prompt-history")
    const keyFor = () => (route.data.type === "session" ? route.data.sessionID : "global")
    const fileFor = (sessionID: string) => path.join(historyDir, `${sessionID}.jsonl`)

    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })

    // Load the ACTIVE session's history; reload whenever the active session
    // changes (also covers the initial mount). Abandonment-guarded: a rapid
    // session switch must not let a stale read overwrite the new list.
    createEffect(async () => {
      const sessionID = keyFor()
      const lines = parsePromptHistory(await readText(fileFor(sessionID)).catch(() => ""))
      if (keyFor() !== sessionID) return
      setStore("index", 0)
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0)
        writeText(fileFor(sessionID), lines.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    })

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      append(item: PromptInfo, sessionID?: string) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
          }),
        )

        // Persist to the given session's file (or the ACTIVE session route's
        // when omitted). An explicit override covers the FIRST prompt of a NEW
        // session: the submit creates the session and appends history BEFORE
        // the route navigates into it, so the active route is still home and
        // would otherwise drop the first prompt into the shared "global"
        // bucket instead of the session's own file.
        const file = fileFor(sessionID ?? keyFor())
        if (trimmed) {
          writeText(file, store.history.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
          return
        }
        appendText(file, JSON.stringify(entry) + "\n").catch(() => {})
      },
    }
  },
})
