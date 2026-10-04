---
paths: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/package.json', '**/tsconfig.json']
---

# TypeScript

Loaded when a TypeScript or JavaScript file is read. Not resident.

Batch implementation until a production path is complete. Use a narrow type check
earlier only when it is needed to unblock work. At a completed change boundary, run
the smallest browser, API, process, or build integration that exercises the real
entry point and collaborators. Unit, component-only, snapshot, and per-edit tests are
not completion evidence. Reserve broad end-to-end, visual, and bundle gates for the
final applicable phase or release boundary.

## Hard rules

- **TypeScript 7 is the pinned toolchain** (`versions.toml` → `typescript =
  "7.0.2"`). The 5.x line is disqualified. `tsc --noEmit` is the real type
  gate — bundlers strip types without checking them, and a green bundle build
  proves nothing about types.
- Cache `.tsbuildinfo`. Incremental typecheck drops substantially with it.
- Watch mode and per-edit test loops are not completion gates.
- Keep e2e to the flows where failure costs money, not to everything reachable.

## Structure

Organize by capability under `features/<domain>/`, not by technical layer.
Layer order is UI, then hooks, then stores, then services, then external. A
component does not import, read, or mutate a store, and does not call a
service. See "Layering rule" below for the five allowed edges.

Components render and submit intent. No business rule exists only in a
component. No browser storage in artifacts.

## Project conventions (ipfs-sync)

These are project policy, recorded in `versions.toml` and the phase specs
under `docs/`:

- **Clean architecture, every layer.** UI (`src/`) → hooks/stores → services →
  external clients (`kubo RPC`, IPFS). Dependencies point inward only:
  outer layers import inner abstractions, never the reverse. The shared kubo
  RPC client (spec 002) is the only sanctioned external boundary — plugin code
  and CLI scripts consume it, they do not speak HTTP to kubo themselves.
  Cross-feature imports are prohibited; features communicate through the
  typed `EventBus` (spec 007), not by reaching into each other's internals.
- **Layering rule (React, Zustand, entity management).** Operator rule,
  2026-10-04: components talk only to hooks, hooks talk to stores, stores talk
  to services and APIs. Components never talk to stores. The five edges:
  1. Components import only hooks (and view models). Never a store, never a
     service, never `obsidian`.
  2. Hooks import stores (selectors and store actions) and the PEM React hooks
     from `@prometheus-ags/prometheus-entity-management` 4.0.2. They are the
     only place those are called. Hooks do not import services.
  3. Stores are vanilla `zustand` plus the PEM core, with no React. They are
     the only layer that calls services and APIs: their actions call the
     service and update state.
  4. Services import no React, no `zustand`, and no stores.
  5. The sync core (`src/sync`, `src/kubo`, `src/crypto`, `src/core`) imports
     none of the above.

  The same chain holds if a view is native DOM instead of React: view, then
  view model or hook, then store, then service. Enforced by
  `tools/check-layering.mjs` (chat-02 task 2.1).
- **Kebab-case for every TypeScript/JavaScript file.** All `.ts`, `.tsx`,
  `.js`, `.mjs`, `.cjs` files — source, CLI scripts, tests, fixtures. No
  camelCase, PascalCase, or snake_case file names. Exported symbols follow
  normal TS conventions; only file names are kebab-cased. (Dot-segments in
  config names like `esbuild.config.mjs` are fine.)
  Check before committing — any output means a violation:
  `git ls-files | grep -E '\.(ts|tsx|js|mjs|cjs)$' | grep -E '(^|/)[^a-z0-9./-]+|_'`

<!-- Replace example boundaries with this project's real production-path gates. -->
