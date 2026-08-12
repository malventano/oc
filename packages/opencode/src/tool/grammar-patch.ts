// Patch-grammar parser: parses the `input` string of the edit tool into
// per-file sections compatible with the hashline engine's op schema.
// The patch grammar format is adapted from can1357/oh-my-pi (MIT license);
// this parser is our own implementation (see hashline.ts for the engine).

export type GrammarOp =
  | { type: "set_line"; line: string; text: string[] }
  | { type: "replace_lines"; start_line: string; end_line: string; text: string[] }
  | { type: "insert_after"; line: string; text: string[] }
  | { type: "insert_before"; line: string; text: string[] }
  | { type: "insert_between"; after_line: string; before_line: string; text: string[] }
  | { type: "append"; text: string[] }
  | { type: "prepend"; text: string[] }
  | { type: "cut"; start_line: string; end_line: string; register?: string }
  | { type: "paste"; register: string; insert_after_line?: string; insert_before_line?: string }

export type GrammarSection = {
 filePath: string
 tag?: string
 edits: GrammarOp[]
 delete?: boolean
 rename?: string
}

export type ParseResult = { ok: true; files: GrammarSection[] } | { ok: false; errors: string[] }

const ID_CHARS = "[0-9A-Z]{2}"
const ANCHOR = `\\d+#${ID_CHARS}`
const REG = "@[A-Za-z0-9_-]+"

const OPS: Array<{ re: RegExp; build: (m: RegExpExecArray) => GrammarOp | "fileLevel" | null }> = [
  { re: new RegExp(`^SET (${ANCHOR}):$`), build: (m) => ({ type: "set_line", line: m[1], text: [] }) },
  {
    re: new RegExp(`^REPLACE (${ANCHOR}) (${ANCHOR}):$`),
    build: (m) => ({ type: "replace_lines", start_line: m[1], end_line: m[2], text: [] }),
  },
  { re: new RegExp(`^AFTER (${ANCHOR}):$`), build: (m) => ({ type: "insert_after", line: m[1], text: [] }) },
  { re: new RegExp(`^BEFORE (${ANCHOR}):$`), build: (m) => ({ type: "insert_before", line: m[1], text: [] }) },
  {
    re: new RegExp(`^BETWEEN (${ANCHOR}) (${ANCHOR}):$`),
    build: (m) => ({ type: "insert_between", after_line: m[1], before_line: m[2], text: [] }),
  },
  { re: /^APPEND:$/, build: () => ({ type: "append", text: [] }) },
  { re: /^PREPEND:$/, build: () => ({ type: "prepend", text: [] }) },
  {
    re: new RegExp(`^CUT (${ANCHOR})(?: (${ANCHOR}))?(?: (${REG}))?$`),
    build: (m) => {
      const start = m[1]
      const end = m[2] ?? m[1]
      const op: GrammarOp = { type: "cut", start_line: start, end_line: end }
      if (m[3]) op.register = m[3]
      return op
    },
  },
  {
    re: new RegExp(`^PASTE (${REG}) (AFTER|BEFORE) (${ANCHOR})$`),
    build: (m) =>
      m[2] === "AFTER"
        ? { type: "paste", register: m[1], insert_after_line: m[3] }
        : { type: "paste", register: m[1], insert_before_line: m[3] },
  },
  { re: /^DELETE$/, build: () => "fileLevel" },
  { re: /^RENAME (.+)$/, build: () => "fileLevel" },
]

export function parsePatch(input: string | null | undefined): ParseResult {
  const lines = String(input ?? "").split(/\r?\n/)
  const errors: string[] = []
  let files: GrammarSection[] | null = null
  let cur: GrammarSection | null = null
  let body: string[] | null = null
  let fileLevelDone = false

  const fail = (i: number, line: string, msg: string) => {
    errors.push(`line ${i + 1}: ${msg} — got: ${JSON.stringify(line.slice(0, 80))}`)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === "") continue
    if (trimmed.startsWith("*** Begin Patch")) {
      if (files !== null) {
        fail(i, line, "duplicate begin marker")
        return { ok: false, errors }
      }
      files = []
      continue
    }
    if (trimmed.startsWith("*** End Patch")) {
      if (files === null) {
        fail(i, line, "end marker without begin")
        return { ok: false, errors }
      }
      if (files.length === 0) {
        fail(i, line, "empty patch (no file sections)")
        return { ok: false, errors }
      }
      return { ok: true, files }
    }
    if (files === null) {
      fail(i, line, "expected *** Begin Patch")
      return { ok: false, errors }
    }

    const sec = /^\[([^#\r\n]+)(?:#([0-9A-Za-z]{1,16}))?\]$/.exec(trimmed)
    if (sec) {
     cur = { filePath: sec[1], edits: [], tag: sec[2] }
      files.push(cur)
      body = null
      fileLevelDone = false
      continue
    }
    if (!cur) {
      fail(i, line, "file content before any [PATH] section")
      return { ok: false, errors }
    }

    if (line.startsWith("+")) {
      if (!body) {
        fail(i, line, "body row outside of an op that takes rows")
        return { ok: false, errors }
      }
      // `+` prefix: strip ONE optional separator space so the model's natural
      // diff-style `+ ` writing matches content byte-exactly (`+  x` -> " x").
      let content = line.slice(1)
      if (content.startsWith(" ")) content = content.slice(1)
      body.push(content)
      continue
    }
    if (line.startsWith(" ")) {
      fail(i, line, "content row must start with `+` (found leading whitespace)")
      return { ok: false, errors }
    }

    let matched = false
    for (const op of OPS) {
      const m = op.re.exec(line)
      if (!m) continue
      matched = true
      const built = op.build(m)
      if (built === "fileLevel") {
        if (fileLevelDone || cur.edits.length > 0 || body) {
          fail(i, line, `${line.startsWith("DELETE") ? "DELETE" : "RENAME"} is file-level: no other ops/rows in the section`)
          return { ok: false, errors }
        }
        if (line.startsWith("RENAME")) cur.rename = m[1]
        else cur.delete = true
        body = null
        fileLevelDone = true
        break
      }
      if (!built) {
        fail(i, line, "not a recognized op, directive, or `+` content row")
        return { ok: false, errors }
      }
      cur.edits.push(built)
      body = "text" in built ? built.text : null
      break
    }
    if (!matched) {
      fail(i, line, "not a recognized op, directive, or `+` content row")
      return { ok: false, errors }
    }
  }
  fail(lines.length, "", "missing *** End Patch")
  return { ok: false, errors }
}

/** First `[PATH#TAG]` section header in a patch (for TUI titles/approvals). */
export function patchSectionPath(input: string): string | undefined {
  const match = /^\[([^#\r\n]+)(?:#[0-9A-Za-z]{1,16})?\]/m.exec(String(input ?? ""))
  return match?.[1]
}
