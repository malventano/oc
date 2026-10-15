// Regression guard for the stuck-prefix self-heal (patch 0402).
//
// The streaming/completed code element paints ONLY via the async highlight
// apply (the streaming content setter never setTexts after the first paint).
// Every known loss path re-dirties (oc-0391), but a lost FINAL highlight with
// no re-trigger left the element at the last applied prefix while the gutter
// counted every row - the live "gutters but no text" freeze on a write block
// (BUG_WRITE_STREAM_BLANK_TAIL: stuck at 47/66 lines, minutes past completion).
// 0402 adds a renderSelf guard: any pass that finds content the last apply
// never covered, with nothing in flight (or an in-flight round trip older than
// 35s), re-fires the highlight the same frame.
//
// This test drives the real @opentui/core CodeRenderable through the stuck
// state (dirty consumed, in-flight flag cleared, buffer at the prefix) and
// asserts the guard re-fires and the body converges.
import { expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient, createTestRenderer } from "@opentui/core/testing"

const PREFIX = "export const a = 1\n"
const FULL = PREFIX + "export const b = 2\n"

test("a lost final highlight self-heals within one frame (0402)", async () => {
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

  try {
    const tb = (code as any).textBuffer

    // Land the prefix highlight: applied + marked (_lastAppliedContent).
    await setup.flush()
    sitter.setMockResult({ highlights: [[0, 6, "keyword", {}]] })
    sitter.resolveAllHighlightOnce()
    await setup.flush()
    expect(tb.getPlainText()).toBe(PREFIX)
    expect((code as any)._lastAppliedContent).toBe(PREFIX)

    // Content advances; the next render consumes the dirty flag and the
    // request goes in flight (the mock holds it pending).
    code.content = FULL
    await setup.flush()
    expect((code as any)._isHighlighting).toBe(true)
    expect(tb.getPlainText()).toBe(PREFIX)

    // Simulate the loss: the response never applies and nothing re-triggers -
    // dirty=false, nothing in flight, buffer at the prefix. Real frames keep
    // coming while the element is on screen; request one.
    ;(code as any)._isHighlighting = false
    ;(code as any)._highlightsDirty = false
    code.requestRender()
    await setup.flush()

    // The guard fired: dirty consumed again and a new round trip is in flight.
    expect((code as any)._highlightsDirty).toBe(false)
    expect((code as any)._isHighlighting).toBe(true)
    expect((code as any)._highlightStartedAt).toBeDefined()

    // The re-fired round trip lands: full body painted + marked.
    sitter.resolveAllHighlightOnce()
    await setup.flush()
    expect(tb.getPlainText()).toBe(FULL)
    expect((code as any)._lastAppliedContent).toBe(FULL)
  } finally {
    setup.renderer.destroy()
  }
})

test("a raw fallback marks applied - the guard does not hot-loop (0402)", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const sitter = new MockTreeSitterClient()
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })

  const code = new CodeRenderable(setup.renderer, {
    id: "code",
    filetype: "python",
    streaming: false,
    drawUnstyledText: false,
    syntaxStyle: syntax,
    treeSitterClient: sitter,
  })
  setup.renderer.root.add(code)

  try {
    const tb = (code as any).textBuffer
    // Empty-highlight response (timeout/error shape): the else branch paints
    // raw and marks applied.
    code.content = FULL
    await setup.flush()
    sitter.setMockResult({ warning: "no highlights" })
    sitter.resolveAllHighlightOnce()
    await setup.flush()
    await setup.flush()
    expect(tb.getPlainText()).toBe(FULL)
    expect((code as any)._lastAppliedContent).toBe(FULL)
    expect((code as any)._highlightsDirty).toBe(false)
    expect((code as any)._isHighlighting).toBe(false)

    // Steady state: further renders must not re-fire (no new pending request).
    const pendingBefore = sitter.isHighlighting()
    await setup.flush()
    await setup.flush()
    expect(sitter.isHighlighting()).toBe(pendingBefore)
  } finally {
    setup.renderer.destroy()
  }
})
