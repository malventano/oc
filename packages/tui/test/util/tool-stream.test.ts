import { describe, expect, test } from "bun:test"
import { streamedJsonInput } from "../../src/routes/session"

describe("streamedJsonInput", () => {
  test("renders top-level primitive args in order", () => {
    expect(streamedJsonInput('{"op":"run","paneId":"%4","command":"echo hi"}')).toBe(
      "[op=run, paneId=%4, command=echo hi]",
    )
  })

  test("includes the mid-stream unterminated string value", () => {
    expect(streamedJsonInput('{"op":"run","paneId":"%4","command":"echo h')).toBe(
      "[op=run, paneId=%4, command=echo h]",
    )
  })

  test("includes a partial primitive token", () => {
    expect(streamedJsonInput('{"op":"run","wait":fals')).toBe("[op=run, wait=fals]")
  })

  test("skips nested objects and arrays", () => {
    expect(streamedJsonInput('{"op":"probe","patterns":{"panel":"esc dismiss"},"lines":40}')).toBe(
      "[op=probe, lines=40]",
    )
    expect(streamedJsonInput('{"op":"run","args":[1,2],"lines":40}')).toBe("[op=run, lines=40]")
  })

  test("includes booleans and numbers", () => {
    expect(streamedJsonInput('{"op":"run","wait":false,"timeoutSeconds":600}')).toBe(
      "[op=run, wait=false, timeoutSeconds=600]",
    )
  })

  test("unescapes string values", () => {
    expect(streamedJsonInput('{"command":"a\\nb"}')).toBe("[command=a\nb]")
  })

  test("returns undefined before the first pair streams", () => {
    expect(streamedJsonInput("")).toBeUndefined()
    expect(streamedJsonInput("{")).toBeUndefined()
    expect(streamedJsonInput('{"op"')).toBeUndefined()
  })
})
