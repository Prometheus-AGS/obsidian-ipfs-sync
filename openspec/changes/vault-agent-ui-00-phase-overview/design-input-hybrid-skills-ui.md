# Design input: hybrid-mobile-architecture skills, React/UI half

Status: advisory input, not authority. Nothing here is decided. Written 2026-10-04 by uiux-lead (read-only study; nothing installed, no scaffold or generator run, no skill invoked as an executor, nothing in the hybrid repo touched). Companion (data half, written by another agent): `design-input-hybrid-skills-data.md` in this directory. This file edits no other file; section 4 is a list of proposed amendments for the planning agent, who owns README, tasks and decisions-needed.

Operator instruction (2026-10-04): use the hybrid mobile skills to help with the React and PGlite design. This file takes the React/UI half: ten skills, plus the docs they cite.

## Source legend

| Tag | Meaning |
|---|---|
| `H:` | `/Users/gqadonis/Projects/hybrid-mobile-architecture-src`, HEAD `c9b3e2d` (2026-09-27). Read-only. Its only uncommitted edit that I looked at is `skills/pem-local-first/references/tauri-patterns.md` (3 lines: PEM 3.x to 4.0.2 and a package rename; `git diff`, 2026-10-04). That edit is not mine and is not repeated here as a decision. |
| `O:` | this repository, HEAD `871257c` on `main`, read 2026-10-04. The branch changed from `mvp-07b-guard-removal` to `main` during my session and `docs/design/` plus `docs/012-vault-agent-ui.md` were committed (871257c) while I read; I first read the byte-identical copy under `.prometheus/cadence/sources/` (checked with `cmp`, all eight design files identical to `docs/design/`). |
| `npm:` | `npm view` output, 2026-10-04 (reading agent). |
| `unpkg:` | file fetched from unpkg for the exact version named, 2026-10-04 (type declarations and README of a published package). |
| `docs.obsidian:` | page fetched with the firecrawl scrape tool on 2026-10-04 (developer docs). |
| `dts:` | `node_modules/obsidian/obsidian.d.ts` (obsidian 1.13.1). |
| `ctx7:` | Context7 query result, library `/websites/base-ui_react`, 2026-10-04. |
| UNVERIFIED | not confirmed by any of the above in this session. |

## 0. The uncomfortable part first

1. **The skills target a different app.** They exist for Tauri, Flutter and Rust-FFI apps whose single invariant is that networking, LLM calls, inference and persistence live in a Rust crate and the UI never does them (`H:AGENTS.md:46-55`). We have a single-file `main.js` in an Obsidian WebView with no Rust, no IPC, no Tauri `invoke()`, no Flutter, and a TypeScript service layer. Every sentence in those skills about `invoke()`, `listen()`, Tauri commands, `flutter_rust_bridge`, pglite-oxide, SQLite-over-FFI, Riverpod, goldens, or Axum `VerifiedSession` is out of scope for us. What transfers is the discipline (layering, exhaustiveness, token roles, a11y checklist, event semantics), not the stack.
2. **The hybrid repo disagrees with itself on the PEM version.** `SKILL.md`, `decisions.md` and `AGENTS.md` still say "Prometheus Entity Management 3.x" (`H:skills/pem-local-first/SKILL.md:3`, `decisions.md:51`, `AGENTS.md:217`), while `H:versions.toml:46` and the uncommitted `tauri-patterns.md` edit say 4.0.2 and the edit renames the package to `@prometheus-ags/entity-graph-react`. Our plan already says 4.0.2 and `@prometheus-ags/prometheus-entity-management` (`O:openspec/changes/chat-00-phase-overview/README.md:12,85`). npm confirms the second name is an alias of the first (section 3, K1).
3. **Two hybrid rules collide with our operator-reviewed design authority** and would be applied silently by an agent that runs the skills as executors: Flat 2.0 (no borders anywhere, `H:skills/reference-ui-fidelity/SKILL.md:69-71`, `H:skills/hybrid-design-tokens/SKILL.md:68-69`) against the concept's hairlines (`O:docs/design/vault-agent-ui-concept.md:279-280,285`); and a brand token source with hex values (`H:assets/templates/design-tokens/tokens.toml`, for example `canvas = "#0D0D18"` in `[dark.surface]`, and an `accent` role with its own hue) against "no hex values, the user's accent is the only accent" (`O:docs/design/README.md:51-53`).
4. **Hybrid's own reference code breaks our layering rule.** Its example entity hook imports an API service (`H:skills/pem-local-first/references/tauri-patterns.md:160`), its feature hook imports another feature's store (`:183`), and its stores use the React-bound `create` (`:96`). Our edges forbid all three (`O:.claude/rules/typescript.md:48-65`). An agent that copies the example fails `check:layering` (planned, chat-02 2.1).
5. **The one thing that is better than we assumed:** the PEM APIs the skills name exist in 4.0.2 with the shapes the skill describes (section 2.1, `unpkg:` type declarations). The thing that is worse than we assumed: PEM persistence is a whole-graph JSON snapshot behind a three-method key/value adapter, not per-entity rows, which changes how chat-03 should read "entities persisted in PGlite" (section 2.1, amendment A7).

## 1. Per skill

Format: what it prescribes (file:line), whether it applies to an Obsidian plugin (single-file `main.js`, WebView on desktop and mobile, lazy-mounted React island, `minAppVersion` 1.12.3, no Node built-ins in `src/`, hook-isolation lint) as opposed to the Tauri/Flutter apps it targets, and what must be adapted.

### 1.1 pem-local-first

Prescribes (`H:skills/pem-local-first/SKILL.md`):
- PEM is the only client entity layer; TanStack Query/DB, SWR, Apollo cache are prohibited, with an audit that fails a scaffold depending on them (:14-21; ADR-LFS-4 `references/decisions.md:49-61`).
- Stack per surface: Component, Hook, PEM hooks/Zustand, transports, local store (:25-27). Zustand holds only transient interaction state (selection, filters, stream buffers); anything durable is a PEM entity (:33-34, :79).
- Wiring recipe: schema first with client-UUID `id`, `tenant_id`, `updated_at` and a declared privacy class (:38-39); `registerEntityTransport(type, transport)` where the transport reads the local store, honours `ListQuery`, never opens sockets (:40-44); `createPGlitePersistenceAdapter` plus `startLocalFirstGraph` once at the runtime boundary (:45-47); features reach PEM through their `hooks/` layer and components never call stores or `invoke()` (:48-49).
- One queue, not two: mutations write the local store and enqueue in `_operation_queue`; pending state reads the queue; `DEAD_LETTER` rolls back visibly (:51-57).
- Conversations are the canonical durable example; streaming deltas live in Zustand until the block finalizes, then the entity write commits (:67-72).
- Checklist (:74-81).

Applies to us:
- Yes: PEM-only and no TanStack Query (already our rule, `O:chat-00-phase-overview/README.md:96` "must not appear" list); the transport pattern; stream-in-zustand-then-commit (equals `O:chat-03-chat-shell-and-entities/specs/chat-entities/spec.md` "Persistence policy"); declared privacy class per entity type; checklist items "Durable data = PEM entity, Zustand = transient", "Transport reads local store only".
- No: `tenant_id`, `_operation_queue`, server authority (`H:references/doctrine.md:45-48`, LFS-INV-1) because chat, providers and collections have no sync plane; pglite-oxide, SQLite FFI, Tauri commands, the Dart PEM package (:30-31, :72); "persistence wired once at runtime boundary via PGlite" is not available for chat while D15 is open (`O:decisions-needed.md:192-204`).

Adapt: section 2.1 (structure under our five layering edges, a non-PGlite persistence adapter for the session-only default, privacy class as a typed constant).

### 1.2 entity-graph-web-shell

Prescribes (`H:skills/entity-graph-web-shell/SKILL.md:10-27`): components import feature hooks, never transports, `fetch` or raw stores (:12); hooks select normalized entities and expose intent-level operations (:13); one transport per entity type and every mutation returns canonical entities so all subscribed views converge (:14-15); PGlite is a projection and queue, not an authorization source (:16); Axum derives tenant and actor from `VerifiedSession` (:17); agent actions enter through the UAR gateway and UI never owns agent lifecycle or tool execution (:18-19); unknown entity kinds stay inspectable (:20). Verification list (:24-28): no direct network or IPC in components; create/update/delete across two subscribed views; restart and verify projection recovery; deny cross-tenant access at the server; idempotent offline replay preserving causal order.

