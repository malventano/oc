import { readFileSync, statSync, readdirSync, existsSync } from "node:fs"
import { join, basename, dirname, resolve } from "node:path"
import z from "zod"

const SKILLS_DIR = resolve(process.env.HOME || process.env.HOMEPATH || "/root", ".config/opencode/skills")

export default {
  description: `Read-only skill metadata query. Returns frontmatter (name, description), line/char counts, sibling file inventory, last-modified mtime, and description byte count for one or all skills. Use for auditing skill state, verifying description changes, or inspecting sibling structure without loading full bodies. No DB access — pure filesystem read.` ,
  args: {
    skill: z.string().optional().describe("Skill name (directory under ~/.config/opencode/skills/). Omit to return metadata for all skills."),
    includeSiblings: z.boolean().optional().default(true).describe("Include sibling file inventory (default true). Set false for compact output (name/description/lineCount only)."),
  },
  async execute(args, ctx) {
    if (!existsSync(SKILLS_DIR)) throw new Error(`Skills directory not found: ${SKILLS_DIR}`)
    const skillNames = args.skill
      ? [args.skill]
      : readdirSync(SKILLS_DIR).filter(name => existsSync(join(SKILLS_DIR, name, "SKILL.md")))

    if (args.skill && !existsSync(join(SKILLS_DIR, args.skill, "SKILL.md"))) {
      throw new Error(`Skill not found: ${args.skill}. Available: ${skillNames.join(", ") || "(none)"}`)
    }

    const results = []
    for (const name of skillNames) {
      const skillDir = join(SKILLS_DIR, name)
      const skillFile = join(skillDir, "SKILL.md")
      try {
        const stat = statSync(skillFile)
        const content = readFileSync(skillFile, "utf-8")
        const lines = content.split("\n")
        const lineCount = lines.length
        const charCount = content.length

        let description = ""
        let descriptionBytes = 0
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (fmMatch) {
          const fm = fmMatch[1]
          const descMatch = fm.match(/^description:\s*(.+)$/m)
          if (descMatch) {
            description = descMatch[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
            descriptionBytes = Buffer.byteLength(descMatch[1], "utf-8")
          }
        }

        const entry = { name, description, lineCount, charCount, lastModified: stat.mtime.toISOString(), descriptionBytes }
        if (args.includeSiblings !== false) {
          const allMd = readdirSync(skillDir).filter(f => f.endsWith(".md") && f !== "SKILL.md")
          const siblings = []
          for (const sib of allMd) {
            try {
              const sibPath = join(skillDir, sib)
              const sibStat = statSync(sibPath)
              const sibContent = readFileSync(sibPath, "utf-8")
              siblings.push({ name: sib, lineCount: sibContent.split("\n").length, charCount: sibContent.length, lastModified: sibStat.mtime.toISOString() })
            } catch {}
          }
          entry.siblings = siblings
          entry.siblingCount = siblings.length
        }
        results.push(entry)
      } catch (err) {
        results.push({ name, error: err.message })
      }
    }

    const summary = {
      totalSkills: results.length,
      totalDescriptionBytes: results.reduce((sum, r) => sum + (r.descriptionBytes || 0), 0),
      totalLineCount: results.reduce((sum, r) => sum + (r.lineCount || 0), 0),
      totalSiblingCount: results.reduce((sum, r) => sum + (r.siblingCount || 0), 0),
    }

    return {
      title: args.skill ? `Skill metadata: ${args.skill}` : `Skill metadata (${results.length} skills)`,
      output: JSON.stringify({ summary, skills: results }, null, 2),
      metadata: { skillCount: results.length, ...summary },
    }
  },
}
