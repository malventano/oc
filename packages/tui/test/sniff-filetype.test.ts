import { describe, expect, test } from "bun:test"
import { sniffFiletype } from "../src/routes/session"

const sniff = (content: string) => sniffFiletype(content, 0)

describe("write content sniffer", () => {
  test("powershell param block and CmdletBinding attribute", () => {
    expect(sniff("[CmdletBinding()]\nparam([string]$Name)\n")).toBe("powershell")
    expect(sniff("param(\n  [Parameter(Mandatory)]\n  [string]$Path\n)\n")).toBe("powershell")
  })

  test("powershell Verb-Noun functions and Write-* cmdlets", () => {
    expect(sniff("function Get-Thing {\n  Write-Host \"hi\"\n}\n")).toBe("powershell")
    expect(sniff("Write-Output 'done'\n")).toBe("powershell")
  })

  test("powershell automatic variables and #requires", () => {
    expect(sniff("$env:PATH = \"$env:PATH;/opt/tool\"\n")).toBe("powershell")
    expect(sniff("#requires -Version 7.0\nSet-StrictMode -Version Latest\n")).toBe("powershell")
  })

  test("csharp is not misread as powershell", () => {
    expect(sniff("using System;\nnamespace Foo {\n  class Bar { }\n}\n")).toBe("csharp")
  })

  test("bash shebang and markdown fallback still resolve", () => {
    expect(sniff("#!/usr/bin/env bash\nset -e\necho hi\n")).toBe("bash")
    expect(sniff("## Heading\n\n- one\n- two\n")).toBe("markdown")
  })
})
