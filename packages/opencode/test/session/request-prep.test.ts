import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID, MessageID } from "@/session/schema"
import { LLMRequestPrep } from "@/session/llm/request"

// Regression: the frozen-system epoch computed `epoch.frozen` in prompt.ts but
// the 4b68d672e2 system-block refactor dropped `epochSystem: epoch.frozen` from
// the handle.process call. The wire then always served the LIVE system join
// (with the env date rolling at midnight), invalidating the entire prefix on
// every real user prompt (2026-09-07 ses_004166c: 00:00:03 in=160191
// read=16128 - "Today's date" flipped Sun->Mon). This test pins the
// prepare-side contract: when epochSystem is provided, the prepared system
// collapses to exactly those bytes (LLMRequestPrep.prepare request.ts:64).

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("openai-test"),
  api: {
    id: "test-model",
    url: "https://example.test/v1",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai-test"),
  name: "Test",
  source: "config",
  env: [],
  options: {},
  models: {},
}

const agentInfo = {
  name: "test",
  mode: "primary",
  prompt: "TEST AGENT PROMPT",
  options: {},
  permission: [],
} satisfies Agent.Info

const flagsInfo: RuntimeFlags.Info = {
  client: "test",
  outputTokenMax: 4096,
} as RuntimeFlags.Info

function makeUser(sessionID: SessionID): SessionV1.User {
  return {
    id: MessageID.make("msg_prep-1"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: agentInfo.name,
    model: {
      providerID: baseModel.providerID,
      modelID: baseModel.id,
    },
  } as SessionV1.User
}

function prepare(input: {
  epochSystem?: string
}) {
  const sessionID = SessionID.make("ses-prep-test")
  const plugin = {
    trigger: ((_name: string, _input: unknown, output: unknown) => Effect.succeed(output)) as unknown as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  } as unknown as Plugin.Interface
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: makeUser(sessionID),
      sessionID,
      model: baseModel,
      agent: agentInfo,
      system: ["live agent prompt", "live env", "live instructions"],
      epochSystem: input.epochSystem,
      messages: [{ role: "user", content: "Hello" }],
      tools: {},
      provider: providerInfo,
      auth: undefined,
      plugin,
      flags: flagsInfo,
      isWorkflow: false,
    }).pipe(Effect.provide(Layer.empty)),
  )
}

describe("LLMRequestPrep.prepare epochSystem", () => {
  test("collapses system to the epoch bytes when epochSystem is set", async () => {
    const frozen = "FROZEN:agent prompt\nFROZEN:env\nFROZEN:instructions"
    const prepared = await prepare({ epochSystem: frozen })
    expect(prepared.system).toEqual([frozen])
  })

  test("serves the live join when epochSystem is absent (no epoch active)", async () => {
    const prepared = await prepare({})
    // Live join: agent prompt + the passed system array, joined into one string.
    expect(prepared.system).toHaveLength(1)
    expect(prepared.system[0]).toBe("TEST AGENT PROMPT\nlive agent prompt\nlive env\nlive instructions")
  })
})
