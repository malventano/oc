import { afterEach, describe, expect, test } from "bun:test"
import { RDT } from "@/provider/rdt"

const realFetch = globalThis.fetch
const realEnv = process.env.OC_DELTA_TRANSPORT

afterEach(() => {
  globalThis.fetch = realFetch
  if (realEnv === undefined) delete process.env.OC_DELTA_TRANSPORT
  else process.env.OC_DELTA_TRANSPORT = realEnv
  RDT._testReset()
})

const prompt: any[] = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "hi" }] },
]

const chatModel = (onStream: () => void = () => {}) =>
  ({
    modelId: "DSV4.1-Flash",
    provider: "vllm-local",
    specificationVersion: "v3",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unused")
    },
    doStream: async () => {
      onStream()
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        request: {},
        response: { headers: {} },
      }
    },
  }) as never

const base = {
  modelID: "DSV4.1-Flash",
  baseURL: "http://127.0.0.1:1/v1/",
  providerKey: "vllm-local",
}

const wrapped = (sessionID: string, mode: "responses" | "responses-nostore" = "responses", language: any = chatModel()) =>
  RDT.wrap(language, { ...base, sessionID, mode })

const capture = (responses: Array<Response | (() => Response)> = []) => {
  const bodies: any[] = []
  let i = 0
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    bodies.push(JSON.parse(init.body ?? "{}"))
    const next = responses[i++]
    return (typeof next === "function" ? next() : next) ?? new Response("", { status: 200 })
  }) as never
  return bodies
}

const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 })

