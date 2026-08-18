import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"
import * as NFS from "fs/promises"
import type { Stats } from "node:fs"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  /** Per-skill file stats as of the last refresh (or the deleted sentinel). */
  lastSeen: Record<string, { mtimeMs: number; size: number } | { deleted: true }>
  /** Per-scanned-root dir mtime at last re-scan (dir mtime changes on entry add/remove). */
  dirMtimes: Record<string, number>
  /** Per-scanned-root matched path list at last re-scan (for add/remove detection). */
  matchCache: Record<string, string[]>
}

type ScanSpec = { root: string; pattern: string; opts?: { dot?: boolean; scope?: string } }

export type RefreshChange =
  | { name: string; deleted: true }
  | { name: string; deleted: false; description: string | undefined; content: string; mtimeMs: number }

type DiscoveryState = {
  matches: string[]
  dirs: string[]
  specs: ScanSpec[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
  specs: ScanSpec[]
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly refresh: (options?: { names?: Set<string> }) => Effect.Effect<RefreshChange[], never, never>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set(), specs: [] }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      state.specs.push({ root, pattern: EXTERNAL_SKILL_PATTERN, opts: { dot: true, scope: "global" } })
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      state.specs.push({ root, pattern: EXTERNAL_SKILL_PATTERN, opts: { dot: true, scope: "project" } })
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    state.specs.push({ root: dir, pattern: OPENCODE_SKILL_PATTERN })
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    state.specs.push({ root: dir, pattern: SKILL_PATTERN })
    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      state.specs.push({ root: dir, pattern: SKILL_PATTERN })
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
    specs: state.specs,
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set(), lastSeen: {}, dirMtimes: {}, matchCache: {} }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })
    const refresh: (options?: { names?: Set<string> }) => Effect.Effect<RefreshChange[], never, never> = (options) =>
      Effect.gen(function* () {
      const [s, d] = yield* Effect.all([InstanceState.get(state), InstanceState.get(discovered)], {
        concurrency: "unbounded",
      })
      const changed: RefreshChange[] = []
      // File-level: stat each cached skill's SKILL.md; re-parse on change. A failed
      // stat marks the skill deleted (once - the sentinel suppresses re-reports).
      // Mid-turn calls pass `names` (the skills loaded into this context since the
      // last compaction) so only those bodies are re-checked; the full re-stat +
      // dir rescan runs on the next real user turn only.
      const skillList = Object.values(s.skills).filter(
        (info) => info.location !== "<built-in>" && (!options?.names || options.names.has(info.name)),
      )
      // One batched stat pass for the skill files AND the dir-watch targets:
      // each Effect.all is a single suspension (~20ms of scheduler delay per
      // sequential suspension in the app), so merging the batches cuts the
      // full-refresh overhead by ~2 yields.
      const watchedDirs =
        options?.names
          ? []
          : (() => {
              const set = new Set<string>()
              for (const spec of d.specs) {
                set.add(spec.root)
                for (const m of s.matchCache[spec.root] ?? []) set.add(path.dirname(m))
                set.add(path.join(spec.root, "skills"))
                set.add(path.join(spec.root, "skill"))
              }
              return Array.from(set)
            })()
      const statResults = yield* Effect.all(
        [
          ...skillList.map((info) => ({ kind: "skill" as const, path: info.location, info })),
          ...watchedDirs.map((dir) => ({ kind: "dir" as const, path: dir, info: undefined as undefined })),
        ].map((t) =>
          Effect.tryPromise(() => NFS.stat(t.path)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.map((st) => ({ t, st })),
          ),
        ),
        { concurrency: "unbounded" },
      )
      // The merged batch yields { t, st } (t = {kind, path, info}); restore the
      // { info, st } shape the file-level consumers below destructure.
      type StatResult = (typeof statResults)[number]
      type DirStatResult = StatResult & { t: { kind: "dir" } }
      type SkillStatResult = StatResult & { t: { kind: "skill" } }
      const stats = statResults
        .filter((r): r is SkillStatResult => r.t.kind === "skill")
        .map(({ t, st }) => ({ info: t.info, st }))
      const dirStatByDir = new Map<string, Stats | undefined>(
        statResults.filter((r): r is DirStatResult => r.t.kind === "dir").map((r) => [r.t.path, r.st]),
      )
      const toParse = stats.filter(({ info, st }) => {
        if (!st) return false
        const prev = s.lastSeen[info.name]
        return !(prev && !("deleted" in prev) && prev.mtimeMs === st.mtimeMs && prev.size === st.size)
      })
      const parsed = yield* Effect.all(
        toParse.map(({ info }) =>
          Effect.tryPromise(() => ConfigMarkdown.parse(info.location)).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.map((md) => ({ info, md })),
          ),
        ),
        { concurrency: "unbounded" },
      )
      const parsedByLoc = new Map(parsed.flatMap((x) => (x.md ? [[x.info.location, x.md]] : [])))
      for (const { info, st } of stats) {
        const prev = s.lastSeen[info.name]
        if (!st) {
          if (prev && "deleted" in prev) continue
          s.lastSeen[info.name] = { deleted: true }
          changed.push({ name: info.name, deleted: true })
          continue
        }
        if (prev && !("deleted" in prev) && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue
        s.lastSeen[info.name] = { mtimeMs: st.mtimeMs, size: st.size }
        const md = parsedByLoc.get(info.location)
        if (!md || !isSkillFrontmatter(md.data)) continue
        s.skills[info.name] = {
          name: md.data.name,
          description: md.data.description,
          location: info.location,
          content: md.content,
        }
        changed.push({ name: md.data.name, deleted: false, description: md.data.description, content: md.content, mtimeMs: st.mtimeMs })
        if (md.data.name !== info.name) {
          // Frontmatter rename: drop the old key.
          delete s.skills[info.name]
          delete s.lastSeen[info.name]
        }
      }
      // Dir-level (full refresh only): re-scan roots whose dir mtime changed
      // (entry add/remove/rename), then add new matches and drop cached skills
      // whose file vanished from the scan. Mid-turn calls scope to the loaded
      // skills above and skip this - new dirs/renames wait for the user turn.
      if (!options?.names) {
       // Watch the parents of known matches plus the well-known skill dirs,
       // not just the root: a new SKILL.md lands at root/skills/<name>/SKILL.md,
       // which changes the skills/ dir's mtime - the root's own mtime only
       // changes for DIRECT children (grandchild add/remove would be missed).
       // dirStatByDir came from the merged stat batch above.
       for (const spec of d.specs) {
         const watched = new Set<string>([spec.root])
         for (const m of s.matchCache[spec.root] ?? []) watched.add(path.dirname(m))
         watched.add(path.join(spec.root, "skills"))
         watched.add(path.join(spec.root, "skill"))
         let rescan = false
         for (const dir of watched) {
           const st = dirStatByDir.get(dir)
           if (!st) continue
           if (s.dirMtimes[dir] !== st.mtimeMs) {
             s.dirMtimes[dir] = st.mtimeMs
             rescan = true
           }
         }
         if (!rescan) continue
         const scanState: ScanState = { matches: new Set(), dirs: new Set(), specs: [] }
        yield* scan(scanState, spec.root, spec.pattern, spec.opts)
        const prevMatches = new Set(s.matchCache[spec.root] ?? [])
        const curMatches = Array.from(scanState.matches)
        s.matchCache[spec.root] = curMatches
        for (const m of curMatches) {
          if (prevMatches.has(m) || Object.values(s.skills).some((i) => i.location === m)) continue
          yield* add(s, m, events)
          const info = Object.values(s.skills).find((i) => i.location === m)
          if (info) {
            const st2 = yield* Effect.tryPromise(() => NFS.stat(m)).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (st2) s.lastSeen[info.name] = { mtimeMs: st2.mtimeMs, size: st2.size }
          }
        }
        for (const [name, info] of Object.entries(s.skills)) {
          if (info.location === "<built-in>") continue
          if (prevMatches.has(info.location) && !curMatches.includes(info.location)) {
            delete s.skills[name]
            delete s.lastSeen[name]
            changed.push({ name, deleted: true })
          }
        }
      }
      }
      return changed
    })

    return Service.of({ get, require, all, dirs, available, refresh })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
