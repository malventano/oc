import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )
    // 0384: coalesce navigation bursts (BUG_SUBAGENT_VIEW_BOTTOM_BLANK.md).
    // Rapid view swaps (<300ms apart) pile outgoing trees onto the deferred
    // destroy queue while incoming trees allocate - the concurrent TextBuffer
    // spike crosses the native pool cap (~15.5-16K) and the allocation-failure
    // cascade kills the session view. Latest-wins coalescing keeps the spike
    // at one swap's worth; single navigations are unaffected.
    let lastNavigateAt = 0
    let pendingRoute: Route | undefined
    let pendingTimer: ReturnType<typeof setTimeout> | undefined
    const applyRoute = (route: Route) => {
      lastNavigateAt = Date.now()
      setStore(reconcile(route))
    }

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        const elapsed = Date.now() - lastNavigateAt
        if (pendingTimer) {
          pendingRoute = route
          return
        }
        if (elapsed < 300) {
          pendingRoute = route
          pendingTimer = setTimeout(() => {
            pendingTimer = undefined
            const next = pendingRoute
            pendingRoute = undefined
            if (next) applyRoute(next)
          }, 300 - elapsed)
          return
        }
        applyRoute(route)
      },
    }
  },
})

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
