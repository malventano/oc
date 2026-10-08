import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { HintChip } from "./hint-chip"
import { useBindings, useCommandShortcut } from "../keymap"
import { createSignal } from "solid-js"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const commandShortcut = useCommandShortcut("command.palette.show")
  const [hintHover, setHintHover] = createSignal<string | null>(null)

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <HintChip hover={hintHover} setHover={setHintHover} id="esc" idleFg={theme.textMuted} onActivate={() => dialog.clear()}>
          esc/enter
        </HintChip>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Press {commandShortcut()} to see all available actions and commands in any context.
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <HintChip hover={hintHover} setHover={setHintHover} id="ok" filled padX={3} onActivate={() => dialog.clear()}>
          ok
        </HintChip>
      </box>
    </box>
  )
}
