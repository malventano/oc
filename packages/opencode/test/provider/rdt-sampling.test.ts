import { afterEach, describe, expect, test } from "bun:test"
import { RDT } from "@/provider/rdt"

// Spec 17 section 12.2a parity rule: the chat-completions transport spreads the
// flattened model/variant options onto the request body, so a model-configured
// temperature/top_p/repetition_penalty applies there. The responses transport
// builds the body itself, so it must forward the same fields or they are silently
// dropped (this dropped DSV4.1's repetition_penalty=1.05).

const model = {
  modelId: "DSV4.1-Flash",
  provider: "vllm-local",
  specificationVersion: "v3",
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error("unused")
  },
  doStream: async () => {
    throw new Error("unused")
  },
} as never

const prompt = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "hi" }] },
] as never

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const capture = () => {
  const bodies: any[] = []
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? "{}"))
    return new Response("", { status: 200 })
  }) as never
  return bodies
}

const wrapped = (sessionID: string) =>
  RDT.wrap(model, {
    sessionID,
    modelID: "DSV4.1-Flash",
    baseURL: "http://127.0.0.1:1/v1",
    providerKey: "vllm-local",
  })

describe("RDT responses body: sampling params", () => {
  test("forwards the flattened provider block (spec 17 12.2a parity)", async () => {
    const bodies = capture()
    await wrapped("rdt-sampling-1").doStream({
      prompt,
      providerOptions: {
        "vllm-local": {
          temperature: 1.0,
          top_p: 0.95,
          repetition_penalty: 1.05,
          chat_template_kwargs: { thinking: true, reasoning_effort: 75 },
        },
      },
    } as never)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].temperature).toBe(1.0)
    expect(bodies[0].top_p).toBe(0.95)
    expect(bodies[0].repetition_penalty).toBe(1.05)
    expect(bodies[0].chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: 75 })
  })

  test("call options fill in, the provider block wins (chat spread order)", async () => {
    const bodies = capture()
    await wrapped("rdt-sampling-2").doStream({
      prompt,
      temperature: 0.2,
      topP: 0.3,
      providerOptions: { "vllm-local": { temperature: 1.0, top_p: 0.95 } },
    } as never)
    expect(bodies[0].temperature).toBe(1.0)
    expect(bodies[0].top_p).toBe(0.95)
  })

  test("omits every sampling param when unset (server default applies)", async () => {
    const bodies = capture()
    await wrapped("rdt-sampling-3").doStream({ prompt, providerOptions: {} } as never)
    for (const key of [
      "temperature",
      "top_p",
      "top_k",
      "repetition_penalty",
      "presence_penalty",
      "frequency_penalty",
      "seed",
    ]) {
      expect(bodies[0][key]).toBeUndefined()
    }
  })
})
