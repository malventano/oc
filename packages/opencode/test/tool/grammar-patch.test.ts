import { describe, expect, test } from "bun:test"
import { type GrammarOp, type GrammarSection, parsePatch, patchSectionPath, patchSectionPaths } from "../../src/tool/grammar-patch"

function parseOk(input: string): GrammarSection[] {
  const parsed = parsePatch(input)
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"))
  return parsed.files
}

describe("grammar-patch parsePatch", () => {
  test("parses SET", () => {
    const files = parseOk("*** Begin Patch\n[a.txt#A1B2]\nSET 1#AB:\n+ hello\n*** End Patch")
    expect(files).toEqual([
      { filePath: "a.txt", tag: "A1B2", edits: [{ type: "set_line", line: "1#AB", text: ["hello"] }] },
    ])
  })

  test("captures the #TAG for basename disambiguation", () => {
    const files = parseOk("*** Begin Patch\n[a.txt#F00D]\nAPPEND:\n+ x\n*** End Patch")
    expect(files[0].tag).toBe("F00D")
    expect(files[0].filePath).toBe("a.txt")
  })

  test("leaves tag undefined when the header has no #TAG", () => {
    const files = parseOk("*** Begin Patch\n[a.txt]\nAPPEND:\n+ x\n*** End Patch")
    expect(files[0].tag).toBeUndefined()
  })

  test("parses REPLACE", () => {
    const files = parseOk("*** Begin Patch\n[a.txt#A1B2]\nREPLACE 1#AB 3#CD:\n+ a\n+ b\n*** End Patch")
    expect(files[0].edits[0]).toEqual({
      type: "replace_lines",
      start_line: "1#AB",
      end_line: "3#CD",
      text: ["a", "b"],
    })
  })

  test("parses AFTER/BEFORE/BETWEEN", () => {
    const files = parseOk(
      [
        "*** Begin Patch",
        "[a.txt#A1B2]",
        "AFTER 1#AB:",
        "+ x",
        "BEFORE 2#CD:",
        "+ y",
        "BETWEEN 1#AB 2#CD:",
        "+ z",
        "*** End Patch",
      ].join("\n"),
    )
    expect(files[0].edits).toEqual([
      { type: "insert_after", line: "1#AB", text: ["x"] },
      { type: "insert_before", line: "2#CD", text: ["y"] },
      { type: "insert_between", after_line: "1#AB", before_line: "2#CD", text: ["z"] },
    ])
  })

  test("parses APPEND/PREPEND", () => {
    const files = parseOk("*** Begin Patch\n[a.txt#A1B2]\nAPPEND:\n+ end\nPREPEND:\n+ start\n*** End Patch")
    expect(files[0].edits).toEqual([
      { type: "append", text: ["end"] },
      { type: "prepend", text: ["start"] },
    ])
  })

  test("parses CUT single-line, ranged, and with register", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "CUT 1#AB", "CUT 2#CD 3#EF", "CUT 4#GH 5#IJ @fn", "*** End Patch"].join("\n"),
    )
    expect(files[0].edits).toEqual([
      { type: "cut", start_line: "1#AB", end_line: "1#AB" },
      { type: "cut", start_line: "2#CD", end_line: "3#EF" },
      { type: "cut", start_line: "4#GH", end_line: "5#IJ", register: "@fn" },
    ])
  })

  test("parses PASTE after and before", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "PASTE @fn AFTER 5#JK", "PASTE @fn BEFORE 6#LM", "*** End Patch"].join("\n"),
    )
    expect(files[0].edits).toEqual([
      { type: "paste", register: "@fn", insert_after_line: "5#JK" },
      { type: "paste", register: "@fn", insert_before_line: "6#LM" },
    ])
  })

  test("parses PASTE with optional trailing colon (matches other op headers)", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "PASTE @fn AFTER 5#JK:", "PASTE @fn BEFORE 6#LM:", "*** End Patch"].join("\n"),
    )
    expect(files[0].edits).toEqual([
      { type: "paste", register: "@fn", insert_after_line: "5#JK" },
      { type: "paste", register: "@fn", insert_before_line: "6#LM" },
    ])
  })

  test("parses DELETE and RENAME as file-level ops", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "RENAME b.txt", "[c.txt#C3D4]", "DELETE", "*** End Patch"].join("\n"),
    )
    expect(files[0]).toEqual({ filePath: "a.txt", tag: "A1B2", edits: [], rename: "b.txt" })
    expect(files[1]).toEqual({ filePath: "c.txt", tag: "C3D4", edits: [], delete: true })
  })

  test("strips one required separator space and keeps extra whitespace", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+ x", "+  x", "+", "+   y", "*** End Patch"].join("\n"),
    )
    const append = files[0].edits[0] as Extract<GrammarOp, { type: "append" }>
    expect(append.text).toEqual(["x", " x", "", "  y"])
  })

  test("accepts `+x` content rows as `+ x` (0113 separator-fold acceptance, with a parse note)", () => {
    const result = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+x", "*** End Patch"].join("\n"))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const append = result.files[0].edits[0] as Extract<GrammarOp, { type: "append" }>
      expect(append.text).toEqual(["x"])
      expect(result.files[0].parseNotes?.some((n) => n.includes("accepted as `+ x`"))).toBe(true)
    }
  })

  test("rejects `-` deletion rows (ranges delete implicitly, 0113)", () => {
    const result = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "- old line", "*** End Patch"].join("\n"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("no `-` deletion rows")
  })

  test("blank line is `+` alone", () => {
    const files = parseOk(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+", "*** End Patch"].join("\n"))
    const append = files[0].edits[0] as Extract<GrammarOp, { type: "append" }>
    expect(append.text).toEqual([""])
  })

  test("parses multiple file sections in one patch", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+ a", "[b.txt#C3D4]", "APPEND:", "+ b", "*** End Patch"].join("\n"),
    )
    expect(files.map((f) => f.filePath)).toEqual(["a.txt", "b.txt"])
    const append = files[1].edits[0] as Extract<GrammarOp, { type: "append" }>
    expect(append.text).toEqual(["b"])
  })

  test("parses cut/paste register flows across files", () => {
    const files = parseOk(
      ["*** Begin Patch", "[a.txt#A1B2]", "CUT 2#CD 3#EF @fn", "[b.txt#C3D4]", "PASTE @fn AFTER 1#AB", "*** End Patch"].join("\n"),
    )
    expect(files[0].edits[0]).toEqual({ type: "cut", start_line: "2#CD", end_line: "3#EF", register: "@fn" })
    expect(files[1].edits[0]).toEqual({ type: "paste", register: "@fn", insert_after_line: "1#AB" })
  })

  test("allows ops after a file-level op (engine enforces combinations)", () => {
    const files = parseOk(["*** Begin Patch", "[a.txt#A1B2]", "DELETE", "APPEND:", "+ x", "*** End Patch"].join("\n"))
    expect(files[0].delete).toBe(true)
    expect(files[0].edits[0]).toEqual({ type: "append", text: ["x"] })
  })

  test("rejects unknown op lines with line numbers", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "BOGUS 2#CD:", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("line 3")
      expect(parsed.errors.join("\n")).toContain("BOGUS")
    }
  })

  test("rejects body rows outside of an op that takes rows", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "+ stray", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("body row outside of an op")
  })

  test("rejects rows with leading whitespace instead of +", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "  x", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("content row must start with `+`")
  })

  test("rejects missing *** End Patch", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+ x"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("missing *** End Patch")
  })

  test("rejects content before any [PATH] section", () => {
    const parsed = parsePatch(["*** Begin Patch", "APPEND:", "+ x", "[a.txt#A1B2]", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("file content before any [PATH] section")
  })

  test("rejects duplicate begin markers", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "*** Begin Patch", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("duplicate begin marker")
  })

  test("rejects end marker without begin", () => {
    const parsed = parsePatch("*** End Patch")
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("end marker without begin")
  })

  test("rejects empty patches", () => {
    expect(parsePatch("*** Begin Patch\n*** End Patch").ok).toBe(false)
  })

  test("rejects file-level ops combined with prior ops or rows", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "APPEND:", "+ x", "DELETE", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("DELETE is file-level")
  })

  test("rejects a second file-level op in one section", () => {
    const parsed = parsePatch(["*** Begin Patch", "[a.txt#A1B2]", "RENAME b.txt", "DELETE", "*** End Patch"].join("\n"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors[0]).toContain("DELETE is file-level")
  })

  test("handles null/undefined input", () => {
    expect(parsePatch(null).ok).toBe(false)
    expect(parsePatch(undefined).ok).toBe(false)
  })
})