Applies: invariants 1, 2, 3, 6 (as "UI never owns tool execution", which matches `O:chat-05-a2ui-host-integration/proposal.md:9`), 7 (matches the `unknown` part, chat-03). Not: 4 as a storage claim (no PGlite for chat yet), 5 and the cross-tenant check (no server of ours; single user per vault). The verification list is usable as BDD scenarios (section 2.7).

Adapt: replace "Axum boundary" with "service layer behind the store"; replace "two subscribed views" with "two React roots" (view tab and quick-ask Modal root, or settings-tab root and view root), which is where our convergence risk lives (A9).

### 1.3 content-block-ui

Prescribes (`H:skills/content-block-ui/SKILL.md`): `ContentBlock` is the single cross-platform UI contract with 11 variants (:13-33); the TypeScript mirror is generated from Rust and never edited by hand (:35-37); rendering rules: exhaustive `switch` with a `never` guard, no `if/else` chain (:41-46); one component per variant and a dispatcher that only switches (:47-49); streaming variants render the partial state with a caret and compositor-only animation (:50-52); `toolUse` and `skill` render a status map `pending, running, complete/failed`, input and summary behind a disclosure, never raw JSON (:53-55); `image` has explicit `width`/`height` and mandatory `alt` (:56-57); block state flows through the store and a `useChat`-style hook (:58-61); adding a variant is a 7-step Rust, Dart, TypeScript change (:63-74).

Applies: rules 1 to 5 as conventions. `chat-04` 2.1 already requires the exhaustive registry (`O:chat-04-spec-010-rendering/tasks.md` task 2.1). Not: Rust ownership, generated mirrors, `references/rust/new-block-type.md`, `flutter_rust_bridge`, and the package `@prometheus-ags/gen-ui-react` (:48), which returns 404 on npm (`npm view @prometheus-ags/gen-ui-react`, 2026-10-04), so it cannot be a dependency of ours.

Adapt: our union is the spec 010 part kinds, not the 11 variants (mapping table in section 2.3). Add a status attribute next to `data-chunk-kind` so status is machine-readable and not color-only (A5).

### 1.4 hybrid-design-tokens

Prescribes (`H:skills/hybrid-design-tokens/SKILL.md`): one token source (`tokens.toml`) generating a Tailwind 4 `@theme` file and a Dart class, never hand-edited (:17-39); generation exists because hand-mirroring drifted (`#0D0D18` against `#0B0F14`, :29-35); tokens are named by role not hue (:41-51); light and dark define the same names so no component branches on theme (:53-58); categories: color, spacing scale, at most two font families, radius and motion (:60-69); strict Flat 2.0, no borders or layout shadows (:68-69); rules: no magic values in components, both themes intentional, semantic naming, cross-surface parity, ContentBlock styling from tokens (:71-83).

Applies: naming by role (:41-51), "same names in light and dark" (:53-58; Obsidian does this natively through `.theme-dark`), "no magic values in components" (:73-74), and the lesson that a mechanism beats an aspiration (:35-37; our mechanism is the planned `check:styles`, `O:vault-agent-ui-01-foundation-react-shell-and-spike-gate/design.md:20`). Not: the TOML source and generator (`H:scripts/gen-design-tokens.mjs`; there is one surface and no Dart), the hex palette in `tokens.toml`, the brand `accent`, the `theme.css` `:root`/`@theme` emission, Flat 2.0, and two font families (we ship no font, `O:docs/design/README.md:51-53`).

Adapt: section 2.4. The product's tokens are Obsidian's, aliased onto shadcn names on the root class, gated by script (`O:decisions-needed.md:147-176`, D12).

### 1.5 a11y-gate

Prescribes (`H:skills/a11y-gate/SKILL.md:17-34`): contrast AA in both themes on resolved pairs; accessible name on every actionable element; keyboard operable with visible focus and no trap; alt on media; reduced motion honoured; streaming and status announced in live regions politely; target size at least 24 by 24 CSS px (AA 2.5.8), 44 recommended for primary touch; status not by color alone. React notes: semantic HTML first, axe at review time but never sufficient, do the keyboard walk (:36-40). A `PostToolUse` hook only reminds (:49-54).

Applies: the checklist nearly verbatim. It agrees with `O:.agents/UI_UX_PROTOCOL.md` (24 px AA floor, 44 px as a project preference) and with the concept (`O:docs/design/vault-agent-ui-concept.md:318-327`: sentence-level live region, percent as text, Cancel first, Escape means no). Not: the Flutter `Semantics` section (:42-47) and the advisory hook (our protocol says no per-edit hooks, `O:.agents/UI_UX_PROTOCOL.md` "No per-edit hooks"). Also not addressed by the skill: which control gets initial focus in a confirmation dialog (it only forbids traps), which is the 07b rule. Section 2.5 merges the two.

### 1.6 mobile-navigation

Prescribes (`H:skills/mobile-navigation/SKILL.md`): top-level destinations in a bottom bar on every platform, rail by width not OS (:13-15); tabs are for related content inside one destination (:29-43); breakpoint 600 px, set via `--breakpoint-sm` (:51-58); red flags: platform checks in nav code, UA sniffing, a top tab bar for app-level destinations, nav state mirrored into a store, two destination lists (:60-68); React recipe with two labelled `nav` landmarks, `env(safe-area-inset-bottom)`, active route derived from the router and exact-matching the index route (:99-120).

Applies: very little. Obsidian owns app-level navigation (sidebar, ribbon, mobile drawer). Our Search/Chat/Index strip is "content switching within one destination" inside one `ItemView`, which the skill itself says belongs on top, subordinate to the shell (:37-43). The control center's six sections are a list with a horizontal scroller on mobile (`O:docs/design/vault-agent-ui-concept.md:262-264`). What transfers: the red-flag list (especially "nav state mirrored into a store", which our slice 01 does, K9/A1), one destinations list, label landmarks distinctly, derive the active item from its single source. The 600 px window breakpoint does not transfer (K10, A16). Bottom sheets: the skill does not cover them at all (no occurrence of "sheet" in `SKILL.md`; checked by reading it end to end).

### 1.7 reference-ui-fidelity

Prescribes (`H:skills/reference-ui-fidelity/SKILL.md`): treat the reference as an acceptance oracle (:13-16); discover the authority set and record precedence, where a newer user instruction beats an older mockup mechanic (:18-34); build a coverage matrix before code over destinations, themes, form factors, data states, interaction states and runtime states (:36-50); extract the visual grammar (:52-62) with Shadcn and Assistant UI and strict Flat 2.0 (:64-71); real architecture behind the visuals (:73-86); screenshot-driven convergence loop (:88-103); completion gate (:105-118).

Applies: the authority-set step, the matrix and the screenshot loop map onto our exit criterion 5 (320/375/768/1024, light and dark, real content, focus, reduced motion; `O:vault-agent-ui-00-phase-overview/README.md:105`) and add the missing axes: data states and runtime states per row (A18). The precedence rule is exactly what D1 applied to the "no React" sentences. Not: Flat 2.0 (:69-71, :113) and "remove border/shadow defaults before judging fidelity" (:70-71), which would delete the concept's hairlines (K3); "local inference is the first working lane" (:85) which our README contradicts (no model exists, D10); Flutter, goldens, Tauri; "a clean-checkout launch" (:117) needs translating to a BRAT install. Important adaptation: our screens (`docs/design/*.html`) are vanilla HTML. They are the oracle for behaviour and copy, not for DOM or component structure (decision S7, `O:decisions-needed.md:66`).

### 1.8 a2ui-surface-contract

Prescribes (`H:skills/a2ui-surface-contract/SKILL.md:10-22`): A2UI describes a projection and grants no authority; parse a versioned discriminated envelope; render only registered component types with validated props; keep unknown events as inspectable artifacts; route actions back through UAR with run, event and idempotency IDs; show pending approval, cancellation, denial, failure and resumed states; never execute tool calls, routing or policy in the UI; sanitize rich content and external URLs; verification list (duplicate events, unknown events, restart continuation, malformed props, denied actions, cancellation).

