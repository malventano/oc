// Regression guard for the write-tool completion flash (patch 0359).
//
// The write block's code element is carried over from streaming to running to
// completed (0199). At the streaming -> running flip the landed input replaces
// the streamed body and the element leaves streaming mode in the same reactive
// batch, so the core's `set content` runs with `streaming === false`. The
// pristine core unconditionally raw-set the buffer there, discarding the colored
// highlight for the duration of the async re-highlight - the whole body painted
// the element fg (textMuted at running, theme.text at completed) = the reported
// completion grey/white flash. 0338 gated the raw sync in `set streaming` but
// left `set content` open; 0359 mirrors the gate on the content setter.
//
// This test drives the real @opentui/core CodeRenderable through that exact
// transition with a mock tree-sitter client and asserts the painted (colored)
// buffer is never raw-set while a re-highlight is pending.
import { expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer } from "@opentui/core/testing"

const PREFIX = "export const a = 1\n"
const FULL = PREFIX + "export const b = 2\n"

test("completion flip keeps the colored buffer (no raw setText)", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const sitter = new MockTreeSitterClient()
  const syntax = SyntaxStyle.fromStyles({
    default: { fg: "#ffffff" },
    keyword: { fg: "#ff0000" },
  })

  const code = new CodeRenderable(setup.renderer, {
    id: "code",
    content: PREFIX,
    filetype: "typescript",
    streaming: true,
    drawUnstyledText: false,
    syntaxStyle: syntax,
    treeSitterClient: sitter,
  })
  setup.renderer.root.add(code)

  const rawSets: string[] = []
  const tb = (code as any).textBuffer
  const origSetText = tb.setText.bind(tb)
  tb.setText = (value: string) => {
    rawSets.push(value)
    return origSetText(value)
  }

  try {
    // Stream the prefix, then let its highlight land (colored buffer).
    await setup.flush()
    sitter.setMockResult({ highlights: [[0, 6, "keyword", {}]] })
    await setup.flush()
    expect(tb.getPlainText()).toBe(PREFIX)
    rawSets.length = 0

    // pending -> running: the landed input replaces the streamed body and the
    // element leaves streaming in the same batch.
    code.streaming = false
    code.content = FULL
    await setup.flush()

    expect(rawSets).toEqual([])
    expect(tb.getPlainText()).toBe(PREFIX)

    // The deferred completion highlight lands the full body, colored.
    sitter.resolveAllHighlightOnce()
    await setup.flush()
    expect(tb.getPlainText()).toBe(FULL)
  } finally {
    setup.renderer.destroy()
  }
})
