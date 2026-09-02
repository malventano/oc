import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Skill } from "@/skill"
import type { ReconstructedSkill } from "../../src/session/skill-delta"
import {
  buildSkillDeltaText,
  computeSkillDeltas,
  extractSkillBody,
  integrateSkillBodies,
} from "../../src/session/skill-delta"

// ---------------------------------------------------------------------------
// Fixture builders (plain object shapes, cast to the session part/message types
// - the walk only reads type/tool/state/synthetic/metadata).
// ---------------------------------------------------------------------------

const SKILL_DIR = "/skills/mcp-docs"

function skillLoadOutput(name: string, body: string): string {
  return [
    `<skill_content name="${name}">`,
    `# Skill: ${name}`,
    "",
    body,
    "",
    `Base directory for this skill: ${SKILL_DIR}`,
    "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    `<file>${SKILL_DIR}/ref.md</file>`,
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

function loadPart(name: string, body: string): SessionV1.Part {
  return {
    id: "p-load",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "skill",
    state: { status: "completed", input: { name }, output: skillLoadOutput(name, body) },
  } as unknown as SessionV1.Part
}

function deltaPart(name: string, content: string | null, deleted = false): SessionV1.Part {
  return {
    id: "p-delta",
    sessionID: "s",
    messageID: "m",
    type: "text",
    text: "<system-reminder>skill drift</system-reminder>",
    synthetic: true,
    metadata: { skillDelta: { [name]: deleted ? { deleted: true } : { content } } },
  } as unknown as SessionV1.Part
}

function editPart(patch: string, filePath: string, relativePath = filePath): SessionV1.Part {
  return {
    id: "p-edit",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "edit",
    state: {
      status: "completed",
      input: { input: "*** Begin Patch" },
      metadata: { paths: [filePath], files: [{ filePath, relativePath, patch }] },
    },
  } as unknown as SessionV1.Part
}

function writePart(filePath: string, content: string): SessionV1.Part {
  return {
    id: "p-write",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    tool: "write",
    state: { status: "completed", input: { filePath, content }, output: "Wrote file." },
  } as unknown as SessionV1.Part
}

function msg(parts: SessionV1.Part[]): SessionV1.WithParts {
  return { info: { id: "m", role: "user" as const, time: { created: 0 } }, parts } as unknown as SessionV1.WithParts
}

const reconstructed = (
  applied: string | null,
  baseline: string | null,
  deleted = false,
  location: string | null = `${SKILL_DIR}/SKILL.md`,
): ReconstructedSkill => ({
  applied,
  baseline,
  deleted,
  location,
})

const unifiedPatch = (from: string, to: string): string =>
  createTwoFilesPatch("a/SKILL.md", "b/SKILL.md", from, to, "", "")

// ---------------------------------------------------------------------------

describe("skill-delta.extractSkillBody", () => {
  test("extracts the content region between the header and the base-dir note", () => {
    const output = skillLoadOutput("mcp-docs", "Use lookup before mutate.\n\nPrefer search.")
    expect(extractSkillBody(output)).toBe("Use lookup before mutate.\n\nPrefer search.")
  })

  test("falls back to the trimmed output when markers are missing", () => {
    expect(extractSkillBody("just some text\n")).toBe("just some text")
  })
})

describe("skill-delta.integrateSkillBodies", () => {
  test("empty chain yields nothing", () => {
    expect(integrateSkillBodies([]).size).toBe(0)
  })

  test("a load establishes the baseline", () => {
    const out = integrateSkillBodies([msg([loadPart("mcp-docs", "v1 body")])])
    const st = out.get("mcp-docs")
    expect(st).toEqual(reconstructed(null, "v1 body"))
  })

  test("a post-load delta replaces the applied state", () => {
    const out = integrateSkillBodies([msg([loadPart("mcp-docs", "v1 body")]), msg([deltaPart("mcp-docs", "v2 body")])])
    expect(out.get("mcp-docs")).toEqual(reconstructed("v2 body", "v1 body"))
  })

  test("multiple deltas: last wins", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([deltaPart("mcp-docs", "v2")]),
      msg([deltaPart("mcp-docs", "v3")]),
    ])
    expect(out.get("mcp-docs")?.applied).toBe("v3")
    expect(out.get("mcp-docs")?.baseline).toBe("v1")
  })

  test("a reload resets the skill epoch: pre-load deltas are never integrated", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([deltaPart("mcp-docs", "v2")]),
      msg([loadPart("mcp-docs", "v2 fresh")]),
    ])
    const st = out.get("mcp-docs")
    expect(st).toEqual(reconstructed(null, "v2 fresh"))
  })

  test("a delta without a prior load is not integrated", () => {
    const out = integrateSkillBodies([msg([deltaPart("mcp-docs", "v2")])])
    expect(out.get("mcp-docs")).toBeUndefined()
  })

  test("a deleted marker is carried", () => {
    const out = integrateSkillBodies([msg([loadPart("mcp-docs", "v1")]), msg([deltaPart("mcp-docs", null, true)])])
    expect(out.get("mcp-docs")).toEqual(reconstructed(null, "v1", true))
  })

  test("two skills tracked independently", () => {
    const out = integrateSkillBodies([
      msg([loadPart("a", "a1")]),
      msg([loadPart("b", "b1")]),
      msg([deltaPart("a", "a2")]),
    ])
    expect(out.get("a")?.applied).toBe("a2")
    expect(out.get("b")?.applied).toBeNull()
    expect(out.get("b")?.baseline).toBe("b1")
  })

  test("a session edit is incorporated into the applied state", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([editPart(unifiedPatch("v1", "v2"), `${SKILL_DIR}/SKILL.md`)]),
    ])
    expect(out.get("mcp-docs")?.applied).toBe("v2")
  })

  test("a write after the load replaces the applied state", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([writePart(`${SKILL_DIR}/SKILL.md`, "v2 from write")]),
    ])
    expect(out.get("mcp-docs")?.applied).toBe("v2 from write")
  })

  test("a write to an UNRELATED file does not pollute the applied state (BUG_SKILL_DELTA_WRITE_POLLUTION)", () => {
    // The write branch lacked the edit branch's location gate: ANY completed
    // write set every tracked skill's applied body to that file's content, so
    // the next step-1 prompt diffed an unrelated file against the real
    // SKILL.md and emitted a bogus skill-drift reminder (old = last file
    // written, new = the skill).
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1 body")]),
      msg([writePart("/root/oc/opencode/bugs/BUG_EDIT_INLINE_MARKERS.md", "unrelated bytes")]),
    ])
    expect(out.get("mcp-docs")?.applied).toBeNull()
    expect(out.get("mcp-docs")?.baseline).toBe("v1 body")
  })

  test("an edit touching a different file does not alter the applied state", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([editPart(unifiedPatch("x", "y"), "/other/file.ts")]),
    ])
    expect(out.get("mcp-docs")?.applied).toBeNull()
    expect(out.get("mcp-docs")?.baseline).toBe("v1")
  })

  test("a reload resets the applied state even after a session edit", () => {
    const out = integrateSkillBodies([
      msg([loadPart("mcp-docs", "v1")]),
      msg([editPart(unifiedPatch("v1", "v2"), `${SKILL_DIR}/SKILL.md`)]),
      msg([loadPart("mcp-docs", "v2 fresh")]),
    ])
    expect(out.get("mcp-docs")).toEqual(reconstructed(null, "v2 fresh"))
  })
})

