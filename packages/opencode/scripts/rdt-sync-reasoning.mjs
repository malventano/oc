// scripts/rdt-sync-reasoning.mjs - byte-equivalence of the RDT chain when the
// conversation carries reasoning + tool-call + tool-result parts (the real
// depth case). Verifies the flattened lowering (reasoning + message +
// function_call as separate top-level items) renders byte-identically between
// a seed full-send and the chained re-render, and that a fresh full-resend of
// the same conversation hits the chain's cache.
// Run: bun run scripts/rdt-sync-reasoning.mjs
import { randomBytes } from "node:crypto"
import { RDT } from "../src/provider/rdt.ts"

const BASE = "http://10.10.10.14:8001/v1"
const MODEL = "DSV4-Flash"

const lang = {
  modelId: MODEL,
  provider: "vllm-local",
  specificationVersion: "v3",
  supportedUrls: {},
  async doGenerate() { throw new Error("n/a") },
  async doStream() { throw new Error("n/a") },
}

const runTurn = async (model, prompt, maxOutputTokens = 8) => {
  const t0 = performance.now()
  const { stream } = await model.doStream({
    prompt,
    tools: [],
    toolChoice: { type: "auto" },
    maxOutputTokens,
    temperature: 1.0,
    topP: 0.95,
    abortSignal: undefined,
  })
  const parts = []
  for await (const p of stream) parts.push(p)
  const finish = parts.find((p) => p.type === "finish")
  return { usage: finish?.usage, ttftMs: Math.round(performance.now() - t0) }
}

const line = (label, r) => {
  const u = r.usage
  const total = u?.inputTokens?.total ?? 0
  const cached = u?.inputTokens?.cacheRead ?? 0
  const pct = total > 0 ? Math.round((100 * cached) / total) : 0
  return `${label}: input=${total} cached=${cached} (${pct}%) ttft=${r.ttftMs}ms`
}

// Novel context (random salt + repeated block) so nothing is pre-cached.
const salt = randomBytes(8).toString("hex")
const block = "The quick brown fox jumps over the lazy dog. ".repeat(400)
const u1 = { role: "user", content: [{ type: "text", text: `${salt} ${block}\n\nInspect the schema.` }] }

// A full-depth turn: reasoning + text + tool-call, then a tool result.
const a1 = {
  role: "assistant",
  content: [
    { type: "reasoning", text: "I need to check the schema before inspecting." },
    { type: "text", text: "Let me check the schema." },
    { type: "tool-call", toolCallId: "call-1", toolName: "query", input: { op: "schema" } },
  ],
}
const tr1 = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "call-1", toolName: "query", output: { type: "text", value: '{"ok":true,"table":"message"}' } }],
}
const u2 = { role: "user", content: [{ type: "text", text: "Now list the rows." }] }
const u3 = { role: "user", content: [{ type: "text", text: "Reply with: DONE-3" }] }

const conversation = [sys(), u1, a1, tr1, u2]
function sys() { return { role: "system", content: "You are a helpful assistant." } }

// Session A: turn 1 = seed of the full conversation, turn 2 = chained (u3).
console.log("== session A: seed (full conversation) then chained ==")
const A = RDT.wrap(lang, { sessionID: "syncR-A", modelID: MODEL, baseURL: BASE })
const t1 = await runTurn(A, conversation)
console.log("  turn 1 (seed):    ", line("", t1))
const conv2 = [...conversation, { role: "assistant", content: [{ type: "text", text: "Done." }] }, u3]
const t2 = await runTurn(A, conv2)
console.log("  turn 2 (chained): ", line("", t2))

// Session B: full-resend of the same conversation -> byte-equivalent if it
// hits session A's chain cache.
console.log("\n== session B: full-resend (same conversation) ==")
const B = RDT.wrap(lang, { sessionID: "syncR-B", modelID: MODEL, baseURL: BASE })
const f1 = await runTurn(B, conversation)
console.log("  full-resend:      ", line("", f1))

const total = t2.usage?.inputTokens?.total ?? 1
const cached = t2.usage?.inputTokens?.cacheRead ?? 0
const pct = Math.round((100 * cached) / total)
const fTotal = f1.usage?.inputTokens?.total ?? 1
const fCached = f1.usage?.inputTokens?.cacheRead ?? 0
const fPct = Math.round((100 * fCached) / fTotal)
console.log(`\nCHAINED-VS-SEED BYTE-EQUAL (turn2 cached>=90%): ${pct >= 90 ? "YES" : "NO"} (${pct}%)`)
console.log(`FULL-RESEND-VS-CHAIN BYTE-EQUAL (>=90%): ${fPct >= 90 ? "YES" : "NO"} (${fPct}%)`)
process.exit(pct >= 90 && fPct >= 90 ? 0 : 1)
