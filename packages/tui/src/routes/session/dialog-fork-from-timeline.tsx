import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import { useTheme } from "../../context/theme"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const [pending, setPending] = createSignal(false)
  const { theme } = useTheme()
  // The whole dialog forks the same source session; a mid-turn fork would
  // snapshot a partial trailing assistant message (truncated text, no
  // step-finish). Lock every option while the source is busy or retrying -
  // unlocks itself when the turn completes.
  const busy = createMemo(() => (sync.data.session_status?.[props.sessionID]?.type ?? "idle") !== "idle")

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        if (pending()) return
        setPending(true)
        try {
          const forked = await sdk.client.session.fork({ sessionID: props.sessionID })
          if (forked.error) {
            const err = forked.error as { message?: string; data?: { message?: string } }
            toast.show({ variant: "error", message: `Fork failed: ${err.message ?? err.data?.message ?? "unknown error"}` })
            return
          }
          route.navigate({
            sessionID: forked.data!.id,
            type: "session",
          })
          dialog.clear()
        } finally {
          setPending(false)
        }
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          if (pending()) return
          setPending(true)
          try {
            const forked = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: message.id,
            })
            if (forked.error) {
              const err = forked.error as { message?: string; data?: { message?: string } }
              toast.show({ variant: "error", message: `Fork failed: ${err.message ?? err.data?.message ?? "unknown error"}` })
              return
            }
            const parts = sync.data.part[message.id] ?? []
            const prompt = parts.reduce(
              (agg, part) => {
                if (part.type === "text") {
                  if (!part.synthetic) agg.input += part.text
                }
                if (part.type === "file") agg.parts.push(strip(part))
                return agg
              },
              { input: "", parts: [] as PromptInfo["parts"] },
            )
            route.navigate({
              sessionID: forked.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          } finally {
            setPending(false)
          }
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return (
    <DialogSelect
      onMove={(option) => props.onMove(option.value)}
      title={pending() ? "Forking..." : "Fork session"}
      locked={pending() || busy()}
      footer={
        busy() ? (
          <text fg={theme.warning}>Source session is busy - fork unlocks when the turn finishes</text>
        ) : undefined
      }
      options={options()}
    />
  )
}
