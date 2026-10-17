import { expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_reconcile_test")

// The projector strips id/sessionID from `data` before writing, and the column
// is text({ mode: "json" }) so the driver value is already decoded. These
// fixtures mirror that REAL shape - a test built on JSON strings alone hid the
// 2026-10-17 bug where JSON.parse threw for every stored row.
function assistant(created: number) {
  return {
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "test-model",
    providerID: "test",
    parentID: "msg_parent",
    time: { created },
  }
}

function toolPart() {
  return {
    type: "tool",
    tool: "bash",
    callID: "call_1",
    state: { status: "pending", input: {}, raw: "", time: { start: 1 } },
  }
}

// A mix of good rows and rows that fail per-item parsing. The reconcile's
// SELECT is stubbed to return exactly these rows (the real query's JSON filters
// are not the subject here); what matters is that one bad row does not abort
// the sweep, and that identity fields come from the row (not from `data`).
const messageRows = [
  { id: "msg_good_1", session_id: sessionID, data: assistant(1) },
  // Pre-migration rows may still be strings; both shapes must work.
  { id: "msg_legacy", session_id: sessionID, data: JSON.stringify(assistant(2)) },
  { id: "msg_bad", session_id: sessionID, data: "{not json" },
  { id: "msg_good_2", session_id: sessionID, data: assistant(3) },
]
const partRows = [
  { id: "prt_good", message_id: "msg_good_1", session_id: sessionID, data: toolPart() },
  { id: "prt_bad", message_id: "msg_good_1", session_id: sessionID, data: "{not json" },
]

const appliedMessages: string[] = []
const appliedParts: string[] = []

const database = Layer.succeed(Database.Service, {
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          all: () => Effect.succeed(table === MessageTable ? messageRows : partRows),
        }),
      }),
    }),
  },
} as never)

const events = Layer.succeed(EventV2Bridge.Service, {
  publish: (definition: { type: string }, data: { info?: { id: string }; part?: { id: string } }) => {
    if (definition.type === SessionV1.Event.MessageUpdated.type && data.info) appliedMessages.push(data.info.id)
    if (definition.type === SessionV1.Event.PartUpdated.type && data.part) appliedParts.push(data.part.id)
    return Effect.succeed({ id: "evt", type: definition.type, data })
  },
} as never)

const status = Layer.succeed(SessionStatus.Service, {
  get: () => Effect.succeed({ type: "idle" }),
} as never)

const background = Layer.succeed(BackgroundJob.Service, {} as never)

const env = LayerNode.compile(LayerNode.group([Session.node]), [
  [Database.node, database],
  [EventV2Bridge.node, events],
  [BackgroundJob.node, background],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [SessionStatus.node, status],
])
const it = testEffect(env)

it.effect("session.reconcile applies good items and collects per-item failures", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    const result = yield* session.reconcile({ sessionID, live: true })

    // Good rows (decoded AND legacy string shapes) are applied; the malformed
    // ones are reported, not thrown.
    expect(result.messages).toBe(3)
    expect(result.parts).toBe(1)
    expect(result.failures).toHaveLength(2)
    expect(result.failures.join("\n")).toContain("message msg_bad: JSON.parse failed")
    expect(result.failures.join("\n")).toContain("part prt_bad: JSON.parse failed")
    // Identity comes from the row, proving the reattachment path.
    expect(appliedMessages).toEqual(["msg_good_1", "msg_legacy", "msg_good_2"])
    expect(appliedParts).toEqual(["prt_good"])
  }),
)
