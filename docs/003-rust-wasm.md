# Spec 003 — Rust → WASM Components Used from TypeScript

Status: **spec for later reference — no phases started.**
Question researched: is it possible and useful to write parts of this project in
Rust, compile to WASM, and call them from the plugin and Node scripts? **Verdict:
yes, for a specific set of jobs — not as a general strategy.**

## Research findings

- **Browser/WebView path (primary):** `wasm32-unknown-unknown` via
  `wasm-bindgen`/`wasm-pack`. Runs in Electron's renderer and in mobile WebViews
  (WebAssembly + WASM SIMD are supported in WKWebView iOS 16+ and current Android
  System WebView). Loading in an Obsidian plugin: read the `.wasm` bytes via
  `app.vault.adapter` (or bundle as base64 through esbuild) →
  `WebAssembly.instantiate` → call exported functions.
- **Node 24 path:** `WebAssembly.compile`/`instantiate` are stable; `node:wasi`
  exists (still flagged experimental in 24) for WASI-preview1 modules.
  **Jco 1.0** (Bytecode Alliance) generates JS+TS bindings for WebAssembly
  *components* (the component model) and runs them in Node and browsers;
  `cargo-component` compiles Rust to components. The component model is the
  better long-term ABI but browser-support tooling is young — phase it in, don't
  start there.
- UAR's existing WASM skill ABI (guest: `alloc`/`execute`/`memory`; host bridge:
  `fs_*`, `net_fetch`, `kv_*`, `agent_*`, `time_now`, `env_read`, `shell_exec`)
  is already designed to be host-portable — the same skill binary can run under
  UAR (Wasmtime), under Node, and inside the plugin. See spec 005.

## Where Rust/WASM earns its place (ranked)

1. **Archive/data-plane formats** — tar parsing (pull path), CAR files, and
   especially **UnixFS/CID computation byte-compatible with kubo** (chunking,
   raw leaves, CIDv1). Rust's `ipld`/`unixfs` ecosystem gets this exactly right;
   reimplementing it in TS is where bugs would live. This also unlocks local CID
   computation → true delta detection without asking the node.
2. **Compression** — zstd (manifest + AI index payloads).
3. **Sandboxed skill execution** — the UAR-lite guest runtime (spec 005).
4. **Serialization hot paths** — CBOR/DAG-CBOR if Phase 2 adopts it.

## Where it does NOT earn its place

- **Hashing and encryption** — `WebCrypto` provides sha256 and AES-GCM natively,
  zero-copy, hardware-accelerated. Do not WASM this.
- **General plugin logic** — plain TypeScript is more maintainable; WASM adds a
  build step and debugging friction.
- **Anything needing OS access** (spawn processes, raw sockets, filesystem
  outside the vault) — WASM can't; that's the *optional* Rust CLI territory
  (e.g., a desktop-side local kubo companion). Rust CLIs ship per-OS binaries;
  WASM ships one artifact for every platform — prefer WASM whenever feasible.

## Distribution and build story

- One `.wasm` artifact is platform-independent: build in CI (GitHub Actions,
  `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen`), attach to
  releases, vendor a pinned copy into this repo.
- Plugin loading: prefer `adapter.readBinary` at runtime (no base64 bloat in
  `main.js`); base64-inline only if mobile filesystem reads prove unreliable.
- Versioning: WASM artifact version pinned in `manifest.json`/`package.json`;
  the plugin refuses mismatched ABI versions (the UAR skill manifest pattern).

## Open questions

1. wasm-bindgen vs component-model-first: start wasm-bindgen, migrate hot
   boundaries to jco later — confirm at implementation time.
2. Bundle ONNX inference in Rust (tract — pure Rust, WASM-compilable) vs
   JS-side onnxruntime-web (spec 005) — benchmark both for embeddings.
3. Do we ever need the optional Rust CLI at all, or does Node 24 + WASM cover
   every desktop need? Default assumption: no CLI unless proven otherwise.
