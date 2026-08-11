import { describe, expect, test } from "bun:test"
import { TimeContext } from "@/session/time-context"
import { SessionV1 } from "@opencode-ai/core/v1/session"

function userMsg(time: number, text?: string, synthetic?: boolean): SessionV1.WithParts {
  const part = {
    type: "text",
    text: text ?? "hello",
    ...(synthetic ? { synthetic: true } : {}),
  } as SessionV1.TextPart
  return {
    info: { role: "user", time: { created: time }, agent: "build" } as SessionV1.User,
    parts: [part],
  }
}

const textOf = (msg: SessionV1.WithParts) => (msg.parts[0] as SessionV1.TextPart).text

describe("TimeContext.localIso", () => {
  test("formats local time with UTC offset", () => {
    const stamp = TimeContext.localIso(1786406400000)
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  })

  test("is byte-stable for the same instant", () => {
    const t = Date.now()
    expect(TimeContext.localIso(t)).toBe(TimeContext.localIso(t))
  })
})

describe("TimeContext.stampUserMessages", () => {
  test("stamps the first non-synthetic text part of a user message", () => {
    const msgs = [userMsg(1786406400000)]
    TimeContext.stampUserMessages(msgs)
    expect(textOf(msgs[0])).toContain(`\n\n<system-reminder>${TimeContext.localIso(1786406400000)}</system-reminder>`)
  })

  test("skips assistant messages", () => {
    const msgs: SessionV1.WithParts[] = [
      {
        info: { role: "assistant", time: { created: 1786406400000 } } as SessionV1.Assistant,
        parts: [{ type: "text", text: "reply" } as SessionV1.TextPart],
      },
    ]
    TimeContext.stampUserMessages(msgs)
    expect(textOf(msgs[0])).toBe("reply")
  })

  test("skips messages whose text part already contains a reminder", () => {
    const msgs = [userMsg(1786406400000, "already\n\n<system-reminder>2026-01-01T00:00:00.000Z</system-reminder>")]
    TimeContext.stampUserMessages(msgs)
    expect(textOf(msgs[0])).toContain("2026-01-01T00:00:00.000Z")
    expect(textOf(msgs[0])).not.toContain(TimeContext.localIso(1786406400000))
  })

  test("skips messages with only synthetic text parts", () => {
    const msgs = [userMsg(1786406400000, "synthetic", true)]
    TimeContext.stampUserMessages(msgs)
    expect(textOf(msgs[0])).toBe("synthetic")
  })
})

describe("TimeContext.stampToolOutput", () => {
  test("appends a UTC reminder to a string output", () => {
    const output = { output: "result" }
    TimeContext.stampToolOutput(output)
    expect(output.output).toMatch(/^result\n\n<system-reminder>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/system-reminder>$/)
  })

  test("skips outputs that already contain a reminder", () => {
    const output = { output: "result\n\n<system-reminder>2026-01-01T00:00:00.000Z</system-reminder>" }
    TimeContext.stampToolOutput(output)
    expect(output.output).toContain("2026-01-01T00:00:00.000Z")
    expect(output.output.match(/<system-reminder>/g)).toHaveLength(1)
  })

  test("no-op when output is not a string", () => {
    const output = { output: undefined }
    TimeContext.stampToolOutput(output)
    expect(output.output).toBeUndefined()
  })
})
