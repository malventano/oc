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
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { SPINNER_FRAMES, Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, addDefaultParsers, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import type {
  AssistantMessage,
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
import { useSDK, setStreamBatchWindow, STREAM_BATCH_MIN_MS, setStreamLoadHintMs, STREAM_BATCH_MAX_MS } from "../../context/sdk"
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
import { filetype } from "../../util/filetype"
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
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
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
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
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
              prompt.set(promptInfoFromParts(parts))
              return
            }
            setTimeout(restore, 50)
          }
          setTimeout(restore, 0)
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
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          const clear = () => {
            if (prompt) {
              prompt.set({ input: "", parts: [] })
              return
            }
            setTimeout(clear, 50)
          }
          setTimeout(clear, 0)
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
        const restore = () => {
          if (prompt) {
            prompt.set(promptInfoFromParts(sync.data.part[message.id] ?? []))
            return
          }
          setTimeout(restore, 50)
        }
        setTimeout(restore, 0)
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
                <For each={messages()}>
                  {(message, index) => (
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
                  )}
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
  const sessionMessages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  // The header marks the QUESTION turn's completion (it sits below the tool
  // line), so it is tied to the previous turn's agent/model - NOT the
  // submit-time agent the answers message carries.
  const questionTurn = createMemo(() => {
    if (!questionAnswers()) return undefined
    const msgs = sessionMessages()
    const idx = msgs.findIndex((m) => m.id === props.message.id)
    // Walk back to the assistant turn that asked the question (the most
    // recent assistant message with a question tool call) - NOT the
    // immediate predecessor, which may be unrelated when the answers
    // message follows other turns (e.g. after a revert/re-ask).
    for (let i = idx - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.role !== "assistant") continue
      const parts = sync.data.part[msg.id]
      if (parts?.some((p) => p.type === "tool" && p.tool === "question")) return msg
    }
    return undefined
  })
  const headerAgent = createMemo(() => questionTurn()?.agent ?? props.message.agent)
  const headerColor = createMemo(() => local.agent.color(headerAgent()))
  const modelName = createMemo(() => {
    const turn = questionTurn()
    if (turn) return Model.name(ctx.providers(), turn.providerID, turn.modelID)
    const model = props.message.model
    if (!model) return ""
    return Model.name(ctx.providers(), model.providerID, model.modelID)
  })
  const pendingDuration = createMemo(() => {
    const turn = questionTurn()
    if (!turn?.time) return 0
    return props.message.time.created - turn.time.created
  })

  return (
    <>
      <Show when={text()}>
        <Show when={questionAnswers()}>
          <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
            <text marginTop={1}>
              <span style={{ fg: headerColor() }}>▣{" "}</span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(headerAgent())}</span>
              <Show when={modelName()}>
                <span style={{ fg: theme.textMuted }}> · {modelName()}</span>
              </Show>
              <Show when={pendingDuration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(pendingDuration())}</span>
              </Show>
            </text>
          </box>
        </Show>
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
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
          <text fg={theme.textMuted}>{note()}</text>
        </box>
      </box>
    </Show>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
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
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
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

  return (
    <Show when={content() || opaque()}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
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
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
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
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
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
          <Shell {...toolprops} />
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

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
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
  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
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
            <Spinner color={theme.textMuted}>{title().replace(/^# /, "")}</Spinner>
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
  const { theme, syntax } = useTheme()
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

  // The gutter only makes sense for multi-line commands - a lone "1"
  // against a one-liner reads as noise. Single-line commands instead get
  // the spinner inline next to the colored command; multi-line commands
  // get it in the block title (it can't span the gutter).
  const gutter = createMemo(() => command().includes("\n"))
  const title = createMemo(() => {
    if (isRunning() && gutter()) {
      const wd = workdirDisplay()
      return wd ? `# Running in ${wd}` : "# Running"
    }
    const wd = workdirDisplay()
    if (!wd) return
    return `# Running in ${wd}`
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
  const commandBlock = () => {
    // line_number only accepts a code element as its target (lineInfo/
    // lineCount/virtualLineCount/scrollY) - a wrapper box is silently
    // dropped (the 0138-revealed bug: heredoc commands lost the command
    // in the completed block). Gutter EACH segment instead; the numbers
    // restart per segment.
    const code = commandSegments() ? (
      <box flexDirection="column">
        {commandSegments()!.map((seg, i) => {
          const el = (
            <code
              // key-less: opentui CodeProps has no key field; segments re-render in place
              filetype={seg.lang}
              // drawUnstyledText={false}: the completed element's FIRST
              // paint would be the raw text (the 1-frame WHITE flash at
              // the running->completed transition - video captured). With
              // it false the buffer defers to the async highlight, so the
              // command stays colored through the transition.
              drawUnstyledText={false}
              syntaxStyle={syntax()}
              content={seg.text}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          )
          return gutter() ? (
            <line_number key={i} fg={theme.textMuted} minWidth={3} paddingRight={1}>
              {el}
            </line_number>
          ) : (
            el
          )
        })}
      </box>
    ) : (
      <code
        filetype="bash"
        // drawUnstyledText={false}: no raw white first frame at the
        // running->completed transition (see the segment branch).
        drawUnstyledText={false}
        syntaxStyle={syntax()}
        content={command()}
        conceal={ctx.conceal()}
        fg={theme.text}
      />
    )
    return code
  }

  return (
    <Switch>
      {/* Live view: the command streams in as it is typed (bash grammar
          colors keywords, strings, variables as they land). */}
      <Match when={stream.streaming()}>
        <LiveToolStream
          part={props.part}
          title={stream.title()}
          streaming={true}
          // The streaming display keeps the model's trailing newline (the
          // raw tool-call content ends with "\n"); the landed command
          // input strips it. The trailing "\n" flips the gutter on
          // mid-stream, the gutter column narrows the code, and a
          // boundary-length command wraps/unwraps between the streaming
          // and completed states - the 1-line vertical judder (video
          // captured: a '1' appears in front of the streaming line).
          // Trim the display's trailing newlines (display-only) so the
          // streaming view matches the completed view's width/rows.
          content={stream.display().replace(/\n+$/, "")}
          filetype={liveFiletype()}
          gutter={stream.display().replace(/\n+$/, "").includes("\n")}
          // segments={undefined} (0143): the segmented branch's per-segment
          // code elements are RECREATED per delta (the component body
          // re-runs when it reads reactive props - the createMemo slots
          // traced this live: 122 new elements per heredoc) and each mount
          // paints a w=1 transient before the layout settles - the
          // '1 p'/'1 d' flicker (BUG_STREAMING_FLICKER.md, video-confirmed
          // 0146: 1-char collapses recur per delta + the gutter-width
          // jitter between 1- and 2-digit segments). Stream as a single
          // bash element (stable, colored); the completed view below
          // switches to the segmented render.
          segments={undefined}
        />
      </Match>
      {/* The running state must keep the BlockTool: a FAST command's
          output stays undefined until completion, and without this the
          TRUE-match InlineTool shows for a frame (the '$' + the block
          vanishing - the vertical judder's second half). */}
      <Match when={stringValue(props.metadata.output) !== undefined || isRunning()}>
        {/* Running: multi-line commands get the spinner in the block title
            (it can't span the gutter); single-line commands get it inline
            next to the colored command - the command stays colored either
            way while it executes. */}
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning() && gutter()}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <Show when={isRunning() && !gutter()} fallback={commandBlock()}>
              <box flexDirection="row" gap={1}>
                <spinner frames={SPINNER_FRAMES} interval={80} color={theme.textMuted} />
                <code
                  flexGrow={1}
                  flexShrink={1}
                  filetype="bash"
                  // drawUnstyledText={false}: the spinner-row element mounts
                  // fresh at the streaming->running transition - its first
                  // paint would be the raw WHITE text (video captured at
                  // the spinner's start frame).
                  drawUnstyledText={false}
                  syntaxStyle={syntax()}
                  content={command()}
                  conceal={ctx.conceal()}
                  fg={theme.text}
                />
              </box>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={command()} part={props.part}>
          {command()}
        </InlineTool>
      </Match>
    </Switch>
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
  if (/^export (?:function|const|class|interface|type|default)\b|^interface \w+\s*\{/m.test(head)) return "typescript"
  if (/^import .* from ['"]/m.test(head) && /:\s*(?:string|number|boolean|Record|Array|Promise|Map)</m.test(head)) return "typescript"
  if (/^(?:export )?(?:function|const|let|var)\b.*=>/m.test(head)) return "typescript"
  if (/^const \w+:\s*[\w<>, |\[\]]+\s*=\s*/m.test(head)) return "typescript"
  if (/^module\.exports|require\(['"]/m.test(head)) return "javascript"
  if (/^package main\b|^func \w+\(/m.test(head)) return "go"
  if (/^fn (?:main|\w+)\(|^use std::|^impl\b/m.test(head)) return "rust"
  if (/^def \w+\(|^class \w+:|^from \w+ import|^import \w+(?: as \w+)?$/m.test(head)) return "python"
  if (/^public (?:static )?(?:class|void|final)\b|^class \w+ \{$/m.test(head)) return "java"
  if (/^fun main|^fun \w+\(/m.test(head)) return "kotlin"
  if (/^#include <(?:iostream|vector|string|map|algorithm)>/m.test(head)) return "cpp"
  if (/^#include <(?:stdio|stdlib)\.h>/m.test(head)) return "c"
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
function heredocSegments(text: string): { text: string; lang: string }[] | undefined {
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

  const segs: { text: string; lang: string }[] = []
  let cursor = 0
  // The language resolution is ONE chain for every opener kind: the
  // delimiter/interpreter name wins (HEREDOC_LANG for heredoc delimiters,
  // EVAL_LANG for interpreters), then the write-tool sniffer on the body,
  // then bash. Heredoc delimiters are conventionally uppercase (PY, JS)
  // so the map key is case-insensitive; interpreter names are lowercase.
  const segLang = (op: { delim: string; quote?: string }, body: string) =>
    HEREDOC_LANG[op.delim.toUpperCase()] ?? EVAL_LANG[op.delim] ?? sniffFiletype(body, 0) ?? "bash"
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
        segs.push({ text: text.slice(cursor, op.end), lang: "bash" })
        const body = text.slice(op.end, close === -1 ? text.length : close).replace(/^\n+/, "")
        if (body.length > 0) {
          segs.push({ text: body.endsWith("\n") ? body.slice(0, -1) : body, lang: segLang(op, body) })
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
      segs.push({ text: body.endsWith("\n") ? body.slice(0, -1) : body, lang: segLang(op, body) })
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

function LiveToolStream(props: {
  part: ToolPart
  title?: string
  streaming: boolean
  content: string
  filetype?: string
  gutter?: boolean
  segments?: { text: string; lang: string }[]
}) {
  const { theme, syntax } = useTheme()
  const ctx = use()
  // The gutter must FOLLOW the streamed content: the Shell's gutter prop
  // is a frozen first-render value (the first delta rarely carries a
  // newline), so the numbers would never appear for heredoc streams.
  // Compute the decision here from the reactive content - the ternary
  // flips once when the first newline lands (heredoc bodies get their
  // numbers mid-stream; single-line commands never flip - no '1' noise,
  // no width change, no judder).
  const showGutter = createMemo(() => props.gutter !== false && props.content.includes("\n"))
  // The single streaming code element - the SAME object in both gutter
  // branches (see below), so the line_number mount never recreates it.
  const singleEl = (
    <code
      {...(props.filetype ? { filetype: props.filetype } : {})}
      // drawUnstyledText={false} + streaming: colored-as-it-streams
      // (the buffer keeps the last landed highlight, one flush
      // behind) - same as the segment branch and the reasoning part.
      // The empty first frame is fixed in opentui (0142), not by
      // flipping this flag.
      drawUnstyledText={false}
      streaming={true}
      syntaxStyle={syntax()}
      content={props.content}
      conceal={ctx.conceal()}
      fg={theme.textMuted}
    />
  )
  // line_number only accepts a code element target - a wrapper box is
  // silently dropped, so segments are guttered individually (numbers
  // restart per segment).
  const code = props.segments ? (
    <box flexDirection="column">
      {props.segments.map((seg, i) => {
        const el = (
          <code
            // key-less: opentui CodeProps has no key field; segments re-render in place
            filetype={seg.lang}
            // drawUnstyledText={false} + streaming: the content setter
            // defers to the async highlight, so the buffer keeps the LAST
            // LANDED HIGHLIGHT (colored, one flush behind) - the same
            // colored-as-it-streams behavior as the reasoning part. The
            // flicker is NOT here: it was the EMPTY first frame on new
            // segment mounts, fixed in opentui's
            // ensureVisibleTextBeforeHighlight (0142) - initial streaming
            // content now renders its raw text immediately instead of
            // waiting for the first highlight.
            drawUnstyledText={false}
            streaming={true}
            syntaxStyle={syntax()}
            content={seg.text}
            conceal={ctx.conceal()}
            fg={theme.textMuted}
          />
        )
        return props.gutter === false ? (
          el
        ) : (
          <line_number key={i} fg={theme.textMuted} minWidth={3} paddingRight={1}>
            {el}
          </line_number>
        )
      })}
    </box>
  ) : (
    // The line_number appears as soon as the streamed content exceeds
    // one line (Show = a reactive memo, so it flips mid-stream - the
    // body's ternary is frozen at the first render). The code element
    // is the SAME object in both branches - the gutter mount does not
    // recreate it, the buffer and colors persist. Single-line commands
    // never flip (no '1' noise, no width change, no judder). Numbers
    // run continuously 1..N over the whole command; the completed view
    // below re-splits into per-segment gutters.
    <Show when={showGutter()} fallback={singleEl}>
      <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
        {singleEl}
      </line_number>
    </Show>
  )
  return (
    <BlockTool title={props.title} part={props.part} spinner={props.streaming}>
      <Show when={props.content.length > 0}>{code}</Show>
    </BlockTool>
  )
}

function Write(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const status = createMemo(() => props.part.state.status)
  const path = createMemo(() => stringValue(props.input.filePath) ?? "")
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })
  const diagnostics = createMemo(() => props.metadata.diagnostics)
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
  const liveFiletype = createMemo(() => {
    const p = stream.livePath() ?? path()
    if (p) return filetype(p)
    return sniffFiletype(stream.display()) ?? "markdown"
  })

  return (
    <Switch>
      <Match when={status() === "error"}>
        <InlineTool icon="←" pending="Preparing write..." complete={path()} part={props.part}>
          Write {pathFormatter.format(path())}
        </InlineTool>
      </Match>
      {/* Live view: the input is still streaming (state.raw) or just landed
          (running) - the content block grows in place as deltas arrive.
          Colored with the target file's own language (plain until the
          filePath arg streams in) so the streaming and completed views
          share one grammar - no color snap at completion. */}
      <Match when={stream.streaming() || stream.status() === "running"}>
        <LiveToolStream
          part={props.part}
          title={stream.title()}
          streaming={stream.streaming()}
          content={stream.display()}
          filetype={liveFiletype()}
        />
      </Match>
      {/* Completed: same gutter layout as the live view, so a batched
          provider (whole content in one delta) has no visible layout flip
          at completion; diagnostics when present. */}
      <Match when={true}>
        <BlockTool title={title()} part={props.part}>
          <Show when={code().length > 0}>
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(path())}
                // drawUnstyledText={false}: same as the bash command block -
                // the completed element's first paint would be the raw
                // WHITE text at the streaming->completed transition.
                drawUnstyledText={false}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
          </Show>
          <Show when={diagnostics() !== undefined}>
            <Diagnostics diagnostics={diagnostics()} filePath={path()} />
          </Show>
        </BlockTool>
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
        <box paddingLeft={3}>
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
    pathKey: "filePath",
    title: (live) => (live ? `← Editing ${pathFormatter.format(live)}` : "← Editing..."),
  })
  // The fence content lines are the target file's code, so color them with
  // the FIRST section's language (the section the model is currently
  // typing) once its [PATH] header streams in; plain text before that.
  const liveFiletype = createMemo(() => {
    const match = /^\[([^#\r\n]+?)(?:#[0-9A-Za-z]{1,16})?\]/m.exec(stream.display())
    return match ? filetype(match[1]) : undefined
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
      {/* Live view: the patch text streams in place while the model
          generates it (content lines colored as the first section's
          language - same combo as the write live view). Swaps to the
          parsed per-file diff once the edit completes and metadata lands. */}
      <Match when={stream.streaming() || stream.status() === "running"}>
        <LiveToolStream
          part={props.part}
          title={stream.title()}
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
  const summaryLen = createMemo(() => numberValue(props.metadata.summaryLen) ?? 0)
  const maxTurnsBack = createMemo(() => numberValue(props.metadata.maxTurnsBack))
  const belowBoundary = props.metadata.belowBoundary === true

  const title = createMemo(() => {
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


  return (
    <Switch>
      <Match when={count() > 0}>
        <BlockTool title={title()} part={props.part}>
          <box flexDirection="column" gap={1}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>summary:</text>
              <text fg={theme.text}>{stringValue(props.input.summary) ?? props.output ?? ""}</text>
            </box>

            <Show when={belowBoundary}>
              <text fg={theme.warning}>below compaction boundary (applies if it re-enters the live chain)</text>
            </Show>
          </box>
        </BlockTool>
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
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
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