Applies: fully as policy, and it matches `chat-05` (`O:chat-05-a2ui-host-integration/proposal.md:9-10`: textContent only, scheme allowlist, gesture-only actions, unknown component placeholder). Gaps in chat-05 against it: idempotency and event IDs on actions, denied and resumed states, malformed-props test (A13). Caveat: this skill uses "A2UI" in Google's sense (surfaces, components, actions); `content-block-ui` and `tauri-patterns.md` use "A2UI event" for the stream that becomes ContentBlocks (`H:skills/content-block-ui/SKILL.md:13-14`, `tauri-patterns.md:73-74`). The hybrid repo lists "A2UI naming" as an open decision (`H:skills/pem-local-first/references/decisions.md:78`, OD-1). We must not import the second sense (section 2.3).

### 1.9 agui-event-contract

Prescribes (`H:skills/agui-event-contract/SKILL.md:11-24`): envelope with protocol version, event ID, run ID, sequence, timestamp, type, typed payload, optional causal parent; event IDs stable across retries; apply idempotently and in sequence; resume with the last committed event ID; represent approval, denial, cancellation, timeout, failure explicitly; redact tool I/O by policy; keep unknown types and never treat them as success; never infer completion from prose; tests for disconnect/reconnect, duplicate and out-of-order events, restart recovery, slow consumers, cancellation races, unknown versions, replay.

Applies: the semantics and the test list. Assumption to check, not adopt: that UAR's AG-UI stream carries event ID and sequence. Spec 002 lists AG-UI events as `RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT` (`O:docs/002-agui-a2ui-client.md`, "AG-UI") and the exact UAR endpoint surface is unconfirmed (same file, "Local UAR evidence"). chat-03 2.1 records the wire facts from a running UAR; whether `eventId` and `sequence` exist is a question it must answer (A12). "Never infer completion from prose" is the same discipline as P1 (`O:decisions-needed.md:242`).

### 1.10 mini-app-module

Prescribes (`H:skills/mini-app-module/SKILL.md:10-30`): a versioned feature boundary with a manifest (stable module ID, version, routes, entity types, capabilities, policy actions, event contracts, migrations) validated by the shell before mounting; presentation depends on domain interfaces; cross-module communication through typed events or shared entity references; a module cannot import another module's store or component tree; capability requests deny by default; done means manifest rejection, lazy-load failure, route isolation, entity cleanup, permission denial, upgrade compatibility are tested and the module can be disabled without breaking the host.

Applies: the boundaries and the "can be disabled without breaking the host" test, which generalizes our preview gate (P2) per feature. Not: routes (we have tabs and commands, not a router), policy actions and a capability deny-by-default engine (no policy engine exists; building a manifest validator now would be speculative, which `O:CLAUDE.md` "Evidentiary standard" bars), Axum enforcement. Cross-feature rule matches `O:.claude/rules/typescript.md:41-46` (features talk through the typed `EventBus`, spec 007).

Adapt: a typed `FeatureDescriptor` constant per slice (id, tabs, commands, entity types) read by the shell and the layering lint, plus a per-tab error boundary that proves lazy-load failure does not take the view down. Nothing more until a second consumer exists.

## 2. Adoptable patterns

All patterns obey the five edges of `O:.claude/rules/typescript.md:48-65`: components import only hooks; hooks import stores and PEM React hooks, never services; stores are vanilla zustand plus PEM core and call services; services import no React, zustand or store; the sync core imports none of them.

### 2.1 PEM, zustand and hooks for chat, collections and providers

Verified API facts (`unpkg:` `@prometheus-ags/entity-graph-core@4.0.2` and `entity-graph-react@4.0.2` `dist/index.d.ts`, 2026-10-04):
- `registerEntityTransport<T>(type, transport)` exists. `EntityTransport<T>` requires `identify(row)`, `authoritative: boolean`, `list(q: ListQuery)`; optional `get(id, signal)`, `subscribe(onChange) => teardown`, `staleTime`. `ListQuery` has `filter`, `sort`, `search`, `limit`, `cursor`, `signal` and transports must honour `signal`. The registry is process-global and re-registering replaces silently (core d.ts, doc comments above `registerEntityTransport`).
- React hooks `useEntities(type, opts)` and `useEntityQuery(type, opts)` read the registered transport; `useEntityMutation({ type, mutate, normalize, optimistic, invalidateLists, onSuccess, onError })` returns `{ mutate, trigger, reset, state }` where `mutate` is a caller-supplied function (react d.ts, `MutationOptions`).
- Non-React write path for a store: `createGraphTransaction(storeApi?)` returns `upsertEntity`, `replaceEntity`, `patchEntity`, `removeEntity`, `markEntityPending`, `markEntitySynced`, `commit`, `rollback`, `snapshot`; `createGraphAction({ key, optimistic, run, onSuccess, onError })` wraps it (core d.ts).
- Persistence: `GraphPersistenceAdapter { get(key), set(key, value), remove?(key) }` (string values), `startLocalFirstGraph({ storage, store?, key?, replayPendingActions?, onlineSource?, persistDebounceMs?, retryPolicy?, scope? })` returns `{ ready, dispose, persistNow, hydrate, getStatus, scope }`; `createPGlitePersistenceAdapter(pglite, { tableName })` stores the snapshot in a table named `_graph_snapshot` by default and takes any client with `query` and `exec` (core d.ts; README of `entity-graph-react@4.0.2`, "v1.3.0 new APIs").
- `GraphSyncStatus.phase` is `idle | hydrating | syncing | ready | offline | error`, with `isOnline` and `pendingActions`; `onlineSource` is injectable (core d.ts).
- Core declares no `react` peer; its only dependencies are `immer` and `zustand`, and its types reference `zustand/vanilla` (`npm view @prometheus-ags/entity-graph-core`, d.ts). The React package depends on `clsx`, `immer`, `zustand`, `lucide-react ^1.28.0`, `tailwind-merge ^3.6.0`, `@tanstack/table-core ^9.2.4`, `@tanstack/react-table ^9.2.4`, `@tanstack/react-virtual ^3.14.9` (`npm view @prometheus-ags/entity-graph-react`). That is a larger transitive set than `chat-00` recorded (it names tailwind-merge and table-core only; `O:chat-00-phase-overview/README.md:133`). `@prometheus-ags/prometheus-entity-management@4.0.2` depends only on `entity-graph-react ^4.0.2` (`npm view`). `entity-graph-react` lists `entity-graph-core ^4.0.2` as a non-optional peer; the package README tells consumers to install core explicitly so the app owns one graph instance (`unpkg:` README, "Quick start"). How pnpm 12.8.1 resolves that peer is UNVERIFIED (chat-02 1.2 `pnpm why` covers it).

Structure (names are proposals; owners confirm; layer-first top directories follow `O:chat-02-foundation-and-layering/design.md:5-17`):

```
src/ui/<feature>/components/     presentational; import hooks only
src/ui/<feature>/hooks/          useEntities / useEntityMutation / zustand `useStore(store, selector)`;
                                 pass STORE ACTIONS as `mutate`; never import a service
src/data/<feature>/              vanilla `createStore` from `zustand/vanilla`; entity types and guards;
                                 registerEntityTransport(...) at store init (once); transports call a service;
                                 flush path = createGraphTransaction(graph).upsertEntity(...).commit()
src/agents/<x>/ (services)       fetch/SSE, providers, index port; no React, zustand, store, obsidian
src/plugin/                      Obsidian-aware host: creates graphs and stores once, passes ports to the mount
```

How the hybrid pattern changes under our layering:
1. The `mutate` function that `useEntityMutation` requires is a store action (stores call services), so the hook never touches a service. The hybrid example passes `memoryApi.write` directly from a hook-layer file (`H:.../tauri-patterns.md:160-161,167`); that is the exact edge we forbid.
2. `registerEntityTransport` lives in the store layer, called once from store creation, not from a hook or component. Hybrid says "register once at the store/runtime boundary" (`H:tauri-patterns.md:88`), which agrees.
3. The transport for chat reads an in-memory repository (session-only default, D15) or, if the ruling allows persistence, the persisted graph. `authoritative: true` (local copy is the truth) is correct for chat, providers and collections (core d.ts doc comment on `authoritative`).
4. Streaming: the store keeps the in-flight buffer; at part boundaries it commits one transaction. `persistDebounceMs` on `startLocalFirstGraph` bounds snapshot writes. Because the adapter stores the whole graph snapshot under one key, write cost grows with total graph size, not message size (amendment A7; spike S5 must record snapshot bytes, not only message counts).
5. Entity types and where they persist (proposal):

