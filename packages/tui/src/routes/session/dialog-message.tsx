import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import type { PromptInfo } from "../../component/prompt/history"
import { partsToPromptInfo } from "../../prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const clipboard = useClipboard()

  // Queued = user message with no assistant child: not picked up by the run
  // loop yet. Re-evaluated at select time - the loop may grab the message
  // between menu open and select.
  const queued = createMemo(() => {
    const msg = message()
    if (!msg || msg.role !== "user") return false
    const messages = sync.data.message[props.sessionID] ?? []
    return !messages.some((m) => m.role === "assistant" && m.parentID === msg.id)
  })

  function busy() {
    return (sync.data.session_status?.[props.sessionID]?.type ?? "idle") !== "idle"
  }

  function restorePrompt(msg: { id: string }) {
    if (!props.setPrompt) return
    const parts = sync.data.part[msg.id] ?? []
    props.setPrompt(partsToPromptInfo(parts))
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: queued() ? "Pull back" : "Revert",
          value: "session.revert",
          description: queued() ? "remove from queue and restore text to input" : "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            // Queued prompt: delete it from the queue and restore its text
            // into the input. Re-checked here - the run loop may have just
            // picked it up, in which case it is history (fall through).
            if (queued()) {
              void sdk.client.session.deleteMessage({ sessionID: props.sessionID, messageID: msg.id }).then((result) => {
                if (result.error) {
                  toast.show({
                    variant: "warning",
                    message: "Queued prompt is already in processing",
                    duration: 3000,
                  })
                  return
                }
                restorePrompt(msg)
              })
              dialog.clear()
              return
            }

            // Processed message: revert is invalid while busy (409) -
            // surface it instead of failing silently.
            if (busy()) {
              toast.show({
                variant: "warning",
                message: "Cannot revert while the session is busy",
                duration: 3000,
              })
              return
            }

            void sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })
            restorePrompt(msg)
            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