describe("skill-delta.computeSkillDeltas", () => {
  const changed = (name: string, content?: string): Skill.RefreshChange[] => [
    content === undefined
      ? { name, deleted: true }
      : { name, deleted: false, description: "desc", content, mtimeMs: 0 },
  ]

  test("no change for a skill absent from the changed set", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v1", "v1")]]), changed("b", "b1"))
    expect(out).toEqual([])
  })

  test("0 delta when the file is still in the reported state", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v2", "v1")]]), changed("a", "v2"))
    expect(out).toEqual([])
  })

  test("0 delta when the file matches the baseline (no deltas since the load)", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed(null, "v1")]]), changed("a", "v1"))
    expect(out).toEqual([])
  })

  test("0 delta when the file matches the state a session edit left it in", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v2", "v1")]]), changed("a", "v2"))
    expect(out).toEqual([])
  })

  test("a changed file yields an incremental diff plus the new content", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v2", "v1")]]), changed("a", "v3"))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: "a", deleted: false, content: "v3" })
    expect(out[0].diff?.lines).toContain("- v2")
    expect(out[0].diff?.lines).toContain("+ v3")
  })

  test("an external change after a session edit diffs incrementally (not against the load)", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v2", "v1")]]), changed("a", "v3"))
    expect(out).toHaveLength(1)
    expect(out[0].diff?.lines).not.toContain("- v1")
    expect(out[0].diff?.lines).toContain("- v2")
  })

  test("deletion: reported once (not re-reported when reconstruction already knows)", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed("v1", "v1")]]), changed("a"))
    expect(out).toEqual([{ name: "a", deleted: true }])
    const out2 = computeSkillDeltas(new Map([["a", reconstructed(null, "v1", true)]]), changed("a"))
    expect(out2).toEqual([])
  })

  test("recreated file diffs from empty", () => {
    const out = computeSkillDeltas(new Map([["a", reconstructed(null, "v1", true)]]), changed("a", "new body"))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ name: "a", deleted: false, content: "new body" })
    expect(out[0].diff?.lines).toContain("+ new body")
  })
})

describe("skill-delta.buildSkillDeltaText", () => {
  test("renders the reminder wrapper with per-skill diff sections", () => {
    const text = buildSkillDeltaText([
      { name: "mcp-docs", deleted: false, diff: { lines: ["- old", "+ new"], truncated: false } },
      { name: "gone", deleted: true },
    ])
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("mcp-docs")
    expect(text).toContain("- old")
    expect(text).toContain("+ new")
    expect(text).toContain("gone")
    expect(text).toContain("deleted from disk")
    expect(text).toContain("</system-reminder>")
  })
})
