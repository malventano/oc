import { describe, expect, test } from "bun:test"
import { applyHashlineEdits, hashlineID, hashlineLine, hashlineRef, parseHashlineRef } from "../../src/tool/hashline"

function swapID(ref: string) {
  const [line, id] = ref.split("#")
  const next = id[0] === "Z" ? `P${id[1]}` : `Z${id[1]}`
  return `${line}#${next}`
}

function errorMessage(run: () => void) {
  try {
    run()
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe("tool.hashline", () => {
  test("hash computation is stable and 2-char alphabet encoded", () => {
    const a = hashlineID(1, "  const x = 1")
    const b = hashlineID(1, "constx=1")
    const c = hashlineID(99, "constx=1")
    expect(a).toBe(b)
    expect(a).toBe(c)
    expect(a).toMatch(/^[ZPMQVRWSNKTXJBYH]{2}$/)
  })

  test("low-signal lines mix line index into hash id", () => {
    const a = hashlineID(1, "")
    const b = hashlineID(2, "")
    const c = hashlineID(1, "{}")
    const d = hashlineID(2, "{}")
    expect(a).not.toBe(b)
    expect(c).not.toBe(d)
  })

  test("autocorrect strips copied hashline prefixes when enabled", () => {
    const old = Bun.env.OPENCODE_HL_AUTOCORRECT
    Bun.env.OPENCODE_HL_AUTOCORRECT = "1"
    try {
      const result = applyHashlineEdits({
        lines: ["a"],
        trailing: false,
        edits: [
          {
            type: "set_line",
            line: hashlineRef(1, "a"),
            text: hashlineLine(1, "b"),
          },
        ],
      })
      expect(result.lines).toEqual(["b"])
    } finally {
      if (old === undefined) delete Bun.env.OPENCODE_HL_AUTOCORRECT
      else Bun.env.OPENCODE_HL_AUTOCORRECT = old
    }
  })

  test("default autocorrect does not rewrite non-prefix content", () => {
    const result = applyHashlineEdits({
      lines: ["a"],
      trailing: false,
      edits: [
        {
          type: "set_line",
          line: hashlineRef(1, "a"),
          text: "+a",
        },
      ],
      autocorrect: true,
      aggressiveAutocorrect: false,
    })
    expect(result.lines).toEqual(["+a"])
  })
test("default autocorrect strips echoed anchor line from insert_after text", () => {
  const result = applyHashlineEdits({
    lines: ["keep", "end"],
    trailing: false,
    edits: [
      {
        type: "insert_after",
        line: hashlineRef(1, "keep"),
        text: ["keep", "new"],
      },
    ],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["keep", "new", "end"])
})

test("default autocorrect strips echoed anchor line from insert_before text", () => {
  const result = applyHashlineEdits({
    lines: ["start", "keep"],
    trailing: false,
    edits: [
      {
        type: "insert_before",
        line: hashlineRef(2, "keep"),
        text: ["new", "keep"],
      },
    ],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["start", "new", "keep"])
})

test("set_line echo auto-strips first line and converts to insert_after", () => {
  const result = applyHashlineEdits({
    lines: ["a", "b", "c"],
    trailing: false,
    edits: [{ type: "set_line", line: hashlineRef(2, "b"), text: ["b", "x", "y"] }],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["a", "b", "x", "y", "c"])
  expect(result.notes).toEqual(["stripped echoed first line (line 2): set_line treated as insert_after"])
})

test("replace_lines echo auto-strips first line and shifts range start", () => {
  const result = applyHashlineEdits({
    lines: ["pairs = []", "for k in items:", "    use(k)", "done"],
    trailing: false,
    edits: [
      {
        type: "replace_lines",
        start_line: hashlineRef(1, "pairs = []"),
        end_line: hashlineRef(3, "    use(k)"),
        text: ["pairs = []", "for k in items:", "    use(k, 1)", "    log(k)"],
      },
    ],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["pairs = []", "for k in items:", "    use(k, 1)", "    log(k)", "done"])
  expect(result.notes).toEqual(["stripped echoed lines (lines 1-2): range now starts at line 3"])
})

test("single-line replace_lines echo auto-strips and converts to insert_after", () => {
  const result = applyHashlineEdits({
    lines: ["a", "b"],
    trailing: false,
    edits: [
      {
        type: "replace_lines",
        start_line: hashlineRef(1, "a"),
        end_line: hashlineRef(1, "a"),
        text: ["a", "keep-and-add"],
      },
    ],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["a", "keep-and-add", "b"])
})

test("lone set_line echo (no new content) still fails closed as ambiguous", () => {
  expect(() =>
    applyHashlineEdits({
      lines: ["a", "b"],
      trailing: false,
      edits: [{ type: "set_line", line: hashlineRef(2, "b"), text: ["b"] }],
      autocorrect: true,
      aggressiveAutocorrect: false,
    }),
  ).toThrow(/ambiguous/)
})

test("insert_after echo strip keeps a non-echoing first line intact", () => {
  const result = applyHashlineEdits({
    lines: ["keep"],
    trailing: false,
    edits: [
      {
        type: "insert_after",
        line: hashlineRef(1, "keep"),
        text: ["new", "keep"],
      },
    ],
    autocorrect: true,
    aggressiveAutocorrect: false,
  })
  expect(result.lines).toEqual(["keep", "new", "keep"])
})

  test("parses strict LINE#ID references with tolerant extraction", () => {
    const ref = parseHashlineRef(">>> 12#ZP:const value = 1", "line")
    expect(ref.line).toBe(12)
    expect(ref.id).toBe("ZP")
    expect(ref.raw).toBe("12#ZP")

    expect(() => parseHashlineRef("12#ab", "line")).toThrow("LINE#ID")
  })

  test("reports compact mismatch errors with retry anchors", () => {
    const lines = ["alpha", "beta", "gamma"]
    const wrong = swapID(hashlineRef(2, lines[1]))

    const message = errorMessage(() =>
      applyHashlineEdits({
        lines,
        trailing: false,
        edits: [
          {
            type: "set_line",
            line: wrong,
            text: "BETA",
          },
        ],
      }),
    )

    expect(message).toContain("anchor mismatch")
    expect(message).toContain("retry with")
    expect(message).toContain("(line 2: beta)")
    expect(message).not.toContain(">>>")

    expect(message.length).toBeLessThan(260)
  })

  test("applies batched line edits bottom-up for stable results", () => {
    const lines = ["a", "b", "c", "d"]
    const one = hashlineRef(1, lines[0])
    const two = hashlineRef(2, lines[1])
    const three = hashlineRef(3, lines[2])
    const four = hashlineRef(4, lines[3])

    const result = applyHashlineEdits({
      lines,
      trailing: false,
      edits: [
        {
          type: "replace_lines",
          start_line: two,
          end_line: three,
          text: ["B", "C"],
        },
        {
          type: "insert_after",
          line: one,
          text: "A1",
        },
        {
          type: "set_line",
          line: four,
          text: "D",
        },
      ],
    })

    expect(result.lines).toEqual(["a", "A1", "B", "C", "D"])
  })

  test("orders append and prepend deterministically on empty files", () => {
    const result = applyHashlineEdits({
      lines: [],
      trailing: false,
      edits: [
        {
          type: "append",
          text: "end",
        },
        {
          type: "prepend",
          text: "start",
        },
      ],
    })

    expect(result.lines).toEqual(["start", "end"])
  })

  test("validates ranges, between constraints, and non-empty insert text", () => {
    const lines = ["a", "b", "c"]
    const one = hashlineRef(1, lines[0])
    const two = hashlineRef(2, lines[1])

    expect(() =>
      applyHashlineEdits({
        lines,
        trailing: false,
        edits: [
          {
            type: "replace_lines",
            start_line: two,
            end_line: one,
            text: "x",
          },
        ],
      }),
    ).toThrow("start_line")

    expect(() =>
      applyHashlineEdits({
        lines,
        trailing: false,
        edits: [
          {
            type: "insert_between",
            after_line: two,
            before_line: one,
            text: "x",
          },
        ],
      }),
    ).toThrow("insert_between.after_line")

    expect(() =>
      applyHashlineEdits({
        lines,
        trailing: false,
        edits: [
          {
            type: "append",
            text: "",
          },
        ],
      }),
    ).toThrow("append.text")
  })

  test("autocorrect strips a single copied ref-prefixed line without majority", () => {
    const old = Bun.env.OPENCODE_HL_AUTOCORRECT
    Bun.env.OPENCODE_HL_AUTOCORRECT = "1"
    try {
      const lines = ["a"]
      const ref = hashlineRef(1, "a")
      const result = applyHashlineEdits({
        lines,
        trailing: false,
        edits: [{ type: "set_line", line: ref, text: [`${ref}:first`, "second"] }],
      })
      expect(result.lines).toEqual(["first", "second"])
    } finally {
      if (old === undefined) delete Bun.env.OPENCODE_HL_AUTOCORRECT
      else Bun.env.OPENCODE_HL_AUTOCORRECT = old
    }
  })

  test("autocorrect strips +N#ID: diff-copy prefixes", () => {
    const old = Bun.env.OPENCODE_HL_AUTOCORRECT
    Bun.env.OPENCODE_HL_AUTOCORRECT = "1"
    try {
      const lines = ["a"]
      const ref = hashlineRef(1, "a")
      const result = applyHashlineEdits({
        lines,
        trailing: false,
        edits: [{ type: "set_line", line: ref, text: `+${ref}:copied` }],
      })
      expect(result.lines).toEqual(["copied"])
    } finally {
      if (old === undefined) delete Bun.env.OPENCODE_HL_AUTOCORRECT
      else Bun.env.OPENCODE_HL_AUTOCORRECT = old
    }
  })

  test("text arrays flatten embedded newlines and drop trailing empties", () => {
    const lines = ["a"]
    const ref = hashlineRef(1, "a")
    const result = applyHashlineEdits({
      lines,
      trailing: false,
      edits: [{ type: "insert_after", line: ref, text: ["b\nc", ""] }],
    })
    expect(result.lines).toEqual(["a", "b", "c"])
    const result2 = applyHashlineEdits({
      lines,
      trailing: false,
      edits: [{ type: "insert_after", line: ref, text: "b\n" }],
    })
    expect(result2.lines).toEqual(["a", "b"])
  })

  test("empty-string text deletes lines", () => {
    const lines = ["a", "b", "c"]
    const single = applyHashlineEdits({
      lines,
      trailing: false,
      edits: [{ type: "set_line", line: hashlineRef(2, "b"), text: "" }],
    })
    expect(single.lines).toEqual(["a", "c"])
    const range = applyHashlineEdits({
      lines,
      trailing: false,
      edits: [
        { type: "replace_lines", start_line: hashlineRef(2, "b"), end_line: hashlineRef(3, "c"), text: "" },
      ],
    })
    expect(range.lines).toEqual(["a"])
  })
})
test("changedLines tracks both replaced lines through a lower insert (shift collision)", () => {
  const content = ["a", "b", "c", "d"]
  const result = applyHashlineEdits({
    lines: [...content],
    trailing: false,
    edits: [
      {
        type: "replace_lines",
        start_line: hashlineRef(2, content[1]),
        end_line: hashlineRef(3, content[2]),
        text: ["B", "C"],
      },
      { type: "insert_after", line: hashlineRef(1, content[0]), text: ["a1"] },
    ],
  })
  expect(result.lines).toEqual(["a", "a1", "B", "C", "d"])
  // both replaced lines present at their final after-indexes (2 and 3),
  // not stomped by the shift of the lower insert
  expect(result.changedLines.get(2)).toBe("b")
  expect(result.changedLines.get(3)).toBe("c")
})
