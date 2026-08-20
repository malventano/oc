// scripts/rdt-live-test.mjs - drive the RDT transport module against the live
// vLLM responses endpoint (10.10.10.14:8001). Verifies: seed full-send,
// stream parts (reasoning/text/finish+usage), chain state advance, and a
// second sequential turn chaining via previous_response_id.
//
// Run: bun run scripts/rdt-live-test.mjs (from packages/opencode)
// Requires: server up with VLLM_ENABLE_RESPONSES_API_STORE=1.
import { createHash } from "node:crypto"
import { RDT } from "../src/provider/rdt.ts"

const BASE = "http://10.10.10.14:8001/v1"
const MODEL = "DSV4-Flash"
const SESSION = "test-rdt-live"

// Deterministic message -> (assistant) reply, so the second turn's delta is
// independent of the model's actual output (the reply text is whatever the
// model said; we only need the message LIST to grow).
const lang = {
  modelId: MODEL,
  provider: "vllm-local",
  specificationVersion: "v3",
  supportedUrls: {},
  async doGenerate() {
    throw new Error("doGenerate should not be called in RDT test")
  },
  async doStream() {
    throw new Error("base doStream should not be called in RDT test")
  },
}

const systemMsg = (text) => ({ role: "system", content: text })
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] })

const runTurn = async (model, prompt, maxOutputTokens) => {
  const parts = []
  const { stream } = await model.doStream({
    prompt,
    tools: [],
    toolChoice: "auto",
    maxOutputTokens,
    temperature: 1.0,
    topP: 0.95,
    abortSignal: undefined,
  })
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const partSummary = (parts) => {
  const types = parts.map((p) => p.type)
  const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  const reasoning = parts.filter((p) => p.type === "reasoning-delta").map((p) => p.delta).join("")
  const finish = parts.find((p) => p.type === "finish")
  const toolCalls = parts.filter((p) => p.type === "tool-call")
  return { types, textLen: text.length, reasoningLen: reasoning.length, finish, toolCalls }
}

const model = RDT.wrap(lang, { sessionID: SESSION, modelID: MODEL, baseURL: BASE })

// Turn 1: seed (no chain state). Full input, no previous_response_id.
console.log("== turn 1 (seed) ==")
const t1 = await runTurn(
  model,
  [systemMsg("You are a helpful assistant."), userMsg("Say hello in one short sentence.")],
  32,
)
const s1 = partSummary(t1)
console.log("parts:", s1.types.join(","))
console.log("text:", JSON.stringify(s1.textLen > 0 ? s1.textLen : "(none)"), "reasoning:", s1.reasoningLen, "toolCalls:", s1.toolCalls.length)
console.log("finish:", s1.finish?.finishReason, "usage:", JSON.stringify(s1.finish?.usage))
const st1 = RDT._testState(SESSION)
const req1 = RDT._testLastRequest(SESSION)
console.log("state after t1:", JSON.stringify({ hwm: st1?.hwm, hasId: !!st1?.responseId }))
console.log("req1:", JSON.stringify(req1))

// Turn 2: append a new user message -> should chain via previous_response_id.
console.log("\n== turn 2 (chained) ==")
const t2 = await runTurn(
  model,
  [systemMsg("You are a helpful assistant."), userMsg("Say hello in one short sentence."), userMsg("Now reply OK.")],
  8,
)
const s2 = partSummary(t2)
console.log("parts:", s2.types.join(","))
const st2 = RDT._testState(SESSION)
const req2 = RDT._testLastRequest(SESSION)
console.log("state after t2:", JSON.stringify({ hwm: st2?.hwm, hasId: !!st2?.responseId }))
console.log("req2:", JSON.stringify(req2))

const chainOk = req2?.mode === "chained" && !!req2?.previousResponseId && st2?.hwm === 2 && req2?.itemCount === 1
console.log("\nCHAIN OK:", chainOk ? "yes" : "NO")

// Turn 3: MUTATE the first user message -> prefix hash mismatch -> full-send.
console.log("\n== turn 3 (mutation -> full-send) ==")
const t3 = await runTurn(
  model,
  [systemMsg("You are a helpful assistant."), userMsg("Say HELLO WORLD in one short sentence."), userMsg("Now reply OK.")],
  8,
)
const st3 = RDT._testState(SESSION)
const req3 = RDT._testLastRequest(SESSION)
console.log("state after t3:", JSON.stringify({ hwm: st3?.hwm, hasId: !!st3?.responseId }))
console.log("req3:", JSON.stringify(req3))

const breakOk = req3?.mode === "seed" && !req3?.previousResponseId && req3?.itemCount === 2
console.log("BREAK OK:", breakOk ? "yes" : "NO")

process.exit(chainOk && breakOk ? 0 : 1)
