import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { bindContextUsageKV, contextUsage } from "../../util/context-usage"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => {
    const rootID = session()?.id
    if (!rootID) return 0
    let total = 0
    let stack = [rootID]
    while (stack.length > 0) {
      const id = stack.pop()!
      const s = props.api.state.session.get(id)
      if (s != null) total += s.cost ?? 0
      const children = props.api.state.session.all().filter((x) => x.parentID === id)
      stack.push(...children.map((c) => c.id))
    }
    return total
  })

  const state = createMemo(() => {
    return contextUsage({
      messages: msg(),
      parts: props.api.state.part,
      session: session(),
      provider: props.api.state.provider,
      directory: props.api.state.path.directory,
      busy: (props.api.state.session.status(props.session_id)?.type ?? "idle") !== "idle",
    })
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {state()?.forecast ? "~" : ""}
        {(state()?.tokens ?? 0).toLocaleString()} tokens
      </text>
      <text fg={theme().textMuted}>
        {state()?.forecast ? "~" : ""}
        {state()?.percent ?? 0}% used
      </text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  bindContextUsageKV(api.kv)
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
