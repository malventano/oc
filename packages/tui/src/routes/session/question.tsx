import { createStore } from "solid-js/store"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { selectedForeground, tint, useTheme } from "../../context/theme"
import { useLocal } from "../../context/local"
import { useSync } from "../../context/sync"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useOpencodeModeStack } from "../../keymap"
import { usePromptRef } from "../../context/prompt"

const QUESTION_MODE = "question"

export function QuestionPrompt(props: { request: QuestionRequest; directory?: string }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()
  const local = useLocal()
  const sync = useSync()
  const promptRef = usePromptRef()
  const agentColor = createMemo(() => {
    const agent = local.agent.current()
    return agent ? local.agent.color(agent.name) : theme.accent
  })

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const tabs = createMemo(() => (single() ? 1 : questions().length + 1)) // questions + confirm tab (no confirm for single select)
  const [tabHover, setTabHover] = createSignal<number | "confirm" | null>(null)
  // A re-asked question (undo back to the question turn) carries the tool
  // part's stored answers: pre-populate the panel so the user can adjust
  // their previous answers instead of re-entering them.
  const priorAnswers = (): QuestionAnswer[] | undefined => {
    const tool = props.request.tool
    if (!tool) return undefined
    const parts = sync.data.part[tool.messageID]
    const part = parts?.find((p) => p.type === "tool" && p.callID === tool.callID)
    if (part?.type !== "tool" || part.state.status !== "completed") return undefined
    const answers = (part.state.metadata as { answers?: QuestionAnswer[] } | undefined)?.answers
    return answers
  }
  const [store, setStore] = createStore({
    tab: 0,
    answers: priorAnswers() ?? [],
    custom: (() => {
      const prior = priorAnswers()
      if (!prior) return []
      return props.request.questions.map((q, i) => {
        const picked = prior[i] ?? []
        const labels = q.options.map((o) => o.label)
        return picked.find((a) => !labels.includes(a)) ?? ""
      })
    })(),
    // Per-tab: the custom row is the active selection (clicked or arrowed
    // to + confirmed) even before the text is committed - the check must
    // move to it immediately because the tab stays visible for the text
    // entry (unlike the other options, which auto-advance away).
    customActive: (() => {
      const prior = priorAnswers()
      if (!prior) return []
      return props.request.questions.map((q, i) => {
        const picked = prior[i] ?? []
        const labels = q.options.map((o) => o.label)
        return picked.some((a) => !labels.includes(a))
      })
    })(),
    selected: 0,
    editing: false,
  })

  let textarea: TextareaRenderable | undefined

  const question = createMemo(() => questions()[store.tab])
  const confirm = createMemo(() => !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  // The COMMITTED custom answer (the answers[] entry that is not one of the
  // question's option labels) - independent of the live textarea text, which
  // lives in store.custom. A committed answer survives clearing the field
  // (only commitEdit's empty-commit removal takes it out), so dropdown submit
  // and viaMouse uncheck key off THIS, not the live input.
  const committedCustom = createMemo(() => {
    const labels = new Set(options().map((o) => o.label))
    const picked = store.answers[store.tab] ?? []
    return picked.find((a) => !labels.has(a))
  })
  const customPicked = createMemo(() => (committedCustom() !== undefined))
  // The custom row is a checkbox that tracks the LIVE textarea content:
  // as soon as there is text in the field the box reads checked, and clearing
  // the field un-checks it (the textarea content-changed hook writes back
  // into store.custom). This is display-only parity with the other options'
  // check marks - the SUBMIT gate (allAnswered) still counts only COMMITTED
  // answers, so typing without Enter never marks the question answered.
  const customChecked = createMemo(() => (input().trim() !== ""))
  // Upstream semantics: only COMMITTED answers count (the custom row's check
  // without a committed text is a selection in progress, not an answer - the
  // user must press Enter in the textarea first). The memo re-evaluates
  // reactively on every state change, so the Confirm enables the moment the
  // last answer commits, from any tab.
  const allAnswered = createMemo(() => questions().every((_, i) => (store.answers[i]?.length ?? 0) > 0))

  async function submit() {
    // Capture before any await: the question.replied event removes the request
    // from the sync store mid-submit, and Solid props are reactive getters - a
    // later props.request read would see the removed (undefined) request.
    const request = props.request
    const directory = props.directory
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    const replied = await sdk.client.question.reply({
      requestID: request.id,
      directory,
      answers,
    })
    if (replied.error) return
    // The asking turn already ended when the question was asked (open-ended
    // question tool) - the reply records the answers as the tool result
    // server-side, and the answers re-enter as a user prompt in the CURRENT
    // agent (plan/build), starting the continuation turn.
    const agent = local.agent.current()
    const model = local.model.current()
    if (!agent || !model) return
    const text = questions()
      .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i]!.join(", ") : "(not answered)"}"`)
      .join(", ")
    await sdk.client.session.prompt({
      sessionID: request.sessionID,
      agent: agent.name,
      model,
      variant: local.model.variant.current(),
      parts: [{ type: "text", text, metadata: { kind: "question_answers" } }],
    })
  }

  function reject() {
    void sdk.client.question.reject({
      requestID: props.request.id,
      directory: props.directory,
    })
    // Lazy rejection: the escape closes the panel and restores the answers
    // text into the prompt input - the rejection solidifies (interrupted
    // write) only when the user commits it with Enter on that text. The
    // prompt remounts after the panel closes, so retry until it is there.
    const tool = props.request.tool
    if (!tool) return
    const msgs = sync.data.message[props.request.sessionID] ?? []
    const turnIndex = msgs.findIndex((m) => m.id === tool.messageID)
    const answers = turnIndex >= 0 ? msgs[turnIndex + 1] : undefined
    if (!answers) return
    const parts = sync.data.part[answers.id] ?? []
    const input = parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => (p as { text: string }).text)
      .join("\n")
    const restore = () => {
      if (promptRef.current) {
        promptRef.current.set({ input, parts: [] })
        return
      }
      setTimeout(restore, 50)
    }
    setTimeout(restore, 0)
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    setStore("customActive", store.tab, custom)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      void submit()
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
    // The custom entry toggled away: the active marker clears with it.
    if (index !== -1 && answer === store.custom[store.tab]) {
      setStore("customActive", store.tab, false)
    }
  }

  // Commit the custom-answer textarea. `advance` = move to the NEXT tab
  // after committing (the Tab binding); Enter commits but STAYS on the tab
  // so the user can still check other boxes on a multi question. Empty text
  // commits a REMOVAL of any previous custom value (the only way to un-answer
  // the custom row).
  function commitEdit(advance: boolean) {
    const text = textarea?.plainText?.trim() ?? ""
    const prev = committedCustom() // the COMMITTED answer (survives live edits to store.custom)

    if (!text) {
      if (prev) {
        const inputs = [...store.custom]
        inputs[store.tab] = ""
        setStore("custom", inputs)
        const answers = [...store.answers]
        answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== prev)
        setStore("answers", answers)
      }
      // An EMPTY commit un-checks the row unconditionally: the box's check
      // tracks LIVE text (content-changed write-back), so clearing the field
      // already un-checks while typing - the commit just finalizes + clears
      // the pending-active marker and any committed answer that was removed.
      setStore("customActive", store.tab, false)
      setStore("editing", false)
      if (advance) {
        setStore("tab", (store.tab + 1) % tabs())
        setStore("selected", 0)
      }
      return
    }

    if (multi()) {
      const inputs = [...store.custom]
      inputs[store.tab] = text
      setStore("custom", inputs)
      const existing = store.answers[store.tab] ?? []
      const next = [...existing]
      if (prev) {
        // A revision replaces the committed answer (the live store.custom now
        // holds the EDITED text, so prev must come from committedCustom()).
        const index = next.indexOf(prev)
        if (index !== -1) next.splice(index, 1)
      }
      if (!next.includes(text)) next.push(text)
      const answers = [...store.answers]
      answers[store.tab] = next
      setStore("answers", answers)
      setStore("editing", false)
      if (advance) {
        setStore("tab", (store.tab + 1) % tabs())
        setStore("selected", 0)
      }
      return
    }

    // Single-select: picking a custom value moves to the next tab itself
    // (and submits when the question is a lone single-select).
    pick(text, true)
    setStore("editing", false)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
    setStore("editing", false)
  }

  // `viaMouse`: a real user click on the custom row. The custom row is a
  // checkbox like the other options - clicking a COMMITTED row unchecks it
  // (removes the answer + clears the text + closes the editor), clicking an
  // uncommitted row opens the textarea. Keyboard Enter/Space/numbers are NOT
  // a click: they reopen the editor for revision and must never toggle the
  // committed answer off (the multi-question answer-loss regression - a
  // second Enter after the text was accepted silenced-wiped the answer).
  function selectOption(viaMouse = false) {
    if (other()) {
      if (!multi()) {
        // The custom row becomes the selection immediately: unlike the other
        // options (which auto-advance away), the tab stays visible for the
        // text entry, so the check must move here at the click/Enter - clear
        // the picked option and mark the custom as active.
        const answers = [...store.answers]
        answers[store.tab] = []
        setStore("answers", answers)
        setStore("customActive", store.tab, true)
        setStore("editing", true)
        return
      }
      const value = input()
      // A mouse click on a COMMITTED custom row = uncheck it (remove the
      // answer, clear the pending text, close the editor) - the same toggle
      // gesture as the other checkboxes. Keys off the committed answer (not
      // the live textarea text, which store.custom now tracks).
      if (viaMouse && customPicked()) {
        const committed = committedCustom()
        const answers = [...store.answers]
        answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== committed)
        setStore("answers", answers)
        const inputs = [...store.custom]
        inputs[store.tab] = ""
        setStore("custom", inputs)
        setStore("customActive", store.tab, false)
        setStore("editing", false)
        return
      }
      setStore("customActive", store.tab, true)
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  useBindings(() => {
    const total = options().length + (custom() ? 1 : 0)
    return {
    mode: QUESTION_MODE,
    enabled: store.editing && !confirm(),
    commands: [
      {
        name: "prompt.clear",
        title: "Clear answer edit",
        category: "Question",
        run() {
          const text = textarea?.plainText ?? ""
          if (!text) {
            setStore("editing", false)
            return
          }
          textarea?.setText("")
        },
      },
    ],
    bindings: [
      {
        key: "escape",
        desc: "Cancel answer edit",
        group: "Question",
        cmd: () => {
          setStore("editing", false)
        },
      },
      ...tuiConfig.keybinds.get("prompt.clear"),
      // The question box is the special input surface for the answers user
      // prompt: the undo/redo hotkeys must keep working through it (the base
      // mode bindings are inactive while the question mode is on top).
      ...tuiConfig.keybinds.gather("session", ["session.undo", "session.redo"]),
      {
        key: "return",
        desc: "Submit answer edit",
        group: "Question",
        cmd: () => commitEdit(false),
      },
      {
        key: "tab",
        desc: "Submit answer and go to next tab",
        group: "Question",
        cmd: () => commitEdit(true),
      },
      // Up/Down while editing: ALWAYS exit the editor and navigate the
      // options (regardless of whether text is entered) - checkbox nav must
      // not trap while the custom field is focused. The pending text is
      // COMMITTED first (commitEdit, advance=false) so arrow-away keeps the
      // typed answer - otherwise Confirm would show nothing entered.
      {
        key: "up",
        desc: "Prior option",
        group: "Question",
        cmd: () => {
          commitEdit(false)
          moveTo((store.selected - 1 + total) % total)
        },
      },
      {
        key: "down",
        desc: "Next option",
        group: "Question",
        cmd: () => {
          commitEdit(false)
          moveTo((store.selected + 1 + total) % total)
        },
      },
    ],
    }
  })

  useBindings(() => {
    const opts = options()
    const total = opts.length + (custom() ? 1 : 0)
    const max = Math.min(total, 9)

    return {
      mode: QUESTION_MODE,
      enabled: !store.editing || confirm(),
      commands: [
        {
          name: "app.exit",
          title: "Reject question",
          category: "Question",
          run() {
            reject()
          },
        },
      ],
      bindings: [
        {
          key: "left",
          desc: "Previous question",
          group: "Question",
          cmd: () => {
            return selectTab((store.tab - 1 + tabs()) % tabs())
          },
        },
        {
          key: "h",
          desc: "Previous question",
          group: "Question",
          cmd: () => {
            return selectTab((store.tab - 1 + tabs()) % tabs())
          },
        },
        {
          key: "right",
          desc: "Next question",
          group: "Question",
          cmd: () => {
            return selectTab((store.tab + 1) % tabs())
          },
        },
        {
          key: "l",
          desc: "Next question",
          group: "Question",
          cmd: () => {
            return selectTab((store.tab + 1) % tabs())
          },
        },
        ...(single() || (confirm() && allAnswered())
          ? [
              {
                key: "tab",
                desc: "Next agent",
                group: "Question",
                cmd: () => {
                  return local.agent.move(1)
                },
              },
              {
                // At the Confirm, shift+tab steps back to the last question
                // tab instead of scrolling the agents backwards (the mode
                // scroll is forward-only via tab).
                key: "shift+tab",
                desc: "Previous question",
                group: "Question",
                cmd: () => {
                  return selectTab((store.tab - 1 + tabs()) % tabs())
                },
              },
            ]
          : [
              {
                key: "tab",
                desc: "Next question",
                group: "Question",
                cmd: ({ event }: { event: { shift: boolean } }) => {
                  return selectTab((store.tab + (event.shift ? -1 : 1) + tabs()) % tabs())
                },
              },
              // At the Confirm (not all answered - this branch), shift+tab must
              // still step back to the last question: the confirm-with-nothing
              // path is NOT the allAnswered branch above, so without this the
              // user is stuck at Confirm when they realize a box was missed.
              {
                key: "shift+tab",
                desc: "Previous question",
                group: "Question",
                cmd: () => {
                  return selectTab((store.tab - 1 + tabs()) % tabs())
                },
              },
            ]),
        ...(confirm()
          ? [
              {
                key: "return",
                desc: "Submit answer",
                group: "Question",
                cmd: () => {
                  return submit()
                },
              },
              {
                key: "escape",
                desc: "Reject question",
                group: "Question",
                cmd: () => {
                  return reject()
                },
              },
              ...tuiConfig.keybinds.get("app.exit"),
            ]
          : [
              ...Array.from({ length: max }, (_, index) => ({
                key: String(index + 1),
                desc: `Select answer ${index + 1}`,
                group: "Question",
                cmd: () => {
                  moveTo(index)
                  selectOption()
                },
              })),
              {
                key: "up",
                desc: "Previous answer",
                group: "Question",
                cmd: () => {
                  return moveTo((store.selected - 1 + total) % total)
                },
              },
              {
                key: "k",
                desc: "Previous answer",
                group: "Question",
                cmd: () => {
                  return moveTo((store.selected - 1 + total) % total)
                },
              },
              {
                key: "down",
                desc: "Next answer",
                group: "Question",
                cmd: () => {
                  return moveTo((store.selected + 1) % total)
                },
              },
              {
                key: "j",
                desc: "Next answer",
                group: "Question",
                cmd: () => {
                  return moveTo((store.selected + 1) % total)
                },
              },
              {
                key: "return",
                desc: "Select answer",
                group: "Question",
                cmd: () => {
                  return selectOption()
                },
              },
              {
                key: "space",
                desc: "Select answer",
                group: "Question",
                cmd: () => {
                  return selectOption()
                },
              },
              {
                key: "escape",
                desc: "Reject question",
                group: "Question",
                cmd: () => {
                  return reject()
                },
              },
              ...tuiConfig.keybinds.get("app.exit"),
              // Undo/redo through the question box (see the editing group).
              ...tuiConfig.keybinds.gather("session", ["session.undo", "session.redo"]),
            ]),
      ],
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={agentColor()}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <Show when={local.agent.current()}>
          {(a) => (
            <box flexDirection="row" gap={1} paddingLeft={1}>
              <text fg={agentColor()}>{a().name}</text>
              <text fg={theme.textMuted}>·</text>
              <text fg={theme.text}>{local.model.parsed().model}</text>
            </box>
          )}
        </Show>
        <Show when={!single()}>
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => {
                  return (store.answers[index()]?.length ?? 0) > 0
                }
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      isActive()
                        ? agentColor()
                        : tabHover() === index()
                          ? theme.backgroundElement
                          : theme.backgroundPanel
                    }
                    onMouseOver={() => {
                      setTabHover(index())
                    }}
                    onMouseOut={() => {
                      setTabHover(null)
                    }}
                    onMouseUp={() => {
                      if (renderer.getSelection()?.getSelectedText()) return
                      selectTab(index())
                    }}
                  >
                    <text
                      fg={
                        isActive()
                          ? selectedForeground(theme, agentColor())
                          : isAnswered()
                            ? theme.text
                            : theme.textMuted
                      }
                    >
                      {q.header}
                    </text>
                  </box>
                )
              }}
            </For>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                confirm() ? agentColor() : tabHover() === "confirm" ? theme.backgroundElement : theme.backgroundPanel
              }
              onMouseOver={() => {
                setTabHover("confirm")
              }}
              onMouseOut={() => {
                setTabHover(null)
              }}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                selectTab(questions().length)
              }}
            >
              <text fg={confirm() ? selectedForeground(theme, agentColor()) : theme.textMuted}>Confirm</text>
            </box>
          </box>
        </Show>

        <Show when={!confirm()}>
          <box paddingLeft={1} gap={1}>
            <box>
              <text fg={theme.text}>
                {question()?.question}
                {multi() ? " (select all that apply)" : ""}
              </text>
            </box>
            <box>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                  return (
                    <box
                      onMouseOver={() => {
                        moveTo(i())
                      }}
                      onMouseDown={() => {
                        moveTo(i())
                      }}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        selectOption()
                      }}
                    >
                      <box flexDirection="row">
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {`${i() + 1}.`}
                          </text>
                        </box>
                        <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                          <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                            {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                          </text>
                        </box>
                        <Show when={!multi()}>
                          <text fg={theme.success}>{picked() ? " ✓" : ""}</text>
                        </Show>
                      </box>

                      <box paddingLeft={3}>
                        <text fg={theme.textMuted}>{opt.description}</text>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={custom()}>
                <box
                  onMouseOver={() => {
                    moveTo(options().length)
                  }}
                  onMouseDown={() => {
                    moveTo(options().length)
                  }}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    selectOption(true)
                  }}
                >
                  <box flexDirection="row">
                    <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                      <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                        {`${options().length + 1}.`}
                      </text>
                    </box>
                    <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                      <text fg={other() ? theme.secondary : customChecked() ? theme.success : theme.text}>
                        {multi() ? `[${customChecked() ? "✓" : " "}] Type your own answer` : "Type your own answer"}
                      </text>
                    </box>

                    <Show when={!multi()}>
                      <text fg={theme.success}>{customChecked() ? " ✓" : ""}</text>
                    </Show>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={3}>
                      <textarea
                        ref={(val: TextareaRenderable) => {
                          textarea = val
                          val.traits = { status: "ANSWER" }
                          // Live write-back: the custom row's check tracks the
                          // textarea content (type -> checked, clear -> uncheck-
                          // ed) - content-changed fires per character edit.
                          const onEdit = (_ev: unknown) => {
                            const inputs = [...store.custom]
                            inputs[store.tab] = val.plainText
                            setStore("custom", inputs)
                            setStore("customActive", store.tab, true)
                          }
                          val.editBuffer.on("content-changed", onEdit)
                          queueMicrotask(() => {
                            val.focus()
                            val.gotoLineEnd()
                          })
                        }}
                        initialValue={input()}
                        placeholder="Type your own answer"
                        placeholderColor={theme.textMuted}
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.primary}
                        cursorStyle={tuiConfig.cursor}
                      />
                    </box>
                  </Show>
                  <Show when={!store.editing && input()}>
                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={confirm() && !single()}>
          <box paddingLeft={1}>
            <text fg={theme.text}>Review</text>
          </box>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              const answered = () => Boolean(value())
              return (
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}:</span>{" "}
                    <span style={{ fg: answered() ? theme.text : theme.error }}>
                      {answered() ? value() : "(not answered)"}
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={single() || (confirm() && allAnswered())}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>tab agents</span>
            </text>
          </Show>
          <Show when={!single() && !(confirm() && allAnswered())}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>tab</span>
            </text>
          </Show>
          <Show when={!confirm()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <text fg={theme.text}>
            enter{" "}
            <span style={{ fg: theme.textMuted }}>
              {confirm() ? "submit" : multi() ? "toggle" : single() ? "submit" : "confirm"}
            </span>
          </text>

          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  )
}