| Feature | Entity types | Durability | Persistence adapter | Source |
|---|---|---|---|---|
| chat | `Conversation`, `Message`, `Run`, `ToolCall` (`O:chat-03-chat-shell-and-entities/specs/chat-entities/spec.md` "Entity types") | session-only until the D15 ruling | an in-memory `GraphPersistenceAdapter` (three methods) in `src/data/chat`, swappable for `createPGlitePersistenceAdapter` after the ruling and mvp-08 | d.ts; `O:decisions-needed.md:192-204` |
| providers | `Provider` record holding a secret id, never the secret (`O:vault-agent-ui-02-llm-connections/design.md` "Provider interface"; L2) | durable authored data, not a cache | an adapter that writes a dedicated plugin data file, separate from the chat graph and from `data.json` auth fields (same reasoning as C6 option B, `O:decisions-needed.md:238`) | |
| collections | `Collection` definitions (C5 membership rules) | durable authored data | same dedicated file; PGlite may mirror, never own (`O:assessment-pglite-collections.md` s.0 item 7) | |

6. One graph per concern, created outside React and handed to every React root. README of the React package says imperative callers resolve "the module-level store published by a mounted `GraphStoreProvider`" (`unpkg:` README, "Core"). We will mount several roots (view, quick-ask Modal, settings tab, bottom sheet). With several providers mounted, which store the module-level value points to is not specified in what I read; treat it as UNVERIFIED and design so it does not matter: create each graph in the store layer, pass the same `GraphStore` to every root's `GraphStoreProvider`, and never rely on the ambient value (A9).
7. Privacy class: every entity type declares `privacy: "local"` as a typed constant and no type is registered without one (`H:skills/pem-local-first/SKILL.md:38-39`; `H:references/doctrine.md:55-58`, LFS-INV-4 "unknown class means local, never enqueue"). We have no queue, so the control is a test that the publish planner never lists these files (same check as `O:chat-03-chat-shell-and-entities/specs/chat-entities/spec.md` "Vault boundary").
8. The "one queue, not two" rule (`H:SKILL.md:51-57`) does not apply to chat. It will apply the day a message is queued "until online" (concept A2b "Queued until online", `O:docs/design/vault-agent-ui-concept.md:228-230`). Then the offline queue is a store concern with explicit `PENDING`, `IN_FLIGHT`, `SYNCED`, `DEAD_LETTER` states that PEM's `markEntityPending` and `GraphSyncStatus.pendingActions` reflect, not a second JS queue. Not designed here.

### 2.2 assistant-ui external-store runtime adapter shape

Verified (`unpkg:` `@assistant-ui/react@0.15.23` `dist/index.d.ts` and `@assistant-ui/core@0.3.22` `dist/runtimes/external-store/external-store-adapter.d.ts`): `useExternalStoreRuntime` is exported from `@assistant-ui/react` (from a path named `legacy-runtime/.../external-store/`, which re-exports from `@assistant-ui/core/react`). `ExternalStoreAdapter` fields include `messages`, `isRunning` (flows to `thread.isRunning`, otherwise a last-message-status heuristic), `isLoading`, `isDisabled` (also disables the composer input), `isSendDisabled` (input usable, `send()` no-op), `setMessages` (needed so cancel can remove a trailing user message; the doc comment says the adapter owns handing back a removal it makes), `onNew(message): Promise<void>`, `onEdit`, `onDelete`, `onReload(parentId, config)`, `onResume`, `onCancel(): Promise<void>`, `convertMessage(message, idx) => ThreadMessageLike`, `state`, `extras`, `suggestions`, `queue`, `onImport`, `onExportExternalState`, `onLoadExternalState`. Thread-list callbacks `onSwitchToNewThread`, `onSwitchToThread` and `threadId` carry a `@deprecated ... under active development` JSDoc, and `unstable_onBranchChange`, `unstable_persistsHistory`, `unstable_messageRepositoryInstance` exist. The package pulls `radix-ui ^1.6.7`, `zod ^4.6.5`, `assistant-cloud`, `safe-content-frame`, `react-textarea-autosize` (`npm view @assistant-ui/react@0.15.23 dependencies`).

Adapter layout (all inside `src/ui/chat/hooks`, the only place that imports the runtime; `O:chat-02-foundation-and-layering/design.md:23-24`):

```
use-chat-runtime.ts      useExternalStoreRuntime({
                           messages,               // selector over the store, stable references
                           isRunning,              // store run status
                           isSendDisabled,         // no provider configured, or consent missing (L4)
                           convertMessage,         // to-thread-message.ts: store Message -> ThreadMessageLike
                           onNew,                  // store action; never writes entities directly
                           onCancel,               // store action; aborts the service
                           setMessages,            // needed for cancel semantics (d.ts comment)
                           onReload })             // retry
to-thread-message.ts     text -> text; thinking -> reasoning; tool-call -> tool-call part;
                         every other part kind -> custom data part carrying the part id
runtime-contract.ts      type-level file that fails `pnpm typecheck` when the pin moves and a field changes
```

Cautions: (a) `onNew` and `onCancel` call store actions, so the hook imports the store, never the service (edge 2). (b) Pin exactly (`0.15.23`); the hybrid reference still pins `^0.14.27` (`H:tauri-patterns.md:30`), which a caret on a 0.x version does not widen to 0.15, so the hybrid reference is one minor behind our pin. (c) Keep the thread-list adapter out of the first adapter version; its switch callbacks are marked unstable, and D15 keeps the conversation switcher per-session anyway (`O:decisions-needed.md:203`).

### 2.3 Content blocks and AG-UI / A2UI mapping

Vocabulary to fix before anyone copies hybrid code: in hybrid's `content-block-ui` and `tauri-patterns.md`, "A2UI event" means the streamed content event that becomes a `ContentBlock` (`H:skills/content-block-ui/SKILL.md:13-14`; `bridge/a2ui/types.ts` and `bridge/agui/` in `H:tauri-patterns.md:72-75`), while `a2ui-surface-contract` and our spec 002 use A2UI for Google's surface protocol (`createSurface`, `updateComponents`, `data`, `delete`; `O:docs/002-agui-a2ui-client.md` "A2UI"). In our code: AG-UI is the SSE event stream, the reducer turns events into message parts, and A2UI is a surface rendered natively inside an `a2ui-surface` part. Do not create `bridge/a2ui/` for the stream.

| Hybrid variant (`H:content-block-ui/SKILL.md:21-33`) | Our part kind (`O:chat-03.../chat-entities/spec.md` "Entity types") | Note |
|---|---|---|
| `text` (+ `isStreaming`) | `text` (raw markdown source) | streaming is message and run status, not a field on the part |
| `thinking` | `thinking` | collapsed after turn end (spec 010 decisions 5, 8) |
| `code` (`language`, `filename`) | none: a fenced block inside `text`, rendered by chat-04 3.1 | hybrid has a variant; we derive it from markdown, so no `filename` unless the fence info string carries it |
| `citation` | `citation` | |
| `memory` | `memory-recall` | spec 010 decision 9 |
| `toolUse` + `toolResult` (paired by `toolUseId`) | one `tool-call` part referencing a `ToolCall` entity (args text, result text, status) | one entity, not two blocks |
| `skill` | `skill-activation` | never hidden (spec 010 decision 7); hybrid's `skill` has `status` and `outputSummary` |
| `artifact` | no equal | nearest: `a2ui-surface` or `data`; mermaid and SVG arrive through markdown. Open: is an `artifact` kind needed? Not in spec 010's table as far as I read; ask the planning agent |
| `image` | markdown image through chat-04 3.4 | keep hybrid's rule: explicit dimensions and mandatory alt (:56-57) |
| `divider` | none | not needed |
| (none) | `state`, `data`, `confirmation`, `error`, `a2ui-surface`, `unknown` | hybrid's 11 variants have no confirmation, error, state or unknown, though its own standard lists confirmation and state-delta blocks (`H:docs/knowme-ui-ux-standard.md:295-296`); the standard is wider than the skill |

