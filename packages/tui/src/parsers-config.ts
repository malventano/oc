export default {
  // NOTE: FOR markdown, javascript and typescript, we use the opentui built-in parsers
  // Warn: when taking queries from the nvim-treesitter repo, make sure to include the query dependencies as well
  //       marked with for example `; inherits: ecma` at the top of the file. Just put the dependencies before the actual query.
  //       ALSO: Some queries use breaking changes in the nvim-treesitter repo, that are not compatible with the (web-)tree-sitter parser.
  parsers: [
    {
      filetype: "python",
      wasm: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
      queries: {
        highlights: [
          // NOTE: This nvim-treesitter query is currently broken, because the parser is not compatible with the query apparently.
          //       it is using "except" nodes that the parser is complaining about, but it has been in the query for 3+ years.
          //       Unclear.
          // "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/python/highlights.scm",
          "https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/python/locals.scm",
        ],
      },
    },
    {
      filetype: "rust",
      wasm: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/locals.scm",
        ],
      },
    },
    {
      filetype: "go",
      wasm: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/locals.scm",
        ],
      },
    },
    {
      filetype: "cpp",
      wasm: "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/cpp/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/cpp/locals.scm",
        ],
      },
    },
    {
      filetype: "csharp",
      wasm: "https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c_sharp/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c_sharp/locals.scm",
        ],
      },
    },
    {
      filetype: "bash",
      wasm: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/bash/highlights.scm",
        ],
      },
    },
    {
      filetype: "c",
      wasm: "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.1/tree-sitter-c.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/c/locals.scm",
        ],
      },
    },
    {
      filetype: "java",
      wasm: "https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.5/tree-sitter-java.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/java/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/java/locals.scm",
        ],
      },
    },
    {
      filetype: "kotlin",
      wasm: "https://github.com/fwcd/tree-sitter-kotlin/releases/download/0.3.8/tree-sitter-kotlin.wasm",
      queries: {
        highlights: ["https://raw.githubusercontent.com/fwcd/tree-sitter-kotlin/0.3.8/queries/highlights.scm"],
        locals: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/kotlin/locals.scm"],
      },
    },
    {
      filetype: "ruby",
      wasm: "https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/ruby/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/ruby/locals.scm",
        ],
      },
    },
    {
      filetype: "php",
      wasm: "https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.24.2/tree-sitter-php.wasm",
      queries: {
        highlights: [
          // NOTE: This nvim-treesitter query is currently broken, because the parser is not compatible with the query apparently.
          // "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/php/highlights.scm",
          "https://github.com/tree-sitter/tree-sitter-php/raw/refs/heads/master/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "scala",
      wasm: "https://github.com/tree-sitter/tree-sitter-scala/releases/download/v0.24.0/tree-sitter-scala.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/scala/highlights.scm",
        ],
      },
    },
    {
      filetype: "html",
      wasm: "https://github.com/tree-sitter/tree-sitter-html/releases/download/v0.23.2/tree-sitter-html.wasm",
      queries: {
        highlights: [
          // NOTE: This nvim-treesitter query is currently broken, because the parser is not compatible with the query apparently.
          // "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/html/highlights.scm",
          "https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/highlights.scm",
        ],
        // TODO: Injections not working for some reason
        // injections: [
        //   "https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/injections.scm",
        // ],
      },
      // injectionMapping: {
      //   nodeTypes: {
      //     script_element: "javascript",
      //     style_element: "css",
      //   },
      //   infoStringMap: {
      //     javascript: "javascript",
      //     css: "css",
      //   },
      // },
    },
    {
      filetype: "vue",
      wasm: "https://github.com/anomalyco/tree-sitter-vue/releases/download/v0.1.2/tree-sitter-vue.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/html_tags/highlights.scm",
          "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/vue/highlights.scm",
        ],
      },
    },
    {
      filetype: "hcl",
      // terraform and terraform-vars use the HCL grammar (0429).
      aliases: ["terraform", "terraform-vars"],
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-hcl/releases/download/v1.2.0/tree-sitter-hcl.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/hcl/highlights.scm",
        ],
      },
    },
    {
      filetype: "json",
      wasm: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm",
        ],
      },
    },
    {
      filetype: "yaml",
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/yaml/highlights.scm",
        ],
      },
    },
    {
      filetype: "haskell",
      wasm: "https://github.com/tree-sitter/tree-sitter-haskell/releases/download/v0.23.1/tree-sitter-haskell.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/haskell/highlights.scm",
        ],
      },
    },
    {
      filetype: "css",
      wasm: "https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/css/highlights.scm",
        ],
      },
    },
    {
      filetype: "julia",
      wasm: "https://github.com/tree-sitter/tree-sitter-julia/releases/download/v0.23.1/tree-sitter-julia.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/julia/highlights.scm",
        ],
      },
    },
    {
      filetype: "lua",
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/download/v0.5.0/tree-sitter-lua.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-lua/v0.5.0/queries/highlights.scm",
        ],
        locals: ["https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-lua/v0.5.0/queries/locals.scm"],
      },
    },
    {
      filetype: "ocaml",
      wasm: "https://github.com/tree-sitter/tree-sitter-ocaml/releases/download/v0.24.2/tree-sitter-ocaml.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/ocaml/highlights.scm",
        ],
      },
    },
    {
      filetype: "clojure",
      // temporarily using fork to fix issues
      wasm: "https://github.com/anomalyco/tree-sitter-clojure/releases/download/v0.0.1/tree-sitter-clojure.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/clojure/highlights.scm",
        ],
      },
    },
    {
      filetype: "swift",
      wasm: "https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.1/tree-sitter-swift.wasm",
      queries: {
        highlights: [
          // NOTE: Using parser repo queries instead of nvim-treesitter due to incompatible #lua-match? predicates.
          // 0429: pinned to the 0.7.1 tag - the main-branch query references
          // unsafe_expression, which the 0.7.1 wasm does not have.
          // "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/highlights.scm
          "https://raw.githubusercontent.com/alex-pinkus/tree-sitter-swift/0.7.1/queries/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/swift/locals.scm",
        ],
      },
    },
    {
      filetype: "toml",
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/toml/highlights.scm",
        ],
      },
    },
    {
      filetype: "nix",
      // TODO: Replace with official tree-sitter-nix WASM when published
      // See: https://github.com/nix-community/tree-sitter-nix/issues/66
      wasm: "https://github.com/ast-grep/ast-grep.github.io/raw/40b84530640aa83a0d34a20a2b0623d7b8e5ea97/website/public/parsers/tree-sitter-nix.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/nix/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/nix/locals.scm",
        ],
      },
    },
    {
      filetype: "diff",
      aliases: ["udiff", "patch"],
      // v0.2.0 (2026-08-14) REQUIRED: the master queries reference nodes
      // added after v0.1.0 (2025-10-29) - change, comment, dissimilarity,
      // payload, size, special (binary patches, dissimilarity headers,
      // normal-diff change markers). v0.1.0 + master queries = query
      // compile failure -> "initialization error" -> plain-text fallback.
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-diff/releases/download/v0.2.0/tree-sitter-diff.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/2520c3f934b3179bb540d23e0ef45f75304b5fed/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "elixir",
      wasm: "https://github.com/elixir-lang/tree-sitter-elixir/releases/download/v0.3.5/tree-sitter-elixir.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/elixir/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/elixir/locals.scm",
        ],
      },
    },
    {
      filetype: "fsharp",
      wasm: "https://github.com/ionide/tree-sitter-fsharp/releases/download/0.3.0/tree-sitter-fsharp.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/fsharp/highlights.scm",
        ],
      },
    },
    {
      filetype: "r",
      wasm: "https://github.com/r-lib/tree-sitter-r/releases/download/v1.2.0/tree-sitter-r.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/r/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/r/locals.scm",
        ],
      },
    },
    {
      filetype: "make",
      aliases: ["makefile"],
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-make/releases/download/v1.1.1/tree-sitter-make.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/make/highlights.scm",
        ],
      },
    },
    {
      filetype: "vim",
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-vim/releases/download/v0.8.1/tree-sitter-vim.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/vim/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/vim/locals.scm",
        ],
      },
    },
    {
      filetype: "xml",
      // XSL stylesheets are XML (0429).
      aliases: ["xsl"],
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-xml/releases/download/v0.7.0/tree-sitter-xml.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/xml/highlights.scm",
        ],
        locals: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/xml/locals.scm",
        ],
      },
    },
    {
      filetype: "agda",
      wasm: "https://github.com/tree-sitter/tree-sitter-agda/releases/download/v1.3.3/tree-sitter-agda.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/agda/highlights.scm",
        ],
      },
    },

    // 0429: grammar coverage for the remaining LANGUAGE_EXTENSIONS values.
    // Every wasm and query below was loaded and compiled together with
    // web-tree-sitter 0.25.10 before landing (Language.load + Query compile).
    // Queries come from the same release/tag as the wasm; where the only
    // usable wasm is a pinned bundle, the query is the bundle's own or is
    // pinned to the exact build commit. Languages with no usable grammar are
    // intentionally absent and resolve as no-grammar (plain on both sides).
    {
      filetype: "astro",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/astro/tree-sitter-astro.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/astro/highlights.scm"],
      },
    },
    {
      filetype: "batch",
      aliases: ["bat"],
      // 0.4.2: 0.5.0+ queries use (?i) inside #match?, which web-tree-sitter 0.25.10 rejects.
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-batch@0.4.2/tree-sitter-batch.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-batch@0.4.2/queries/highlights.scm"],
      },
    },
    {
      filetype: "bibtex",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/bibtex/tree-sitter-bibtex.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/bibtex/highlights.scm"],
      },
    },
    {
      filetype: "d",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/d/tree-sitter-d.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/d/highlights.scm"],
      },
    },
    {
      filetype: "dart",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-dart@1.0.0/tree-sitter-dart.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-dart@1.0.0/queries/highlights.scm"],
      },
    },
    {
      filetype: "dockerfile",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/dockerfile/tree-sitter-dockerfile.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/dockerfile/highlights.scm"],
      },
    },
    {
      filetype: "embedded_template",
      aliases: ["erb"],
      wasm: "https://github.com/tree-sitter/tree-sitter-embedded-template/releases/download/v0.25.0/tree-sitter-embedded_template.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter/tree-sitter-embedded-template/v0.25.0/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "erlang",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/erlang/tree-sitter-erlang.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/erlang/highlights.scm"],
      },
    },
    {
      filetype: "git_rebase",
      aliases: ["git-rebase"],
      wasm: "https://github.com/the-mikedavis/tree-sitter-git-rebase/releases/download/v1.0.0/tree-sitter-git_rebase.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/the-mikedavis/tree-sitter-git-rebase/v1.0.0/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "gleam",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/gleam/tree-sitter-gleam.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/gleam/highlights.scm"],
      },
    },
    {
      filetype: "groovy",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/groovy/tree-sitter-groovy.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/groovy/highlights.scm"],
      },
    },
    {
      filetype: "handlebars",
      wasm: "https://github.com/bennypowers/tree-sitter-handlebars/releases/download/v0.1.1/tree-sitter-handlebars.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/bennypowers/tree-sitter-handlebars/v0.1.1/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "ini",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/ini/tree-sitter-ini.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/ini/highlights.scm"],
      },
    },
    {
      filetype: "pug",
      aliases: ["jade"],
      // codemirror-treesitter wasm + the version-matched npm query.
      wasm: "https://cdn.jsdelivr.net/gh/Eric-Song-Nop/codemirror-treesitter@d91b8e13b21abde718caa56bd64e2891da997b0d/packages/language-data/src/wasm/tree-sitter-pug.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-pug@1.0.12/queries/highlights.scm"],
      },
    },
    {
      filetype: "latex",
      // treelight pins wasm and query to the same build; the tree-sitter-wasm
      // 2.0.4 latex query uses 3-arg #set!, which this runtime rejects.
      wasm: "https://cdn.jsdelivr.net/gh/matoous/treelight@14a71e455a4800b789ce1d27960d74d9b048ba82/packages/languages/latex/src/wasm/tree-sitter-latex.wasm",
      queries: {
        highlights: [
          "https://cdn.jsdelivr.net/gh/matoous/treelight@14a71e455a4800b789ce1d27960d74d9b048ba82/packages/languages/latex/src/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "less",
      wasm: "https://cdn.jsdelivr.net/gh/Eric-Song-Nop/codemirror-treesitter@d91b8e13b21abde718caa56bd64e2891da997b0d/packages/language-data/src/wasm/tree-sitter-less.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/helix-editor/helix/ba40e547426b0f9896c8bdc699a4ab11f2b37dbc/runtime/queries/less/highlights.scm",
        ],
      },
    },
    {
      filetype: "objc",
      aliases: ["objective-c"],
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-objc/releases/download/v3.0.2/tree-sitter-objc.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-objc/v3.0.2/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "pascal",
      wasm: "https://cdn.jsdelivr.net/gh/Eric-Song-Nop/codemirror-treesitter@d91b8e13b21abde718caa56bd64e2891da997b0d/packages/language-data/src/wasm/tree-sitter-pascal.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-pascal@0.0.1/queries/highlights.scm"],
      },
    },
    {
      filetype: "perl",
      wasm: "https://github.com/tree-sitter-perl/tree-sitter-perl/releases/download/v2.0.0/tree-sitter-perl.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter-perl/tree-sitter-perl/v2.0.0/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "powershell",
      // The npm package ships the wasm and the matching query. The
      // nvim-treesitter query does not compile against this grammar
      // (Bad node name 'class').
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-powershell@0.25.10/tree-sitter-powershell.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-powershell@0.25.10/queries/highlights.scm"],
      },
    },
    {
      filetype: "razor",
      wasm: "https://github.com/meloncholera/tree-sitter-razor-modern/releases/download/v0.1.0/tree-sitter-razor.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/meloncholera/tree-sitter-razor-modern/v0.1.0/queries/highlights.scm",
        ],
      },
    },
    {
      filetype: "scss",
      // lumis wasm + its processed query pinned to the same build revision.
      wasm: "https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-scss@0.26.2/tree-sitter-scss.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/leandrocp/lumis/ba127578eb8580b903106cc8b75769b69b0b248a/queries/processed/scss/highlights.scm",
        ],
      },
    },
    {
      filetype: "sql",
      wasm: "https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/sql/tree-sitter-sql.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/tree-sitter-wasm@2.0.4/out/sql/highlights.scm"],
      },
    },
    {
      filetype: "svelte",
      wasm: "https://cdn.jsdelivr.net/npm/@tree-sitter-grammars/tree-sitter-svelte@1.0.2/tree-sitter-svelte.wasm",
      queries: {
        highlights: ["https://cdn.jsdelivr.net/npm/@tree-sitter-grammars/tree-sitter-svelte@1.0.2/queries/highlights.scm"],
      },
    },
    {
      filetype: "typst",
      // lumis wasm built from uben0 46cf4de; query pinned to that revision.
      wasm: "https://cdn.jsdelivr.net/npm/@lumis-sh/wasm-typst@0.26.3/tree-sitter-typst.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/uben0/tree-sitter-typst/46cf4ded12ee974a70bf8457263b67ad7ee0379d/queries/typst/highlights.scm",
        ],
      },
    },
    {
      filetype: "zig",
      wasm: "https://github.com/tree-sitter-grammars/tree-sitter-zig/releases/download/v1.1.2/tree-sitter-zig.wasm",
      queries: {
        highlights: [
          "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-zig/v1.1.2/queries/highlights.scm",
        ],
      },
    },
  ],
}
