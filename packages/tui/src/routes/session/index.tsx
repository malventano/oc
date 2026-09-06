import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { appendFileSync } from "node:fs"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useArgs } from "../../context/args"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { SPINNER_FRAMES, Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import {
  countTurnWalkParts,
  foldTurnSteps,
  formatCount,
  newTurnLiveAccum,
  streamRateFor,
  streamedChars,
  turnLiveFromAccum,
  turnSteps,
} from "../../component/prompt/turn-stats"
import type { TurnDbWalk, TurnLiveAccum, TurnWalkPageState } from "../../component/prompt/turn-stats"
import type {
  AssistantMessage,
  Message,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
  SessionStatus,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK, setStreamBatchWindow, STREAM_BATCH_MIN_MS } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { coalesceFiletype, filetype } from "../../util/filetype"
import { parseStreamingPatch } from "../../util/streaming-patch"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"
import { restart } from "../../util/restart"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

// Position-keyed draft stash for undo/redo navigation. When the user has a
// typed-but-unsubmitted draft in the input field and walks away with undo/
// redo, the draft is preserved here (keyed by the message id of the position
// it belongs to, or "bottom" for the live session tail) and restored when they
// navigate back. In-memory only: a draft is ephemeral UI state - it dies with
// the process and never enters the session DB (which records submitted
// history). Without this, undo populates the reverted prompt and redo to the
// bottom clears the field, losing the user's draft on the round trip.
const draftStash = new Map<string, PromptInfo>()
const DRAFT_STASH_BOTTOM = "bottom"

// cancellable prompt-restore timer (2026-09-04): undo/redo restore the prompt
// into the input field via a setTimeout(0) (the slash menu's close clears the
// input after the command run, so the restore must land after it). If the user
// hits Enter before the restore lands, the submit must CANCEL it - otherwise
// the pending restore fires after submitInner cleared the field and
// re-populates it with the just-submitted text (the "had to enter again" feel;
// a second Enter then duplicates the prompt). The retry loop re-arms the same
// timer so the single id tracks the newest pending restore.
let pendingRestoreTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRestore(fn: () => void, delay: number) {
  if (pendingRestoreTimer) clearTimeout(pendingRestoreTimer)
  pendingRestoreTimer = setTimeout(() => {
    pendingRestoreTimer = null
    fn()
  }, delay)
}
function cancelRestore() {
  if (pendingRestoreTimer) {
    clearTimeout(pendingRestoreTimer)
    pendingRestoreTimer = null
  }
}

export const alwaysSeparate = new WeakSet<BoxRenderable>()

type RetryAction = Extract<SessionStatus, { type: "retry" }>["action"]

function goUpsellKeys(action: RetryAction) {
  if (!action) return
  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return {
      lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT,
      dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW,
    }
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    }
  }
}

