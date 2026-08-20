// Probe: does RDT's seed lowering carry reasoning that rides
// providerOptions.openaiCompatible.reasoning_content (the interleaved-field
// shape transform.ts:322-354 produces for DSV4)? The chat path sends that
// field verbatim; RDT must emit it as a reasoning item or the responses seed
// drops all prior reasoning (the ~128k context gap).
// Run: bun run scripts/rdt-interleaved-reasoning.mjs
import { randomBytes } from "node:crypto"
import { RDT } from "../src/provider/rdt.ts"

const BASE = "http://10.10.10.14:8001/v1"
const MODEL = "DSV4-Flash"
const SESSION = "probe-interleaved-" + randomBytes(4).toString("hex")

const lang = {
  modelId: MODEL,
  provider: "vllm-local",
  specificationVersion: "v3",
  supportedUrls: {},
  async doGenerate() { throw new Error("n/a") },
  async doStream() { throw new Error("n/a") },
}

const BLOCK_REASONING = ("reasoning_content_text ".repeat(2000)) // ~52k chars of reasoning
const salt = randomBytes(8).toString("hex")
const u1 = { role: "user", content: [{ type: "text", text: `${salt} Investigate the schema.` }] }

// The transform-shape assistant message: reasoning sunk into the interleaved
// field, content carries only text + tool-call (no reasoning part).
const a1 = {
  role: "assistant",
  content: [
    { type: "text", text: "Let me query the schema." },
    { type: "tool-call", toolCallId: "call-1", toolName: "query", input: { op: "schema" } },
  ],
  providerOptions: {
    openaiCompatible: { reasoning_content: BLOCK_REASONING },
  },
}
const tr1 = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "call-1", toolName: "query", output: { type: "text", value: '{"ok":true}' } }],
}
const u2 = { role: "user", content: [{ type: "text", text: "Now list rows." }] }

const conversation = [
  { role: "system", content: "You are a helpful assistant." },
  u1, a1, tr1, u2,
]

const model = RDT.wrap(lang, { sessionID: SESSION, modelID: MODEL, baseURL: BASE })
const t0 = performance.now()
const { stream } = await model.doStream({
  prompt: conversation,
  tools: [],
  toolChoice: { type: "auto" },
  maxOutputTokens: 4,
  temperature: 1.0,
  topP: 0.95,
  abortSignal: undefined,
})
const parts = []
for await (const p of stream) parts.push(p)
const finish = parts.find((p) => p.type === "finish")
const usage = finish?.usage
console.log("input total:", usage?.inputTokens?.total, "cacheRead:", usage?.inputTokens?.cacheRead)

const req = RDT._testLastRequest(SESSION)
console.log("mode:", req?.mode, "itemCount:", req?.itemCount, "bytes:", req?.bytes)
console.log("comp:", JSON.stringify(req?.comp, null, 2))
const reasoning = req?.comp?.reasoning
if (reasoning && reasoning.chars > 10000) {
  console.log("PASS: seed carries the large interleaved reasoning (~" + reasoning.chars + " serialized chars)")
} else {
  console.log("FAIL: seed reasoning is missing/tiny:", JSON.stringify(reasoning))
}

// Chained-turn parity: the same conversation re-sent (fresh process state -> seed);
// if the server re-renders the reasoning item byte-identically, cache.read ~ total.
