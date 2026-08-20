// scripts/rdt-sync200k.mjs - byte-stability of the RDT chain at 200k context.
// Chained turn N+1 hits turn N's render if the re-render is byte-stable
// (TTFT warm ~1.1s, cached ~= input). Cold (~19s) means the re-render bytes
// diverged. Decisive at this size where warm vs cold is ~18s apart.
// Run: bun run scripts/rdt-sync200k.mjs [ctx-file]
import { readFileSync } from "node:fs"
import { RDT } from "../src/provider/rdt.ts"

const BASE = "http://10.10.10.14:8001/v1"
const MODEL = "DSV4-Flash"
const ctxFile = process.argv[2] ?? "/tmp/opencode/ctx-200k.txt"

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
  const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  return { usage: finish?.usage, ttftMs: Math.round(performance.now() - t0), text }
}

const line = (label, r) => {
  const u = r.usage
  const total = u?.inputTokens?.total ?? 0
  const cached = u?.inputTokens?.cacheRead ?? 0
  const pct = total > 0 ? Math.round((100 * cached) / total) : 0
  return `${label}: input=${total} cached=${cached} (${pct}%) ttft=${r.ttftMs}ms`
}

const text = readFileSync(ctxFile, "utf8")
console.log(`context: ${text.length.toLocaleString()} chars`)
const sys = { role: "system", content: "You are a helpful assistant." }
const u1 = { role: "user", content: [{ type: "text", text: text + "\n\nReply with: OK-1" }] }
const a1 = { role: "assistant", content: [{ type: "text", text: "OK-1" }] }
const u2 = { role: "user", content: [{ type: "text", text: "Reply with: OK-2" }] }
const a2 = { role: "assistant", content: [{ type: "text", text: "OK-2" }] }
const u3 = { role: "user", content: [{ type: "text", text: "Reply with: OK-3" }] }

const A = RDT.wrap(lang, { sessionID: "sync200k-A", modelID: MODEL, baseURL: BASE })

console.log("== session A: seed then chained ==")
const t1 = await runTurn(A, [sys, u1])
console.log("  turn 1 (seed):    ", line("", t1))
const t2 = await runTurn(A, [sys, u1, a1, u2])
console.log("  turn 2 (chained): ", line("", t2))
const t3 = await runTurn(A, [sys, u1, a1, u2, a2, u3])
console.log("  turn 3 (chained): ", line("", t3))

const warm = t3.ttftMs < 5000
const cachedPct = t3.usage?.inputTokens?.cacheRead ?? 0
const total = t3.usage?.inputTokens?.total ?? 1
const pct = Math.round((100 * cachedPct) / total)
console.log(`\nCHAIN BYTE-STABLE (turn3 warm + cached>=90%): ${warm && pct >= 90 ? "YES" : "NO"} (ttft=${t3.ttftMs}ms cached=${pct}%)`)

// ---- Session B: full-resend of the SAME conversation (using the real model
// outputs captured above) - if it hits session A's chain cache, a mid-chain
// break + reseed lands byte-identically (no prefix miss). ----
console.log("\n== session B: full-resend (same conversation, real outputs) ==")
const B = RDT.wrap(lang, { sessionID: "sync200k-B", modelID: MODEL, baseURL: BASE })
const r1 = { role: "assistant", content: [{ type: "text", text: t1.text || "OK-1" }] }
const r2 = { role: "assistant", content: [{ type: "text", text: t2.text || "OK-2" }] }
const fullPrompt = [sys, u1, r1, u2, r2, u3]
const f1 = await runTurn(B, fullPrompt)
console.log("  full-resend:      ", line("", f1))

const fTotal = f1.usage?.inputTokens?.total ?? 1
const fCached = f1.usage?.inputTokens?.cacheRead ?? 0
const fPct = Math.round((100 * fCached) / fTotal)
const byteEq = fPct >= 90
console.log(`\nFULL-RESEND BYTE-EQUIVALENT (hits chain cache >=90%): ${byteEq ? "YES" : "NO"} (${fPct}%)`)

process.exit(warm && pct >= 90 && byteEq ? 0 : 1)
