// scripts/rdt-sync-test.mjs - byte-equivalence of the RDT chain vs a full
// resend. The KV prefix cache is the oracle: if a full-resend of the same
// conversation hits the chained re-render's cache, the bytes are identical;
// if it cold-prefills, the chain re-renders differently (prefix miss on
// reseed). Also verifies within-chain stability (no cumulative drift).
// Run: bun run scripts/rdt-sync-test.mjs
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

const sys = { role: "system", content: "You are a helpful assistant." }
const u = (i) => ({ role: "user", content: [{ type: "text", text: `Turn ${i} message. Reply with the word TURN-${i} only.` }] })

const runTurn = async (model, prompt, maxOutputTokens = 16) => {
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

const usageLine = (label, u, ttftMs) => {
  if (!u) return `${label}: no usage`
  const total = u.inputTokens?.total ?? 0
  const cached = u.inputTokens?.cacheRead ?? 0
  const pct = total > 0 ? Math.round((100 * cached) / total) : 0
  return `${label}: input=${total} cached=${cached} (${pct}%) ttft=${ttftMs}ms`
}

// ---- Session A: seed then 4 chained turns (same process, real chain) ----
console.log("== session A (seed + chained turns, one process) ==")
const A = RDT.wrap(lang, { sessionID: "sync-A", modelID: MODEL, baseURL: BASE })

let promptA = [sys, u(1)]
const uA1 = await runTurn(A, promptA)
console.log("  turn 1 (seed):      ", usageLine("", uA1.usage, uA1.ttftMs))
promptA = [...promptA, { role: "assistant", content: [{ type: "text", text: "TURN-1" }] }, u(2)]
const uA2 = await runTurn(A, promptA)
console.log("  turn 2 (chained):   ", usageLine("", uA2.usage, uA2.ttftMs))
promptA = [...promptA, { role: "assistant", content: [{ type: "text", text: "TURN-2" }] }, u(3)]
const uA3 = await runTurn(A, promptA)
console.log("  turn 3 (chained):   ", usageLine("", uA3.usage, uA3.ttftMs))
promptA = [...promptA, { role: "assistant", content: [{ type: "text", text: "TURN-3" }] }, u(4)]
const uA4 = await runTurn(A, promptA)
console.log("  turn 4 (chained):   ", usageLine("", uA4.usage, uA4.ttftMs))
// turn 5 (no assistant, just the next user msg) - chain stability
const promptA5 = [...promptA, { role: "assistant", content: [{ type: "text", text: "TURN-4" }] }, u(5)]
const uA5 = await runTurn(A, promptA5)
console.log("  turn 5 (chained):   ", usageLine("", uA5.usage, uA5.ttftMs))

// ---- Session B: full-resend of turn 5's conversation (fresh process/state) ----
// If the full-send renders byte-identically to the chain, it hits the cache
// that session A's turn 5 established -> cached near input.
console.log("\n== session B (full-resend of the same conversation) ==")
const B = RDT.wrap(lang, { sessionID: "sync-B", modelID: MODEL, baseURL: BASE })
const promptB = promptA5 // identical conversation as session A turn 5
const uB1 = await runTurn(B, promptB)
console.log("  full-resend:        ", usageLine("", uB1.usage, uB1.ttftMs))

const input = uA5?.usage?.inputTokens?.total ?? 0
const cached = uB1?.usage?.inputTokens?.cacheRead ?? 0
const pct = input > 0 ? Math.round((100 * cached) / input) : 0
const byteEq = pct >= 95
console.log(`\nBYTE-EQUIVALENT (full-resend hits chain cache >=95%): ${byteEq ? "YES" : "NO"} (${pct}%)`)
process.exit(byteEq ? 0 : 1)
