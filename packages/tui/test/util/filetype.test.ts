import { describe, expect, test } from "bun:test"
import { filetype } from "../../src/util/filetype"

describe("util.filetype", () => {
  test("maps filenames to presentation languages", () => {
    expect(filetype("component.tsx")).toBe("typescript")
    expect(filetype("script.js")).toBe("typescript")
    expect(filetype("main.py")).toBe("python")
    expect(filetype("README.unknown")).toBe("none")
  })

  test("uses none for missing filenames", () => {
    expect(filetype()).toBe("none")
    expect(filetype("")).toBe("none")
  })

  // 0360 precondition: a streaming filePath whose extension has not landed
  // yet resolves "none" - a TRUTHY value. The write live view must treat it
  // as NOT confident (fall through to the sniff/latch), or the transient
  // no-grammar signal raw-repaints the whole body (the write flash).
  test("an extensionless streaming path resolves the truthy no-grammar value", () => {
    expect(filetype("/root/oc/opencode/tmp/probe-run1")).toBe("none")
    expect(filetype("/root/oc/opencode/tmp/probe-run1.")).toBe("none")
    expect(filetype("/root/oc/opencode/tmp/probe-run1.m")).toBe("objective-c")
    expect(filetype("/root/oc/opencode/tmp/probe-run1.md")).toBe("markdown")
  })
})