const readParts = async (stream: ReadableStream<any>) => {
  const reader = stream.getReader()
  const parts: any[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

describe("RDT transport selection", () => {
  test("provider default, model override, chat and env override", () => {
    delete process.env.OC_DELTA_TRANSPORT
    const provider = { options: { deltaTransport: "responses" } } as never
    expect(RDT.mode(provider)).toBe("responses")
    expect(RDT.mode(provider, { options: { deltaTransport: "responses-nostore" } })).toBe("responses-nostore")
    expect(RDT.mode(provider, { options: { deltaTransport: "chat" } })).toBeUndefined()
    process.env.OC_DELTA_TRANSPORT = "off"
    expect(RDT.mode(provider)).toBeUndefined()
    process.env.OC_DELTA_TRANSPORT = "responses-nostore"
    expect(RDT.mode(provider)).toBe("responses-nostore")
  })

  test("OC_DELTA_TRANSPORT=off bypasses RDT", () => {
    process.env.OC_DELTA_TRANSPORT = "off"
    const provider = { options: { deltaTransport: "responses" } } as never
    expect(RDT.mode(provider, { options: { deltaTransport: "responses" } })).toBeUndefined()
    expect(RDT.enabled(provider)).toBe(false)
  })
})

describe("RDT request bodies", () => {
  test("responses keeps store:true and seeds without previous_response_id", async () => {
    const bodies = capture()
    await wrapped("responses-1").doStream({ prompt } as never)
    expect(bodies[0].store).toBe(true)
    expect(bodies[0].previous_response_id).toBeUndefined()
  })

  test("responses keeps store:true and chains on the next turn", async () => {
    const bodies = capture([
      sse([
        {
          type: "response.completed",
          response: { id: "resp_vllm", usage: { input_tokens: 5, output_tokens: 1 } },
        },
      ]),
      sse([
        {
          type: "response.completed",
          response: { id: "resp_vllm_2", usage: { input_tokens: 2, output_tokens: 1 } },
        },
      ]),
    ])
    const w = wrapped("responses-chain-1")
    const first = await w.doStream({ prompt } as never)
    await readParts(first.stream)

    const second = await w.doStream({
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    } as never)
    await readParts(second.stream)

    expect(bodies).toHaveLength(2)
    expect(bodies[1].store).toBe(true)
    expect(bodies[1].previous_response_id).toBe("resp_vllm")
    expect(bodies[1].input).toHaveLength(1)
  })

  test("responses-nostore omits store and previous_response_id and sends full input", async () => {
    const bodies = capture()
    const w = wrapped("nostore-1", "responses-nostore")
    await w.doStream({ prompt } as never)
    expect(bodies[0].store).toBeUndefined()
    expect(bodies[0].previous_response_id).toBeUndefined()
    expect(bodies[0].input).toHaveLength(1)

    await w.doStream({
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    } as never)
    expect(bodies[1].store).toBeUndefined()
    expect(bodies[1].previous_response_id).toBeUndefined()
    expect(bodies[1].input).toHaveLength(3)
  })
})

describe("RDT unsupported-endpoint fallback", () => {
  test("a seed 400 store not supported retries nostore and reuses it", async () => {
    let chatCalls = 0
    const chat = chatModel(() => {
      chatCalls++
    })
    const bodies = capture([
      new Response(JSON.stringify({ error: { message: "store is not supported" } }), { status: 400 }),
      sse([
        {
          type: "response.completed",
          response: { id: "resp_nostore", usage: { input_tokens: 5, output_tokens: 1 } },
        },
      ]),
    ])

    const warnings: string[] = []
    const first = RDT.wrap(chat, {
      ...base,
      sessionID: "fallback-1",
      mode: "responses",
      warn: (message) => warnings.push(message),
    })
    const result = await first.doStream({ prompt } as never)
    await readParts(result.stream)

    expect(bodies).toHaveLength(2)
    expect(bodies[0].store).toBe(true)
    expect(bodies[0].previous_response_id).toBeUndefined()
    expect(bodies[1].store).toBeUndefined()
    expect(bodies[1].previous_response_id).toBeUndefined()
    expect(bodies[1].input).toHaveLength(1)
    expect(chatCalls).toBe(0)
    expect(warnings).toHaveLength(1)

    // Same baseURL+modelID: the endpoint is now stateless for later turns.
    const second = RDT.wrap(chat, { ...base, sessionID: "fallback-2", mode: "responses" })
    const next = await second.doStream({ prompt } as never)
    await readParts(next.stream)
    expect(bodies).toHaveLength(3)
    expect(bodies[2].store).toBeUndefined()
    expect(bodies[2].previous_response_id).toBeUndefined()
    expect(bodies[2].input).toHaveLength(1)
    expect(chatCalls).toBe(0)
  })

  test("a nostore retry failure latches chat with one warning", async () => {
    let chatCalls = 0
    const chat = chatModel(() => {
      chatCalls++
    })
    const bodies = capture([
      new Response(JSON.stringify({ error: { message: "store is not supported" } }), { status: 400 }),
      new Response(JSON.stringify({ error: { message: "store is not supported" } }), { status: 400 }),
    ])

    const warnings: string[] = []
    const first = RDT.wrap(chat, {
      ...base,
      sessionID: "fallback-chat-1",
      mode: "responses",
      warn: (message) => warnings.push(message),
    })
    const result = await first.doStream({ prompt } as never)
    await readParts(result.stream)
    expect(bodies).toHaveLength(2)
    expect(chatCalls).toBe(1)
    expect(warnings).toHaveLength(1)

    // The endpoint is latched to chat: later turns do not probe responses.
    const second = RDT.wrap(chat, { ...base, sessionID: "fallback-chat-2", mode: "responses" })
    const next = await second.doStream({ prompt } as never)
    await readParts(next.stream)
    expect(bodies).toHaveLength(2)
    expect(chatCalls).toBe(2)
  })

  test("a chained 400 previous_response_id not supported retries full nostore", async () => {
    let chatCalls = 0
    const chat = chatModel(() => {
      chatCalls++
    })
    const bodies = capture([
      sse([
        {
          type: "response.completed",
          response: { id: "resp_seed", usage: { input_tokens: 5, output_tokens: 1 } },
        },
      ]),
      new Response(JSON.stringify({ error: { message: "previous_response_id is not supported" } }), {
        status: 400,
      }),
      sse([
        {
          type: "response.completed",
          response: { id: "resp_nostore", usage: { input_tokens: 8, output_tokens: 1 } },
        },
      ]),
    ])

    const w = RDT.wrap(chat, { ...base, sessionID: "chain-fallback-1", mode: "responses" })
    const first = await w.doStream({ prompt } as never)
    await readParts(first.stream)

    const second = await w.doStream({
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    } as never)
    await readParts(second.stream)

    expect(bodies).toHaveLength(3)
    expect(bodies[1].store).toBe(true)
    expect(bodies[1].previous_response_id).toBe("resp_seed")
    expect(bodies[2].store).toBeUndefined()
    expect(bodies[2].previous_response_id).toBeUndefined()
    expect(bodies[2].input).toHaveLength(3)
    expect(chatCalls).toBe(0)
  })

  test("an expired previous_response_id keeps the full Responses retry, not nostore", async () => {
    let chatCalls = 0
    const chat = chatModel(() => {
      chatCalls++
    })
    const bodies = capture([
      sse([
        {
          type: "response.completed",
          response: { id: "resp_seed", usage: { input_tokens: 5, output_tokens: 1 } },
        },
      ]),
      new Response(JSON.stringify({ error: { message: "Previous response with id 'resp_seed' not found" } }), {
        status: 400,
      }),
      sse([
        {
          type: "response.completed",
          response: { id: "resp_full", usage: { input_tokens: 9, output_tokens: 1 } },
        },
      ]),
    ])

    const w = RDT.wrap(chat, { ...base, sessionID: "expired-1", mode: "responses" })
    const first = await w.doStream({ prompt } as never)
    await readParts(first.stream)

    const second = await w.doStream({
      prompt: [
        ...prompt,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    } as never)
    await readParts(second.stream)

    expect(bodies).toHaveLength(3)
    expect(bodies[1].previous_response_id).toBe("resp_seed")
    expect(bodies[2].store).toBe(true)
    expect(bodies[2].previous_response_id).toBeUndefined()
    expect(bodies[2].input).toHaveLength(3)
    expect(chatCalls).toBe(0)
  })
})

describe("RDT FLARE parser compatibility", () => {
  test("reasoning, text, indexed tool arguments and usage", async () => {
    capture([
      sse([
        { type: "response.created", response: { id: "resp_x" } },
        { type: "response.in_progress" },
        { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning" } },
        { type: "response.reasoning_text.delta", item_id: "rs_1", delta: "think" },
        { type: "response.reasoning_text.done", item_id: "rs_1" },
        { type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message" } },
        { type: "response.content_part.added", item_id: "msg_1", part: { type: "output_text" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "hi" },
        { type: "response.output_text.done", item_id: "msg_1", text: "hi" },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash" },
        },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"command":' },
        { type: "response.function_call_arguments.delta", output_index: 2, delta: '"ls"}' },
        { type: "response.function_call_arguments.done", output_index: 2, arguments: '{"command":"ls"}' },
        // FLARE-style output_item.done without arguments: must not clobber.
        {
          type: "response.output_item.done",
          output_index: 2,
          item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "bash" },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_x",
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        },
      ]),
    ])

    const result = await wrapped("parser-1", "responses-nostore").doStream({ prompt } as never)
    const parts = await readParts(result.stream)

    expect(parts.some((part) => part.type === "reasoning-delta" && part.delta === "think")).toBe(true)
    expect(parts.some((part) => part.type === "text-delta" && part.delta === "hi")).toBe(true)
    const start = parts.find((part) => part.type === "tool-input-start")
    expect(start.toolName).toBe("bash")
    expect(parts.some((part) => part.type === "tool-input-delta" && String(part.delta).includes("ls"))).toBe(true)
    const call = parts.find((part) => part.type === "tool-call")
    expect(call.toolCallId).toBe("call_1")
    expect(call.input).toBe('{"command":"ls"}')
    const finish = parts.find((part) => part.type === "finish")
    expect(finish.finishReason.unified).toBe("tool-calls")
    expect(finish.usage.inputTokens.cacheRead).toBe(2)
    expect(finish.usage.outputTokens.reasoning).toBe(1)
  })

  test("response.incomplete finishes with length instead of hanging", async () => {
    capture([
      sse([
        { type: "response.created", response: { id: "resp_inc" } },
        { type: "response.content_part.added" },
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          response: { id: "resp_inc", usage: { input_tokens: 5, output_tokens: 2 } },
        },
      ]),
    ])

    const result = await wrapped("incomplete-1", "responses-nostore").doStream({ prompt } as never)
    const parts = await readParts(result.stream)
    const finish = parts.find((part) => part.type === "finish")
    expect(finish.finishReason.unified).toBe("length")
    expect(finish.usage.outputTokens.total).toBe(2)
  })

  test("server_error surfaces as an error part", async () => {
    capture([sse([{ type: "server_error", error: { message: "boom" } }])])
    const result = await wrapped("server-error-1", "responses-nostore").doStream({ prompt } as never)
    const parts = await readParts(result.stream)
    const error = parts.find((part) => part.type === "error")
    expect(error.error.message).toBe("boom")
  })
})
