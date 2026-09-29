# Spec 001 — Cross-Platform Runtime: Node 24+, No Shell Scripts

Status: **spec for later reference — no phases started.**
Supersedes: `scripts/publish.sh`, `scripts/pull.sh` (to be deleted after migration).

## Constraint

This project must run on **mobile (iOS/Android via the Obsidian plugin), desktop
(macOS), and Windows**. Shell scripts are disqualified: they don't exist on
mobile, behave differently across macOS/Linux/Windows (the current scripts
already bit us twice on macOS's bash 3.2 and openrsync), and can't be tested
on one platform with confidence for another.

## The runtime decision

**Node.js 24 or above is the only sanctioned script/CLI runtime**, and TypeScript
is the script language:

- Node 24 strips TypeScript types natively — `.ts` scripts run with no build
  step (`node scripts/publish.ts`). This is the "TypeScript 7 / JavaScript"
  toolchain: plain TS everywhere, `tsgo`/tsc only where a type-check gate is
  wanted in CI.
- One runtime across macOS, Windows, Linux, and CI. No Python-style env drift
  (see spec 004).
- Stable WebAssembly support for the Rust/WASM components (specs 003, 005).
- Distributable as `npx @prometheus-ags/ipfs-sync publish` once the CLI stabilizes.

## The three execution surfaces

| Surface | Platforms | Role |
|---|---|---|
| Obsidian plugin JS | mobile + desktop (all OS) | Sync engine, UI, agent host (UAR-lite) |
| Node 24 scripts | desktop, Windows, CI, servers | CLI parity with plugin ops, automation, tests |
| WASM components | plugin + Node + anywhere | Shared Rust logic: tar/CAR/UnixFS, zstd, sandbox (specs 003/005) |

No logic lives in exactly one surface except by necessity: anything the plugin
needs on mobile must exist as plugin JS or WASM — never as an external script.

## Migration map (when phases start)

| Shell script piece | Node replacement |
|---|---|
| `rsync` staging + `excludes.txt` | `fs.cp(src, dest, { filter })` with the same exclusion list (single shared TS module) |
| `curl` + query-string kubo calls | `fetch` with `URLSearchParams` — same `ipfsRequest()` shape as the plugin; ideally one shared RPC client module consumed by both plugin and Node |
| `python3` URL-encode / JSON parsing | `URLSearchParams`, `JSON.parse` (python dies entirely, spec 004) |
| `tar` extraction on pull | TS tar reader or WASM tar component (spec 003); no external `tar` binary on Windows |
| concurrency (`xargs -P 8`) | `p-limit`-style pool (10 lines, no dep) |
| env vars (`IPFS_RPC_URL` etc.) | same names, read via `process.env` |

## Windows-specific rules

- `node:path` everywhere; no POSIX path literals; drive-letter-safe.
- No `/tmp` assumptions — `node:os` tmpdir.
- LF line endings enforced via `.gitattributes` (`* text=auto eol=lf`).
- Zero native npm dependencies for the CLI (pure TS).

## Acceptance criteria (for the phase that implements this)

- `node scripts/publish.ts` and `node scripts/pull.ts` pass the same
  end-to-end fixture test the shell scripts pass today.
- `scripts/*.sh` deleted; `bash-32-compatible-scripts` constraint removed from
  `.kbd-orchestrator/constraints.md`.
- Plugin + CLI share one kubo RPC client module (single source of truth for
  the proxy quirks documented in README §node-quirks).