const sessionBindingCommands = [
  "session.share",
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.unshare",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  // Solid's <For> keys by item REFERENCE, but the sync store replaces message
  // objects on every message.updated reconcile - without stable keys every
  // message block remounts mid-turn, destroying the scrollbox's manual-scroll
  // anchor (the root cause of the pruned-viewport jumps: a remounted anchor
  // leaves no reference to compensate the next prune). Key by message id: each
  // entry is a stable shell whose msg() memo resolves the CURRENT message
  // reactively, so only the changed block re-renders (equalFn on the memo
  // value keeps untouched blocks dormant).
  const messageShells = new Map<string, { id: string; msg: () => Message | undefined }>()
  const keyedMessages = createMemo(() => {
    const list = messages()
    const seen = new Set<string>()
    const out: { id: string; msg: () => Message | undefined }[] = []
    for (const m of list) {
      seen.add(m.id)
      let shell = messageShells.get(m.id)
      if (!shell) {
        const id = m.id
        shell = {
          id,
          msg: createMemo(() => (sync.data.message[route.sessionID] ?? []).find((x) => x.id === id)),
        }
        messageShells.set(id, shell)
      }
      out.push(shell)
    }
    for (const id of messageShells.keys()) {
      if (!seen.has(id)) messageShells.delete(id)
    }
    return out
  })
  // Marker message ids whose compaction part is `virtual` (created by the
  // virtual-compact path). Their synthetic summaries render as compact blocks
  // instead of full assistant messages, mirroring the undo block.
  const virtualCompactionMarkers = createMemo(() => {
    const set = new Set<string>()
    for (const message of messages()) {
      if (message.role !== "user") continue
      const parts = sync.data.part[message.id] ?? []
      if (parts.some((p) => p.type === "compaction" && p.virtual === true)) set.add(message.id)
    }
    return set
  })
  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    return index === -1 ? messages() : messages().slice(0, index)
  }
  // Reduce a message's parts back into a prompt: plain text (non-synthetic)
  // becomes the input, file parts are re-attached. Shared by undo/redo so the
  // input mirrors the session state at every revert point.
  const promptInfoFromParts = (parts: Part[]) =>
    parts.reduce(
      (agg, part) => {
        if (part.type === "text") {
          if (!part.synthetic) agg.input += part.text
        }
        if (part.type === "file") agg.parts.push(part)
        return agg
      },
      { input: "", parts: [] as PromptInfo["parts"] },
    )
  // Draft-stash navigation helpers. The stash is keyed by the position the
  // draft belongs to: the message id of the revert point, or a bottom key
  // scoped to the current last-user-message id (so a NEW submit naturally
  // orphans the pre-submit draft - the key stops matching). A position's
  // "expected" prompt (message-derived) is not a user draft and is never
  // stashed; only text the user actually typed beyond that survives the
  // undo/redo round trip.
  const expectedPromptAt = (messageID: string | undefined): PromptInfo =>
    messageID ? promptInfoFromParts(sync.data.part[messageID] ?? []) : { input: "", parts: [] as PromptInfo["parts"] }
  const currentDraftKey = (): string => {
    const revertID = session()?.revert?.messageID
    if (revertID) return revertID
    const lastUser = messages().findLast((m) => m.role === "user")
    return `${DRAFT_STASH_BOTTOM}:${lastUser?.id ?? "none"}`
  }
  // Stash the field's content for the position it currently occupies, but only
  // when it is a genuine user draft (differs from the position's message text).
  // A draft must NEVER be overwritten by the position's message-derived text:
  // after an undo restores the reverted prompt into the field, a subsequent
  // stashCurrentDraft() (e.g. redo's) must not clobber the already-stashed
  // draft with that message text - the bottom restore would then return the
  // message instead of the draft (the 07-14 live catch: `test` draft came back
  // as the restored message text). The `same` comparison must be against the
  // expected text at the KEY ITSELF (bottom -> the last user message's text),
  // not merely the render state, and an existing stash always wins.
  const stashCurrentDraft = () => {
    if (!prompt) return
    const cur = prompt.current
    if (!cur.input && cur.parts.length === 0) return
    const key = currentDraftKey()
    // Expected text at the KEY's OWN position: a bottom key expects the last
    // user message's restorable text; a raw message id expects that message's
    // text. A field holding the message text (an undo restore, not a user
    // draft) matches and is skipped.
    const expected =
      key.startsWith(`${DRAFT_STASH_BOTTOM}:`)
        ? expectedPromptAt(messages().findLast((m) => m.role === "user")?.id)
        : expectedPromptAt(key)
    const same = cur.input === expected.input && cur.parts.length === expected.parts.length
    if (same) return
    // Never clobber an existing stash: the first stash of a position wins.
    if (draftStash.has(key)) return
    // Store a CLONE, not the live store.prompt proxy: an undo restore
    // repopulates the field with the message text via prompt.set, mutating
    // the same object a by-reference stash would hold - the stashed draft
    // would silently become the message text (live catch: `test` restored as
    // the message text). The copy freezes the draft at stash time.
    draftStash.set(key, {
      input: cur.input,
      parts: cur.parts.map((p) => ({ ...p })),
    })
  }
  const foregroundTasks = createMemo(() =>
    sync.data.capabilities.experimentalBackgroundSubagents
      ? messages().flatMap((message) =>
          (sync.data.part[message.id] ?? []).filter(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              part.state.metadata?.background !== true,
          ),
        )
      : [],
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  const pending = createMemo(() => {
    const completed = messages().findLastIndex((message) => message.role === "assistant" && message.time.completed)
    const pending = messages().findLastIndex(
      (message, index) => index > completed && message.role === "assistant" && !message.time.completed,
    )
    return pending === -1 ? undefined : pending
  })

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const args = useArgs()
  const [promptRefSignal, setPromptRefSignal] = createSignal<PromptRef | undefined>()
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    setPromptRefSignal(r)
    if (!r) return
    if (route.prompt) {
      seeded = true
      r.set(route.prompt)
      return
    }
    // Re-seed on EVERY bind (the Prompt remounts when the session route's
    // visibility flips): args.prompt must land in the input regardless of
    // mount count - idempotent. EXCEPT once the resume prompt has been
    // CONSUMED (auto-submitted at boot, module latch): re-seeding it after a
    // later remount (e.g. the Prompt rebinding when a single-click question
    // answer closes) would plant the stale "Restart complete: <reason>" text
    // into the input field, visible but never re-submitted - the 0247 latch
    // stops the submit, not the seed (live 2026-09-06: pasted the restart
    // complete text into the prompt field after answering a push question).
    if (args.prompt && !resumePromptFired.has(`${route.sessionID}\u0000${args.prompt}`)) {
      r.set({ input: args.prompt, parts: [] })
    }
  }

  // Tool-initiated restart (the `restart` tool): the processor ends the turn
  // at the tool result; once the turn FINALIZES (time.completed written, the
  // message.updated event fires post-write), execve in place with the resume
  // prompt - the new instance boots into this session and auto-submits it,
  // handing the turn back to the agent.
  const restartFired = new Set<string>()
  event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.sessionID !== route.sessionID) return
    if (info.role !== "assistant" || !info.time.completed) return
    if (restartFired.has(info.id)) return
    const parts = sync.data.part[info.id] ?? []
    // Type-guard predicate: .find returns the un-narrowed Part union, and
    // the property access below needs the ToolPart variant.
    const tool = parts.find(
      (p): p is ToolPart => p.type === "tool" && p.tool === "restart" && p.state.status === "completed",
    )
    if (!tool) return
    restartFired.add(info.id)
    const reason = (tool.state.input as { reason?: string } | undefined)?.reason
    restart(info.sessionID, reason ? `Restart complete: ${reason}` : "Restart complete")
  })

  // Boot with --prompt into an existing session (tool-initiated restart
  // resume, or `oc -s <id> --prompt "..."` from the shell): auto-submit once
  // the TUI is ready AND the mode has synced. The prompt component restores
  // the agent from the session's lastUserAgent (primary-only latch); firing
  // before that latch would run the turn in the config-default agent, not the
  // session's plan/build mode. Subagent-mode sessions skip the latch by
  // design - the gate falls through so the prompt still fires.
  //
  // Gate: TUI ready + mode latched + the session IDLE (a prompt fired while
  // the restart turn is still winding down behaves like an Enter during a
  // turn - wait for the last assistant to finalize) + the seeded input
  // matches (the bind re-seeds per mount). Submit goes through the prompt
  // component (the user-Enter path, live-verified) with the input seeded by
  // the bind.
  //
  // The mode-latch comparison is on NAMES: local.agent.current() is the
  // agent OBJECT while lastUserAgent is the name string - an object!==string
  // comparison never latches (the 2026-08-16 investigation: the gate probe
  // displayed current().name so every probe showed a "pass" while the object
  // comparison blocked the submit; the direct-SDK alternative was also
  // evaluated and rejected - the component path is the proven one).
  let resumeSent = false
  createEffect(() => {
    if (resumeSent || !args.prompt) return
    if (!sync.ready || !local.model.ready) return
    const sessionID = route.sessionID
    if (!sessionID) return
    const lastUserAgent = sync.session.get(sessionID)?.lastUserAgent
    if (!lastUserAgent) return
    const primary = local.agent.list().some((x) => x.name === lastUserAgent)
    if (primary && local.agent.current()?.name !== lastUserAgent) return
    if (sync.session.status(sessionID) !== "idle") return
    const r = promptRefSignal()
    if (!r) return
    if (r.current.input !== args.prompt) return
    // Module-level latch (NOT component scope): a crash-dialogue "Restart"
    // (ErrorBoundary reset) remounts this route, resetting resumeSent, but the
    // process never re-exec'd and args.prompt still holds the stale --prompt -
    // without the module latch the OLD restart prompt would re-submit as a fresh
    // turn (BUG_CRASH_DIALOG_RESTART_PROMPT). Keyed on sessionID+prompt so a
    // genuine restart (new process, empty Set) still fires exactly once.
    const resumeKey = `${sessionID}\u0000${args.prompt}`
    if (resumePromptFired.has(resumeKey)) return
    resumePromptFired.add(resumeKey)
    resumeSent = true
    r.submit()
  })
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (!evt.properties.status.action) return
    if (dialog.stack.length > 0) return

    const keys = goUpsellKeys(evt.properties.status.action)
    if (!keys) return

    const seen = kv.get(keys.lastSeenAt)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(keys.dontShow)) return

    void DialogRetryAction.show(dialog, evt.properties.status.action).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(keys.dontShow, true)
      kv.set(keys.lastSeenAt, Date.now())
    })
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // Scroll to the newest content only if the viewport is still pinned to the
  // bottom (within a row of tolerance). Undo's revert completes server-side
  // LATE asynchronously (snapshot + diff work) - a call that lands after the
  // user already scrolled up must not yank the viewport down (the
  // undo-then-Enter scroll jump for a frame or two).
  function toBottomIfPinned() {
    if (!scroll || scroll.isDestroyed) return
    if (scroll.scrollHeight - (scroll.y + scroll.height) <= 2) toBottom()
  }

  const local = useLocal()

  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      run: async () => {
        const copy = (url: string) =>
          clipboard
            .write?.(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
              else scroll.scrollTo(0)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session
          .summarize({
            sessionID: route.sessionID,
            modelID: selectedModel.modelID,
            providerID: selectedModel.providerID,
            variant: local.model.variant.current(),
          })
          .then((outcome) => {
          if (outcome.data === "virtual_empty") {
          toast.show({
            variant: "warning",
            message: "Pre-compaction tail is empty. Nothing to reduce.",
            duration: 3000,
          })
        } else if (outcome.data === "in_progress") {
          toast.show({
            variant: "info",
            message: "Compaction already in progress.",
            duration: 3000,
          })
        }
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      run: async () => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const message = messagesBeforeRevert().findLast((item) => item.role === "user")
        if (!message) return
        // Preserve a typed-but-unsubmitted draft at the current position so it
        // survives the round trip (undo then redo back to the same spot).
        stashCurrentDraft()
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottomIfPinned()
          })
        // Question answers re-enter as a user prompt (question_answers part
        // metadata): the undo re-asks the question and the panel pre-populates
        // the boxes from the tool part - pulling the answers text back into
        // the input field would just duplicate them, so skip the pull-back
        // for answers messages. Other messages: defer the pull-back so the
        // slash menu's close/cancel input clear (which runs after the command
        // run) does not wipe the restored text, and retry until the prompt is
        // mounted (an undo from the question panel closes it asynchronously).
        const parts = sync.data.part[message.id] ?? []
        if (!parts.some((part) => part.type === "text" && part.metadata?.kind === "question_answers")) {
          const restore = () => {
            if (prompt) {
              prompt.set(draftStash.get(message.id) ?? promptInfoFromParts(parts))
              return
            }
            scheduleRestore(restore, 50)
          }
          scheduleRestore(restore, 0)
        }
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        // The next user message AFTER the revert point by ARRAY POSITION (the
        // chronological store order), mirroring undo's findLast - NOT by a
        // lexicographic `x.id > messageID` string compare. Message ids are not
        // time-ordered as strings across id-generator eras (compaction tail
        // re-insertion, restart; the 0252 lesson) - an ancient `msg_ffbe...`
        // id sorts GREATER than a recent `msg_0755...`, so the string compare
        // could pick a stale chronologically-EARLIER message as "next", undoing
        // into a real prompt where the blank/restart spot was (the redo-shows-
        // the-prior-prompt asymmetry).
        const list = messages()
        const revertIndex = list.findIndex((x) => x.id === messageID)
        const message = revertIndex === -1 ? undefined : list.slice(revertIndex + 1).find((x) => x.role === "user")
        // Preserve the current draft before moving forward (undo->redo round
        // trip: the draft at the departure position must survive and come back
        // when the user returns to it).
        stashCurrentDraft()
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          // Read the BOTTOM stash key explicitly (last-user scoped, the same
          // form the undo path stashed it under): currentDraftKey() prefers
          // the still-active revert messageID here, which would MISS the draft
          // stashed at the bottom (undo typed a draft with no revert active ->
          // key `bottom:<lastUser.id>`, but the revert has fired by the redo,
          // so currentDraftKey() returns the raw message id - the lookup comes
          // up empty and the field clears, losing the draft even on a single
          // undo+redo round trip).
          const lastUser = messages().findLast((m) => m.role === "user")
          const bottomKey = `${DRAFT_STASH_BOTTOM}:${lastUser?.id ?? "none"}`
          const clear = () => {
            if (prompt) {
              prompt.set(draftStash.get(bottomKey) ?? { input: "", parts: [] })
              return
            }
            scheduleRestore(clear, 50)
          }
          scheduleRestore(clear, 0)
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
        const restore = () => {
          if (prompt) {
            prompt.set(draftStash.get(message.id) ?? promptInfoFromParts(sync.data.part[message.id] ?? []))
            return
          }
          scheduleRestore(restore, 50)
        }
        scheduleRestore(restore, 0)
      },
    },
    {
      title: "Restart the app",
      value: "session.restart",
      category: "Session",
      slash: {
        name: "restart",
      },
      run: () => {
        dialog.clear()
        try {
          restart(route.sessionID)
       } catch (error) {
         toast.show({
            message: error instanceof Error ? error.message : "Failed to restart",
            variant: "error",
          })
        }
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result = await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background({
          sessionID: route.sessionID,
          workspace: project.workspace.current(),
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertMessageIndex = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return -1
    return messages().findIndex((message) => message.id === messageID)
  })

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    const index = revertMessageIndex()
    if (index === -1) return []
    return messages()
      .slice(index)
      .filter((message) => message.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <LocationProvider location={location()}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
            <Show when={session()}>
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.border,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <For each={keyedMessages()}>
                  {(shell, index) => {
                    const message = shell.msg()!
                    return (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const redoShortcut = useCommandShortcut("session.redo")
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              keymap.dispatchCommand("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match
                        when={revert()?.messageID && revertMessageIndex() !== -1 && index() >= revertMessageIndex()}
                      >
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match
                        when={
                          message.role === "assistant" &&
                          message.parentID !== undefined &&
                          virtualCompactionMarkers().has(message.parentID)
                        }
                      >
                        <VirtualCompactionBlock
                          parts={sync.data.part[message.id] ?? []}
                          message={message as AssistantMessage}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                    )
                  }}
                </For>
              </scrollbox>
              <box flexShrink={0}>
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt
                    request={questions()[0]}
                    directory={sync.session.get(questions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        // A pending undo/redo restore must not repopulate the
                        // field behind this submit.
                        cancelRestore()
                        toBottom()
                        setStreamBatchWindow(STREAM_BATCH_MIN_MS)
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </pluginRuntime.Slot>
                </Show>
              </box>
            </Show>
          </box>
          <Show when={sidebarVisible()}>
            <Switch>
              <Match when={wide()}>
                <Sidebar sessionID={route.sessionID} />
              </Match>
              <Match when={!wide()}>
                <box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  alignItems="flex-end"
                  backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                >
                  <Sidebar sessionID={route.sessionID} />
                </box>
              </Match>
            </Switch>
          </Show>
        </box>
      </context.Provider>
    </LocationProvider>
  )
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: number
}) {
  const ctx = use()
  const local = useLocal()
  const sync = useSync()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending !== undefined && props.index > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))
  // Question answers re-enter the conversation as a user prompt: render the
  // turn summary header (▣ agent · model · pending duration) ABOVE the
  // message, mirroring the assistant turn header, so the answer submission
  // shows its agent boundary in the transcript.
  const questionAnswers = createMemo(() =>
    props.parts.some((x) => x.type === "text" && x.metadata?.kind === "question_answers"),
  )

  // The question/answer dialogue (0268): the question tool call ends the turn
  // (single line + completed footer above); the answered display lives HERE,
  // as the question_answers user message's body - parsed from this message's
  // OWN serialized `"Q"="Ans"` text (the same bytes the model sees, always
  // present - no cross-message store lookup). Renders as a `# Questions` box
  // so it reads as the answered question, not a typed prompt, and stays a
  // real undoable user-prompt boundary (undo into it re-opens the panel).
  const questionDialogue = createMemo(() => {
    if (!questionAnswers()) return []
    const serialized = props.parts
      .filter((x): x is TextPart => x.type === "text" && !x.synthetic)
      .map((x) => x.text)
      .join(", ")
    const pairs: Array<{ question: string; answer: string }> = []
    const pairRe = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g
    let m: RegExpExecArray | null
    while ((m = pairRe.exec(serialized)) !== null) {
      pairs.push({ question: m[1].replace(/\\(.)/g, "$1"), answer: m[2].replace(/\\(.)/g, "$1") })
    }
    return pairs
  })

  return (
    <>
      <Show when={text()}>
        <Show when={questionAnswers()}>
          <box
            ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
            border={["left"]}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            marginTop={1}
            flexShrink={0}
            width="100%"
            backgroundColor={theme.backgroundPanel}
            customBorderChars={SplitBorder.customBorderChars}
            borderColor={theme.background}
          >
            <text paddingLeft={3} paddingBottom={1} fg={theme.textMuted}>
              # Questions
            </text>
            <For each={questionDialogue()}>
              {(qa) => (
                <Show when={qa.question || qa.answer}>
                  <box flexDirection="column" paddingTop={0} paddingBottom={1} width="100%" flexShrink={0}>
                    {/* width="100%" + flexShrink={0}: the box must stretch to
                        the message column, not collapse to its children's
                        content width - otherwise the lines wrap at the longest
                        answer instead of the pane edge (the multi-line answers
                        wrapped at ~90 cols vs the 151-col pane). */}
                    <text fg={theme.textMuted}>{qa.question}</text>
                    {/* A multi-select joins its answers with ", " - render each
                        selection on its OWN line so the answers never wrap mid-
                        text at the box edge. "not answered" stays one line. */}
                    <For each={qa.answer.split(/,\s*/).filter((a) => a)}>
                      {(line) => (
                        <text fg={theme.text}>
                          {`  ${line}`}
                        </text>
                      )}
                    </For>
                  </box>
                </Show>
              )}
            </For>
          </box>
        </Show>
        <Show when={!questionAnswers()}>
          <box
            id={props.message.id}
            ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
            border={["left"]}
            borderColor={color()}
            customBorderChars={SplitBorder.customBorderChars}
            marginTop={props.index === 0 ? 0 : 1}
          >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
        </Show>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

// Synthetic summary of a "virtual" compaction (no LLM turn): a compact
// bordered block like the undo/revert block, carrying the note text.
function VirtualCompactionBlock(props: { message: AssistantMessage; parts: Part[] }) {
  const { theme } = useTheme()
  const note = createMemo(() =>
    props.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n\n"),
  )
  return (
    <Show when={note()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        marginTop={1}
        flexShrink={0}
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundPanel}
      >
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={theme.backgroundPanel}>
          <text fg={theme.textMuted}>{note()}</text>
        </box>
      </box>
    </Show>
  )
}

// Completed turns' footers walk back in the session DB (paginated messages
// API) because the TUI sync store caps at the last 100 messages: a long turn's
// early steps and its root user prompt fall outside that window, so the
// footer's store-based stats would undercount or miss them entirely. The walk
// starts at the footer message's cursor and pages older until the turn's root
// user message is found, accumulating in ONE pass everything the footer shows
// for a completed turn: the tool-call count, the assistant steps' real
// reasoning/output token totals, and the root's created time (the elapsed
// clock's anchor). Cached per (session, turn) with the RESOLVED value so a
// remount can seed the signal synchronously (no flash of the pruned store
// stats). A completed turn's footer is locked to the DB contents - the walk
// result does not change when the store window shifts.
const turnDbCache = new Map<string, TurnDbWalk>()

// The turn's root user message's created time, seeded from the store while
// the parent is still in the window (the live clock's early anchor). Merged
// into the DB walk's result at completion; stored separately because the full
// walk only runs when the session is idle, and the clock must work mid-turn.
const parentStartCache = new Map<string, number>()
// In-flight root-start fetches: on a fresh restart every in-window footer
// runs the seeding effect and the root is pruned from the store, so all of
// them would fire the same `session.message` fetch - this set dedupes to one.
const parentStartFetching = new Set<string>()

// Resume-prompt consumption latch (module scope, survives component remounts):
// the `restart` tool re-exec's with `--prompt "Restart complete: <reason>"`,
// and the session route auto-submits it once via the resume effect below. If
// the TUI then crashes and the user clicks the crash-dialogue "Restart" (an
// in-place ErrorBoundary reset that REMOUNTS the route), the component-local
// guard would reset while args.prompt still holds the stale --prompt - the
// effect would re-submit the old restart prompt as a fresh turn
// (BUG_CRASH_DIALOG_RESTART_PROMPT). Keying consumption here lets a genuine
// restart (new process) still fire once (module reloads, Set empty), while an
// in-place reset cannot re-fire.
const resumePromptFired = new Set<string>()

// In-memory accumulator for LIVE turns' footer stats, keyed by
// `${sessionID}:${parentID}` (the same key parentStartCache uses). Each
// completed step folds its real values in ONCE at step completion - no
// mid-turn DB walk and no per-delta re-scan of every step's parts. The
// completed-turn DB walk (turnDbCache) supersedes it once it lands. The map
// is bounded: entries are per turn, and turns are pruned by size cap.
const turnLiveCache = new Map<string, TurnLiveAccum>()

async function dbTurnStats(
  sdk: ReturnType<typeof useSDK>,
  sessionID: string,
  parentID: string,
  footer: AssistantMessage,
  footerParts: Part[],
): Promise<TurnDbWalk> {
  const key = `${sessionID}:${parentID}`
  const cached = turnDbCache.get(key)
  if (cached !== undefined) return cached
  let state: TurnWalkPageState = {
    tools: footerParts.filter((p) => p.type === "tool").length,
    reasoning: footer.tokens?.reasoning ?? 0,
    output: footer.tokens?.output ?? 0,
    reachedRoot: false,
    start: parentStartCache.get(key),
  }
  let cursor = Buffer.from(JSON.stringify({ id: footer.id, time: footer.time.created })).toString("base64url")
  for (let page = 0; page < 200; page++) {
    const resp = await sdk.client.session.messages({ sessionID, limit: 100, before: cursor })
    state = countTurnWalkParts(resp.data ?? [], parentID, state)
    if (state.reachedRoot) {
      const result: TurnDbWalk = {
        tools: state.tools,
        reasoning: state.reasoning,
        output: state.output,
        start: state.start,
      }
      turnDbCache.set(key, result)
      return result
    }
    const next = resp.response?.headers.get("X-Next-Cursor")
    if (!next) {
      const result: TurnDbWalk = {
        tools: state.tools,
        reasoning: state.reasoning,
        output: state.output,
        start: state.start,
      }
      turnDbCache.set(key, result)
      return result
    }
    cursor = next
  }
  const result: TurnDbWalk = {
    tools: state.tools,
    reasoning: state.reasoning,
    output: state.output,
    start: state.start,
  }
  turnDbCache.set(key, result)
  return result
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  // The turn's start time (root user message's created). Reads the store
  // first (fast, the live turn's parent is present until the 100-cap prunes
  // it), falling back to the DB-walked value for long turns and remounts
  // after restart. Seeds the cache while the parent is still in the store so
  // a mid-turn prune can't drop the live clock to 0ms.
  const parentKey = () =>
    props.message.parentID ? `${props.message.sessionID}:${props.message.parentID}` : undefined
  const [dbTurnStart, setDbTurnStart] = createSignal<number | undefined>(
    parentKey() ? parentStartCache.get(parentKey()!) : undefined,
  )
  createEffect(() => {
    const key = parentKey()
    if (!key) return
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    // Seed the start into its own cache (the full turnDbCache holds only
    // COMPLETED walk results; the start is the one piece known from the
    // store while the turn is still live, so it gets its own slot). tools/
    // tokens stay out of dbTurn until the walk lands so the live footer
    // keeps its store-based counts.
    if (user?.time.created) {
      if (parentStartCache.get(key) !== user.time.created) parentStartCache.set(key, user.time.created)
      setDbTurnStart(user.time.created)
      return
    }
    // The root is pruned from the store window (long turn) - fetch it by ID
    // DIRECTLY (a single indexed DB read) instead of waiting for the full
    // paginated walk to page back to it. This is what makes the timer appear
    // instantly on a fresh restart (parentStartCache is process-local and
    // empty): tokens/tools fold from the in-window steps, and the root fetch
    // gives the clock its anchor in one round trip. Deduped across footers.
    if (parentStartCache.has(key) || parentStartFetching.has(key)) return
    parentStartFetching.add(key)
    sdk.client.session
      .message({ sessionID: props.message.sessionID, messageID: props.message.parentID })
      .then((res) => {
        const created = res.data?.info?.time?.created
        if (created !== undefined) {
          if (parentStartCache.get(key) !== created) parentStartCache.set(key, created)
          setDbTurnStart(created)
        }
      })
      .catch(() => {})
      .finally(() => parentStartFetching.delete(key))
  })
  // Live agent-footer counter for the active turn: the last assistant
  // message's ▣ line ticks the elapsed time (100ms / tenths) and counts up
  // the whole turn's reasoning/output tokens (real for completed steps,
  // streamed-text estimates for the in-flight one). Liveness comes from the
  // session status ("busy" covers streaming AND tool-execution gaps where no
  // step is mid-stream), OR'd with this step being in flight so the counter
  // starts the instant the stream begins. On completion the numbers snap to
  // the turn's final totals (all steps back to the root user prompt,
  // including tool calls).
  const isInFlight = createMemo(() => !props.message.time.completed)
  // The turn's message-boundary steps view, folded first so every reader below
  // (turnActive's busy branch, showLive, inFlightStep, turnAccum) can close
  // over it WITHOUT a temporal-dead-zone hazard: solid's server-mode
  // createMemo evaluates its body synchronously at the call site, and any
  // memo created before this const's initializer runs that reads it throws
  // "Cannot access 'turnStepsMemo' before initialization" during the
  // synchronous render of a busy session's footer (BUG_TUI_TURNSTEPS_TDZ).
  const turnStepsMemo = createMemo(() => turnSteps(messages(), props.message.parentID))
  // Live until the whole turn is done IN THE STORE, independent of the
  // session.status event. A "busy" status keeps the clock live during
  // streaming and tool-call gaps, but the idle event that ends the busy can
  // be missed between the worker and the TUI - a completed turn then sits on
  // the busy-driven branch forever and the footer clock ticks on ("12m 21s"
  // on a clean 1.3s run, BUG_TUI_LIVE_FROZEN; the server log shows the idle
  // WAS emitted, so the client lost it). The store's own completion is the
  // authoritative stop signal: once the final step and its message both
  // report completed here, nothing is left to stream, so snap the clock off
  // without waiting for the event. A genuinely-streaming turn always holds an
  // uncompleted step (its message), so a live stream is never cut.
  const turnActive = createMemo(() => {
    if (isInFlight()) return true
    const status = sync.data.session_status?.[props.message.sessionID]?.type
    if (status !== undefined && status !== "idle") {
      // Busy, but the whole turn is done IN THE STORE: the loop-settle busy
      // after a finished turn, or the lost-idle-event case above. "Done"
      // requires a TERMINAL last step (final() - finish is stop/error, not
      // tool-calls/unknown) with no tool part left to run. A completed step
      // with finish "tool-calls" (or a provider "stop" that still carries a
      // tool part) is a CONTINUATION: the loop runs the tool and streams a
      // NEW step, so the clock must hold through the boundary. Snapping off
      // there (0232's initial gate) made the elapsed cell unmount for 1-2
      // frames between tool calls, shifting the footer layout left and back
      // (BUG_TUI_LIVE_ELAPSED_VANISH).
      const steps = turnStepsMemo()
      const last = steps.at(-1)
      if (last) {
        const turnDone =
          last.id === props.message.id &&
          last.time.completed !== undefined &&
          final() &&
          !(sync.data.part[last.id] ?? []).some((p) => p.type === "tool")
        if (turnDone) return false
      }
      return true
    }
    return false
  })
  const showLive = createMemo(() => turnActive() && props.last)
  // The turn's not-yet-completed step (the one streaming). Message boundaries
  // change it; part deltas don't (the messages array is stable), so this
  // memo does NOT recompute per delta. NEWEST non-completed step, not the
  // first: a loop/stall-guard-fired message is error-marked and never gets
  // time.completed, so `.find()` would latch onto that orphan forever and
  // freeze the live tok / tok-s counters (BUG_TUI_LIVE_FROZEN_ON_GUARD) even
  // though the actual streaming step comes after it in the turn.
  const inFlightStep = createMemo(() => {
    const steps = turnStepsMemo()
    for (let i = steps.length - 1; i >= 0; i--) {
      if (!steps[i].time.completed) return steps[i]
    }
    return undefined
  })
  // The step whose parts feed the LIVE counters. Normally inFlightStep (the
  // first non-completed step). Fallback: when the turn is ACTIVE but no
  // non-completed step is in the client message window (a missed
  // message.updated create over an SSE reconnect, or sync() rebuilding from a
  // stale snapshot while the first stream starts - the fullSyncedSessions
  // dedup means a partial gap never re-syncs), count the newest turn step's
  // parts instead so tok / tok-s keep moving instead of freezing until the
  // next boundary event (BUG_FOOTER_LIVE_STATS_STALE). A genuinely completed
  // turn resolves undefined here too (newest step completed), so the folded
  // totals stand.
  const liveSourceStep = createMemo(() => {
    const inFlight = inFlightStep()
    if (inFlight) return inFlight
    if (!showLive()) return undefined
    const steps = turnStepsMemo()
    const last = steps.at(-1)
    if (!last) return undefined
    return last.time.completed === undefined ? last : undefined
  })
  // The in-memory turn accumulator, folded as a MEMO so the fold lands in the
  // same reactive flush as the message update that completed the step - the
  // live memos below read the folded result immediately (no one-frame dip,
  // no effect-ordering race). It returns a fresh snapshot reference every
  // recompute (Solid memos compare by reference, and the shared accumulator
  // object is mutated in place by every footer of the turn - a same-reference
  // return would freeze dependents on a pre-mutation snapshot). It recomputes
  // ONLY at message boundaries: part deltas do not change turnStepsMemo, and
  // parts are read only for NEWLY completed steps. Every footer of the turn
  // folds the SAME shared accumulator (idempotent via the `folded` set), so
  // any footer - the live one and a completed turn's final step - shows the
  // accumulated values before the DB walk lands. On a remount/restart
  // mid-turn it rebuilds from the store. No DB walk - the completed turn's
  // walk (dbTurnStats) supersedes it once it lands.
  const turnAccum = createMemo(() => {
    const key = parentKey()
    if (!key) return
    const steps = turnStepsMemo()
    if (steps.length === 0) return
    let acc = turnLiveCache.get(key)
    if (!acc) {
      acc = newTurnLiveAccum(parentStartCache.get(key))
      turnLiveCache.set(key, acc)
    }
    // Seed the clock anchor while the parent is in the window (the store
    // find), falling back to the module cache (survives the mid-turn prune
    // and the walk's own seed) and then the cached walk result (the walked
    // start is persisted to parentStartCache on completion, so a remount in
    // the same process seeds the timer instantly - no second walk needed).
    if (acc.start === undefined) {
      const parent = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
      acc.start = parent?.time.created ?? parentStartCache.get(key) ?? turnDbCache.get(key)?.start
    }
    foldTurnSteps(acc, steps, (id) => sync.data.part[id])
    // ALWAYS a fresh snapshot reference (Solid memos compare by reference):
    // the shared accumulator object is mutated in place by EVERY footer of
    // the turn (they share the turnLiveCache entry), so a same-reference
    // return here would freeze this footer's dependents on a pre-mutation
    // snapshot even when another footer's fold changed the values. The memo
    // only recomputes at message boundaries (part deltas do not reach it), so
    // the copy cost is bounded to step completions - never per delta.
    return { ...acc }
  })
  // The turn's start time (root user message's created): the in-memory start
  // that lives next to the counters (seeded into the accumulator from the
  // store while the parent is in the window, or from parentStartCache once
  // pruned). Falls back to the DB-walked value for remounts after restart
  // and long turns whose start the store window never had.
  const userStart = createMemo(() => {
    const acc = turnAccum()
    if (acc?.start !== undefined) return acc.start
    return dbTurnStart()
  })
  // Live tokens: the folded real values (completed steps) + the in-flight
  // step's streamed-text estimate. Per part delta this is O(1) over the
  // completed turn - just the one in-flight step's parts walk.
  const turnLive = createMemo(() => turnLiveFromAccum(turnAccum(), liveSourceStep(), (id) => sync.data.part[id]))

  // Completed-step footer duration: the final step's elapsed time from the
  // turn's start (the in-memory start) to its own completion.
  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const start = userStart()
    if (!start) return 0
    return props.message.time.completed - start
  })
  // The turn's full DB-walked stats (tools + reasoning/output tokens + root
  // start). The LIVE turn counts from the store (the stream keeps it
  // complete); completed turns are LOCKED to the DB via the walk - the store
  // caps at 100 messages, so a long turn's early steps and its root prompt
  // are pruned away, and the walk result must not depend on the store
  // window. The signal seeds from the resolved cache so a remount never
  // flashes the pruned store numbers; the plain effect (NO defer) runs the
  // walk on mount for prior turns and on the live turn's completion.
  const [dbTurn, setDbTurn] = createSignal<TurnDbWalk | undefined>(
    parentKey() ? turnDbCache.get(parentKey()!) : undefined,
  )
  createEffect(() => {
    if (showLive()) return
    const parentID = props.message.parentID
    if (!parentID) return
    // The turn's NEWEST in-window step is the only authoritative walk source:
    // the walk pages OLDER from the footer's cursor, so a mid-turn footer's
    // walk would count only the steps before it and cache a PARTIAL result
    // that races the real one. The newest step's walk spans the whole turn.
    const steps = turnStepsMemo()
    if (steps.length === 0 || steps.at(-1)?.id !== props.message.id) return
    // Walk the DB only when the SESSION is idle (the turn fully over). A
    // completed step's footer goes non-live mid-turn while later steps are
    // still streaming - walking then CACHES A PARTIAL COUNT for the turn,
    // and every subsequent live footer seeds `dbTurn` from that cache,
    // freezing the counter at the stale value ("flips back to 1 and stays").
    // The idle gate defers the walk until the final count exists; it also
    // stops the mid-turn DB pagination (the inter-tool-call stalls).
    const status = sync.data.session_status?.[props.message.sessionID]?.type
    if (status !== undefined && status !== "idle") return
    void dbTurnStats(sdk, props.message.sessionID, parentID, props.message, props.parts).then((stats) => {
      const key = `${props.message.sessionID}:${parentID}`
      turnDbCache.set(key, stats)
      setDbTurn(stats)
      // Persist the walked start into the module cache too, not just the
      // signal: a remount/reload seeds `turnAccum` from parentStartCache, so
      // the timer appears instantly on a session reload instead of waiting
      // for the walk to land again (the walk result itself is cached, but the
      // live-clock seed must come from the in-memory map).
      if (stats.start !== undefined) {
        setDbTurnStart(stats.start)
        if (parentStartCache.get(key) !== stats.start) parentStartCache.set(key, stats.start)
      }
    })
  })
  const turnTools = createMemo(() => {
    const db = dbTurn()
    if (db !== undefined) return db.tools
    // Folded tool count (completed steps) + the in-flight step's tool parts
    // only - O(1) over the completed turn, no per-delta re-scan.
    const acc = turnAccum()
    let tools = acc?.tools ?? 0
    const inFlight = inFlightStep()
    if (inFlight) tools += (sync.data.part[inFlight.id] ?? []).filter((p) => p.type === "tool").length
    return tools
  })
  const [turnNow, setTurnNow] = createSignal(0)
  createEffect(
    on(
      showLive,
      (live) => {
        if (!live) return
        setTurnNow(Date.now())
        const id = setInterval(() => setTurnNow(Date.now()), 100)
        onCleanup(() => clearInterval(id))
      },
    ),
  )
  const liveElapsed = createMemo(() => {
    if (!showLive()) return 0
    const start = userStart()
    return start ? Math.max(0, turnNow() - start) : 0
  })
  const turnTokens = createMemo(() => {
    // Completed turns: the DB walk's full token totals (the store window
    // truncates long turns' early steps - the walk result is authoritative).
    const db = dbTurn()
    if (db !== undefined) {
      if (db.reasoning + db.output <= 0) return
      return { reasoning: db.reasoning, output: db.output }
    }
    const live = turnLive()
    if (live.reasoning + live.output <= 0) return
    return live
  })

  // Streaming tokens/s for the footer: a 1s rolling window over the turn's
  // streamed chars, keyed by the turn and sampled only while text is actually
  // arriving. The freeze is keyed to the STREAMING STATE: the in-flight step
  // id ("" when no step is mid-stream, i.e. tool execution / TTFT gaps) - an
  // episode change resets the window and freezes the EMA through it, so the
  // value holds across gaps and only resumes tracking once the next stream
  // has real deltas. The window spans the WHOLE agent turn - mid-turn LLM
  // calls continue it (state shared across the turn's per-step footers). The
  // frozen rate stays on the last footer after the turn ends; it vanishes
  // when the next message supersedes it (props.last gates the display).
  const turnKey = props.message.parentID
  // The turn's streamed chars: the accumulator folds each COMPLETED step's
  // chars once (their parts never change after the step lands), so the only
  // per-delta work is the in-flight step's parts walk - O(1) over the
  // completed turn (the same win the old per-step cache gave, without the
  // Map or the step list iteration).
  const turnStreamedChars = createMemo(() => {
    const acc = turnAccum()
    let chars = acc?.chars ?? 0
    const live = liveSourceStep()
    if (live) chars += streamedChars(sync.data.part[live.id])
    return chars
  })
  const streamKey = createMemo(() => liveSourceStep()?.id ?? "")
  const streamRateMemo = createMemo(() => streamRateFor(turnKey, streamKey(), turnStreamedChars()))
  const rateDisplay = createMemo(() => {
    if (!props.last) return
    const r = streamRateMemo()
    if (r <= 0) return
    return formatCount(Math.round(r))
  })

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")

  return (
    <>
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={
                sync.data.capabilities.experimentalBackgroundSubagents &&
                props.parts.some(
                  (x) =>
                    x.type === "tool" &&
                    x.tool === "task" &&
                    x.state.status === "running" &&
                    x.state.metadata?.background !== true,
                )
              }
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.error}>{errorMessage(props.message.error)}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || props.message.error?.name === "MessageAbortedError"}>
          <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={showLive()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(liveElapsed())}</span>
              </Show>
              <Show when={!showLive() && duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
              </Show>
              <Show when={turnTokens()}>
                <span style={{ fg: theme.textMuted }}>
                  {" · "}
                  <span style={{ fg: theme.textMuted }}>{formatCount(turnTokens()!.reasoning)}</span>
                  {"+"}
                  <span style={{ fg: theme.text }}>{formatCount(turnTokens()!.output)}</span>
                  {"="}
                  <span style={{ fg: theme.warning }}>{formatCount(turnTokens()!.reasoning + turnTokens()!.output)}</span>
                  {" tok"}
                  <Show when={rateDisplay()}>
                    {" ("}
                    {rateDisplay()}
                    {"/s)"}
                  </Show>
                </span>
              </Show>
              <Show when={turnTools() > 0}>
                <span style={{ fg: theme.textMuted }}>
                  {" · "}
                  {turnTools()} tool{turnTools() > 1 ? "s" : ""}
                </span>
              </Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

// ============ TEMP INSTRUMENTATION (0277: tool-block grow/shrink/jitter) ============
// Reusable tool code-element tracer: mirrors the ReasoningPart tracer but for
// the streaming tool code elements (write/bash single stream, heredoc segments,
// edit-diff left/right columns). Logs each change + a 100ms tick to
// /tmp/tool-trace.jsonl so GrowOnly removal can be validated for jitter across
// ALL narrowed-width blocks, not just reasoning.
function useToolTrace(content: () => string, tag: string) {
  let el: any = undefined
  const layout = (e: any) => {
    try {
      return e?.getLayoutNode?.().getComputedLayout?.()
    } catch {
      return undefined
    }
  }
  const sample = (cause: string) => {
    try {
      const l = layout(el)
      const viewed = el?.textBufferView
      const cw = l?.width ?? 140
      const v = typeof el?.virtualLineCount === "number" ? el.virtualLineCount : -1
      const m139 = viewed?.measureForDimensions ? viewed.measureForDimensions(139, 99999)?.lineCount ?? -1 : -1
      const m140 = viewed?.measureForDimensions ? viewed.measureForDimensions(140, 99999)?.lineCount ?? -1 : -1
      appendFileSync(
        "/tmp/tool-trace.jsonl",
        JSON.stringify({
          t: Date.now(),
          tag,
          cause,
          len: content().length,
          codeH: l?.height ?? -1,
          cw,
          v,
          m139,
          m140,
        }) + "\n",
      )
    } catch (e) {
      try {
        appendFileSync("/tmp/tool-trace.jsonl", JSON.stringify({ t: Date.now(), tag, cause, err: String(e) }) + "\n")
      } catch {}
    }
  }
  createEffect(() => {
    void content()
    sample("change")
  })
  onMount(() => {
    const id = setInterval(() => sample("tick"), 100)
    onCleanup(() => clearInterval(id))
  })
  return (ref: any) => {
    el = ref
  }
}

// 0276b: the width-1 height fix, generalized to streaming tool code elements.
// The native Yoga measure wraps at width-1 while the textBufferView wraps at
// the full width, so a streamed line crossing the wrap boundary gives the box
// a +1 phantom row (flush at done). The reasoning fix (0276) drives the box
// height from `measureForDimensions(layoutW).lineCount` - the buffer's OWN
// wrapped count at the real laid-out width, always correct. This hook applies
// the same driver to a code element directly (no wrapper box, so line_number
// keeps its direct code target). `trace` optionally chains the jitter tracer's
// ref assignment onto the same element.
// 0284b: the trailing-newline blank row. `measureForDimensions(...).lineCount`
// counts a trailing "\n" as an extra (empty) row, and the driver passed that
// count straight to the code box height - so streamed content ending in "\n"
// (every diff block mid-stream) got a +1 phantom row, which the line_number
// GUTTER painted as an extra numbered line at the bottom of both columns (the
// completed-snap path drops the blank, so the final diff was fine - the
// regression only showed while streaming). Strip one row when the current
// content ends in a newline so the box matches the visible buffered rows.
function useFixedStreamHeight(
  content: () => string,
  trace: ((el: any) => void) | undefined,
  opts?: { released?: () => boolean },
) {
  let el: any = undefined
  const [rows, setRows] = createSignal(0)
  const released = opts?.released ?? (() => false)
  // opts.released(): re-measure when the "released" (streaming->completed /
  // grow-only release) flag flips true. ROOT CAUSE of the "gutters but no
  // text" family (heredoc body, write tool, completed patch diff): while
  // streaming, Code.set content DEFERS the buffer update to the async
  // highlight (Code.ts:103 - `_streaming && !_drawUnstyledText &&
  // _filetype` -> requestRender, no setText). The height effect measures
  // the buffer synchronously after content() changes and reads the OLD
  // (1-line) buffer -> rows=1. When streaming then flips to completed, set
  // content takes the synchronous textBuffer.setText branch, but content()
  // is already stable so NOTHING re-triggers the measure -> the element
  // keeps the stale height and paints 1 of N lines while the gutter
  // (counting the content string) shows all N. Subscribing to the released
  // transition re-measures once the buffer has caught up.
  // The streaming element's REAL width, read LIVE on each effect run (not a
  // createMemo: `el` is a plain closure var, so a memo would evaluate once and
  // pin the early 140 fallback forever - the 0286 phantom-gutter root cause).
  // Prefer the renderable's own `.width` (the column it lays out at, ~58-70
  // for the diff halves; the paint probe confirms measureForDimensions at that
  // width equals the buffer's virtualLineCount). Fall back to the last known
  // good width for the pre-layout content-change frames, then 140 as a last
  // resort. 0286c's writeback (setWrapWidth(140)) was the extend/snap bounce:
  // it drove the WRONG width into the buffer.
  let lastWidth = 0
  const width = () => {
    try {
      const rw = typeof el?.width === "number" ? el.width : 0
      if (rw > 0) {
        lastWidth = rw
        return rw
      }
    } catch {}
    try {
      const cw = el?.getLayoutNode?.().getComputedLayout?.().width ?? 0
      if (cw > 0) {
        lastWidth = cw
        return cw
      }
    } catch {}
    return lastWidth || 140
  }
  createEffect(() => {
    void width()
    // The wrapped count grows as content streams - re-measure per content
    // change (the reasoning driver tracks summary()/isDone() for the same
    // reason). The line count includes any trailing newline's blank row, so
    // subtract one when the current content ends with a newline (0284b - the
    // gutter painted the blank row as a phantom line number).
    // `released` (streaming/completed flip) also re-runs this: the buffer
    // catches up synchronously at completion, fixing the stale-height member.
    void content()
    void released()
    const viewed = el?.textBufferView
    if (!viewed?.measureForDimensions) {
      setRows(0)
      return
    }
    // 0284c REVERTED (2026-09-06): the width writeback caused a feedback
    // loop - setWrapWidth(width()) mutates the buffer's wrap state, which
    // changes virtualLineCount, which the native measure consumes, which
    // changes the laid-out width, re-firing this effect with a new width ->
    // the box bounced between wrap states (lines "extending outside bounds and
    // snapping back", live). The driver is READ-ONLY measure again; the
    // instrumentation below logs the width / virtualLineCount / measure /
    // applied-rows gap so the phantom-gutter mechanism can be pinned before a
    // proper fix.
    const _pqjWidth = width()
    // The renderable's OWN width (the paint probe shows the diff cols are ~60;
    // getComputedLayout().width may return undefined early and pin the fallback).
    let _pqjElWidth = -1
    try {
      _pqjElWidth = typeof el?.width === "number" ? el.width : -1
    } catch {}
    let _pqjLayoutW = -1
    try {
      _pqjLayoutW = el?.getLayoutNode?.().getComputedLayout?.().width ?? -1
    } catch {}
    // A destroyed TextBufferView THROWS on virtualLineCount/measure (0289:
    // the slot elements made this easy to hit - a slot's code element can be
    // torn down while its StreamSegment measure hook still lives, crashing the
    // whole TUI with "TextBufferView is destroyed"). Guard the measurement.
    let _pqjVlc = -1
    let c = 0
    try {
      _pqjVlc = typeof viewed.getVirtualLineCount === "function" ? viewed.getVirtualLineCount() : -1
      // Measure at the element's real width (the 0286 root cause: the memo pinned
      // 140, undersizing the box and phantom-numbering the gutter). Both
      // `measure.lineCount` and `virtualLineCount` count the trailing-newline
      // blank row identically, so the box height and gutter agree - no strip.
      c = viewed.measureForDimensions(_pqjWidth, 99999)?.lineCount ?? 0
      const _pqjRows = Math.max(0, c)
      setRows(_pqjRows)
    } catch {
      setRows(0)
    }
    try {
      appendFileSync(
        "/tmp/gutter-jump.jsonl",
        JSON.stringify({
          t: Date.now(),
          len: content().length,
          width: _pqjWidth,
          elWidth: _pqjElWidth,
          layoutW: _pqjLayoutW,
          vlc: _pqjVlc,
          measure: c,
          rows: c,
        }) + "\n",
      )
    } catch {}
  })
  const ref = (node: any) => {
    el = node
    trace?.(node)
  }
  return { height: rows, ref }
}
// ========================================================================

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    // OpenRouter encrypts some reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const opaque = createMemo(() => !content() && Boolean(props.part.metadata))
  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

  const toggle = () => {
    if (!inMinimal() || opaque()) return
    setExpanded((prev) => !prev)
  }

  // ============ TEMP INSTRUMENTATION (0276 tracer: wrap-width-1 measure) ============
  const traceID = props.part.id
  let traceOuter: BoxRenderable | undefined
  let traceInner: any = undefined
  let traceCodeEl: any = undefined
  const layoutH = (el: any) => {
    try {
      return el?.getLayoutNode?.().getComputedLayout?.().height ?? -1
    } catch {
      return -1
    }
  }
  const trace = (cause: string) => {
    try {
      const body = summary().body ?? ""
      const safe = <T,>(fn: () => T, def: T): T => {
        try {
          return fn()
        } catch {
          return def
        }
      }
      const bufLen = safe(() => traceCodeEl?.textBuffer?.getPlainText?.().length ?? -1, -1)
      const lineInfo = safe(() => traceCodeEl?.lineInfo ?? null, null)
      const wrappedRows = lineInfo ? (lineInfo.lineStartCols ?? []).length : -1
      const virtLines = safe(() => traceCodeEl?.virtualLineCount ?? -1, -1)
      const viewed = safe(() => traceCodeEl?.textBufferView ?? null, null)
      const codeWidth = (() => {
        try {
          return traceCodeEl?.getLayoutNode?.().getComputedLayout?.().width ?? 140
        } catch {
          return 140
        }
      })()
      const measured = viewed ? {
        lineCountAtWidth: viewed.measureForDimensions ? viewed.measureForDimensions(codeWidth, 99999)?.lineCount ?? -1 : -1,
        lineCount139: viewed.measureForDimensions ? viewed.measureForDimensions(139, 99999)?.lineCount ?? -1 : -1,
        lineCount140: viewed.measureForDimensions ? viewed.measureForDimensions(140, 99999)?.lineCount ?? -1 : -1,
        codeWidth,
        elWidth: safe(() => traceCodeEl?.width ?? -1, -1),
      } : null
      appendFileSync(
        "/tmp/reasoning-trace.jsonl",
        JSON.stringify({
          t: Date.now(),
          id: traceID,
          cause,
          done: isDone(),
          len: body.length,
          bufLen,
          wrappedRows,
          virtLines,
          measured,
          outerH: layoutH(traceOuter),
          innerH: layoutH(traceInner),
          codeH: layoutH(traceCodeEl),
        }) + "\n",
      )
    } catch (e) {
      try {
        appendFileSync(
          "/tmp/reasoning-trace.jsonl",
          JSON.stringify({ t: Date.now(), id: traceID, cause, traceError: String(e) }) + "\n",
        )
      } catch {}
    }
  }
  createEffect(() => {
    void summary()
    void isDone()
    trace("change")
  })
  onMount(() => {
    const id = setInterval(() => trace("tick"), 100)
    onCleanup(() => clearInterval(id))
  })
  // 0276 experiment: the box height driver = the buffer's wrapped row count at
  // the element's REAL laid-out width (measureForDimensions at codeWidth), not
  // the native layout height (which wraps at width-1 and yields the +1).
  // 0286f note: the reasoning element renders at FULL width (its elWidth is 140
  // in the trace) - NOT a 50% column like the diff halves - so its layoutW memo
  // pinning 140 is correct and was left untouched. Only useFixedStreamHeight
  // (the diff columns + tool stream) had the wrong-width bug.
  const [streamRowsCount, setStreamRowsCount] = createSignal(0)
  const layoutW = createMemo(() => {
    try {
      return traceCodeEl?.getLayoutNode?.().getComputedLayout?.().width ?? 140
    } catch {
      return 140
    }
  })
  createEffect(() => {
    void layoutW()
    void summary()
    void isDone()
    const el = traceCodeEl as any
    if (!el?.textBufferView?.measureForDimensions) {
      setStreamRowsCount(0)
      return
    }
    const c = el.textBufferView.measureForDimensions(layoutW(), 99999)?.lineCount ?? 0
    setStreamRowsCount(c)
  })
  // ========================================================================

  return (
    <Show when={content() || opaque()}>
      <box
        ref={(el: BoxRenderable) => {
          alwaysSeparate.add(el)
          traceOuter = el
        }}
        paddingLeft={3}
        paddingRight={2}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={toggle}>
          <ReasoningHeader
            toggleable={inMinimal() && !opaque()}
            open={!inMinimal() || expanded()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
            encrypted={opaque()}
          />
        </box>
        <Show when={!opaque() && (!inMinimal() || expanded()) && summary().body}>
          {/* 0276: the box's natural height is the native measure wrapped at
              width-1 (a +1 phantom row while streaming - flushes at done).
              Drive the box height from the buffer's OWN wrapped count at the
              real laid-out width (lineCountAtWidth == virtualLineCount, always
              correct) instead of the compromised layout height. */}
          <box
            ref={(el: any) => {
              traceInner = el
            }}
            height={streamRowsCount()}
            paddingLeft={inMinimal() ? 2 : 0}
            marginTop={1}
            flexShrink={0}
          >
            <code
              ref={(el: any) => {
                traceCodeEl = el
              }}
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={summary().body}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
  encrypted?: boolean
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning
  const completed = () => {
    if (props.encrypted) return `Thought${props.duration ? ` · ${props.duration}` : ""}`
    const detail = [props.title, props.duration].filter(Boolean).join(" · ")
    return `${props.toggleable ? (props.open ? "- " : "+ ") : ""}Thought${detail ? `: ${detail}` : ""}`
  }

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={fg()}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          {completed()}
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} paddingRight={2} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={props.part.text.trim()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  // A bash part created by session.shell (the user's "!" shell-mode command)
  // is distinguishable by its message chain: the tool part sits in an
  // assistant message whose PARENT user message carries the synthetic
  // "The following tool was executed by the user" text part. The block then
  // titles as "! shell" / "! Running" instead of "# bash" / "# Running"
  // (2026-08-17).
  const sync = useSync()
  const fromUserShell = createMemo(() => {
    if (display() !== "bash") return false
    const parentID = props.message.parentID
    if (!parentID) return false
    const parent = (sync.data.message[props.message.sessionID] ?? []).find((m) => m.id === parentID)
    if (!parent || parent.role !== "user") return false
    const parts = sync.data.part[parent.id] ?? []
    return parts.some(
      (p) => p.type === "text" && p.synthetic === true && p.text === "The following tool was executed by the user",
    )
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={display() === "bash"}>
          <Shell {...toolprops} fromUserShell={fromUserShell()} />
        </Match>
        <Match when={display() === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={display() === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={display() === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={display() === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={display() === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={display() === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={display() === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={display() === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={display() === "execute"}>
          <Execute {...toolprops} />
        </Match>
        <Match when={display() === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={display() === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={display() === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={display() === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={display() === "squash-output"}>
          <SquashOutput {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

// Tool calls whose prose-carrying arg is streamed into the inline grey text
// while composing (0219): the model's JSON args land in state.raw as a
// stream, so a text-bearing call shows its body growing next to the icon
// instead of the composed [op=...] listing snapping in at completion.
// Tools without an entry keep the composed-shot listing.
const TEXT_BODY_KEY: Record<string, string> = {
  "sessions-query": "sql",
  "sessions-browse": "pattern",
  "sessions-manage": "op",
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
  // Set for bash parts created by session.shell (the user's "!" shell-mode
  // command): the block titles as "! shell" instead of "# bash" so the GUI
  // (and the agent via the output <metadata> marker) can tell a user-entered
  // command from a model-generated bash call.
  fromUserShell?: boolean
}
function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })
  // Stream the composing tool call into the grey inline text (no block): the
  // model's JSON args arrive in state.raw as a stream, so while pending we
  // show the live extracted body ("sessions-query SELECT ...") growing next
  // to the icon instead of the single composed [op=...] listing snapping in
  // at completion. The bodyKey is per-tool (the arg carrying the prose);
  // tools without one fall back to the previous composed listing.
  const stream = useToolStream(props, { bodyKey: TEXT_BODY_KEY[props.tool] ?? "", title: () => undefined })
  const live = createMemo(() => {
    if (!stream.streaming()) return undefined
    const body = stream.display()
    return body ? `${props.tool} ${body}` : undefined
  })
  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {live() ?? `${props.tool} ${input(props.input)}`}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.tool} ${input(props.input)}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  gap?: number
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      marginTop={1}
      gap={props.gap ?? 1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{title().replace(/^[#!←] /, "")}</Spinner>
          </Show>
        )}
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const stream = useToolStream(props, {
    bodyKey: "command",
    title: () => undefined,
  })
  const command = createMemo(() => stringValue(props.input.command) ?? "")
  const output = createMemo(() => stripAnsi(stringValue(props.metadata.output)?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    const formatted = pathFormatter.format(workdir)
    if (formatted === ".") return undefined
    return formatted
  })

  // The gutter turns on inside LiveToolStream, driven by the STREAMING
  // content's first newline (0288: an AND on a shell-side selector gated on
  // the landed input.command, which is empty mid-stream, kept the gutter off
  // the whole stream - zero native gutter frames witnessed). The shell-side
  // selector is dropped: content().includes("\n") is the one true gate,
  // reactive to every delta, identical at completion. A lone "1" against a
  // completed one-liner still never appears (content has no newline).
  const gutter = () => true
  // PERSISTENT header (2026-08-17): the "# Running" line used to pop in
  // and out with the state - a multi-line command with no workdir lost
  // the title at completion and the block SHRANK a row (the jumpy pop the
  // user reported). The header is now always present and only the text
  // toggles: "# Running [in <wd>]" while the command executes, "# bash"
  // once it completes - the tool call box height never changes (same
  // pattern as write's # Writing <-> # Wrote and edit's <- Editing <->
  // <- Patched). The bash tool also gains the persistent label so the GUI
  // always shows what the block was.
  const title = createMemo(() => {
    const p = props.fromUserShell ? "!" : "#"
    if (isRunning()) {
      const wd = workdirDisplay()
      return wd ? `${p} Running in ${wd}` : `${p} Running`
    }
    return props.fromUserShell ? "! shell" : "# bash"
  })
  // Heredoc bodies get their own language colors (delimiter-named, else
  // sniffed from the body, else bash) - the shell parts stay bash.
  // The heredoc body-language detection for the STREAMING view (0147):
  // once the opener (`<< 'EOF'`) completes, the body's language resolves
  // (delimiter-named, else the 0137 sniffer) - the single streaming
  // element then renders with the BODY's grammar (write-style streaming:
  // the element persists and the filetype flips IN PLACE via the adapter
  // - no segments branch, no recreation, no flicker). The opener/closer
  // lines render with the body's grammar during streaming; the completed
  // view below re-splits into the proper per-segment grammars.
  const liveFiletype = createMemo(() => {
    const segs = heredocSegments(stream.display().replace(/\n+$/, ""))
    return segs && segs.length > 1 ? segs[1]!.lang : "bash"
  })
  const commandSegments = createMemo(() => heredocSegments(command()))
  // 0289 (stable slots): live heredoc segmentation WITHOUT per-delta element
  // recreation. The segments branch's `props.segments.map()` creates fresh
  // <code> elements every delta (the reactive array read in the body
  // re-renders it; each fresh mount measures at width 0 -> jump). Instead we
  // pre-create a FIXED set of slot components once and feed their content
  // through accessor props: the reconciler's createRenderEffect calls
  // setProperty(node, "content", ...) in place, so the elements persist (the
  // same mechanism that keeps singleEl stable) and per-slot gutters justify
  // independently (body crossing 10 widens ITS gutter only). Empty slots
  // hide via showLineNumbers (in-place), avoiding 0147's phantom "1"s.
  // Slots are keyed by segment role (bash/body/bash-tail), stable across the
  // stream's shape changes -> solid keeps the node for an existing key.
  //
  // The slot components are defined OUTSIDE LiveToolStream (module scope,
  // created once by the runtime) and receive the segment TEXTS as getter
  // props, so their bodies never re-run on delta - only the element
  // accessors update.
  const liveSegments = createMemo(() => heredocSegments(stream.display().replace(/\n+$/, "")))
  // 0199 carry-over: the SINGLE code element (LiveToolStream's) persists
  // through streaming -> running -> completed, so the non-heredoc command
  // never remounts at completion (its buffer holds the last highlight of
  // the identical content). The completed HEREDOC flips the segments prop
  // to the static per-segment re-split (fresh mounts - the 0143 per-delta
  // recreation concern does not apply: no more deltas at completion).
  const completed = () => !stream.streaming() && !isRunning()
  // The block shows once there is ANYTHING to render (streaming, running,
  // landed command, or output); the bare pre-stream/errored-no-output
  // pending state falls back to the inline "$ command" row.
  const showBlock = () =>
    stream.streaming() ||
    isRunning() ||
    stringValue(props.metadata.output) !== undefined ||
    command().length > 0

  return (
    <Show when={showBlock()} fallback={
      <InlineTool icon="$" pending="Writing command..." complete={command()} part={props.part}>
        {command()}
      </InlineTool>
    }>
      {/* 0199 carry-over: ONE LiveToolStream for streaming, running, AND
          completed. The single code element persists (its buffer holds the
          last highlight of the identical content), so the completion never
          remounts a fresh element - no white flash, no blank. The title
          toggles "# bash" <-> "# Running" <-> "# bash" in place, the
          spinner runs while streaming/running, fg brightens
          textMuted -> theme.text at completion, and the grow-only clamp
          releases to the command's natural final height. The completed
          HEREDOC flips segments to the static per-segment re-split (fresh
          mounts - fine: no deltas after completion). The output + expand
          toggle render as block children after the code. */}
      <LiveToolStream
        part={props.part}
        title={title()}
        streaming={stream.streaming()}
        // Trim the display's trailing newlines (display-only) so the
        // streaming width/rows match the landed command's (0146 judder).
        content={stream.display().replace(/\n+$/, "")}
        filetype={liveFiletype()}
        gutter={gutter()}
        // 0289 (stable slots): LIVE heredoc segments throughout - each block
        // mounts once (StreamSegment's fixed slots) and grows in place, so the
        // bash/body split with independent gutters streams without jumping. The
        // completed value is the static re-split (same shape; the slots update
        // in place, so the completion never repaints).
        segments={completed() ? commandSegments() : liveSegments()}
        fg={stream.streaming() || isRunning() ? theme.textMuted : theme.text}
        release={completed()}
        spinner={stream.streaming() || isRunning()}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <Show when={output()}>
          <text fg={theme.text}>{limited()}</text>
        </Show>
        <Show when={collapsed().overflow}>
          <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
        </Show>
      </LiveToolStream>
    </Show>
  )
}

// Best-effort extraction of a top-level string key from a partially streamed
// JSON tool input (the accumulating raw tool call). String VALUES have their
// quotes escaped (\" ), so an unescaped `"key":` can only be the key itself;
// the value tail is returned JSON-unescaped for display. Mid-stream, escape
// sequences at the cut point may be incomplete - display-only, the tail can
// flicker a character as the next delta lands.
function streamedJsonValue(raw: string, key: string): string | undefined {
  const marker = `"${key}":`
  const start = raw.indexOf(marker)
  if (start === -1) return undefined
  let i = start + marker.length
  while (i < raw.length && /\s/.test(raw[i]!)) i++
  if (raw[i] !== '"') return undefined
  const tail = raw.slice(i + 1)
  let out = ""
  for (let j = 0; j < tail.length; j++) {
    const c = tail[j]!
    // The value ENDS at the first unescaped closing quote - without this
    // the extraction kept reading into the trailing JSON args ("...", 
    // "filePath": "...}") and the live title/filetype got a garbage path:
    // filetype() resolved no extension and the write streamed WHITE text
    // (markdown content reverting to plain the moment the filePath arg
    // landed, snapping back at completion - 2026-08-17). Escaped quotes
    // (\" and \u0022) are consumed by the escape branch below and stay
    // part of the value.
    if (c === '"') break
    if (c !== "\\" || j + 1 >= tail.length) {
      out += c
      continue
    }
    const n = tail[j + 1]!
    switch (n) {
      case "n":
        out += "\n"
        break
      case "t":
        out += "\t"
        break
      case "r":
        out += "\r"
        break
      case '"':
        out += '"'
        break
      case "\\":
        out += "\\"
        break
      case "/":
        out += "/"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "u": {
        const hex = tail.slice(j + 2, j + 6)
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          j += 4
        } else {
          out += "\\u"
        }
        break
      }
      default:
        out += n
    }
    j++
  }
  return out
}

// Shared live-streaming view for tool calls: while the model generates a
// tool's JSON arguments (message.part.delta -> state.raw), extract the body
// text and the live title arg, and slow the SDK flush window so the
// tree-sitter worker can re-highlight the growing body per delta (same
// mechanism as the reasoning part, with an 8ms FLOOR so the adaptive
// controller widens the window from the very start). Completed views
// (parsed metadata) take over once the tool lands.
function useToolStream(
  props: ToolProps,
  opts: {
    bodyKey: string
    title: (livePath: string | undefined) => string | undefined
    pathKey?: string
  },
) {
  const status = createMemo(() => props.part.state.status)
  const raw = createMemo(() => ("raw" in props.part.state ? props.part.state.raw : ""))
  const streaming = createMemo(() => status() === "pending" && raw().length > 0)
  const liveBody = createMemo(() => streamedJsonValue(raw(), opts.bodyKey) ?? "")
  const livePath = createMemo(() => (opts.pathKey ? streamedJsonValue(raw(), opts.pathKey) : undefined))
  // The body shown in the live block: the unescaped stream while the input
  // is pending, the full parsed input once the call lands.
  const display = createMemo(() => (streaming() ? liveBody() : stringValue(props.input[opts.bodyKey]) ?? ""))

  return {
    status,
    streaming,
    display,
    livePath,
    showContent: createMemo(() => display().length > 0),
    title: createMemo(() => opts.title(streaming() ? livePath() : undefined)),
  }
}

// The live-streaming block itself: reasoning-style code element (conceal
// from the app state + muted fg so the per-flush highlight applies - the
// conceal={false} + fg={theme.text} combo suppressed it, verified by
// bisect 2026-08-16) with a gutter, so nothing pops in at completion.
// Content-language sniffing for the write live view: when the filePath arg
// hasn't streamed in yet (some models emit it last), guess the language
// from the first lines of the body so code writes stream colored instead
// of plain. Heuristic only - the authoritative filetype applies once the
// path lands, and a wrong guess flips silently at the end.
function sniffFiletype(content: string, minLength = 60): string | undefined {
  if (content.length < minLength) return undefined
  // 1500-char window: comment-headed files (license/doc headers) put their
  // first code line well past 600 chars - the window must reach it.
  const head = content.slice(0, 1500)
  const firstLine = head.split("\n", 1)[0] ?? ""
  // Full-line capture: env-style shebangs ("#!/usr/bin/env python3") put
  // the interpreter on the second token - (\S+) stops at "/usr/bin/env".
  const shebang = /^#!\s*(.+)/.exec(firstLine)
  if (shebang) {
    const p = shebang[1]!
    if (/python/i.test(p)) return "python"
    if (/(?:ba|da|k)?sh$|bash/i.test(p)) return "bash"
    if (/node/i.test(p)) return "javascript"
    if (/ruby/i.test(p)) return "ruby"
    if (/perl/i.test(p)) return "perl"
  }
  if (/^<\?xml/.test(head)) return "xml"
  if (/^<!DOCTYPE html|<html[\s>]/i.test(head)) return "html"
  if (/^<\?php/m.test(head)) return "php"
  if (/^using [A-Za-z0-9_.]+;|^namespace [A-Za-z0-9_.]+\s*\{/m.test(head)) return "csharp"
  if (/^export (?:function|const|class|interface|type|default)\b|^interface \w+\s*\{/m.test(head)) return "typescript"
  if (/^import .* from ['"]/m.test(head) && /:\s*(?:string|number|boolean|Record|Array|Promise|Map)</m.test(head)) return "typescript"
  if (/^(?:export )?(?:function|const|let|var)\b.*=>/m.test(head)) return "typescript"
  if (/^const \w+:\s*[\w<>, |\[\]]+\s*=\s*/m.test(head)) return "typescript"
  if (/^module\.exports|require\(['"]/m.test(head)) return "javascript"
  if (/^package main\b|^func \w+\(/m.test(head)) return "go"
  if (/^fn (?:main|\w+)\(|^use std::|^impl\b/m.test(head)) return "rust"
  // Comma-delimited module lists (import os, sys, re - the probe-script
  // opener) end with the LAST module, so the trailing $ anchor must accept
  // `, \w+` repeats. JS imports (import React, {x} from 'react', import * as
  // x from '...') never reach this rule: the ` from ...` suffix fails the $
  // anchor and they fall to their own JS rules below.
  if (/^def \w+\(|^class \w+:|^from \w+ import|^import \w+(?: as \w+)?(?:\s*,\s*\w+(?: as \w+)?)*$/m.test(head)) return "python"
  if (/^public (?:static )?(?:class|void|final)\b|^class \w+ \{$/m.test(head)) return "java"
  if (/^fun main|^fun \w+\(/m.test(head)) return "kotlin"
  // cpp/c: any std header without a .h extension is cpp (iostream, vector,
  // memory, ...), .h system headers are c (stdio.h, string.h, ...). cpp
  // also covers using-namespace-std and std:: starts.
  if (/^#include <(?![\w./]*\.h>)[\w./]+>|^(?:using namespace std\b|std::[a-z]+\s*\()/m.test(head)) return "cpp"
  if (/^#include <[a-z0-9_]+\.h>/m.test(head)) return "c"
  if (/^import Foundation|^import SwiftUI/m.test(head)) return "swift"
  if (/^main :: IO \(\)/m.test(head)) return "haskell"
  if (/^require ['"]/m.test(head)) return "ruby"
  if (/^local function\b/m.test(head)) return "lua"
  // Plain JS idioms (no type annotations): comment-headed .js files whose
  // export/module lines sit beyond the window still get javascript from
  // their first declarations. TS-typed forms matched above win first; a
  // wrong guess flips to the real language when the filePath arg lands.
  if (/^import .* from ['"]/m.test(head)) return "javascript"
  if (/^(?:const|let|var)\s+\w+\s*=\s*[\[\{\/\'"`(]/m.test(head)) return "javascript"
  if (/^function \w+\(/m.test(head)) return "javascript"
  if (/^\{/.test(firstLine) && /"\w+"\s*:/.test(head)) return "json"
  // css: a selector + { at line end. JS-block false positives excluded by
  // the keyword blacklist (import/const/if/function/interface/... start
  // with the same letters as element selectors) and by excluding ( and =
  // from the pre-{ run.
  if (/^(?!(?:import|export|const|let|var|function|class|if|for|while|switch|return|interface|type|namespace|enum|struct)\b)[A-Za-z#.\*@][^{}()=]*\{/m.test(head)) return "css"
  // yaml: TWO OR MORE key: value lines at line start, or front-matter
  // (--- + a key: value). A single sentence-like "Key: value" line inside
  // a markdown/prose document is NOT yaml - a .md write whose "Status:
  // FIXED (0161)..." line streamed flipped the sniffer (and with batched
  // deltas, the latched live filetype) to the yaml grammar mid-stream
  // (2026-08-17). A bare --- horizontal rule is not yaml either.
  if ((head.match(/^[A-Za-z0-9_./-]+\s*:\s+[^\s#]/gm) ?? []).length >= 2) return "yaml"
  if (/^---\s*$/m.test(head) && /^[A-Za-z0-9_./-]+\s*:/m.test(head)) return "yaml"
  // toml/ini: [section] header to EOL, or key = "..." (dot-free key to
  // avoid JS exports.a = patterns; quoted values only).
  if (/^\[[A-Za-z0-9_.-]+\](?:\s.*)?$|^[A-Za-z0-9_-]+\s*=\s*["']/m.test(head)) return "toml"
  // Markdown (heredoc docs with non-language delimiters like EOF, and
  // prose writes): ATX headings, bullet/numbered lists, code fences,
  // tables, blockquotes. Checked AFTER the code languages - comment-headed
  // code still wins its real language (a "#" alone is a bash comment; the
  // heading must be "##"+ or carry another marker).
  if (/^(?:#{2,6}\s|[-*+]\s+|\d+\.\s|```|~~~|\|.*\||>\s)/m.test(head)) return "markdown"
  return undefined
}

// Heredoc body language resolution for the bash streaming view: a command
// containing heredocs is split into segments - the shell parts stay bash,
// each heredoc body is colored with the language its delimiter names
// (PY/PYTHON -> python, JS/MJS -> javascript, ...), falling back to the
// write-tool content sniffer for non-language delimiters (EOF etc.), and
// to bash (current behavior) when nothing matches. While the closing
// delimiter is still streaming, the body is the open tail. Best-effort
// visual only - the completed command keeps its own single-bash render.
// A segment is tagged body:true when it is HEREDOC CONTENT (between an opener
// and its closer) rather than shell syntax (the opener line, the closing
// delimiter, or trailing shell) - REGARDLESS of what language it sniffed to
// (an SH-delimited body full of echo lines is still a heredoc body). The TUI
// uses the flag to restart the body's numbering at 1 and indent it; the shell
// opener/closer/tail keep the continuous bash counter.
type StreamSegmentData = { text: string; lang: string; body?: boolean }
function heredocSegments(text: string): StreamSegmentData[] | undefined {
  const HEREDOC_LANG: Record<string, string> = {
    PY: "python",
    PYTHON: "python",
    SH: "bash",
    BASH: "bash",
    JS: "javascript",
    MJS: "javascript",
    NODE: "javascript",
    TS: "typescript",
    TSX: "typescript",
    JSON: "json",
    RB: "ruby",
    RUBY: "ruby",
    PL: "perl",
    PERL: "perl",
    SQL: "sql",
    GO: "go",
    RS: "rust",
    YAML: "yaml",
    YML: "yaml",
    MD: "markdown",
    MARKDOWN: "markdown",
  }
  // The -e/-c quoted-code form (bun -e '...', python -c "...", node -e):
  // the interpreter names the language, the quoted body is the code, and
  // the closing quote + the rest of its line is a shell tail. Falls back
  // to the write-tool sniffer when the interpreter is not a code runner.
  const EVAL_LANG: Record<string, string> = {
    bun: "javascript",
    node: "javascript",
    deno: "javascript",
    tsx: "javascript",
    python: "python",
    python3: "python",
    ruby: "ruby",
    perl: "perl",
    php: "php",
    sqlite3: "sql",
    psql: "sql",
  }
  const opens: { delim: string; end: number; quote?: string }[] = []
  const openRe = /(?:^|[\s;&|(])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g
  let m: RegExpExecArray | null
  while ((m = openRe.exec(text))) opens.push({ delim: m[1]!, end: m.index + m[0].length })
  const evalRe = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)\s+-[ec]\s*(['"])/g
  while ((m = evalRe.exec(text))) opens.push({ delim: m[1]!, end: m.index + m[0].length, quote: m[2]! })
  // The here-string form (python3 <<< 'code'): the interpreter names the
  // language, the quoted body is the code - same quote-based branch as
  // -e/-c. Single-line here-strings keep the code bash-colored with the
  // opener line; multi-line ones split like -e/-c.
  const hereStringRe = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)\s+<<<\s*(['"])/g
  while ((m = hereStringRe.exec(text))) opens.push({ delim: m[1]!, end: m.index + m[0].length, quote: m[2]! })
  opens.sort((a, b) => a.end - b.end)
  if (!opens.length) return undefined

  const segs: StreamSegmentData[] = []
  let cursor = 0
  // The language resolution is ONE chain for every opener kind: the
  // delimiter/interpreter name wins (HEREDOC_LANG for heredoc delimiters,
  // EVAL_LANG for interpreters), then the target FILE the heredoc is
  // redirected into (cat > foo.py << 'EOF', tee foo.yaml << 'END' - the
  // redirect's filename extension is authoritative, no content sniff),
  // then the write-tool sniffer on the body, then bash. Heredoc delimiters
  // are conventionally uppercase (PY, JS) so the map key is case-insensitive;
  // interpreter names are lowercase. `opener` = the full opening line, used
  // for the `> file` redirect target and a bare interpreter (`python3 - <<`).
  const segLang = (op: { delim: string; quote?: string }, body: string, opener?: string) => {
    const target = opener && /(?:^|[\s;&|(])(?:cat|tee|dd|cp)\s+[>\-]?\s*([A-Za-z0-9_./+\-]+)\s*(?:<<|<<<)/.exec(opener)
    const targetFt = target ? coalesceFiletype(filetype(target[1]!)) : undefined
    // Bare interpreter feeding stdin (python3 - << 'EOF', sqlite3 << 'END',
    // node <<< 'code'): the word before `- <<`/`<<` names the runtime. `cat`
    // matches here too but is not in EVAL_LANG, so it falls through to the
    // redirect target / sniffer.
    const interp = opener && /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)\s+(?:-\s*)?(?:<<|<<<)/.exec(opener)
    return (
      HEREDOC_LANG[op.delim.toUpperCase()] ??
      EVAL_LANG[op.delim] ??
      (targetFt && targetFt !== "none" ? targetFt : undefined) ??
      (interp ? EVAL_LANG[interp[1]!] : undefined) ??
      sniffFiletype(body, 0) ??
      "bash"
    )
  }
  for (const op of opens) {
    // Skip opens already consumed by a previous open's body: the body
    // text can legitimately contain the opener patterns (a manifest
    // entry mentioning "bun -e '...' python3 <<< '...'" - witnessed
    // live 2026-08-16, four phantom "1" gutter rows). The cursor sits
    // past the previous open's closer, so any open ending before it is
    // inside that body.
    if (op.end < cursor) continue
    // The whole opening line (cat > f << 'PY', ... && bun -e ') is
    // shell. No newline after it yet = the opener is still streaming -
    // everything stays bash.
    const lineEnd = text.indexOf("\n", op.end)
    if (lineEnd === -1) break
    // Trim the trailing newline from each segment: a code element whose
    // content ends in "\n" renders a phantom EMPTY line, and its gutter
    // shows one extra number (the "2" under a 1-line opener, the "50"
    // under a 49-line body). The segments are separate code elements, so
    // the newline carries no layout information - drop it.
    if (op.quote) {
      // -e/-c/<<<: the quoted code. The closing quote is the first
      // UNESCAPED one after the opening quote (the code itself must avoid
      // the shell's quoting char - same constraint as running it). A
      // closing quote before the line end = the single-line form
      // (bun -e 'one-liner') - the whole line stays bash with the opener.
      // Otherwise the opener is the line UP TO the opening quote (a
      // here-string starts its code on the opener line - "<<< 'code"
      // - while -e usually starts it on the next line), the body is the
      // quoted code (leading newlines are the line break after the
      // opening quote), and the tail = the closing quote + the rest of
      // its line (shell syntax stays bash).
      let close = -1
      for (let i = op.end; i < text.length; i++) {
        if (text[i] === op.quote && text[i - 1] !== "\\") {
          close = i
          break
        }
      }
      if (close !== -1 && close < lineEnd) {
        segs.push({ text: text.slice(cursor, lineEnd), lang: "bash" })
        cursor = lineEnd + 1
      } else {
        const quoteOpener = text.slice(cursor, op.end)
        segs.push({ text: quoteOpener, lang: "bash" })
        const body = text.slice(op.end, close === -1 ? text.length : close).replace(/^\n+/, "")
        if (body.length > 0) {
          segs.push({
            text: body.endsWith("\n") ? body.slice(0, -1) : body,
            lang: segLang(op, body, quoteOpener),
            body: true,
          })
        }
        if (close === -1) {
          // The closing quote is still streaming - the body is the open
          // tail (the single-element live view colors it as the language).
          cursor = text.length
        } else {
          const tailEnd = text.indexOf("\n", close)
          const tailText = text.slice(close, tailEnd === -1 ? text.length : tailEnd + 1)
          segs.push({
            text: tailText.endsWith("\n") ? tailText.slice(0, -1) : tailText,
            lang: "bash",
          })
          cursor = tailEnd === -1 ? text.length : tailEnd + 1
        }
      }
      if (cursor >= text.length) break
      continue
    }
    const openerText = text.slice(cursor, lineEnd)
    if (openerText.length > 0) segs.push({ text: openerText, lang: "bash" })
    const closer = new RegExp(`^${op.delim}(?=[\\s;]|$)`, "gm")
    closer.lastIndex = op.end
    const close = closer.exec(text)
    const bodyEnd = close ? close.index : text.length
    if (bodyEnd > lineEnd + 1) {
      const body = text.slice(lineEnd + 1, bodyEnd)
      // bodyEnd is the closer line's start, so the body ends with "\n".
      segs.push({ text: body.endsWith("\n") ? body.slice(0, -1) : body, lang: segLang(op, body, openerText), body: true })
    }
    if (close) {
      // The closing delimiter line is shell syntax - render it as bash.
      const closeLineEnd = text.indexOf("\n", close.index)
      const closerText = text.slice(close.index, closeLineEnd === -1 ? text.length : closeLineEnd + 1)
      segs.push({
        text: closerText.endsWith("\n") ? closerText.slice(0, -1) : closerText,
        lang: "bash",
      })
      cursor = closeLineEnd === -1 ? text.length : closeLineEnd + 1
    } else {
      cursor = text.length
    }
    if (cursor === 0) cursor = text.length
    if (cursor >= text.length) break
  }
  // The opener line was still streaming (no newline yet): no complete
  // segment exists. Return undefined so the caller falls back to a single
  // bash code element - an EMPTY array is truthy, and the segments branch
  // would render an empty box (the block collapses to title-only while
  // the opener streams in).
  if (!segs.length) return undefined
  if (cursor < text.length) segs.push({ text: text.slice(cursor), lang: "bash" })
  return segs
}

// 0289 (stable slots): the segmented heredoc view as ONE-WAY TRIPS. Each
// segment gets a pre-created slot: this component's body runs once, at
// LiveToolStream mount, so its <code> and <line_number> mount ONCE and only
// GROW - every changing value (text, language, streaming, numbers) flows
// through ACCESSOR props that the universal-solid adapter evaluates in a
// createRenderEffect and applies IN PLACE (node[name]=value, index.bun.js:769).
// The old segments branch did `props.segments.map(...)` inside the box
// children; the compiled children getter ran inside a tracked effect, so every
// content delta re-created the segment <code> nodes - fresh elements measure
// at width 0 in the global layout pass, hence the 0287/0288b jump. Here the
// box children are the fixed slot junctions (slotEls, a plain const - nothing
// reactive in that getter), so the box never re-renders. Each slot owns its
// gutter, so the bash sections and the heredoc body justify independently:
// bash runs a continuous counter across segments, the body RESTARTS AT 1 the
// moment it appears, and the body's gutter is one column wider (minWidth 4 vs
// 3) purely from the gutter - the indent is not text.
const MAX_SLOTS = 5
function StreamSegment(props: {
  // Accessors into the parent's live segments - tracked through the adapter's
  // render effect, so the elements update without ever re-mounting.
  text: () => string
  lang: () => string
  streaming: () => boolean
  fg: () => RGBA
  conceal: () => boolean
  // Bash line the first row of this slot continues from (0 for the body,
  // which restarts at 1).
  lineStart: () => number
  // True for the heredoc body (restart at 1 + the wider indent gutter).
  restart: () => boolean
  // Slot present in the resolved segments (bash opener/tail or the body).
  show: () => boolean
  // The block resolved into a heredoc (more than one segment): bash gutters
  // appear even for single-line opener/closer lines, so a lone "1" next to
  // the body block is legitimate.
  segmented: () => boolean
}) {
  const { theme, syntax } = useTheme()
  // Bash slots pass a small continuation map so the closer/tail keep
  // counting the opener's bash lines (opener 1, closer 2, tail 3). The BODY
  // slot gets NO map - its gutter numbers by DEFAULT continuous 1..N (starts
  // at 1, the one-way numbering), and no setter sits in its streaming path
  // (the 0288 shared-gutter map went BLANK mid-stream: the linenums probe
  // shows setLineNumbers fired once with an empty map at mount and never
  // again while the text raced ahead).
  const lineNumbers = createMemo(() => {
    const n = props.text().split("\n").length
    const base = props.lineStart()
    const map = new Map<number, number>()
    for (let i = 0; i < n; i++) map.set(i, base + i + 1)
    return map
  })
  // Guarded height driver only - the 100ms trace ticker was dropped (a slot's
  // element could be torn down mid-tick; the per-slot probes multiplied the
  // destroyed-buffer reads that crashed the TUI).
  const streamHeight = useFixedStreamHeight(props.text, undefined, {
    // Re-measure at the streaming -> completed transition: the buffer catches
    // up synchronously then, fixing the "gutters but no text" stale height.
    released: () => !props.streaming(),
  })
  const ref = (el: any) => {
    streamHeight.ref(el)
  }
  // ONE code element per slot for the whole stream - never replaced, only
  // its content/height/streaming accessors update.
  const el = (
    <code
      ref={ref}
      height={streamHeight.height()}
      filetype={props.lang()}
      width="100%"
      drawUnstyledText={false}
      streaming={props.streaming()}
      syntaxStyle={syntax()}
      content={props.text()}
      conceal={props.conceal()}
      fg={props.fg()}
    />
  )
  // Bash gutters appear once the content passes a line, OR the moment the
  // command resolves into a heredoc; body slots number from their first line.
  // The toggle is a line_number-only Show (fallback = the SAME `el`) - the
  // code element never re-mounts (the solid adapter disposes the gutter node
  // only, and `el` persists across the flip).
  const gutterOn = createMemo(() =>
    props.show() && (props.restart() || props.text().includes("\n") || props.segmented()),
  )
  // The solid adapter constructs native elements with { id } only and applies
  // props via node[name]=value, so a gutter's minWidth/paddingRight (captured
  // in the native constructor) are IMMOVABLE at runtime - only the lineNumbers
  // map reaches the gutter (set lineNumbers forwards into it). The body's
  // 1-col indent therefore comes from wrapping its row in a padded box: the
  // body gutter and code recede together as a unit, and the body gutter still
  // justifies on its own digit count (10+ widens ONLY it).
  return (
    <Show when={props.show()}>
      <box paddingLeft={props.restart() ? 1 : 0}>
        <Show when={gutterOn()} fallback={el}>
          <line_number
            fg={theme.textMuted}
            minWidth={3}
            paddingRight={1}
            {...(props.restart() ? {} : { lineNumbers: lineNumbers() })}
          >
            {el}
          </line_number>
        </Show>
      </box>
    </Show>
  )
}

function LiveToolStream(props: {
  part: ToolPart
  title?: string
  streaming: boolean
  content: string
  filetype?: string
  gutter?: boolean
  conceal?: boolean
  segments?: StreamSegmentData[]
  // 0199 carry-over: the SAME code element persists through
  // streaming -> running -> completed (the caller flips these props instead
  // of remounting a fresh completed element). fg is the code's unstyled
  // color (textMuted while streaming/running, theme.text at completion);
  // release drops the grow-only clamp at completion; spinner overrides the
  // default (bash shows the title spinner through running, not just
  // streaming); children render after the code (bash's output).
  fg?: RGBA
  release?: boolean
  spinner?: boolean
  onClick?: () => void
  // Content rendered between the BlockTool title and the streamed code
  // (squash-output's label line) - distinct from `children`, which renders
  // AFTER the code in the same box.
  above?: JSX.Element
  children?: JSX.Element
}) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  // 0289e: ONE structure from the first frame. The gutter decision moved per
  // slot (StreamSegment's gutterOn) - the whole command lives in slot 0 and
  // heredoc bodies/tails mount as later slots; there is no single-element
  // branch to flip into. The PROBE keeps summary state only.
  createEffect((prev) => {
    const state = {
      gutterOn: props.content.includes("\n") || (props.segments?.length ?? 0) > 1,
      nl: props.content.includes("\n"),
      contentLen: props.content.length,
      lineNumbers: 0,
      segments: props.segments?.length ?? 0,
      streaming: props.streaming,
    }
    const key = JSON.stringify(state)
    if (key !== prev) {
      try {
        require("fs").appendFileSync(
          "/tmp/opencode/gutter-gate.jsonl",
          JSON.stringify({
            t: Date.now(),
            ...state,
            preview: props.content.split("\n")[0]?.slice(0, 30) ?? "",
            // The first ~5 lines of the content with JSON escaping, so the
            // indentation of the heredoc body lines is verifiable verbatim.
            bodyLines: props.content.split("\n").slice(0, 5).map((l) =>
              l.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").slice(0, 40),
            ),
          }) + "\n",
        )
      } catch {}
    }
    return key
  }, "")
  // The streaming view must match the completed view's conceal choice.
  // The write completed view renders conceal={false}; if the live view
  // hides comments (conceal=true), the concealed spans keep their text
  // in the buffer but LOSE their style span - the comments render with
  // the element's muted fg, a grey comment block above the colored code
  // (the 2026-08-17 duplicate-grey-copy report, video-confirmed), and
  // the colors snap in at completion when the conceal=false block lands.
  const conceal = createMemo(() => props.conceal ?? ctx.conceal())
  // 0289e: ONE uniform segmentation - the caller's segments (heredoc split)
  // when present, otherwise the whole content as a single bash segment. The
  // bash/heredoc structure is identical from the first frame: slot 0 carries
  // the bash (the whole command while not a heredoc, the opener once it is),
  // heredoc bodies/tails land in the later slots as they resolve. Slots only
  // ever MOUNT (segment counts are monotonic), never dispose mid-life - the
  // earlier branch flip between a single element and a slot box disposed live
  // elements with pending prop updates and crashed the TUI.
  const segs = createMemo(() => {
    if (props.segments && props.segments.length > 0) return props.segments
    const c = props.content
    return c.length > 0 ? [{ text: c, lang: props.filetype ?? "bash" }] : []
  })
  // The SHELL sections run a CONTINUOUS line counter across segments (opener
  // 1..K, closer/tail K+1...); heredoc BODY segments are excluded entirely -
  // they restart at 1 in their own gutter, so they never feed the bash counter
  // regardless of what language they sniffed to (an SH-valued body still
  // resets the count). lineStart[i] = the bash row the i-th slot's first line
  // labels.
  const bashStarts = createMemo(() => {
    const s = segs()
    const starts: number[] = []
    let acc = 0
    for (let i = 0; i < s.length; i++) {
      const isShell = s[i]!.lang === "bash" && !s[i]!.body
      starts[i] = isShell ? acc : 0
      if (isShell) acc += Math.max(1, s[i]!.text.split("\n").length)
    }
    return starts
  })
  // The fixed slot junctions - created ONCE, mounted once (the box children
  // getter here is a plain const read, nothing reactive, so the box never
  // re-renders). Each slot hides until its segment exists, then only its
  // content/numbers/streaming ACCESSORS update per delta - in place.
  const slotEls: JSX.Element[] = []
  for (let i = 0; i < MAX_SLOTS; i++) {
    slotEls.push(
      <StreamSegment
        text={() =>
          i < MAX_SLOTS - 1
            ? segs()[i]?.text ?? ""
            : // the last slot absorbs any overflow segments - no text lost.
              segs().slice(i).map((s) => s.text).join("")
        }
        lang={() => segs()[i]?.lang ?? "bash"}
        streaming={() => props.streaming}
        fg={() => props.fg ?? theme.textMuted}
        conceal={() => conceal()}
        lineStart={() => bashStarts()[i] ?? 0}
        restart={() => segs()[i]?.body === true}
        show={() => i < segs().length}
        segmented={() => segs().length > 1}
      />,
    )
  }
  // No branch flips: the slots box is the ONE structure for the whole block
  // life (it renders nothing while every slot is hidden). Each slot's gutter
  // toggles line_number-only inside StreamSegment.
  const code = (
    <box flexDirection="column">
      {slotEls}
    </box>
  )
  return (
    <BlockTool title={props.title} part={props.part} spinner={props.spinner ?? props.streaming} onClick={props.onClick}>
      {/* above: label/content between the title and the streamed code
          (squash-output's "summary" line) - never shifts the code's margin. */}
      {props.above}
      <Show when={props.content.length > 0}>{code}</Show>
      {/* 0199: caller content after the code (bash's output + expand
          toggle) - renders in the same BlockTool so the carry-over
          structure keeps one box for the whole life of the block. */}
      {props.children}
    </BlockTool>
  )
}

function Write(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const status = createMemo(() => props.part.state.status)
  const path = createMemo(() => stringValue(props.input.filePath) ?? "")
  const diagnostics = createMemo(() => props.metadata.diagnostics)
  // The block's content for every state is the tool stream's display: the
  // live body while streaming, the landed input once running (== the
  // completed content - identical strings, so the 0199 carry-over never
  // re-paints the buffer at completion).
  const stream = useToolStream(props, {
    bodyKey: "content",
    pathKey: "filePath",
    title: (live) => `# Writing ${pathFormatter.format(live ?? path())}`,
  })
  const title = createMemo(() => `# Wrote ${pathFormatter.format(path())}`)
  // The target file's language for the streaming view: the LIVE path while
  // the args are still streaming (the landed input is empty until running),
  // the full arg path once the call lands. Before the path arrives (some
  // models emit the content argument first, so the path can be the last
  // thing to stream): sniff the language from the content's first lines,
  // falling back to markdown (correct for prose files; the flip to the
  // file's real language happens when the path lands and at completion).
  // The sniffed guess MUST resolve through the same coalescing as
  // filetype() (0157): the JS family renders with the typescript grammar
  // everywhere, or a content-first JS write streams "javascript" and snaps
  // to "typescript" when the path lands - the grammar axis of the
  // duplicate-grey-copy bug.
  // Latched live filetype: the FIRST CONFIDENT resolution (the path once
  // it lands and resolves, or a real content sniff) sticks for the
  // stream's duration - a mid-stream flip reverts the view to plain and
  // STAYS white (the 2026-08-17 write white-revert: the filePath arg
  // landing mid-stream flipped the live type to undefined, likely via the
  // streamedJsonValue tail-garbage path). The low-content markdown
  // default is NOT latched - a later confident signal still engages. The
  // completed view re-evaluates from the actual filename.
  let latched: string | undefined
  const liveFiletype = createMemo(() => {
    const p = stream.livePath() ?? path()
    const pathFt = p ? filetype(p) : undefined
    const sniffed = coalesceFiletype(sniffFiletype(stream.display()))
    const candidate = pathFt ?? sniffed
    if (candidate) latched = candidate
    if (latched) return latched
    return "markdown"
  })

  const running = () => stream.status() === "running"
  const completed = () => !stream.streaming() && !running()
  return (
    <Switch>
      <Match when={status() === "error"}>
        <InlineTool icon="←" pending="Preparing write..." complete={path()} part={props.part}>
          Write {pathFormatter.format(path())}
        </InlineTool>
      </Match>
      {/* 0199 carry-over: ONE LiveToolStream for streaming, running, AND
          completed - the code element persists, so at completion the buffer
          (the last landed highlight of the identical content) keeps
          painting; fg brightens textMuted -> theme.text and the grow-only
          clamp releases to the natural final height. No fresh completed
          element, no white first paint, no blank frame. */}
      <Match when={true}>
        <LiveToolStream
          part={props.part}
          title={stream.streaming() || running() ? stream.title() : title()}
          streaming={stream.streaming()}
          content={stream.display()}
          filetype={liveFiletype()}
          // Always guttered and never conceals (0156) - stable from the
          // first frame, no Show flip at completion.
          gutter={true}
          conceal={false}
          fg={stream.streaming() || running() ? theme.textMuted : theme.text}
          release={completed()}
        />
        <Show when={completed() && diagnostics() !== undefined}>
          <Diagnostics diagnostics={diagnostics()} filePath={path()} />
        </Show>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        ({numberValue(props.metadata.matches)} {numberValue(props.metadata.matches) === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    const sessionID = stringValue(props.metadata.sessionId)
    if (sessionID && !sync.data.message[sessionID]?.length) void sync.session.sync(sessionID)
  })

  const sessionID = createMemo(() => stringValue(props.metadata.sessionId))
  const messages = createMemo(() => sync.data.message[sessionID() ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    const value = status()
    return (
      props.part.state.status === "running" ||
      (props.metadata.background === true && value !== undefined && value.type !== "idle")
    )
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    let content = [
      formatSubagentTitle(
        Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
        description,
        props.metadata.background === true,
      ),
    ]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      content.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      separate={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true)
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  const showOutput = createMemo(() => output() && hasRuntimeError())
  const content = createMemo(() => {
    const lines = ["execute"]
    for (const call of calls()) {
      const args = input(call.input ?? {})
      lines.push(`↳ ${call.tool}${args ? ` ${args}` : ""}${call.status === "error" ? " (failed)" : ""}`)
    }
    return lines.join("\n")
  })

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.error : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
      >
        {content()}
      </InlineTool>
      <Show when={showOutput()}>
        <box paddingLeft={3} paddingRight={2}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.error}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

// The OLD<->NEW match ladder (step 2): find the identical context prefix by
// comparing the removed (OLD) lines to the added (NEW) lines at each index.
// The first divergent line is the diff ANCHOR; everything before it is
// unchanged context (shown in both columns, neutral). The ladder is MONOTONIC
// - the anchor only moves FORWARD as the stream confirms more matching lines
// - so the per-line color maps can rebuild per flush without the diff
// re-layouting: content, elements, and layout never change, only the line
// colors (the instability lesson: re-segmenting moved lines between
// elements whose async highlight buffers lag, making the OLD block
// intermittently vanish; color-only updates cannot). The context AFTER the
// change is not yet detected (the identical tail needs the suffix ladder -
// a later step); for now the removed/added bands run to the end of each
// block, exactly like the pre-step-2 view past the anchor.
function diffAnchor(oldLines: string[], newLines: string[]): number {
  const min = Math.min(oldLines.length, newLines.length)
  for (let i = 0; i < min; i++) {
    if (oldLines[i] !== newLines[i]) return i
  }
  return min
}

// The edit live view: TWO fixed columns keyed on OLD vs NEW (block type,
// NOT per-section - the 0159 jumpy-render decision, see BUG_EDIT_LIVE_DIFF).
// The whole stream's removed content (OLD + CUT blocks across every
// section) grows the left column, the added content (NEW + PASTE blocks)
// grows the right. The code elements are created ONCE; their content props
// read signals that only grow, so the streaming buffers append in place
// exactly like the write live view (the smoothest streaming view in the
// build). No per-section structure to remount, no flexGrow/flexBasis
// re-measure dance (fixed width="50%") - the per-section variant collapsed
// to a single line and bounced (video-captured). STEP 2 (the ladder): the
// line_number per-line color maps express the diff - the identical context
// prefix stays neutral, the removed lines get diffRemovedBg (left), the
// added lines diffAddedBg (right) - while the content itself never changes,
// so the diff flows into its end state instead of jumping.
function LiveEditDiff(props: {
  part: ToolPart
  title?: string
  streaming: boolean
  content: string
  filetype?: string
}) {
  const { theme, syntax } = useTheme()
  const [left, setLeft] = createSignal("")
  const [right, setRight] = createSignal("")
  // Re-parse per flush and push the freshly parsed column text into the
  // signals (monotonic growth). Signals are written in an effect so the
  // two code element descriptors stay STABLE - only the content props
  // re-evaluate, patching the buffers in place.
  createEffect(() => {
    const p = parseStreamingPatch(props.content)
    const l: string[] = []
    const r: string[] = []
    for (const sec of p.sections) {
      l.push(...sec.left)
      r.push(...sec.right)
    }
    setLeft(l.join("\n"))
    setRight(r.join("\n"))
  })
  const lang = () => props.filetype
  // 0277: GrowOnly/measuredGrowRows REMOVED - each column wraps at its own
  // real width (the 0276 root cause fix); the block grows/shrinks with the
  // content like upstream.
  const traceL = useToolTrace(left, "diffL")
  const traceR = useToolTrace(right, "diffR")
  // 0276b: fixed-height driver per column - the code element's own height
  // must be the buffer's wrapped count at its real width, not the native
  // width-1 measure (persistent +1 phantom on the diff columns at cw~66).
  const heightL = useFixedStreamHeight(left, traceL, { released: () => !props.streaming })
  const heightR = useFixedStreamHeight(right, traceR, { released: () => !props.streaming })
  const refL = (el: any) => {
    heightL.ref(el)
    traceL(el)
  }
  const refR = (el: any) => {
    heightR.ref(el)
    traceR(el)
  }
  // STEP 2 ladder: the line arrays + the diff anchor. The anchor is the
  // first index where OLD[i] !== NEW[i] (or the shorter length when one
  // column is a prefix of the other). Only moves forward as the stream
  // confirms matching lines - the color maps below are color-only updates.
  const leftLines = createMemo(() => (left().length === 0 ? [] : left().split("\n")))
  const rightLines = createMemo(() => (right().length === 0 ? [] : right().split("\n")))
  const anchor = createMemo(() => diffAnchor(leftLines(), rightLines()))
  // Per-line colors for the line_number wrappers: lines past the anchor are
  // the changed region (red removed on the left, green added on the right);
  // the confirmed context prefix gets NO band (neutral, both columns).
  const leftColors = createMemo(() => {
    const map = new Map<number, { gutter: typeof theme.diffRemoved; content: typeof theme.diffRemovedBg }>()
    const lines = leftLines()
    for (let i = anchor(); i < lines.length; i++) {
      map.set(i, { gutter: theme.diffRemoved, content: theme.diffRemovedBg })
    }
    return map
  })
  const rightColors = createMemo(() => {
    const map = new Map<number, { gutter: typeof theme.diffAdded; content: typeof theme.diffAddedBg }>()
    const lines = rightLines()
    for (let i = anchor(); i < lines.length; i++) {
      map.set(i, { gutter: theme.diffAdded, content: theme.diffAddedBg })
    }
    return map
  })
  return (
    <BlockTool title={props.title} part={props.part} spinner={props.streaming}>
      <Show when={props.content.length > 0}>
        <box flexDirection="row">
          <box width="50%" paddingRight={1}>
            {/* Block-relative line numbers (1..N per column; the step-2
                ladder tints the changed region via lineColors - context
                stays neutral, removed gets the diffRemoved band). The
                gutter width keeps the code's x-position aligned with the
                completed diff, which is always guttered - no sideways
                snap at completion. */}
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1} lineColors={leftColors()}>
              <code
                ref={refL}
                height={heightL.height()}
                {...(lang() ? { filetype: lang() } : {})}
                // width="100%" (0179): the streaming code element must wrap
                // at its FINAL column width from the first frame. Without it
                // the element's width is content-intrinsic (W6->W31->W80 as
                // content lands), so the content wraps at transiently narrow
                // widths during the settle and the natural height is
                // non-monotonic - the block flashed tall then dropped (the
                // left->right column-handoff shrink the user caught on
                // video) and the clamp latched the settle peaks as blank
                // lines at the bottom. The completed diff uses width="100%".
                width="100%"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={left()}
                conceal={false}
                fg={theme.textMuted}
              />
            </line_number>
          </box>
          <box width="50%">
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1} lineColors={rightColors()}>
              <code
                ref={refR}
                height={heightR.height()}
                {...(lang() ? { filetype: lang() } : {})}
                width="100%"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={right()}
                conceal={false}
                fg={theme.textMuted}
              />
            </line_number>
          </box>
        </box>
      </Show>
    </BlockTool>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const editPaths = createMemo(() => {
    const fromMetadata = props.metadata.paths
    if (Array.isArray(fromMetadata)) {
      // Dedupe: same-path multi-section patches report the path once per
      // section, which would inflate the "N files" title (e.g. an append +
      // delete on one file rendering as "Edit 2 files").
      const seen = new Set<string>()
      return fromMetadata.filter((p): p is string => {
        if (typeof p !== "string" || p.length === 0 || seen.has(p)) return false
        seen.add(p)
        return true
      })
    }
    const single = stringValue(props.input.filePath)
    if (single) return [single]
    const files = props.input.files
    if (Array.isArray(files)) {
      return files.map((f) => stringValue(f?.filePath)).filter((p): p is string => p !== undefined && p.length > 0)
    }
    const patch = stringValue(props.input.input)
    if (patch) {
      const paths: string[] = []
      for (const line of patch.split("\n")) {
        const match = /^\[([^#\r\n]+?)(?:#[0-9A-Za-z]{1,16})?\]$/.exec(line)
        if (match) paths.push(match[1])
      }
      return paths
    }
    return []
  })

  const title = createMemo(() => {
    // Failed calls carry no metadata - the input-derived count would count
    // grammar-example [path] rows as files. "Edit failed" is honest; the
    // error message (with the real path) renders as the body.
    if (props.part.state.status === "error") return "Edit failed"
    const paths = editPaths()
    if (paths.length === 0) return "Edit"
    if (paths.length === 1) return `Edit ${pathFormatter.format(paths[0])}`
    return `Edit ${paths.length} files`
  })

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const stream = useToolStream(props, {
    bodyKey: "input",
    // The edit tool has NO filePath argument - the target path lives inside
    // the patch text as a [path] section header (liveEditPath below), so
    // useToolStream's pathKey extraction (a "filePath" JSON key that never
    // exists) would never resolve. The streaming title is computed locally.
    title: () => undefined,
  })
  // Live target path: the FIRST [path] section header inside the streamed
  // patch. The write tool's # Writing <path> updates the instant the
  // filePath arg streams in; the edit tool's ← Patching does the same when
  // the [path] header line lands (0186). No end anchor - the streaming
  // header line is unterminated; the closing bracket IS the signal.
  const liveEditPath = createMemo(() => {
    const match = /^\[([^#\r\n]+?)(?:#[0-9A-Za-z]{1,16})?\]/m.exec(stream.display())
    return match ? match[1] : undefined
  })
  // The target file's language for the streaming columns from the same live
  // path; falls back to nothing (grey columns) until the header lands.
  const liveFiletype = createMemo(() => (liveEditPath() ? filetype(liveEditPath()!) : undefined))
  // Streaming title: "← Patching <path>" as soon as the [path] header
  // streams in, falling back to the landed input paths once the call lands
  // (the write tool's live ?? path() parity). "← Patching..." until then.
  const streamingTitle = createMemo(() => {
    const target = liveEditPath() ?? editPaths()[0]
    return target ? `← Patching ${pathFormatter.format(target)}` : "← Patching..."
  })
  const fileDiffs = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  function fileTitle(file: { type: string; relativePath: string; filePath: string; movePath?: string }) {
    const to = pathFormatter.format(file.relativePath)
    if (file.type === "delete") return "# Deleted " + to
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " > " + to
    return "← Patched " + to
  }

  return (
    <Switch>
      <Match when={fileDiffs().length > 0}>
        <For each={fileDiffs()}>
          {(file) => (
          <BlockTool title={fileTitle(file)} part={props.part} gap={file.changed ? 1 : 0}>
          <Show when={file.changed} fallback={file.type === "delete" ? <text fg={theme.diffRemoved}>-{file.deletions} line{file.deletions !== 1 ? "s" : ""}</text> : <text fg={theme.error}>no change - content already matches</text>}>
                <box paddingLeft={1}>
                  <diff
                    diff={file.patch}
                    view={view()}
                    filetype={filetype(file.filePath)}
                    syntaxStyle={syntax()}
                    showLineNumbers={true}
                    width="100%"
                    wrapMode={ctx.diffWrapMode()}
                    // drawUnstyledText={false} (0196): the completed diff
                    // must defer to its async highlight instead of
                    // raw-painting white for a frame at completion (the
                    // streaming->completed white flash). EXCEPT for
                    // filetypes with no grammar ("none" - extensionless
                    // shell scripts like vllm-start): the highlight never
                    // fires, so deferring renders a PERMANENT BLANK
                    // (conceal + no grammar => waiting forever). Render
                    // those unstyled (raw, visible).
                    drawUnstyledText={filetype(file.filePath) === "none"}
                    fg={theme.text}
                    addedBg={theme.diffAddedBg}
                    removedBg={theme.diffRemovedBg}
                    contextBg={theme.diffContextBg}
                    addedSignColor={theme.diffHighlightAdded}
                    removedSignColor={theme.diffHighlightRemoved}
                    lineNumberFg={theme.diffLineNumber}
                    lineNumberBg={theme.diffContextBg}
                    addedLineNumberBg={theme.diffAddedLineNumberBg}
                    removedLineNumberBg={theme.diffRemovedLineNumberBg}
                  />
                </box>
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool title={"← " + title()} part={props.part}>
          {/* All-plans noop: the server strips empty patches from
              metadata.files (edit.ts), so this block falls through with an
              EMPTY metadata.diff - without this line the "Patched" title
              would be the only feedback. Same red line as the per-file
              fallback above. */}
          <Show when={numberValue(props.metadata.noop) === 1}>
            <text fg={theme.error}>no change - content already matches</text>
          </Show>
          <Show when={numberValue(props.metadata.noop) !== 1}>
            <box paddingLeft={1}>
              <diff
                diff={stringValue(props.metadata.diff) ?? ""}
                view={view()}
                filetype={filetype(editPaths()[0] ?? "")}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode={ctx.diffWrapMode()}
                // drawUnstyledText={false} (0196): see the per-file diff.
                // "none" filetype (extensionless script) => no grammar =>
                // the deferred highlight never fires => permanent blank;
                // render unstyled.
                drawUnstyledText={filetype(editPaths()[0] ?? "") === "none"}
                fg={theme.text}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                contextBg={theme.diffContextBg}
                addedSignColor={theme.diffHighlightAdded}
                removedSignColor={theme.diffHighlightRemoved}
                lineNumberFg={theme.diffLineNumber}
                lineNumberBg={theme.diffContextBg}
                addedLineNumberBg={theme.diffAddedLineNumberBg}
                removedLineNumberBg={theme.diffRemovedLineNumberBg}
              />
            </box>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={editPaths()[0] ?? ""} />
          </Show>
        </BlockTool>
      </Match>
      {/* Live view: the streamed patch's OLD lines in a removed column,
          NEW lines in an added column (two fixed columns keyed on block
          type - see LiveEditDiff). Swaps to the parsed per-file diff once
          the edit completes and metadata lands. */}
      <Match when={stream.streaming() || stream.status() === "running"}>
        <LiveEditDiff
          part={props.part}
          title={streamingTitle()}
          streaming={stream.streaming()}
          content={stream.display()}
          filetype={liveFiletype()}
        />
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={title()} part={props.part}>
          {title()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
                <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="⚙"
          pending="Updating todos..."
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function SquashOutput(props: ToolProps) {
  const { theme } = useTheme()
  // Stream the model's summary argument like write/bash: the
  // tool-input-delta -> state.raw mechanism feeds the live body while
  // pending; the landed input takes over once the call lands.
  const stream = useToolStream(props, { bodyKey: "summary", title: () => undefined })
  const results = createMemo(() =>
    Array.isArray(props.metadata.results)
      ? props.metadata.results.flatMap((item) => {
          const r = recordValue(item)
          if (!r) return []
          const tool = stringValue(r.tool)
          const originalLen = numberValue(r.originalLen)
          if (!tool || originalLen === undefined) return []
          return [{ tool, originalLen }]
        })
      : [],
  )
  const count = createMemo(() => numberValue(props.metadata.count) ?? 0)
  const aggregateOriginal = createMemo(() => numberValue(props.metadata.aggregateOriginal))
  const maxTurnsBack = createMemo(() => numberValue(props.metadata.maxTurnsBack))
  const belowBoundary = props.metadata.belowBoundary === true
  // Live summary length: the streamed body while pending/running (updates
  // per delta), the final metadata value once the call lands.
  const summaryLen = createMemo(() =>
    stream.streaming() ? stream.display().length : (numberValue(props.metadata.summaryLen) ?? stream.display().length),
  )
  const active = () => stream.streaming() || stream.status() === "running"

  const liveTitle = createMemo(() => {
    const parts = ["Squashing output"]
    if (summaryLen() > 0) parts.push(`${summaryLen().toLocaleString()} chars`)
    return `# ${parts.join(" · ")}`
  })
  const title = createMemo(() => {
    if (active()) return liveTitle()
    const parts = [`Squashed ${count()} output${count() !== 1 ? "s" : ""}`]
    if (maxTurnsBack() !== undefined) parts.push(`${maxTurnsBack()} turn${maxTurnsBack() !== 1 ? "s" : ""} back`)
    if (aggregateOriginal() !== undefined) {
      const total = summaryLen() * count()
      const sizes =
        results().length > 1
          ? `${results().map((r) => r.originalLen.toLocaleString()).join("+")}=${aggregateOriginal()!.toLocaleString()} → ${summaryLen().toLocaleString()}×${count()}=${total.toLocaleString()}`
          : `${aggregateOriginal()!.toLocaleString()} → ${summaryLen().toLocaleString()}`
      parts.push(`${sizes} chars`)
    }
    return `# ${parts.join(" · ")}`
  })

  const completed = () => !stream.streaming()

  return (
    <Switch>
      <Match when={stream.streaming() || count() > 0}>
        {/* 0199 carry-over: ONE LiveToolStream for streaming, running, AND
            completed - the summary's code element persists, so nothing
            remounts at completion. The "summary" label sits ABOVE the text
            (via the `above` slot) instead of inline, so it never shifts
            the content's left margin. */}
        <LiveToolStream
          part={props.part}
          title={title()}
          streaming={stream.streaming()}
          content={stream.display()}
          // Prose, not code: stream in its final color (white) - no
          // textMuted -> text flip at completion. filetype="" is required:
          // the segs default is "bash" (below), and a truthy filetype routes
          // the text through the tree-sitter tokenizer, which colors the
          // summary despite the fg below. Empty string = the unstyled text
          // buffer (opentui code.tsx: _shouldRenderTextBuffer = drawUnstyledText
          // || !filetype), rendered in fg as intended.
          filetype=""
          fg={theme.text}
          release={completed()}
          gutter={false}
          above={<text fg={theme.textMuted}>summary</text>}
        >
          <Show when={completed() && belowBoundary}>
            <text fg={theme.warning}>below compaction boundary (applies if it re-enters the live chain)</text>
          </Show>
        </LiveToolStream>
      </Match>
      <Match when={true}>
        <InlineTool icon="♻" pending="Squashing output..." failure="Squash failed" complete={false} part={props.part}>
          Squashing output
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const count = createMemo(() => questions().length)
  // The tool call ALWAYS renders as a single line (0268): the answered
  // Q+A block is NOT inlined at the tool-call position - the turn ends at
  // the ask (completed footer above), and the answered question renders
  // SEPARATELY as the question_answers user message's "# Questions" body
  // (undoable boundary), not inside the tool call.
  return (
    <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
      Asked {count()} question{count() !== 1 ? "s" : ""}
    </InlineTool>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "execute",

  "squash-output",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const patch = stringValue(file.patch)
    const additions = numberValue(file.additions) ?? 0
    const deletions = numberValue(file.deletions) ?? 0
  const changed = file.changed === true
  if (!type || !relativePath || !filePath || patch === undefined) return []
  return [{ type, relativePath, filePath, patch, additions, deletions, changed, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