AG-UI to part mapping stays as in `O:chat-03.../agui-runtime-adapter/spec.md` "Event mapping". Additions from `agui-event-contract` to apply there: idempotent apply by event ID if UAR sends one, duplicate and out-of-order tests, an explicit "not resumable, marked interrupted" statement if `Last-Event-ID` resume is not built (A12). Surfaces follow `a2ui-surface-contract`: render only registered components, unknown component placeholder, actions only on user gesture (A13).

### 2.4 Design tokens: shadcn and Base UI onto Obsidian variables

Authority: the design copies and D12, not the hybrid skill. Hybrid contributes naming discipline and the "no magic values" rule. Obsidian variable names below are confirmed against `docs.obsidian:` pages unless marked.

| Hybrid role (`H:hybrid-design-tokens/SKILL.md:62-63`) | shadcn token (D12) | Obsidian variable | Check |
|---|---|---|---|
| canvas / chrome (panel) | `--background` | `--background-secondary` | documented (Colors page) |
| surface | `--card`, `--popover` | `--background-primary` | documented |
| raised | (none in D12) | `--background-primary-alt` ("surfaces on top of primary") | documented; candidate for streaming or expanded regions |
| hover | `--accent` (collision, below) | `--background-modifier-hover` | documented |
| text, muted, faint | `--foreground`, `--muted-foreground` | `--text-normal`, `--text-muted`, `--text-faint` | documented |
| accent (fills, one per surface) | `--primary` | `--interactive-accent` | documented |
| accent (text, links) | link color | `--text-accent` | documented |
| on-accent text | `--primary-foreground` | `--text-on-accent` (accent is dark) or `--text-on-accent-inverted` (accent is light) | both documented; D12 maps only the first (A4) |
| destructive | `--destructive` | `--text-error` / `--background-modifier-error` | documented |
| success, warning | status chips | `--text-success`, `--text-warning`; `--background-modifier-success` | documented; no warning background variable on the Colors page |
| focus | `--ring` | `--background-modifier-border-focus` ("Border color (focus)") | documented; a border variable used as a ring |
| border, input | `--border`, `--input` | `--background-modifier-border` | documented |
| radius | `--radius` | `--radius-s/m/l/xl` = 4/8/12/16 px | documented (Radiuses page) |
| fonts | font tokens | the concept uses `--font-interface` and `--font-monospace`; the Typography page lists `--font-interface-theme`, `--font-text-theme`, `--font-monospace-theme` and not the unsuffixed names | UNVERIFIED in-app; the spike S3 dump must confirm which resolves |
| sizes | scale | `--font-ui-smaller/small/medium/large` = 12/13/15/20 px; `--size-4-*` | type sizes documented; `--size-4-*` UNVERIFIED here (concept only) |
| icons | `lucide-react` | Obsidian `setIcon`/`getIcon` (`dts:` lines 3351, 5689) | icon source is an open pin (S2) |

Rules carried over from hybrid, all compatible with D12:
- Name by role. Our alias names stay shadcn's; the collision to record is that hybrid's `accent` means the primary brand color while shadcn's `accent` is a hover surface (D12 resolved it for shadcn; never map `--accent` to `--interactive-accent`).
- Same names in light and dark. The only theme switch is Obsidian's own variable change; forbid `dark:` utilities and `.theme-dark` selectors in component rules (A3).
- One mechanism, not an aspiration: `check:styles` (slice 01 3.1) is the equivalent of hybrid's generator.
- Contrast: hybrid says re-check on every value change (:57-58). D12 already records the 3.6:1 default-light case; add the light-accent case from `--text-on-accent-inverted` to the measured set (A4).
- `color-mix`: `docs.obsidian:` Colors page states that as of Obsidian 1.13 mixing uses OKLCH and tells themes to use `color-mix(in oklch, ...)` instead of the deprecated `-rgb` variables. `minAppVersion` is 1.12.3 (`O:manifest.json`), so D12's "avoid `color-mix`" stands, and the deprecated `--color-*-rgb` variables are not an alternative.

