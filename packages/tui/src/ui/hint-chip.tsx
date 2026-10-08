import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { JSX } from "solid-js"
import { useTheme } from "../context/theme"

/**
 * A clickable keyboard-hint chip (spec 18). Text mode (default): the hover
 * affordance is the text fg accent (theme.secondary) plus the
 * backgroundElement tint where the theme differentiates it. Filled mode
 * (props.filled): the primary button look is preserved (theme.primary bg,
 * selectedListItemText fg) and hover flips the bg to theme.secondary.
 * Activation is onMouseUp with the text-selection guard, dispatching what
 * the hint's key does.
 */
export function HintChip(props: {
  hover: () => string | null
  setHover: (value: string | null) => void
  id: string
  onActivate: () => void
  /** Idle text color; defaults to theme.text. All-muted hints pass
   * theme.textMuted so the idle look is unchanged - only hover pops. */
  idleFg?: RGBA | string
  /** Filled primary-button mode: bg primary -> secondary on hover. */
  filled?: boolean
  padX?: number
  children: JSX.Element
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const active = () => props.hover() === props.id
  return (
    <box
      paddingLeft={props.padX}
      paddingRight={props.padX}
      backgroundColor={
        props.filled
          ? active()
            ? theme.secondary
            : theme.primary
          : active()
            ? theme.backgroundElement
            : undefined
      }
      onMouseOver={() => props.setHover(props.id)}
      onMouseOut={() => props.setHover(null)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onActivate()
      }}
    >
      <text
        fg={
          props.filled
            ? theme.selectedListItemText
            : active()
              ? theme.secondary
              : (props.idleFg ?? theme.text)
        }
      >
        {props.children}
      </text>
    </box>
  )
}
