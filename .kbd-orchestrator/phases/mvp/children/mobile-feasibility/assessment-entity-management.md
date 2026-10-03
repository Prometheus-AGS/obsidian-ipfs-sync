# Assessment: "prometheus entity management"

## Finding

The term refers to a real, published library: **Prometheus Entity Management (PEM)**, npm `@prometheus-ags/prometheus-entity-management`, repo `github.com/Prometheus-AGS/prometheus-entity-management` (local clone `/Users/gqadonis/Projects/prometheus/prometheus-entity-management`). It is the Prometheus-owned replacement for TanStack Query, and it is built on Zustand. This matches the operator's phrase ("not tanstack react-query", "alongside Zustand") exactly.

Evidence that this is the intended meaning (not a guess):
- Binding decision note `/Users/gqadonis/Projects/hybrid-mobile-architecture-portable/.prometheus/knowledge/wiki/prometheus-entity-management-3-x-replaces-tanstack-query.md`: "Do not install or recommend `@tanstack/react-query`"; "Zustand owns client/UI state such as selection, filters, navigation state, and streaming state"; PEM owns the normalized entity graph, request dedup, mutations, relations, local-first persistence.
- Skill `~/.claude/skills/prometheus-entity-skills` (and ~40 `entity-*` sub-skills) all target `@prometheus-ags/prometheus-entity-management`.
- That same note says chat is normalized by PEM, persisted in PGlite (browser) / pglite-oxide (Tauri), with Zustand limited to transient interaction state.

Nothing in `/Users/gqadonis/obsidian/.ipfs-sync` docs/, DESIGN.md or .agents/ mentions it (grep for "entity management", "entity-management", "entity-graph": zero hits). The term comes only from the operator and the global skills.

## Package facts (npm registry, verified this session)

| Item | Value |
|---|---|
| `@prometheus-ags/prometheus-entity-management` | 4.0.2, MIT, 8.4 kB. A compatibility alias: re-exports `@prometheus-ags/entity-graph-react` ^4.0.2 |
| `@prometheus-ags/entity-graph-react` | 4.0.2, MIT, 1.68 MB unpacked (342 kB tgz). React 19 hooks, CRUD, UI, devtools |
| `@prometheus-ags/entity-graph-core` | 4.0.2, MIT, framework-neutral, no React. Deps: `zustand ^5.0.14`, `immer ^11.1.15` |
| `@prometheus-ags/entity-graph-sync` | 4.0.2, CRDT peers (Yjs / Loro), optional peers |
| `@prometheus-ags/a2ui-react` | 4.0.2, EntityChat / EntityCopilot / EntityStream; deps zod 3.25.76, @a2ui/react 0.10.2; 1.97 MB unpacked |
| Peers (react pkg) | react and react-dom `>=19 <20`; optional `@ag-ui/core`, `loro-crdt`, `@tauri-apps/plugin-sql` |
| Engines | node `^22.14 || ^24 || >=26` (build/runtime for Node; irrelevant in WebView) |
| Format | ESM only (`.mjs`), `sideEffects` only for devtools/auto |

Version discrepancy: the hybrid-mobile-architecture binding decision says "3.x". The registry `latest` is 4.0.2 (3.2.0 is the `next` tag). `4.0.0` moved to ESM-only. If the project must follow the written 3.x rule, pin 3.2.0; otherwise the decision note is stale. Operator question below.

README claims: normalized entity graph, one canonical record at `type + id`; lists hold ordered IDs; local optimistic patches kept separate from canonical state with rollback; adapters for REST, GraphQL, WebSocket, Supabase, Flint, ElectricSQL/PGlite, SurrealDB live, Convex, Tauri SQLite; framework-neutral core plus React/Svelte/Solid/Flutter bindings.

## API surface (from the 4.0.2 `.d.ts`)

- Hooks: `useEntity`, `useEntities`, `useEntityList`, `useEntityQuery`, `useEntityMutation`, `useEntityView`, `useEntityCRUD`, `useEntityListAsTable`, `useEntityAugment`, `useGraphSyncStatus`, `useGraphStore`, `useGraphStoreApi`, `useGraphDevTools`, `useGQL*`.
- Core: `createGraphStore`, `registerEntityTransport`, `startLocalFirstGraph` (hydrate, persist, replay pending actions with retry), `createPGlitePersistenceAdapter`, `applyAgUiSnapshot`, `applyAgUiDelta`, adapters (Electric, Flint, Surreal live, WebSocket, Supabase, Convex).
- Store shape: `entities[type][id]` canonical, `patches[type][id]` optimistic overlay, `lists[queryKey].ids`.

