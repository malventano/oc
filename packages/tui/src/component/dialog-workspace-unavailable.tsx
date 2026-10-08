import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { HintChip } from "../ui/hint-chip"
import { useBindings } from "../keymap"
import { createSignal } from "solid-js"

export function DialogWorkspaceUnavailable(props: { onRestore?: () => boolean | void | Promise<boolean | void> }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "restore" as "cancel" | "restore",
  })
  const [hintHover, setHintHover] = createSignal<string | null>(null)
  const renderer = useRenderer()

  const options = ["cancel", "restore"] as const

  async function confirm() {
    if (store.active === "cancel") {
      dialog.clear()
      return
    }
    const result = await props.onRestore?.()
    if (result === false) return
  }

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Confirm workspace option", group: "Dialog", cmd: () => void confirm() },
      { key: "left", desc: "Cancel workspace restore", group: "Dialog", cmd: () => setStore("active", "cancel") },
      { key: "right", desc: "Restore workspace", group: "Dialog", cmd: () => setStore("active", "restore") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Workspace Unavailable
        </text>
        <HintChip hover={hintHover} setHover={setHintHover} id="esc" idleFg={theme.textMuted} onActivate={() => dialog.clear()}>
          esc
        </HintChip>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        This session is attached to a workspace that is no longer available.
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        Would you like to restore this session into a new workspace?
      </text>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} gap={1}>
        <For each={options}>
          {(item) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={item === store.active ? theme.primary : undefined}
              onMouseOver={() => setHintHover(item)}
              onMouseOut={() => setHintHover(null)}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                setStore("active", item)
                void confirm()
              }}
            >
              <text fg={item === store.active ? theme.selectedListItemText : hintHover() === item ? theme.secondary : theme.textMuted}>
                {item}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
