import { Effect, Option, Schema } from "effect"
import path from "node:path"
import { Buffer } from "node:buffer"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Skill } from "../skill"
import * as Tool from "./tool"

const DESCRIPTION = `Read-only skill metadata query. Returns frontmatter (name, description), line/char counts, sibling file inventory, last-modified mtime, and description byte count for one or all skills. Use for auditing skill state, verifying description changes, or inspecting sibling structure without loading full bodies. No DB access - pure filesystem read.`

export const Parameters = Schema.Struct({
  skill: Schema.optional(Schema.String).annotate({
    description: "Skill name (directory under ~/.config/opencode/skills/). Omit to return metadata for all skills.",
  }),
  includeSiblings: Schema.optional(Schema.Boolean).annotate({
    description: "Include sibling file inventory (default true). Set false for compact output (name/description/lineCount only).",
  }),
})

type Metadata = { [key: string]: any }

function parseFrontmatter(content: string) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return { description: "", descriptionBytes: 0 }
  const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m)
  if (!descMatch) return { description: "", descriptionBytes: 0 }
  const raw = descMatch[1]
  const description = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
  return { description, descriptionBytes: Buffer.byteLength(raw, "utf-8") }
}

export const SkillMetadataTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | Skill.Service>(
  "skill-metadata",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const skills = yield* Skill.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const infos = params.skill
            ? [yield* skills.require(params.skill).pipe(Effect.orDie)]
            : (yield* skills.all()).toSorted((a, b) => a.name.localeCompare(b.name))

          const results = []
          for (const info of infos) {
            const entry = yield* (Effect.gen(function* () {
              if (!info.location.startsWith("/")) {
                return {
                  name: info.name,
                  description: info.description ?? "",
                  lineCount: info.content.split("\n").length,
                  charCount: info.content.length,
                }
              }
              const content = yield* fs.readFileString(info.location)
              const { description, descriptionBytes } = parseFrontmatter(content)
              const stat = yield* fs.stat(info.location)
              const lines = content.split("\n")
              const result: any = {
                name: info.name,
                description,
                lineCount: lines.length,
                charCount: content.length,
                lastModified: Option.getOrUndefined(stat.mtime)?.toISOString() ?? "",
                descriptionBytes,
              }
              if (params.includeSiblings !== false) {
                const siblings = []
                const dir = path.dirname(info.location)
                for (const sib of yield* fs.readDirectoryEntries(dir)) {
                  if (sib.name.endsWith(".md") && sib.name !== "SKILL.md" && sib.type === "file") {
                    const sibPath = path.join(dir, sib.name)
                    const [sibStat, sibContent] = yield* Effect.all([fs.stat(sibPath), fs.readFileString(sibPath)])
                    siblings.push({
                      name: sib.name,
                      lineCount: sibContent.split("\n").length,
                      charCount: sibContent.length,
                      lastModified: Option.getOrUndefined(sibStat.mtime)?.toISOString() ?? "",
                    })
                  }
                }
                result.siblings = siblings
                result.siblingCount = siblings.length
              }
              return result
            }).pipe(
              Effect.catch((err) => Effect.succeed({ name: info.name, error: (err as Error).message }))
            ))
            results.push(entry)
          }

          const summary = {
            totalSkills: results.length,
            totalDescriptionBytes: results.reduce((sum, r) => sum + (r.descriptionBytes || 0), 0),
            totalLineCount: results.reduce((sum, r) => sum + (r.lineCount || 0), 0),
            totalSiblingCount: results.reduce((sum, r) => sum + (r.siblingCount || 0), 0),
          }

          return {
            title: params.skill ? `Skill metadata: ${params.skill}` : `Skill metadata (${results.length} skills)`,
            output: JSON.stringify({ summary, skills: results }, null, 2),
            metadata: { skillCount: results.length, ...summary },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