## Relation to Zustand

PEM's graph store IS a Zustand store (core depends on zustand ^5 and immer). Intended split per the decision note: PEM for server/entity state, plain Zustand for UI and transient state (selection, filters, streaming buffer). No second Zustand copy is needed beyond what PEM pulls in.

## Streaming chat coverage (messages, tool calls, runs)

Partial; not a chat-state model.
- Core ingests only AG-UI `STATE_SNAPSHOT` and `STATE_DELTA` (RFC-6902) into entities via `applyAgUiSnapshot` / `applyAgUiDelta`, with a user-defined `AgUiStateMapping`. There is no first-class handling of `TEXT_MESSAGE_*`, `TOOL_CALL_*` or `RUN_*` events in core (grep of core d.ts found none).
- `a2ui-react`'s `useChatSession` (source read) keeps the message list in **React `useState`, "not the entity graph"**, handles a `StreamEvent` async iterable, and forwards only state snapshot/delta to the graph. Tool calls go through an optional `EntityToolProvider`.
- Conclusion: messages/streaming/tool-call/run lifecycle would be the app's own Zustand state (consistent with the decision note), with PEM persisting normalized conversation entities if we model them (conversation, message, run, tool-call as registered entity types). That modeling is our work, not provided.
- `a2ui-react` is heavy (1.97 MB unpacked, brings @a2ui/react, zod); not needed for a plugin chat UI.

## WebView safety and bundle impact

Measured in scratch only (`.../scratchpad/entity-research/bt`, esbuild, minified, react/react-dom/optional peers external; nothing installed in the project):
- Core only (`createGraphStore`, `registerEntityTransport`): 19.6 kB min / **7.1 kB gzip** (includes zustand + immer).
- React package with four hooks/functions imported: 91.8 kB min / **29.7 kB gzip**. Breakdown by bytes: tailwind-merge 27 kB, @tanstack/table-core 28 kB, immer 9 kB, core 14 kB, react pkg 11 kB, zustand 1.7 kB. Tailwind-merge and table-core are dragged in by the React barrel (CRUD/UI), not by the hooks themselves; tree-shaking did not drop them. Importing from core and writing thin hooks would avoid ~55 kB, but then the React hooks are not used.
- No Node built-ins found in dist; code is browser-oriented (PGlite, Tauri SQL adapters are optional). `@tauri-apps/plugin-sql` is not applicable in Obsidian (Electron desktop / Capacitor mobile); use the PGlite adapter or a custom `GraphPersistenceAdapter`. Not tested on iOS/Android WebView; PGlite on Obsidian mobile is a separate unverified question.
- Fit with our CLAUDE.md "Verify dependency versions against official sources": version above is from the registry; not yet pinned in `versions.toml`.

## Other candidates considered

- `prometheus-entity-sync` (Rust, Postgres/PGlite/SQLite replication sync engine, 0.1.0): server-side sync, not UI state.
- `Prometheus-AGS/hybrid-mobile-architecture` skills `pem-local-first`, `entity-graph-web-shell`: usage guidance for PEM, not separate libs.
- `surreal-memory` MCP "entities": agent memory graph, unrelated.
- TanStack DB / TanStack Query: what PEM explicitly replaces (`docs/tanstack-comparison.md`).
No competing meaning found.

## Questions for the operator

1. Pin 3.2.0 (matches the written decision) or adopt 4.0.2 (current latest, ESM-only)?
2. Is the 55 kB of tailwind-merge/table-core in the React barrel acceptable in the plugin bundle, or should we use core plus our own thin hooks?
3. Are chat messages, runs and tool calls to be PEM entities (persisted, normalized) or only Zustand transient state? PEM does not model them.
4. Persistence: PGlite in an Obsidian mobile WebView is unverified; should the plugin use PEM with a custom adapter over the vault/embedded store (spec 006) instead?
5. Is the Obsidian plugin governed by the hybrid-mobile-architecture rule at all (it mandates shadcn, assistant-ui, Flat 2.0)?
