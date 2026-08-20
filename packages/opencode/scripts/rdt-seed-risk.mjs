// scripts/rdt-seed-risk.mjs - de-risk the real-depth seed: verify the item
// shapes oc will send on a full-send (reasoning replay + function_call_output
// with a real tool result, no `status` field) validate against the deployed
// vLLM. If this 200s, a live-session restart+seed is safe; if 400s, the
// lowering needs a fix first.
// Run: bun run scripts/rdt-seed-risk.mjs
import { readFileSync } from "node:fs"

const BASE = "http://10.10.10.14:8001/v1"
const MODEL = "DSV4-Flash"

import { RDT } from "../src/provider/rdt.ts"

// ---- Direct POST with the flattened item shapes (validation reference) ----
const items = [
  { role: "user", content: [{ type: "input_text", text: "Investigate the message table." }] },
  { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "I need to check the schema first." }] },
  { role: "assistant", content: [{ type: "input_text", text: "Let me check the schema." }] },
  {
    type: "function_call",
    call_id: "chatcmpl-tool-a26643740fc11db0",
    name: "sessions-query",
    arguments: '{"op":"describe-table","tableName":"message"}',
  },
  {
    type: "function_call_output",
    call_id: "chatcmpl-tool-a26643740fc11db0",
    output: '{"tableName":"message","columns":[{"cid":0,"name":"id","type":"TEXT","notnull":0}]}',
  },
  { role: "user", content: [{ type: "input_text", text: "Now list the rows." }] },
]

const body = {
  model: MODEL,
  instructions: "You are opencode, an interactive CLI tool.",
  input: items,
  tools: [{ type: "function", name: "sessions-query", parameters: { type: "object" } }],
  tool_choice: "auto",
  stream: false,
  max_output_tokens: 8,
  store: true,
}

const res = await fetch(`${BASE}/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
const text = await res.text()
console.log("DIRECT-ITEMS STATUS:", res.status)

// ---- Through the RDT module: V3 prompt with reasoning + tool-call +
// tool-result parts, lowered by lowerMessage. This is what the live seed
// actually sends. ----
console.log("\n== through RDT module ==")
const lang = {
  modelId: MODEL,
  provider: "vllm-local",
  specificationVersion: "v3",
  supportedUrls: {},
  async doGenerate() { throw new Error("n/a") },
  async doStream() { throw new Error("n/a") },
}
const model = RDT.wrap(lang, { sessionID: "seed-risk", modelID: MODEL, baseURL: BASE })
const prompt = [
  { role: "system", content: "You are opencode, an interactive CLI tool." },
  { role: "user", content: [{ type: "text", text: "Investigate the message table." }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I need to check the schema first." },
      { type: "text", text: "Let me check the schema." },
      { type: "tool-call", toolCallId: "chatcmpl-tool-a26643740fc11db0", toolName: "sessions-query", input: { op: "describe-table", tableName: "message" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "chatcmpl-tool-a26643740fc11db0", toolName: "sessions-query", output: { type: "text", value: '{"tableName":"message","columns":[{"cid":0,"name":"id"}]}' } },
    ],
  },
  { role: "user", content: [{ type: "text", text: "Now list the rows." }] },
]
try {
  const { stream } = await model.doStream({
    prompt,
    tools: [{ type: "function", name: "sessions-query", inputSchema: { type: "object" } }],
    toolChoice: { type: "auto" },
    maxOutputTokens: 8,
    temperature: 1.0,
    topP: 0.95,
    abortSignal: undefined,
  })
  const parts = []
  for await (const p of stream) parts.push(p)
  console.log("MODULE OK parts:", parts.map((p) => p.type).join(","))
} catch (e) {
  console.log("MODULE ERROR:", String(e?.message ?? e).slice(0, 800))
}
