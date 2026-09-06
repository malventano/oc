import { afterEach, test } from "bun:test"
import { createSignal } from "solid-js"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"

// SIM harness (0274 root-cause). The reasoning code element uses
// filetype + drawUnstyledText={false} + streaming={true}. opentui's
// `set content` then DEFERS the buffer update to the async highlight
// (requestRender + return); the buffer only reflects the last LANDED
// highlight, so the box wraps against a stale near-final snapshot - the
// persisted-extra-LF jitter. Compare:
//   A: deferred config (the reasoning as-is)
//   B: plain streaming code (sync setText)   <- the control
//   F: same as A but streaming flips to false at the final delta
//      (the candidate root-cause fix)
// Feed the same real reasoning text in word increments; report laid-out
// height vs true word-wrap height.

const WIDTH = 140

function wrapRows(line: string, width: number): number {
  if (!line) return 1
  let rows = 1
  let cur = 0
  for (const w of line.split(" ")) {
    if (cur === 0) cur = w.length
    else if (cur + 1 + w.length <= width) cur += 1 + w.length
    else {
      rows++
      cur = w.length
    }
  }
  return rows
}

function trueWrap(text: string, width: number): number {
  return text.split("\n").reduce((acc, l) => acc + wrapRows(l, width), 0)
}

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

test("deferred streaming wrap divergence + streaming-off fix", async () => {
  const textFull = await Bun.file("/tmp/simtext.txt").text().catch(() => "")
  const raw =
    textFull.length > 1000
      ? textFull
      : Array.from(
          { length: 120 },
          (_, i) => `Line ${i}: The quick brown fox jumps over the lazy dog ${i} times.`.repeat(6),
        ).join("\n")

  const [aContent, setA] = createSignal("")
  const [bContent, setB] = createSignal("")
  const [fContent, setF] = createSignal("")
  const [fDone, setFDone] = createSignal(false)
  const syntaxStyle = SyntaxStyle.create()
  const fg = RGBA.fromValues(127, 127, 127, 1)
  let aEl: any
  let bEl: any
  let fEl: any

  testSetup = await testRender(
    () => (
      <box width={WIDTH} height={200}>
        <code
          ref={(e: any) => {
            aEl = e
          }}
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          width="100%"
          syntaxStyle={syntaxStyle}
          content={aContent()}
          conceal={false}
          fg={fg}
        />
        <code
          ref={(e: any) => {
            bEl = e
          }}
          streaming={true}
          width="100%"
          syntaxStyle={syntaxStyle}
          content={bContent()}
          fg={fg}
        />
        <code
          ref={(e: any) => {
            fEl = e
          }}
          filetype="markdown"
          drawUnstyledText={false}
          streaming={!fDone()}
          width="100%"
          syntaxStyle={syntaxStyle}
          content={fContent()}
          conceal={false}
          fg={fg}
        />
      </box>
    ),
    { width: WIDTH, height: 200 },
  )
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  const readHeight = (el: any) => {
    try {
      return el?.getLayoutNode?.().getComputedLayout?.().height ?? 0
    } catch {
      return 0
    }
  }
  const bufLen = (el: any) => {
    try {
      return el?.textBuffer?.getPlainText?.().length ?? -1
    } catch {
      return -1
    }
  }

  // stream in word increments, but STOP short of the final text (the final
  // delta is delivered together with the completion flag below)
  const words = raw.split(" ")
  const perChunk = Math.max(1, Math.ceil(words.length / 300))
  let prev = ""
  let lastStreamed = ""
  let steps = 0
  for (let i = 0; i < words.length - perChunk; i += perChunk) {
    const slice = words.slice(0, i + perChunk).join(" ")
    if (slice === prev) continue
    prev = slice
    lastStreamed = slice
    setA(slice)
    setB(slice)
    setF(slice)
    await testSetup.renderOnce()
    await testSetup.renderOnce()
    steps++
  }

  const T_BEFORE = trueWrap(lastStreamed, WIDTH)
  console.log(`streamed ${steps} steps; last intermediate true=${T_BEFORE}`)
  console.log(
    `mid: A laid=${readHeight(aEl)} buf=${bufLen(aEl)} B laid=${readHeight(bEl)} F laid=${readHeight(fEl)} buf=${bufLen(fEl)}`,
  )

  // completion: deliver the FINAL text while flipping streaming off on F.
  // This is the real-world ordering (the last delta and the reasoning end
  // land together). A and B stay streaming.
  setFDone(true)
  setF(raw)
  setA(raw)
  setB(raw)
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  await testSetup.renderOnce()

  const trueF = trueWrap(raw, WIDTH)
  console.log(
    `FINAL true=${trueF} A laid=${readHeight(aEl)} buf=${bufLen(aEl)} B laid=${readHeight(bEl)} F laid=${readHeight(fEl)} buf=${bufLen(fEl)}`,
  )
  if (readHeight(fEl) !== trueF) {
    throw new Error(`F (streaming-off fix) did not lay out at true wrap: got ${readHeight(fEl)}, want ${trueF}`)
  }
})