describe("grammar-patch patchSectionPath", () => {
  test("returns the first section path", () => {
    expect(patchSectionPath("*** Begin Patch\n[a.txt#A1B2]\nAPPEND:\n+ x\n[b.txt#C3D4]\n*** End Patch")).toBe("a.txt")
  })

  test("matches sections without a tag", () => {
    expect(patchSectionPath("*** Begin Patch\n[a.txt]\n*** End Patch")).toBe("a.txt")
  })

  test("returns undefined when no section exists", () => {
    expect(patchSectionPath("*** Begin Patch\nAPPEND:\n+ x\n*** End Patch")).toBeUndefined()
    expect(patchSectionPath("")).toBeUndefined()
    expect(patchSectionPath("")).toBeUndefined()
  })
})

describe("grammar-patch patchSectionPaths", () => {
  test("returns all section headers in order", () => {
    const paths = patchSectionPaths(
      ["*** Begin Patch", "[a.txt#A1B2]", "SET 1#AB:", "+ x", "[b.txt#C3D4]", "APPEND:", "+ y", "*** End Patch"].join("\n"),
    )
    expect(paths).toEqual(["a.txt", "b.txt"])
  })

  test("skips op lines and content rows", () => {
    const paths = patchSectionPaths(
      ["*** Begin Patch", "[a.txt#A1B2]", "SET 1#AB:", "+ [not-a-section]", "*** End Patch"].join("\n"),
    )
    expect(paths).toEqual(["a.txt"])
  })

  test("handles null/empty input", () => {
    expect(patchSectionPaths(null)).toEqual([])
    expect(patchSectionPaths("")).toEqual([])
  })
})
