import path from "node:path"

export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".abap": "abap",
  ".bat": "bat",
  ".bib": "bibtex",
  ".bibtex": "bibtex",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".coffee": "coffeescript",
  ".c": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".cs": "csharp",
  ".csx": "csharp",
  ".css": "css",
  ".d": "d",
  ".pas": "pascal",
  ".pascal": "pascal",
  ".diff": "diff",
  ".patch": "diff",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".ets": "typescript",
  ".hrl": "erlang",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".gitcommit": "git-commit",
  ".gitrebase": "git-rebase",
  ".go": "go",
  ".groovy": "groovy",
  ".gleam": "gleam",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".tex": "latex",
  ".latex": "latex",
  ".less": "less",
  ".lua": "lua",
  ".makefile": "makefile",
  makefile: "makefile",
  ".md": "markdown",
  ".markdown": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".pl": "perl",
  ".pm": "perl",
  ".pm6": "perl6",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".pug": "jade",
  ".jade": "jade",
  ".py": "python",
  ".r": "r",
  ".cshtml": "razor",
  ".razor": "razor",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".erb": "erb",
  ".html.erb": "erb",
  ".js.erb": "erb",
  ".css.erb": "erb",
  ".json.erb": "erb",
  ".rs": "rust",
  ".scss": "scss",
  ".sass": "sass",
  ".scala": "scala",
  ".shader": "shaderlab",
  // 0199: the shell family must resolve to "bash" - the REAL tree-sitter
  // grammar name (opentui's own extensionToFiletype maps sh/bash/zsh/ksh to
  // bash). The previous "shellscript" value had no grammar: the write tool
  // streamed a .sh file with a filetype that returned ZERO highlights (the
  // content stayed raw - grey while streaming, white after completion),
  // while the bash tool (hardcoded "bash") was colorful.
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ksh": "bash",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".xml": "xml",
  ".xsl": "xsl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".zig": "zig",
  ".zon": "zig",
  ".astro": "astro",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".nix": "nix",
  ".typ": "typst",
  ".typc": "typst",
  // ".txt" is a first-class TYPE with NO tree-sitter grammar (2026-09-08):
  // it must not resolve to "none" (unknown). Consumers distinguish the
  // no-grammar types via isNoGrammar() - the write live view streams them
  // unstyled-bright (dimming is only the pre-identification state), and the
  // diff views render them unstyled instead of deferring to a highlight
  // that never fires (permanent blank).
  ".txt": "text",
}

// The JS/TS family renders with ONE grammar (the typescript grammar covers
// plain JS) so a view that renders the same file in two phases never shows
// a grammar flip. The completed write view resolves through this; the
// streaming sniffer (index.tsx) must resolve its guess through it too, or a
// content-first write streams "javascript" and completes "typescript"
// (BUG_WRITE_STREAMING_DUPLICATE_GREY.md, grammar axis 0157).
export function coalesceFiletype(language: string | undefined) {
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language!)) return "typescript"
  return language
}

// No-grammar types: no tree-sitter grammar exists for these, so a consumer
// that defers to an async highlight would wait on a highlight that never
// fires (permanent blank) - it must render unstyled instead. "none" = no
// LANGUAGE_EXTENSIONS match (unknown/extensionless); "text" = the explicit
// plain-text type (no grammar by design, 2026-09-08).
export function isNoGrammar(language: string | undefined) {
  return language === undefined || language === "none" || language === "text"
}

export function filetype(input?: string) {
  if (!input) return "none"
  return coalesceFiletype(LANGUAGE_EXTENSIONS[path.extname(input)]) ?? "none"
}
