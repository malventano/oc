import type { TextareaRenderable } from "@opentui/core"

function atTopVisualRow(input: TextareaRenderable) {
  return input.scrollY + input.visualCursor.visualRow === 0
}

function atBottomVisualRow(input: TextareaRenderable) {
  const last = Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
  return input.scrollY + input.visualCursor.visualRow === last
}

export function smartCursorBindings(input: () => TextareaRenderable | undefined) {
  return [
    {
      key: "up",
      desc: "Move to start of line in input",
      group: "Input",
      cmd: () => {
        const editor = input()
        if (!editor || editor.cursorOffset === 0) return false
        if (atTopVisualRow(editor)) editor.cursorOffset = 0
        return false
      },
    },
    {
      key: "down",
      desc: "Move to end of line in input",
      group: "Input",
      cmd: () => {
        const editor = input()
        if (!editor || editor.cursorOffset === editor.plainText.length) return false
        if (atBottomVisualRow(editor)) editor.cursorOffset = editor.plainText.length
        return false
      },
    },
  ]
}