What not to adopt: `tokens.toml`, the generator, the hex palette, role names such as `ember` (the skill's own counterexample, :44-47), the second font family, Dart parity hashes.

### 2.5 Mobile navigation, bottom sheet and a11y gate usable for our dialogs

Navigation: keep Obsidian's shell. Inside the view, tabs are top tabs (in-page content, `H:mobile-navigation/SKILL.md:37-43`). Derive the active tab from one source (A1). Responsive switches are by container width, not viewport and not OS (A16). Host choice for quick ask (Modal on desktop, bottom sheet on mobile) uses Obsidian's own `Platform.isMobile`/`isPhone` (`dts:` lines 4833, 4858) because the host is a different container type, not different navigation; the hybrid red flag is about nav trees keyed on `isIOS`/`isAndroid` and UA strings (:62-65), which we avoid.

Bottom sheet: no guidance in the ten skills. Sources we have: the concept (`O:docs/design/vault-agent-ui-concept.md:256-258`: grabber, half height expanding to full, input at the top so the keyboard does not cover it, controls at least 44 px), `H:docs/knowme-ui-ux-standard.md:240,361` (a sheet or drawer on narrow screens), and Base UI's `Dialog.Portal` `container` prop (accepts an `HTMLElement`, `ShadowRoot` or ref) plus `Dialog.Popup` `initialFocus` and `finalFocus` (`ctx7:`). Whether shadcn's generated Sheet on Base UI uses `Dialog` is UNVERIFIED (chat-02 1.1 dry run lists the files). Inside Obsidian, whether `env(safe-area-inset-bottom)` is the right inset for a sheet inside Obsidian's mobile chrome is UNVERIFIED; chat-03 3.1 plans `visualViewport`.

Dialog acceptance checklist (merge of `H:a11y-gate/SKILL.md:17-34`, D5, 07b and P4). Applies to every dialog we write; consequence dialogs stay Obsidian `Modal`s (P4, `O:decisions-needed.md:245`); this list is also the review list for any in-view Base UI popover.
- [ ] Contrast at least 4.5:1 (3:1 large text and UI components) on resolved colors in default light, default dark and one theme with a different accent.
- [ ] Every control has an accessible name; icon-only controls have a visible label or tooltip.
- [ ] Tab order equals reading order; no trap; visible focus; Escape closes and means no.
- [ ] Confirmation dialogs: Cancel precedes the confirm control in DOM order and receives initial focus; dialogs with a required field focus the field; after an end state focus returns to Cancel or Close (D5, `O:decisions-needed.md:98-103`). For a Base UI popover use `Dialog.Popup initialFocus={cancelRef}` and `finalFocus` (`ctx7:`; note the documented default: on touch the popup itself is focused).
- [ ] Targets at least 24 by 24 CSS px; 44 px on mobile primary actions (project preference, `O:.agents/UI_UX_PROTOCOL.md`).
- [ ] Status is never color alone; polite live region, once per sentence for streams (`O:docs/design/vault-agent-ui-concept.md:322-324`).
- [ ] Reduced motion removes expand and collapse animation.
- [ ] Key dialogs: no passphrase or key shown or persisted beyond the single generated-passphrase step; a copy control for it clears the clipboard after a fixed short time or does not exist, and never exists on mobile (`O:openspec/changes/mvp-07b-keys-history-guard-release-2/specs/plugin-key-management-ui/spec.md:60`); node-supplied text via `textContent` only.
- [ ] The automated pass (axe) is not completion evidence; the keyboard walk and the screen-reader pass are (`H:a11y-gate/SKILL.md:39-40`).

### 2.6 Obsidian React hosting: ports instead of `App`

Obsidian's own guide mounts React with `createRoot(this.contentEl)`, `StrictMode`, `root.unmount()` in `onClose`, and an `AppContext` carrying the `App` that a `useApp` hook reads (`docs.obsidian:` "Use React in your plugin"). Keep the mount and unmount shape. Replace `AppContext<App>` with a typed `HostPorts` context (open a note, notice, platform facts, key store, `requestUrl`) created by `src/plugin`, read only by hooks, never by components, so components still never import `obsidian` (`O:chat-02.../design.md:23`). For popout windows the element API offers `onWindowMigrated(listener)`, `el.win`, `el.doc` and `activeDocument` (`dts:` lines 212-233, 262-278); chat-02 3.2 plans `ownerDocument` at mount only (A11).

### 2.7 Verification lists that carry over as BDD scenarios

From `H:entity-graph-web-shell/SKILL.md:24-28` and `H:agui-event-contract/SKILL.md:22-24`, restated for us and to be run through the real mount path (`O:vault-agent-ui-00-phase-overview/tasks.md` 0.6): components import no network or host API; one change visible in two React roots; restart recovers the projection or shows the interrupted marker; duplicate event applied once; out-of-order event handled or rejected visibly; cancellation race keeps partial content; unknown event kind stays visible; unknown event version stays visible and is not success.

## 3. Conflicts and drift

Each row: what conflicts, evidence, which side wins and why. "Wins" follows our rule that existing design authority and operator decisions are preserved (`O:.agents/UI_UX_PROTOCOL.md` "Authority and context").

| Id | Conflict or drift | Evidence | Resolution proposed |
|---|---|---|---|
| K1 | PEM version and package name. Hybrid prose says 3.x; hybrid `versions.toml` and an uncommitted edit say 4.0.2 and `@prometheus-ags/entity-graph-react`; ours says 4.0.2 and `@prometheus-ags/prometheus-entity-management` | `H:skills/pem-local-first/SKILL.md:3`, `references/decisions.md:51`, `AGENTS.md:217`; `H:versions.toml:46`; `git diff` of `tauri-patterns.md`; `O:chat-00-phase-overview/README.md:12,85`; `npm view`: both names at 4.0.2, the first depends only on the second | Ours stands (alias, one graph). `chat-00` already states "Supersedes the 3.x hybrid note" (`README.md:85`). Do not copy hybrid import lines: its examples import from `@prometheus-ags/prometheus-entity-management` while its package.json lists `entity-graph-react` (`H:tauri-patterns.md:15` against `:156-159`) |
| K2 | React, zustand, assistant-ui, Vite, Node, pnpm pins differ | `H:versions.toml:22-28,43-46`: React 19.2.7, zustand 5.0.14, Vite 8.1.5, Node 26.5.0, pnpm 11.15.0; `H:tauri-patterns.md:30` assistant-ui `^0.14.27`; ours: `O:chat-00 README:82-91` React 19.3.0, zustand 5.0.15, assistant-ui 0.15.23, `O:versions.toml` Node 24.15.0, `O:package.json` pnpm 12.8.1, vite 7.3.6; `npm view` today: react 19.3.0, zustand 5.0.15, `@assistant-ui/react` 0.15.23, `@base-ui/react` 1.8.0, shadcn 4.21.1, `@assistant-ui/react-markdown` 0.14.18, dompurify 3.4.16, tailwindcss 4.3.3 | Ours matches npm today for every package `chat-00` lists. Never copy a hybrid pin. Hybrid also uses caret ranges and `latest` for `@shadcn/ui` (`H:tauri-patterns.md:20`) against our exact-pin rule; npm has a package `@shadcn/ui` at 0.0.4 (`npm view`), which is not the `shadcn` CLI we pin (4.21.1) |
| K3 | Flat 2.0 (no borders, dividers or layout shadows) against the concept's hairlines and "rows over cards; hairlines over boxes" | `H:skills/reference-ui-fidelity/SKILL.md:69-71,113`; `H:docs/knowme-ui-ux-standard.md:54-100`; `O:docs/design/vault-agent-ui-concept.md:279-280,285`; D12 maps `--border` and `--input` to `--background-modifier-border` (`O:decisions-needed.md:165`) | Design authority wins; the concept is operator-reviewed and the product is a native-looking Obsidian panel. Flat 2.0 is KnowMe's brand rule (`H:docs/knowme-ui-ux-standard.md:11`). Record it as a rejected import so no executor skill strips the hairlines (A20) |
| K4 | Brand tokens with hex and a non-user accent against "no hex, the user's accent only" | `H:assets/templates/design-tokens/tokens.toml` (hex, `accent`, `accentAlt`); `O:docs/design/README.md:51-53`; `O:vault-agent-ui-01.../specs/vault-agent-styles/spec.md` "Obsidian variables only" | Ours wins. Hybrid token generator and palette not adopted (section 2.4) |
| K5 | Hybrid layering examples violate our edges | hook-layer file imports an API: `H:tauri-patterns.md:160-161`; hook imports another feature's store: `:183`; store built with React-bound `create`: `:96`; `entities/` folder imports `api/`: layout `:62-64` | Our edges win (`O:.claude/rules/typescript.md:48-65`). Same chain, stricter: hooks never import services, no cross-feature imports (`:41-46`), stores vanilla. Put the three examples in `check:layering` as failing fixtures (A2) |
| K6 | Layout: hybrid is feature-first (`features/<name>/{api,stores,entities,hooks,components}`), ours is layer-first top directories with feature subfolders (`src/ui/chat`, `src/data/chat`, `src/agents/*`), while `typescript.md` says "organize by capability under `features/<domain>/`, not by technical layer" | `H:AGENTS.md:209-211`; `O:chat-02.../design.md:5-17`; `O:.claude/rules/typescript.md:28-29`; open item P6 (`O:decisions-needed.md:246`) | Internal tension in our own docs, not caused by hybrid. Add to P6 so the layout is settled before slice 01 writes a store (A19) |
| K7 | Tauri, Flutter, Rust FFI, Axum, Node assumptions | `H:AGENTS.md:46-55`; `H:tauri-patterns.md:270-337` (`invoke`, `listen`, `@tauri-apps/plugin-store`); `H:entity-graph-web-shell/SKILL.md:17`; `H:versions.toml` `[inference]`, Tauri and Flutter pins | None apply. Our WebView-safe rule (no Node built-ins in `src/`, `tools/hook-isolation.mjs`) and the `desktopNodeModules` lookup pattern are the host seam (`O:vault-agent-ui-00.../README.md:103,120`) |
| K8 | Content model: 11 variants generated from Rust against our part kinds from spec 010 and chat-03 | `H:content-block-ui/SKILL.md:19-37`; `O:chat-03.../chat-entities/spec.md` "Entity types"; `@prometheus-ags/gen-ui-react` is 404 on npm | Ours wins; mapping in section 2.3. "A2UI" is used in two senses inside hybrid (OD-1, `H:decisions.md:78`); we use Google's sense only |
| K9 | Nav state in a store: our slice 01 holds the active tab in `src/data/shell` and calls it "view state" | `O:vault-agent-ui-01.../design.md:25-31`, `tasks.md` 4.2; red flag `H:mobile-navigation/SKILL.md:66` ("two sources of truth") | Make one the source (A1) |
| K10 | 600 px breakpoint and bottom bar assume a full-window app; our view is 300 to 420 px wide in a sidebar on desktop | `H:mobile-navigation/SKILL.md:51-58`; `O:docs/design/vault-agent-ui-concept.md:110` | Responsive by container, not viewport (A16). Tailwind 4 container queries are UNVERIFIED by me; chat-02 1.1 and the spike S3 should confirm before the plan relies on them |
| K11 | Persistence claim: "conversations persisted as PEM entities in PGlite" read as per-entity rows | `H:SKILL.md:67-72`; actual adapter is a snapshot key/value store (`unpkg:` README "v1.3.0", core d.ts `GraphPersistenceAdapter`, `createPGlitePersistenceAdapter` table `_graph_snapshot`) | Reword chat-03 1.2 and 1.3 around snapshot cost; session-only default needs no PGlite (A7) |
| K12 | Hybrid assumes local inference is the first working lane and a model exists | `H:reference-ui-fidelity/SKILL.md:85` | Our README: no model, no index (`O:vault-agent-ui-00.../README.md:17-19`, D10). Do not copy the "first working lane" gate |
| K13 | Event envelope assumption (event ID, sequence, causal parent) against what UAR is known to emit | `H:agui-event-contract/SKILL.md:13-14`; `O:docs/002-agui-a2ui-client.md` (event kinds listed without IDs; UAR endpoint unconfirmed) | Unverified assumption, to be answered by chat-03 2.1 (A12). Without IDs, idempotent apply is not possible and the interrupted marker is the honest fallback |
| K14 | Skill-activation hooks and per-edit reminders against our phase-boundary verification | `H:a11y-gate/SKILL.md:49-54`; `O:.agents/UI_UX_PROTOCOL.md` "No per-edit hooks"; `O:CLAUDE.md` "Verification boundaries" | Ours wins; use the checklist at the phase gate only |
| K15 | Hybrid development philosophy ("features first, test later, 3 to 5 behaviour tests", no unit tests of internals) | `H:AGENTS.md:108-142` | Compatible in spirit with `O:CLAUDE.md` "Verification boundaries" (integration at the boundary, unit tests not completion evidence). Not adopted as text; ours governs |
| K16 | Dialog focus: hybrid gives no initial-focus rule; Base UI's default is "first tabbable element, or the popup on touch" | `H:a11y-gate/SKILL.md:24-25`; `ctx7:` Dialog.Popup `initialFocus` | 07b and D5 govern: confirmation dialogs focus Cancel (`O:decisions-needed.md:98-103`; shipped dialogs at `mass-removal-dialog.ts:42`, `cost-confirm-dialog.ts:42`, `abandon-vault-dialog.ts:69,102`, `clear-stale-lock-dialog.ts:53,79` per D5). A shadcn Dialog must set `initialFocus` explicitly; it must not wrap a 07b dialog (P4) |
| K17 | Copy affordances on every block vs 07b "no passphrase copy on mobile, clipboard cleared" | `H:docs/knowme-ui-ux-standard.md:274` (copy action) against `O:.../plugin-key-management-ui/spec.md:60`; spec 010 requires block-level copy (`O:docs/010-agentic-ui-rendering.md` decision 4) | No conflict inside the chat transcript; conflict only if a key dialog is ever rebuilt with chat or shadcn components. Keep the 07b dialogs native (P4); add a gate that no `src/ui` file renders passphrase material (A15) |
| K18 | Hybrid expects its activation skills to fire on keywords ("ALWAYS invoke ... entity, persistence, TanStack Query") | `H:skills/pem-local-first/SKILL.md:3` (description); the skills are installed as `hybrid-mobile-architecture:*` in this environment | Risk of an agent loading scaffold-oriented guidance during UI work. Treat as read-only knowledge; see section 5 |
| K19 | Design copy still says "native Obsidian DOM, no React island in v1" while the operator decided React | `O:docs/design/README.md:48-50`; `O:CLAUDE.md:248`; commit message of `871257c` | Known; S1 to S11 (`O:decisions-needed.md:58-70`). Not repeated here. One addition: `docs/design/assets/obsidian-shell.css` has hex literals (D12 says 16; `grep -c` of lines with a six-digit hex gives 15) so it is a seed to read, not to copy |
| K20 | `useExternalStoreRuntime` sits under a `legacy-runtime` directory and thread-list callbacks are marked deprecated or unstable | `unpkg:` `@assistant-ui/react@0.15.23` `dist/index.d.ts`; `external-store-adapter.d.ts` JSDoc | Not a conflict today (exported from the package root); a churn risk for the one-adapter-file plan. Exact pin plus the type-level contract file (already in `agui-runtime-adapter` spec "Pin discipline") |
| K21 | A vault design set that was untracked when the planning files were written is now committed | `O:vault-agent-ui-00.../README.md:24` ("`?? docs/design/`"); `git show --stat 871257c` | The README's "not in git history" sentence is now stale (README line 24 and the decisions-needed "set is not in git history" claim). The planning agent should update it; I did not |

## 4. Proposed amendments

For the planning agent (owner of README, tasks, decisions-needed). Not applied. Format: id, slice, change, reason, source skill or document.

| Id | Slice | Change | Reason | Source |
|---|---|---|---|---|
| A1 | 01 (design.md "Shell", tasks 4.2, spec "Tabs as view state") | Name one source of truth for the active tab. Either `ItemView.getState/setState` is the source and the store is a read projection updated by the host, or the store is the source and `getState` reads it. State which; forbid a second writable copy | Mirroring nav state in a store is a listed red flag; our design.md currently has both | `mobile-navigation` :66 |
| A2 | 01 (chat-02 2.1 `check:layering` fixtures) | Add failing fixtures copied from the hybrid examples: a hook-layer file importing a service, a hook importing another feature's store, a store importing React-bound `zustand` (`create`) instead of `zustand/vanilla`, a component importing `obsidian` | A copied hybrid example then fails early instead of in review | `pem-local-first` references/tauri-patterns.md :96,160,183 |
| A3 | 01 (styles contract, `check:styles`) | Add: no `dark:` utility and no `.theme-dark` selector outside the token block | "Same names in light and dark, components never branch on theme" | `hybrid-design-tokens` :53-58 |
| A4 | 01 (D12 table, spec "Contrast of accent fills") | Add `--text-on-accent-inverted` to the primary-foreground row and measure a light accent as well as the default; record that `--font-interface` and `--font-monospace` are not on the Typography page and let spike S3 resolve them; confirm `--radius-*` values 4/8/12/16 | Obsidian picks between two on-accent text variables depending on accent lightness; D12 maps one | Obsidian docs (Colors, Typography, Radiuses); `hybrid-design-tokens` :57-58 |
| A5 | 05, 06 (chat-04 2.1 and block chrome 0.2) | Add a `data-chunk-status` attribute (pending, running, complete, failed, denied, stopped) beside `data-chunk-kind`, with text or icon, never color alone | Machine-readable status for BDD and a11y; `toolUse` and `skill` status map | `content-block-ui` :53-55; `a11y-gate` :34 |
| A6 | 05 (chat-03 2.3 runtime adapter) | Record the verified `ExternalStoreAdapter` fields in the task: use `isRunning`, `isSendDisabled`, `setMessages`, `onNew`, `onCancel`, `onReload`; defer thread-list callbacks (marked unstable); add them to the type-level contract file | Cancel removes a trailing user message only if the adapter implements `setMessages`; thread-list API is unstable | assistant-ui d.ts (0.15.23, core 0.3.22) |
| A7 | 05 (chat-03 1.2, 1.3, 1.4; spike S5) | Say that PEM persistence is a whole-graph snapshot behind `GraphPersistenceAdapter`; S5 records snapshot bytes and hydrate time against message count; the D15 session-only default uses an in-memory adapter; flush goes through `createGraphTransaction(...).commit()` with `persistDebounceMs` | "Table layout and hydrate behaviour of PEM's PGlite adapter" is listed unverified in `O:chat-00 README:116`; the d.ts and README answer the layout half | `pem-local-first` :45-47, :67-72; PEM d.ts and README |
| A8 | 02, 03, 05 (entity types) | Give every entity type a typed `privacy: "local"` constant and a test that the publish planner never lists chat, provider or collection files; keep provider and collection definitions out of the chat graph (dedicated durable file) | Fail closed on unknown class; authored data is not a cache | `pem-local-first` :38-39; `references/doctrine.md` :55-58 (LFS-INV-4) |
| A9 | 01 (design "Shell", mount), 02, 07 | One graph per concern created in the store layer and passed to every React root's `GraphStoreProvider` (view, Modal, settings tab, sheet); never rely on the ambient active store | Several roots will mount; ambient resolution is unspecified in what I read | PEM README "Core" (unpkg); `entity-graph-web-shell` :12-15, :24-28 |
| A10 | 01 (mount), 02 | Provide a typed `HostPorts` context from `src/plugin`, read only by hooks, in place of Obsidian's `AppContext<App>` | Keeps "components never import `obsidian`" while following the official mount shape | Obsidian "Use React in your plugin"; `entity-graph-web-shell` :12 |
| A11 | 01 (chat-02 3.2) | In the popout task, also handle element migration: recompute the portal container on `onWindowMigrated`, use `el.win` and `el.doc` for events | A root mounted into an element that moves windows keeps a stale `ownerDocument` | `dts:` lines 212-233 |
| A12 | 05, 06 (chat-03 2.1, 2.2, BDD list in 3.4) | wire-contract.md answers: does UAR send event ID, sequence, run ID, version? Is `Last-Event-ID` resume supported? If not, state "no resume; interrupted marker". Add tests: duplicate event, out-of-order event, slow consumer, cancellation race, unknown version | These decide whether idempotent apply is possible at all | `agui-event-contract` :13-24 |
| A13 | 06 (chat-05 1.1, 1.6, 1.7) | Capture whether the A2UI action carries run, event and idempotency IDs; add a client idempotency ID if UAR accepts it; add scenarios for denied action, action after restart, malformed props | chat-05 1.6 covers ack, failure and double tap only | `a2ui-surface-contract` :14-22 |
| A14 | 06 (chat-04 2.3 confirmation card) | Model pending, approved, denied, timed out, cancelled run and failed; Deny precedes Approve in DOM order with the safe default focused; decision recorded in place | Explicit terminal states; matches D5's safe-default rule | `agui-event-contract` :18-19; `H:docs/knowme-ui-ux-standard.md:296` |
| A15 | 08, 09 | Dialog acceptance checklist of section 2.5 becomes the review list for `ConsequenceDialog` and the control center; add a check that no `src/ui` file renders passphrase or key material; confirm shadcn Dialog is used for in-view popovers only and sets `initialFocus` | P4 and the 07b clipboard rule | `a11y-gate` :17-34; 07b spec :60; D5 |
| A16 | 01, 07, 08 | State that responsive switches are by container width (container query or measured width), not viewport or OS; verify container-query support in the spike; quick-ask host uses `Platform.isMobile`/`isPhone` as a host choice only | The view is 300 to 420 px inside a window; hybrid's 600 px is a window breakpoint | `mobile-navigation` :51-58, :60-68 |
| A17 | 08 | Keep the concept's horizontal section scroller on mobile; do not add a bottom bar | Obsidian owns app-level nav; six sections is not a nav-bar case | `mobile-navigation` :37-43 |
| A18 | 00 (README exit criterion 5, tasks 0.6) | Replace "each shipped surface captured at 4 widths in 2 themes" with a coverage matrix: surface x theme x width x data state (empty, loading or streaming, degraded, error, offline) x interaction state, one named screenshot per row, plus a precedence record naming `docs/design/*.html` as behaviour and copy oracle, not DOM | The skill's matrix adds states we do not list | `reference-ui-fidelity` :36-50, :88-118 |
| A19 | 00 (decisions P6) | Add K6: settle layer-first top directories against `typescript.md` "features/<domain>" before slice 01 writes a store | Internal contradiction in our rules | `O:.claude/rules/typescript.md:28-29`; chat-02 design.md |
| A20 | 00 (decisions-needed, new rows D17, D18) | D17: Flat 2.0 not adopted; concept hairlines stand (K3). D18: our part kinds, not hybrid's 11 variants and not Google-sense/stream-sense "A2UI" mixing (K8) | Prevents an executor skill from applying either silently | `reference-ui-fidelity` :69-71; `content-block-ui` :13-14 |
| A21 | 00 (tasks 0.5 pin table) | Add `dompurify` 3.4.16 (`npm view`, 2026-10-04); record the extra transitive set of the PEM barrel (`lucide-react ^1.28.0`, `@tanstack/react-table ^9.2.4`, `@tanstack/react-virtual ^3.14.9`, plus `tailwind-merge`, `table-core`); record that `@shadcn/ui` on npm is not the pinned `shadcn` | chat-00 open item 1 lists two of the transitive packages; the pin table lacks dompurify | PEM `npm view`; `H:tauri-patterns.md:20` as the trap |
| A22 | 00 (README "Evidence versus inference") | Update: the design set is committed in `871257c`; PEM exports named in the plan exist in 4.0.2; `@assistant-ui/react` 0.15.23 exports `useExternalStoreRuntime` | Stale statements | `git show --stat 871257c`; d.ts |

## 5. Which hybrid skills could later be executors or checklists for our agents, and with what caution

Rule for all: they are knowledge until an operator decision says otherwise. This environment lists them as `hybrid-mobile-architecture:*` skills with "ALWAYS invoke" descriptions (for example `pem-local-first`, which fires on "entity", "persistence", "TanStack Query"), so an agent can load one by accident. `O:CLAUDE.md` says a missing skill is invoked by name or reported, never improvised; the converse risk is a present skill loaded when it should not be. None of the ten writes files by itself in the text I read (each `SKILL.md` is guidance), but each cites generators and scaffolds elsewhere in its repo (`H:skills/hybrid-design-tokens/SKILL.md:17-24`, `H:AGENTS.md:81-105`) that must not run against our repository.

| Skill | Possible later use | Caution |
|---|---|---|
| a11y-gate | Checklist at the phase gate for `prometheus-ui-review` and bdd-engineer (section 2.5) | Skip the Flutter section and the advisory hook; keyboard walk and screen-reader pass are human evidence, not axe output |
| agui-event-contract | Test-list source for chat-03 and bdd-engineer (section 2.7) | Its envelope is a requirement we have not confirmed UAR meets (K13); do not write the reducer from it before 2.1 |
| a2ui-surface-contract | Review checklist for chat-05 and the hostile-surface scenario | Sense of "A2UI" differs from `content-block-ui` (K8) |
| entity-graph-web-shell | Review list for layering and two-root convergence | Axum and tenancy lines do not apply |
| mini-app-module | "Can be disabled without breaking the host" as a per-feature BDD scenario | Do not build a manifest validator (no second consumer; `O:CLAUDE.md` evidentiary standard) |
| content-block-ui | Rendering rules 1 to 5 as a review list for chat-04 | Do not run its 7-step Rust guide; no generated mirrors |
| reference-ui-fidelity | Coverage-matrix and screenshot-loop template for 0.6 | Strip Flat 2.0 and "remove border defaults" before use (K3); "local inference first" does not hold (K12) |
| hybrid-design-tokens | Naming and "no magic values" as a review list | Never its generator or palette (K4); our mechanism is `check:styles` |
| mobile-navigation | Red-flag list for the view shell | Almost nothing else transfers (section 1.6) |
| pem-local-first | Checklist items for entity wiring (section 1.1) | Prose says 3.x; examples break our layering (K1, K5); its "persist via PGlite once" step waits on D15 |

Executor use (an agent running the skill to produce files) is not recommended for any of them: the project's own team manifest and review roles already own those outputs (`O:AGENTS.md` "agent team is the default"), and the skills carry Tauri and Flutter outputs. If the operator later wants one as an executor, the first step is a dry run in a scratch directory with the file list pasted, as chat-02 1.1 does for `shadcn init`.

## 6. Not verified, not read

Not read:
- `H:skills/pem-local-first/references/{client-rag,partial-replication,peer-crdt,rust-patterns}.md`, `H:docs/pglite-oxide-tauri-hybrid.md`, `H:docs/knowme-local-first-realtime-master-plan.md`, `H:docs/research/` (data half or Rust).
- `H:skills/tauri-ui-review`, `flutter-golden-ui`, `tauri-custom-titlebar` (cited by the skills, outside the ten).
- `H:skills/*/agents/openai.yaml` except `a2ui-surface-contract` (a one-line display stub).
- `H:docs/reference-app/*`, the generated scaffolds, `H:scripts/`, `H:tools/`, `H:references/` (referenced by `AGENTS.md`; not in the cited set).
- `O:vault-agent-ui-02` beyond `design.md` and the first lines of `tasks.md`; `O:chat-04` specs beyond the mixed-turn spec and tasks 1 to 3.
- The five HTML screens (`docs/design/*.html`); I read the concept and README only.
- `O:docs/design/assets/obsidian-shell.css` beyond a hex-literal count.
- The A2UI v0.9 specification page and UAR route source (chat-05 1.1 reads them).

Unverified:
- Everything on a device: WebView behaviour, iOS/Android focus and keyboard in a sheet, whether Obsidian mobile supplies safe-area insets to plugin content, whether `onWindowMigrated` fires as I read it, StrictMode double effects with PEM subscriptions.
- Tailwind 4 container-query support and `@layer` behaviour against Obsidian's CSS (chat-01 S3).
- Which `GraphStore` the module-level active store resolves to with several providers mounted.
- Whether shadcn's generated Sheet on Base UI is built on `Dialog`.
- `--font-interface`, `--font-monospace`, `--size-4-*` and the mobile body class (`is-mobile`) exist in the app; the docs pages I fetched list `-theme` font variables and no mobile class.
- Whether UAR's AG-UI stream carries event ID, sequence or a protocol version.
- How pnpm 12.8.1 resolves the `entity-graph-core` peer of `entity-graph-react`.
- `npm view tailwindcss` failed once (cache error) and returned 4.3.3 on retry; the other versions were read once each.
- I did not run any PEM, assistant-ui or Base UI code; API shapes are from published type declarations and docs, not from execution.
- The README bundled in `entity-graph-react@4.0.2` still says "3.0 React release ... `3.2.0` package line" in its prose (`unpkg:` README), so prose in that package is older than its version; I used the type declarations for shapes.
