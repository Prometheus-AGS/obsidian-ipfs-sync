# Spec 005 — UAR-lite: Local WASM Agents (AG-UI + A2A, Offline-Capable)

Status: **spec for later reference — no phases started.**
Related: spec 002 (AG-UI/A2UI client), spec 003 (Rust/WASM).

## Intent

Run agents **locally on whatever platform we're on** — mobile, web, desktop —
inside a WASM "UAR-lite": a subset of the Universal Agent Runtime embedded in
the plugin. Agents can be defined to run **locally, or against UAR, or against
any other AG-UI/A2A endpoint**, and the system must keep working **fully
disconnected** (no network) for local agentic support — search, embeddings,
small-model inference. Decentralized AI: every device is a node, UAR is the
heavy peer, the vault op-log is the shared memory.

## Why this is feasible (local evidence + research)

- **UAR already executes skills as WASM.** `src/sandbox/wasmtime_runner.rs` runs
  capability-checked skill components under Wasmtime; the guest ABI
  (`alloc`/`execute`/`memory` + `host_call` bridge: `fs_*`, `net_fetch`, `kv_*`,
  `agent_*`, `time_now`, `env_read`, `shell_exec`) is explicitly host-portable.
  A skill built for UAR is the same binary that runs in the plugin — only the
  host bridge changes per surface.
- **Local inference in WebViews is real (research):** WebLLM/MLC (WebGPU),
  transformers.js v3 (on top of **onnxruntime-web**, WASM SIMD/WebGPU), and
  llama.cpp WASM ports run in browsers today; onnxruntime-web's WebGPU backend
  is Microsoft's supported path for in-browser generative AI. WebGPU is shipped
  on Android Chrome and iOS Safari 26; pure WASM SIMD fallback covers older
  WebViews. Realistic ceilings: 1–4B-class quantized models on phones, 9B+ on
  desktops (matches our KBD model registry's local lane).
- **ONNX embeddings offline (research):** two viable lanes —
  1. **JS lane:** onnxruntime-web + transformers.js `feature-extraction`
     pipeline — fastest to ship, ONNX models directly from Hugging Face.
  2. **Rust→WASM lane:** `tract` (pure-Rust ONNX inference) compiled to WASM —
     one artifact, no JS model-runtime dependency, consistent with spec 003.
  Decision deferred to a benchmark spike; both satisfy "no network required".
- **A2A:** UAR ships an A2A protocol doc (`docs/A2A_PROTOCOL.md`); the
  AgentCard discovery pattern (`/.well-known/agent.json`, JSON-RPC tasks) is
  the complement to AG-UI for agent-to-agent traffic. UAR-lite supporting A2A
  means a phone can *be* an agent on the network, not just a client of one.

## UAR-lite scope (what the WASM subset includes)

| Included | Excluded (stays on UAR) |
|---|---|
| Agent definition loader + manifest validation | Tokio networking, Axum server |
| Skill registry + WASM guest loader (WebAssembly API host) | Wasmtime host (we *are* the guest runtime) |
| Tool dispatch through the host bridge | Postgres/Surreal storage (host provides `kv_*`) |
| Session/memory (vault-scoped, via `kv_*` → IndexedDB/localStorage) | Heavy/multi-step orchestration at scale |
| LLM provider abstraction with **lanes** (below) | |
| Event emission in AG-UI event shapes; A2A agent card when online | |

## Host bridge mapping (per surface)

| host_call | Obsidian plugin | Node scripts |
|---|---|---|
| `fs_*` | Vault adapter (capability-scoped paths) | `node:fs` |
| `net_fetch` | `fetch` | `fetch` |
| `kv_*` | IndexedDB / localStorage | `node:fs` KV or SQLite |
| `agent_*` | local loop, or route to remote AG-UI/A2A endpoint | same |
| `shell_exec` | **deny** (mobile) / restricted allowlist (desktop) | allowlist |
| `time_now`, `env_read` | `Date`, plugin config | `Date`, `process.env` |

## LLM lanes

1. **local-onnx** — embeddings always; small generative models via
   onnxruntime-web/tract. Works disconnected.
2. **local-webllm** — WebLLM/MLC generative lane on WebGPU-capable devices.
3. **remote-agui** — UAR or any AG-UI endpoint (cloud models, heavy tools).
4. **remote-a2a** — delegate whole tasks to peer agents.

Lane selection is per-agent-manifest and per-call with fallback chains
(e.g., `local-onnx → remote-agui`). Disconnected = lanes 1–2 only; the agent
loop must degrade gracefully (no tool that requires `net_fetch` unless the
manifest declares it optional).

## Agent manifest sketch

```json
{
  "name": "vault-librarian",
  "skills": ["urn:ipfs:<skill-wasm-cid>", "./skills/summarize.wasm"],
  "protocols": { "agui": true, "a2a": true },
  "execution": { "default": "local", "allowRemote": ["uar", "agui:https://…"] },
  "llm": { "lane": ["local-onnx", "remote-agui"], "embeddingModel": "onnx:all-MiniLM-L6-v2" },
  "capabilities": { "fs": ["notes/", ".ipfs-sync/ai/"], "net": ["ipfs.prometheusags.ai"] },
  "memory": { "scope": "vault", "via": "kv" }
}
```

Skills referenced by IPFS CID are fetched once (via vault sync or on first
connect) and cached — skill distribution rides the same content-addressed
rail as the vault.

## Disconnected operation (the acceptance scenario)

Airplane mode, phone only:
1. User asks the agent panel "find notes about X".
2. UAR-lite embeds the query **locally** (ONNX), searches the local index
   (embeddings for the current snapshot were synced down with the vault —
   spec 003/AI-layer: index pinned to snapshot, keyed by content hash).
3. Answers with citations to vault notes. No packets.

When connectivity returns: op-log sync (Phase 2) reconciles, remote lanes
become available, A2A card re-announces.

## Decentralized topology

```
phone (UAR-lite) ◄─A2A/AG-UI─► UAR (heavy peer) ◄─A2A─► other agents
      │                             │
      └── vault op-log (Phase 2) ───┘   ← shared memory; agents write notes
```

## Open questions

1. Which UAR crates compile wasm32-clean (dependency audit — spike).
2. AG-UI event emission from UAR-lite: adopt `@ag-ui/core` event DTO shapes
   directly.
3. Identity/auth for remote endpoints when disconnected-first (cached JWT?
   capability tokens?).
4. Embedding index format + update policy when offline edits diverge from the
   pinned index (re-embed changed files locally — confirms spec 003's
   Rust/WASM unixfs+hash lane for content-keyed index entries).
5. A2A AgentCard on a device with no inbound connectivity: announce-on-LAN
   only, or skip discovery and use address-book manifests?
6. ONNX lane choice (onnxruntime-web vs tract-in-WASM) — benchmark spike.
