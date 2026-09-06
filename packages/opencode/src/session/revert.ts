import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Deferred, Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
  readonly awaitInFlight: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const database = yield* Database.Service

    // In-flight revert latch per session (2026-09-04): the TUI undo fires
    // `revert` fire-and-forget and can follow it with an immediate Enter ->
    // `prompt` on another HTTP call. Without coordination, `prompt`'s
    // `revert.cleanup` reads a session snapshot that predates the revert commit
    // (cleanup no-ops, the stale rollback point lands AHEAD of the new prompt,
    // and the undo's slow `.then(toBottom)` lands after the submit).
    // `awaitInFlight` lets the prompt wait for the mutation to commit, then
    // re-reads the row so cleanup sees the settled revert state.
    const inflight = new Map<SessionID, Deferred.Deferred<void>>()

    const awaitInFlight = Effect.fnUntraced(function* (sessionID: SessionID) {
      const pending = inflight.get(sessionID)
      if (pending) yield* Deferred.await(pending)
    })

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      // Already reverting this session: join the in-flight revert instead of
      // running two overlapping ones (they would double-apply snapshots).
      const existing = inflight.get(input.sessionID)
      if (existing) {
        yield* Deferred.await(existing)
        return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      }
      const done = yield* Deferred.make<void>()
      inflight.set(input.sessionID, done)
      try {
        yield* state.assertNotBusy(input.sessionID)
        const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
        // Undo BOUNDED to the compaction+tail window (0271): full
        // `sessions.messages()` pages EVERY message of a long session per
        // undo/redo (21921 msgs = hundreds of pages, several seconds). The
        // revert only needs the messages the undo affects: the TARGET, prior
        // user messages for rev.messageID, and everything NEWER than the target
        // (that is where the snapshot patches collect). MessageV2.stream()
        // walks newest-first and caps AFTER two completed compaction markers +
        // tail reachability - the whole live-chain tail, exactly the range. A
        // target below the newest compaction boundary (undoing INTO or across
        // pre-compaction history) isn't inside the bounded window, so the walk
        // falls back to the full paging (the user's rule: cap walks within the
        // compaction+tail range; only walk back further when an undo/redo
        // crosses a boundary).
        const bounded = yield* MessageV2.stream(input.sessionID).pipe(
          Effect.provideService(Database.Service, database),
        )
        const targetable = (m: SessionV1.WithParts) =>
          (!input.partID && m.info.id === input.messageID) ||
          (!!input.partID && m.parts.some((p) => p.id === input.partID))
        const startIndex = bounded.findIndex((m) => targetable(m))
        // bounded is newest- FIRST; the target's index is where the newest
        // copy of it sits, and everything BEFORE it (indices 0..startIndex)
        // is NEWER - exactly the messages the revert's patch collection falls
        // on (patches accumulate after `rev` is found). Reversing
        // bounded.slice(0, startIndex+1) yields target + newer messages in
        // chronological order - a strict subset of what the full walk
        // produced, so the same loop logic applies. The target's own
        // `lastUser` resolves to itself when it is a user message (the TUI
        // undo always passes one), so no OLDER history is needed.
        const all = startIndex === -1
          ? yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
          : bounded.slice(0, startIndex + 1).reverse()
        let lastUser: SessionV1.User | undefined

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      const index = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = index < 0 ? [] : all.slice(index)
      const diffs = yield* summary.computeDiff({ messages: range })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      } finally {
        inflight.delete(input.sessionID)
        yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      }
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const index = msgs.findIndex((msg) => msg.info.id === messageID)
      const target = index < 0 ? undefined : msgs[index]
      const remove = index < 0 ? [] : msgs.slice(index + (session.revert.partID ? 1 : 0))
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup, awaitInFlight })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, Database.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
