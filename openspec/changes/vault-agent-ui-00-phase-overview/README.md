# vault-agent-ui-00-phase-overview (phase `vault-agent-ui`)

## STATUS (2026-10-04, one page)

**Decided (operator):**
- D1: React 19, shadcn/ui and assistant-ui for chat; builds on the `chat-react-shell` stack, spike gate, lazy-mount plan and layering lint (`decisions-needed.md` D1 lists the fold).
- L1, L5: REST first (OpenAI-compatible and Anthropic-compatible, all platforms); desktop Claude and Codex adapters are the later slice 10.
- Collections: PGlite with vectors, embeddings for user-defined collections; spec 006 and mvp-08 are cited, not reopened.
- C3: embeddings stay local per device, never published or synced.
- Conversations: persistence and cross-device sync are first-class concerns (decision group S has the options; the choice among them is not yet made, see below).
- No built-in IPFS node default: `ipfs.prometheusags.ai` is retired as a default (KBD task 46 on `main`); no vault-agent-ui slice hard-codes any host (P9).

**Recommended, awaiting the operator:**
- L2: key storage in `app.secretStorage` (fallback ranking in L2).
- S1: conversations A first (local persistence), then B as an opt-in sync (files, per-device, off by default); C (op-log) deferred until a measured need. Lead's recommendation, evaluated and agreed with changes.
- C1: one shared per-block index, membership as a filter, scope = union of collections.
- D2 to D14 as written in `decisions-needed.md`, D17 (Flat 2.0 not adopted), D18 (our part kinds).

**Open for the operator:**
- C6: where collection definitions live (two recommendations side by side, not chosen).
- C2: embedding source (local model or provider endpoint, with the privacy cost).
- D15 ruling (security-reviewer) and S4, S5, S7: deletion semantics, retention, write cadence.
- D16 design questions, L3, L4, L6, L8, P1 to P9 (pins P7, P8 need the operator's hand on `versions.toml`).
- Phase shape (P3) and whether the preview gate stays hidden (P2).

**Blocked on other phases that do not exist yet:**
- Data phase (embedding pipeline, retrieval, index state): slices 03 B, 04 B, 05, 07, 09.
- Runtime phase (AG-UI client, lane field, confirmation path): slice 06 and the A2UI follow-up.
- Anthropic's written answer, panel design, security review, on-install checks: slice 10.
- Gate G1 (chat-01 device spike): slice 01 sections 2 to 5 and everything after.
- D15 ruling: slice 11.

Status: **PLANNED, NOT ACTIVE.** Written 2026-10-04 by product-manager, revised the same day after two operator decisions (D1 and LLM connections, below). The active KBD position stays `mvp` (`.kbd-orchestrator/current-waypoint.json`: change `mvp-07b-keys-history-guard-release-2`, `currentTask` `29`, read 2026-10-04). No KBD phase named `vault-agent-ui` exists, no task of this set is registered in KBD, nothing is dispatched. The lead creates the phase after the `mvp` reflection closes (after mvp-10). Phase order for this set: Spec (these files, draft), Plan (after the ZeeSpec gate and operator approval), Execute, Reflect. Reviewers stay dormant until the phase gate (`tasks.md` 0.6).

Operator instruction, 2026-10-04: "start the vault-agent-ui phase after mvp-10". The lead read it as "write the plan for a phase that begins only after mvp-10 reflects". This set is that plan. It writes only new files under `openspec/changes/vault-agent-ui-*`. It does not edit `chat-00` to `chat-05`, `docs/design/`, `CLAUDE.md`, code, tools or KBD state.

## Operator decisions received 2026-10-04 (relayed by the lead)

1. **D1 is decided: the Vault agent UI uses React 19, shadcn/ui and assistant-ui for chat** ("so we get the absolute best UI/UX"). The native-DOM recommendation is withdrawn. `vault-agent-ui` builds on the `chat-react-shell` stack and plan: React 19.3.0, vanilla `zustand` stores, `@prometheus-ags/prometheus-entity-management` 4.0.2, assistant-ui with our own external-store runtime adapter, shadcn on Base UI, the chat-01 on-device spike gate, the lazy-mount bundle plan and the layering lint. The `chat-*` changes are folded, not discarded. `decisions-needed.md` D1 says which goes where.
2. **LLM connections are in scope, early (slice 02), and REST first: DECIDED, "REST first, desktop CLI later".** Slice 02 ships only the OpenAI-compatible and Anthropic-compatible REST adapters on all platforms (base URL, API key), with the settings UI for the provider list (add, edit, remove, test), keys that stay on the device, model selection, default provider per mode and the lane chip. The desktop adapters (Claude Code, Codex) move to a later slice, **10 `desktop-cli-adapters`**, after the Notes and Agent chat slices, blocked on (a) a recorded answer from Anthropic about launching the user's own signed-in `claude` binary, (b) the detection and setup panel design, (c) a security review of child-process use and vault-borne `.claude/settings.json` hooks, (d) on-install verification of the unverified items in the assessment. The default auth for any desktop adapter is an API key; subscription use only if Anthropic confirms. Slice 02 leaves a named, hidden-on-mobile place for the detection panel and does not ship it empty or disabled. Facts: `assessment-llm-connections.md` in this directory (finished; cited below as "assessment s.N" by section number). Key storage stays a recommendation (L2).
3. **Collections of documents (operator input, same day): use PGlite with vectors so embeddings can be created for user-defined collections.** A collection is a named set of notes (by folder, tag, saved query, manual picks, exclusions). It (a) scopes which notes get embedded at all, which saves compute and memory on a phone, and (b) scopes Search, Notes mode and the Index tab. This is new slice 03. Facts that are already decided and not reopened: `docs/006-embedded-stores.md` (status "decision record - user-approved") puts vectors and metadata in PGlite, with pgvector when brute force stops sufficing (about 100k vectors), the graph in SurrealDB WASM, both as rebuildable caches referenced by `file_sha256`, never by path; `openspec/changes/mvp-08-sync-history-store/README.md` owns the PGlite pin, says embeddings must not ride the vault snapshot (docs 005, 006 and DESIGN section 7 are to be revised; spec 006 line 44 still says "embeddings ride the vault snapshot"), requires a size budget, and makes phone embeddings opt-in behind an iPhone gate (PGlite and the ONNX model together, peak memory) that has never been run. Technical facts about PGlite, pgvector, indexing cost and collections are in `openspec/changes/vault-agent-ui-00-phase-overview/assessment-pglite-collections.md` (data-engineer, desk study, no device run; cited as "pglite assessment s.N"). It recommends one shared per-block index with path-level membership, and corrects spec 006 on one point: collection definitions are authored data, not a cache, so they cannot live only in evictable IndexedDB (s.4.5, decision C6). Privacy rule, stated as a requirement in slices 03 and 09 (and see item 4 for conversations): embeddings are derived from plaintext notes, so they stay on the device that made them, are rebuildable, are never published or synced, and the Index tab says so.

## The uncomfortable part first

This phase depends on three things that do not exist, and on one gate that can say no.

1. **No retrieval index is planned anywhere.** The operator's brief names "mvp-08 index state" as the prerequisite for Search and Index. `openspec/changes/mvp-08-sync-history-store/README.md` says mvp-08 is "StoreAdapter interfaces + PGlite metadata/sync-state adapter in CLI; ipfs-sync history". Its only embedding content is a list of things to decide before it starts (exclude embeddings from the snapshot or keep an own store, a size budget, phone embeddings opt-in) and an unrun iPhone gate for PGlite plus the ONNX model. mvp-09 is the encrypted sync fixture; mvp-10 is the real-vault release. None builds an embedding pipeline, a local model, `search(query, scope)` or an index-state stream. `DESIGN.md` section 7 reads "decision pending, specs TBD". Search, Notes retrieval, Index data and the quick-ask answer wait for an **AI-layer data phase** with no plan, owner or date. "The data phase" is a placeholder name.
2. **No agent runtime exists in `src/`.** `ls src` shows `core crypto kubo main.ts plugin sync`: no AG-UI client, no lane selector, no skill or memory event path. `chat-03` tasks 2.1 and 2.2 plan the wire contract and client, but inside a phase that is not active. Agent mode with skills and tools waits for a **runtime phase**, also unplanned.
3. **No provider layer exists.** Slice 02 builds the REST half. Whether mobile can stream tokens is untested (assessment s.9 item 5); some hosted APIs may answer only whole. The desktop half is slice 10 and waits on an answer from Anthropic that nobody has asked for yet.
4. **Gate G1 can say no.** React on an iPhone inside Obsidian was never measured. The only phone evidence is Argon2id timing and a BRAT install (`chat-00` README, evidence table). The chat-01 spike (task 1.14) can return `no-go`, and the fallback in `chat-00` (a second plugin) is not designed. Nothing React-shaped is built before G1 reads `go` or `go with fallback`.

What can start at phase start: the non-React parts of slice 01 (styles contract, gates), the chat-01 spike itself, and, after G1, the shell. Slice 02 service work (REST providers) has no phase dependency but needs G1 for its settings UI. By my estimate, about a third of the UI work is startable without the data and runtime phases. If those slip, the phase ships a shell, provider settings, plain chat against a model endpoint, and a settings view. The design's central claim (find and ask by meaning, locally) is not delivered.

Also: the design authority set contradicts D1. `docs/design/README.md:48-49`, `docs/012-vault-agent-ui.md:28`, `docs/design/vault-agent-ui-concept.md:331-333,357` and `CLAUDE.md:248` still say "native Obsidian DOM, no React island in v1". `decisions-needed.md` lists each statement as a task for uiux-lead through Open Design, with proposed replacement wording for `CLAUDE.md` that the operator applies by hand. The design set itself is committed: `871257c` on `main`, "docs: the vault agent UI design set and the design-authority wiring" (local, not pushed; `git log` read 2026-10-04). The operator rule "copy design iterations in the same commit as the change they justify" therefore has something to attach to. This plan commits nothing.

## Goal

React surfaces inside Obsidian that read like a core plugin and make three facts legible everywhere: the embedding index is a rebuildable cache, which lane produced an answer (Local, Remote, Offline), and which skills an agent invoked. Surfaces: the Vault agent sidebar view (Search, Chat in Notes and Agent modes, Index), the quick-ask popup, the control center, the status chip, and provider settings. Authority: `docs/design/README.md`, `docs/design/vault-agent-ui-concept.md` and the five screens for behaviour and copy; `docs/012-vault-agent-ui.md` as pointer. Where the design says "native DOM", D1 overrides it until the design copies are updated through Open Design.
4. **Conversations: persist them, and consider syncing them across devices over IPFS (operator input, same day; first-class concern).** New slice 11. Cited, not re-decided: `chat-00-phase-overview/README.md` decision 3 (conversations persist as entities through the entity graph's PGlite persistence; messages, tool calls and runs are our own entity types); D15 in `decisions-needed.md` (persisted conversations are authored data, so the spec 006 cache rule does not cover them; a security-reviewer ruling is open); the product's own sync (encrypted snapshot, sequence floor, fork resolution by ancestor, conflict copies where the node's version wins and local content is kept, remote deletions not applied, one history file per changing publish, the prune-history bound, default exclusions including `.obsidian/` and `.ipfs-sync/` in `src/sync/exclusions.ts`; README sections "History growth" and the conflict policy); `mvp-08` ("embeddings never ride the snapshot"). The options and the recommendation are decision group S in `decisions-needed.md`. The lead's recommendation is under evaluation, not decided: v1 local persistence, sync as an opt-in file-based path, no op-log until a measured need.
5. **No default IPFS server (operator, 2026-10-04): "we are not going to use https://ipfs.prometheusags.ai as the default IPFS server, as that is wide open and our own server".** KBD task 46 on `main` removes the built-in default (I did not read that task; `src/core/config/retired-default-hosts.ts` exists and carries the retired host and a warning, see the evidence table). Plan rules: (a) the vault-agent-ui settings UI has a "Node" section (slice 08, Sync) with an empty field and no default endpoint; (b) it shows `RETIRED_DEFAULT_WARNING` beside the field and once at load when the configured URL's host equals a retired default host, using `isRetiredDefaultHost` through a host port, never a copy of the string; (c) no vault-agent-ui slice, fixture, stub, doc example or test hard-codes any real host; stubs use `localhost` or reserved example names. Slice 01 adds the grep gate (task 3.1). Provider base URLs (slice 02) have no defaults either.

## Decisions encoded

Kept from the design authority (`docs/design/README.md` "Decisions the screens encode"): one right-sidebar view with tabs Search, Chat, Index; Chat has Notes (default) and Agent modes; quick ask is a one-shot popup that hands off and never grows its own composer; Notes mode never answers from model knowledge; lane chip on every agent surface; skill activations never hidden; consequence dialogs with Cancel focused (refined by D5); no default hotkeys; sentence case; Obsidian CSS variables only, user's accent the only accent, no hex, no custom fonts, no gradients (re-examined for shadcn in D12).

Kept from `chat-00` README "Operator decisions encoded" (2026-10-02): React for the chat shell with A2UI surfaces staying native; stack and pins (React 19, zustand, PEM 4.0.2, assistant-ui, shadcn on Base UI; pins still not in `versions.toml`, which holds `@noble/hashes`, `typescript`, `node` only, read 2026-10-04); the 300 KB bundle limit waived for chat code and replaced by a measured iPhone cold-start gate with lazy evaluation; our own adapter from our client to assistant-ui's external-store runtime; the spike gates everything. Layering, operator rule 2026-10-04 (`.claude/rules/typescript.md`): components import only hooks; hooks import stores and PEM React hooks, never services; stores call services; services import no React, zustand or store; the sync core imports none of them.

Not decided by D1: whether and how conversations persist (`chat-00` decision 3) and whether they sync. That collides with D15 (plaintext at rest) and waits for the security-reviewer ruling, the retention answer and decision group S (slice 11).

## Scope

In: slices 01 to 09 below, including user-defined collections of notes as the scope for embedding, Search, Notes mode and the Index tab; the chat-01 spike and the chat-02 foundation as folded into slice 01; provider service, provider settings and key storage; host wiring in `src/plugin`; BDD fixtures; independent review; spec deltas and design-copy tasks.

Out (each needs its own change): the embedding pipeline, local model and index store (data phase); the AG-UI client, reducer, lane selection and offline queue (runtime phase); replacing the 07b Encryption section or its key, prune, mass-removal and cost-confirm dialogs (slice 08 hosts them); device and grant management, QR pairing, UCAN, Revoke, Direct links (no engine: `grep -rli "ucan\|spake\|did:key\|webrtc" src` finds nothing, 2026-10-04); default hotkeys and gestures (D8); voice, web companion, agent management UI, Karpathy records; syncing chat or provider data through the vault; edits to `docs/design/` or `CLAUDE.md` by this set.

## Start condition

1. `mvp-10-real-vault-publish-and-release` reflected. 07b closed, so the exact-tree review of 07b (`mvp-07b-keys-history-guard-release-2/tasks.md` 6.4, 6.5) is not reopened by new `src/ui/` files or `styles.css`.
2. `tasks.md` 0.2 closed: D2, D3, D5, D7, D9, D10, D12 resolved or deferred in writing; L1 to L5 (providers) answered; pins landed (0.5).
3. ZeeSpec manifest for subject `vault-agent-ui` with GO or CAUTION (0.1). Not run.
4. Per slice: its `Blocked on` list in its `proposal.md`. No slice starts against a mock that the UI then ships around.

## Slices, revised order

Sizes are my estimates in focused agent-days (one role, tests, no device time), not measurements. They exclude `chat-01` and `chat-02`, which I did not size (17 tasks in chat-02, 14 in chat-01). The discovery report estimated about 53 for its 14 native steps; the React stack changes that and I have not re-estimated it. Do not commit to these numbers.

| Slice | Delivers | Owners | Est. | Blocked on | Starts at phase start |
|---|---|---|---|---|---|
| 01 `foundation-react-shell-and-spike-gate` | chat-01 spike and G1; chat-02 foundation folded in; styles contract and shadcn token map; Vault agent view shell with tabs, lazy mount, preview gate; Index tab on a stub; status chip | uiux-lead; ipfs-engineer; release-deployment-lead; identity-security-engineer; operator | 6 (mine) | D12; pins; G1 | Yes, gated by G1 |
| 02 `llm-connections` | REST only: provider interface, OpenAI-compatible and Anthropic-compatible adapters, key storage, provider settings UI (list, add, edit, remove, test, models, default per mode), lane chip per provider, consent | uar-engineer (services); uiux-lead (settings UI); ipfs-engineer (plugin wiring, streaming transport); identity-security-engineer (key storage review) | 8 | 01 sections 2 and 3; L2 (key storage) confirmed; device checks for mobile streaming | Yes after 01 |
| 03 `collections` | User-defined named sets of notes: A: define, edit, preview membership count (filters over Obsidian metadata, no index needed). B: per-collection index status and cost, default collection per chat, indexing driven by the union of collections | uiux-lead; data-engineer (membership-to-index contract) | 3 + 2 | A: 01. B: mvp-08 PGlite adapter and size budget, embedding provider (02 and the data phase), `assessment-pglite-collections.md`, C1 to C6 | A yes, B no |
| 04 `search-tab` | A: text fallback and scope chips. B: semantic rows, coverage line, lane chip, collection scope | uiux-lead; data-engineer | 2 + 3 | A: 01. B: 03 B, data phase retrieval interface, D2, model-load design | A yes, B no |
| 05 `notes-mode-chat` | Transcript kit (chat-04 0.2, 1.1, 3.x, 4.1, 5.1), runtime adapter, Thread, Notes mode, refusal, grounding line, Quote only, save as note, default collection per chat | uiux-lead; data-engineer; bdd-engineer | 12 | 02 (a provider to answer with, or Quote only), 03 B, 04 B, D6, D10, D11, D15 | No |
| 11 `conversation-persistence-and-sync` | A: conversations persisted locally as entities (conversation, message, run, tool call), retention, delete, eviction notice. B: opt-in sync of conversations through the existing encrypted vault sync as files in a dedicated folder, off by default, excluded from embeddings, written on turn complete, disclosure before enabling | data-engineer (entities, store); uiux-lead (UI, disclosure); ipfs-engineer (file writer, exclusion wiring); security-reviewer (ruling before A starts); bdd-engineer | 8 (A 4, B 4) | 05 (a conversation to persist); D15 ruling; mvp-08 PGlite decision (one database or two); S1 to S8; for B also the sync core's behaviour with new files (conflict copies, no remote deletes, history growth) | A after the ruling and 05; B after A and an operator yes |
| 06 `agent-mode-and-approvals` | Remaining chat-04 chunk renderers, Agent mode thread, skill, error and confirmation cards, scope bar, composer, lane chip from the stream; optional A2UI slot | uiux-lead; uar-engineer; bdd-engineer | 8 | 05 section 1, runtime phase client and lane field, D9 | No |
| 07 `quick-ask` | Desktop prompt in a Modal, mobile bottom sheet, answer through the Notes pipeline, Continue in panel | uiux-lead | 4 | 05; D7, D8, D14 | No |
| 08 `control-center` | Searchable control center; Sync, Security (hosting 07b dialogs), Appearance, Agents (provider list from 02), Data rows (collections from 03) with backing code | uiux-lead; ipfs-engineer | 7 | 01, 02 (Agents), 07b closed, D3, D4 | Core rows yes |
| 10 `desktop-cli-adapters` | Desktop-only Claude Code and Codex adapters, detection and setup panel (desktop only), consent, process-spawn hardening | uar-engineer; uiux-lead; ipfs-engineer; identity-security-engineer; security-reviewer | 6 (estimate; sizing waits on the blockers) | 02, 05 and 06 shipped; Anthropic answer; panel design; security review; on-install verification | No, and not before its four blockers close |
| 09 `index-tab` | Index tab real data per collection, Embed changed, Pause on battery, Rebuild dialog, `ConsequenceDialog` base, per-file queue, the "stays on this device" statement | uiux-lead; data-engineer | 4 | 03 B, data phase index-state interface, D2, D5 | No |

Why 02 is early: Notes mode needs a model to answer with (or it ships Quote only), and Agent mode needs a connection. Moving provider settings ahead of Search keeps the first usable chat from waiting on the index. It does not remove the data-phase dependency of Notes mode, which retrieves from the index.

Numbers are identifiers, not execution order. Execution order is the dependency order of this table and the diagram; slice 11 sits after 05 and slice 10 last.

Why 03 sits before Search: collections decide what gets embedded at all. Embedding the whole vault by default costs compute and memory, which matters most on a phone (`mvp-08-sync-history-store/README.md`: phone embeddings are opt-in; its iPhone gate for PGlite plus the ONNX model together has never been run). Search, Notes mode and the Index tab all scope by collection.

Kit rule: each component and each block of `styles.css` lands with its first consumer. The collapsible, similarity row and lane chip arrive in slices 04 to 06; `ConsequenceDialog` in slice 09.

Recommended order with one UI writer: 01 (after G1), 02 REST adapters and settings, 03 A, 04 A, 08 core rows, then 03 B, 04 B and 09 when the data interface exists, 05, 11 A (after the ruling), 07, 11 B (only on an operator yes), then 06 when the runtime interface exists, and 10 last, only after its four blockers close.

Prerequisite chain for retrieval features (each link is outside this phase except the last two): mvp-08 PGlite adapter and size budget (owns the PGlite pin) -> embedding provider (local ONNX/WASM model, or the embeddings endpoint of a configured provider from slice 02: decision C2) -> collections (slice 03) -> Search and Notes mode (slices 04, 05).

```
chat-01 spike --G1--> 01 foundation --> 02 llm-connections --> 03 A --> 04 A --> 08 core rows -------+
  (operator)                                  |                                                       |
 mvp-08 PGlite + size budget (planned) -> embedding provider (unplanned) -> 03 B --> 04 B --> 09 --> 05 --> 07   +--> gate(s) --> review --> device run --> reflect
 runtime phase interface (unplanned) ---------------------------------------> 06 (needs 05 section 1)  -------+
 pglite assessment s.7.2 device measurements (unrun) --> defaults for 03 B
 Anthropic answer + panel design + security review + on-install checks --> 10 (after 05, 06)
```

## Phase shape (proposed, operator decides)

The 07b precedent (`mvp-07b-keys-history-guard-release-2/tasks.md`, "Cadence", operator decision 2026-10-03) used two increments with a gate each. Proposal: **Increment A** = 01, 02, 03 A, 04 A, 08 core rows (no data or runtime prerequisite); **Increment B** = 03 B, 04 B, 05, 06, 07, 08 Agents and Data rows, 09. One gate at the end of a phase that waits on two unplanned phases could stay open for months. See `decisions-needed.md` P3.

## What the UI needs from the other phases (needs, not interface definitions)

Data phase (data-engineer, spec 006): `search(query, scope)` rows with title, path, score, excerpt and match offsets, heading; passage records for Notes mode; a subscribable `indexState()` (model, dimensions, where it runs, size, last rebuilt, counts, per-file state, building, paused, missing, failed); commands (embed changed, pause on battery, rebuild, pin, exclude); an answer path with per-sentence passage markers so the UI never infers attribution from prose; the answer to D2.

Runtime phase (uar-engineer, specs 002 and 005): the AG-UI wire contract as UAR actually emits it (`chat-03` 2.1); a per-turn lane and model field (D9); cancel; how a confirmation response returns; offline queue state; auth and CORS from a phone.

Provider layer (slice 02) is built in this phase and is the one exception: the UI team owns its settings, uar-engineer owns the services.

## Exit criteria (phase)

1. ZeeSpec GO or CAUTION; D1 to D18, L1 to L8, C1 to C6, S1 to S8 and P1 to P9 each resolved or deferred in writing.
2. chat-01 G1 recorded `go` or `go with fallback` with device numbers and the operator's signature.
3. Per gate: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm probe:webview` (extended), `pnpm check:layering`, `pnpm check:chat`, the styles gate, `pnpm gate:chat`, the BDD features of the slices in that increment. Commands and output pasted. No Node built-in in the bundle except through the gated lookup of slice 02.
4. iPhone cold start before and after, inside the threshold the operator signed before reading the after-number (`chat-01` 1.8, `chat-02` 2.4). Operator-run.
5. A coverage matrix, not a width list: surface x theme (light, dark, one non-default accent) x width (320, 375, 768, 1024) x data state (empty, loading or streaming, degraded, error, offline) x interaction state, one named capture per row, with real content, focus and reduced motion (`.agents/UI_UX_PROTOCOL.md`; adapted from `design-input-hybrid-skills-ui.md` amendment A18). A precedence record names `docs/design/*.html` as the oracle for behaviour and copy, not for DOM or component structure. Responsive switches are by container width, not viewport or OS (A16).
6. Independent review by security-reviewer (untrusted text sinks, sanitizer, link handling, key storage, process spawning, note writes, approval path, consent copy) and a UI review with `prometheus-ui-review`. No open critical or high finding. The builder's review does not count.
7. Spec deltas, design-copy updates and docs landed (`tasks.md` 0.2, 0.9, 0.10). No sentence claims a device check that is not in a device-results file.
8. No release text names a feature whose slice did not ship (preview gate).

## Evidence versus inference

| Statement | Class | Source |
|---|---|---|
| mvp-08 is the sync-history adapter with embedding preconditions only; mvp-09, mvp-10 have no retrieval work | Evidence, read 2026-10-04 | the three README files |
| The AI layer is unplanned | Evidence | `DESIGN.md` section 7 |
| `src/` has no `ui`, `data`, `agents`, `styles.css`, `ItemView` | Evidence | `ls src`; `ls styles.css` fails |
| The build emits no `styles.css` today; release tooling accepts one as optional | Evidence | `esbuild.config.mjs` line 15 copies `manifest.json` only; `tools/release/constants.mjs`, `tools/check-guard-preconditions.mjs` lines 355-365 |
| `versions.toml` pins three things; React, zustand, PEM, assistant-ui, shadcn are not pinned; agents cannot edit it | Evidence | `versions.toml`; `package.json` |
| `SecretStorage` (`getSecret`, `setSecret`, `listSecrets`), `requestUrl` and the view, markdown and platform APIs exist in obsidian 1.13.1 | Evidence | `node_modules/obsidian/obsidian.d.ts` (`SecretStorage` since 1.11.4; `manifest.json` `minAppVersion` 1.12.3) |
| `desktopNodeModules` does a run-time `require` lookup so the bundle names no Node built-in | Evidence | `src/plugin/range-streaming-transport.ts` lines 134-139 |
| `SecretStorage` exists since 1.11.4 with no delete method in the typings | Evidence | assessment s.5 |
| Where `SecretStorage` persists, whether Obsidian Sync carries it, whether ids are namespaced per plugin, whether it works on mobile | Unverified | assessment s.5, s.9 item 4 |
| React, assistant-ui and Base UI run acceptably on an iPhone inside Obsidian | Unverified | chat-01 spike; no device number exists |
| Tailwind `@layer` output loses to Obsidian's unlayered CSS | Inference, never tested | `chat-00` README |
| Claude Code `-p stream-json` and `claude auth status` documented; Codex `exec --json` documented; token-level Codex streaming, `claude auth status --json` shape (not run), `--setting-sources ""`, Codex `-C` flag all unverified | Evidence for the docs, unverified for behaviour | assessment s.2, s.3, s.9 |
| Anthropic terms: no routing requests through subscription credentials on behalf of users; an end user signing in to the unmodified binary is allowed; whether a plugin driving that binary counts is a legal judgment | Evidence for the text, open for the judgment | assessment s.8 items 1 and 2 |
| PGlite and pgvector behaviour in the Obsidian WebViews, index size per collection, embedding cost, whether a filter over one shared per-block index is cheap enough | Unverified | pglite assessment s.8: every performance, memory and eviction claim there is arithmetic or documentation, not measurement (iPhone checklist s.7.2 unrun). Arithmetic that holds: 384-dim float32 vector is 1,544 bytes; 100k chunks is about 154 MB (s.2.3) |
| PGlite 0.5.8 is about 3.4 MB gz wasm plus 1.9 MB gz data; `idb://` loads the whole database into memory; pgvector is a separate package peer-pinned to PGlite 0.5.8 exactly | Evidence (npm, doc, calc, 2026-10-04) | pglite assessment s.0, s.1, s.2.1 |
| Pull applies no remote deletions and keeps a local edit as `name (ipfs conflict YYYY-MM-DD).ext` when both sides changed; a history file is added per changing publish; warning at 1,500 and refusal at 1,999 files in `manifests/`; prune keeps at least the newest 20 | Evidence | `README.md` "conflict policy" and "History growth" (read 2026-10-04); `mvp-07b-keys-history-guard-release-2/tasks.md` 1.8 |
| Whether a dot-folder outside the default exclusions publishes, and whether Obsidian search, graph and other plugins skip it | Unverified | `src/sync/exclusions.ts` list read via the pglite assessment s.4.4 and `grep`; the Obsidian side is general behaviour, not checked; slice 11 task 1.1 tests both |
| Anthropic offers no embeddings endpoint | Evidence (doc) | pglite assessment s.3.2 |
| Spec 006 and mvp-08 disagree on whether embeddings ride the snapshot | Evidence | `docs/006-embedded-stores.md` line 44 versus `mvp-08-sync-history-store/README.md` "Required before this change starts" |
| `requestUrl` returns the whole body and has no abort signal; mobile `fetch` streaming and the mobile CORS origin are untested | Evidence for the first half, unverified for the second | assessment s.5, s.7.3, s.9 item 5 |
| The design set is committed (`871257c`, `main`, local); `@prometheus-ags/prometheus-entity-management` 4.0.2 is an alias that depends only on `entity-graph-react` ^4.0.2, and the PEM exports the plan names exist in 4.0.2; `@assistant-ui/react` 0.15.23 exports `useExternalStoreRuntime` | Evidence | `git log`; `design-input-hybrid-skills-ui.md` s.2.1, s.2.2, K1, K21 (npm and published type declarations, 2026-10-04, not executed) |
| PEM persistence is a whole-graph JSON snapshot behind a three-method key/value adapter (`GraphPersistenceAdapter`: `get`, `set`, `remove?`), not per-entity rows; `createPGlitePersistenceAdapter` stores it in one table (`_graph_snapshot`); write cost grows with total graph size | Evidence (declarations and README); behaviour unrun | `design-input-hybrid-skills-ui.md` s.2.1, K11, A7 |
| `src/core/config/retired-default-hosts.ts` exists in the working tree: `RETIRED_DEFAULT_HOSTS` holds `ipfs.prometheusags.ai`, `isRetiredDefaultHost(url)` compares only, `RETIRED_DEFAULT_WARNING` is the warning text; its header says a test scans `src/` and `cli/` for any other such host | Evidence (file read; whether it is committed and how KBD task 46 on `main` finishes is not read by me) | `src/core/config/retired-default-hosts.ts` |
| Design screens match Open Design's current state | Partly verified | the report found the on-disk copy identical; the `open-design` MCP was not reachable |

## Risks (ranked)

1. **Gate G1 and the prerequisite phases.** No G1, no React. No data phase, no Search or Notes retrieval. No runtime phase, no Agent mode. Mitigation: increments, blocked-on lists, no mocks shipped.
2. **Trust boundary: note text to a third-party model.** The encrypted vault protects data on the node. A provider sees whatever Notes mode sends (retrieved excerpts), whatever Agent mode sends, and anything the user pastes. That is a different boundary and the encryption story does not cover it. UI must disclose per provider and per mode (slices 02, 05). The product headline is "encrypted-only publish"; chat is the first feature that undercuts the privacy reading of it unless disclosure is honest.
3. **Spawning a local CLI is a privilege.** Desktop Claude and Codex adapters (slice 10, later) run processes with the user's credentials and file access, and `claude -p` without `--bare` loads hooks and `.mcp.json` from the working directory with no trust prompt (assessment s.2.2, s.7.5). Run-time gated module lookup, neutral working directory, security review. Not in the first release.
4. **Key handling.** API keys must stay on the device, out of vault files, out of sync, out of logs, out of entities and out of error text. Redaction rules in slice 02 spec. Where `SecretStorage` persists and whether it syncs is unverified (assessment s.9 item 4).
5. **Mobile streaming.** `requestUrl` buffers whole bodies and has no abort signal (assessment s.5), so token streaming on a phone needs `fetch` against endpoints with CORS allowing the Obsidian origin, or degrades to non-streaming. Many hosted APIs do not allow arbitrary browser origins. Mobile may end up non-streaming for some providers.
6. **Cold start and the iOS launch watchdog** (`chat-00` risk 1): the lazy plan is inference until measured; an open view restored at launch bypasses lazy evaluation.
7. **Conversations at rest in plaintext** (D15), Save as note, and, if sync is enabled, **irrecoverable copies**: IPFS content is immutable, so a conversation that was published cannot be erased from older roots or from anyone who pinned them. `prune-history` trims only the node's own history files and does not recall copied blocks (README "History growth"). Synced conversations carry note excerpts and model answers; they get the vault's encryption and are visible to every device that holds the vault; remote providers may log what was sent. A chat also becomes a constant source of non-empty publishes: with the README's own numbers (a 15-minute timer, a vault that changes on every tick, 96 history files a day, each 4 to 14 MB for 5,000 to 20,000 files) that is 384 MB to 1.3 GB of pinned manifest history a day in the worst case, with the warning at 1,500 files in about 15.6 days (my arithmetic from those numbers, not a measurement). Slice 11 B batches writes for that reason.
8. **shadcn token mapping can leak a second accent** (D12). Gate in slice 01.
9. **Review reopening** if any `src/ui/` file lands before 07b closes.
10. **Evidence is thin:** one iPhone on a beta OS, no Android device, Open Design unreachable by MCP.

## Unverified

Everything on a device. The 16 items of `assessment-llm-connections.md` s.9 and the real-install and real-device checks of its s.10. Obsidian variable names beyond those the concept uses (D12). `color-mix` against `minAppVersion` 1.12.3. Whether Obsidian's `MarkdownRenderer.render` is needed at all now that assistant-ui renders markdown (D11). Where the data and runtime phases will put code and what their interfaces look like. Whether drag of a result title into the editor works from a React element.

## ZeeSpec gate (before this set is approved for planning)

Status: **not run as a scored interrogation.** The skill needs the operator's answers to 60 questions and writes `.zeespec/` state; `ls .zeespec` finds nothing. First-pass gap list, unscored:

- What: retrieval and index ports; provider record (kind, base URL, model, locality, consent flags); conversation entity if persisted (D15); passage and sentence markers.
- Where: key storage location and whether it can reach a synced folder; transcripts on disk and outside the publish tree; where the local model runs; WebGPU on phones; desktop CLI locations.
- Who: who sees conversations on a shared device; who consents to what is sent; who owns each port and by when; reviewer roles.
- When: cadence; preview gate lift; provider test timing; offline queue replay; token refresh for desktop sign-in.
- Why: cold-start threshold rule; why direct providers beside UAR; why desktop CLI adapters ship in the first release or not (L5).
- How: lazy mount mechanism (chat-01 B1 or B2); wire names; shadcn token map; run-time module lookup and its gate; mobile streaming fallback.

`tasks.md` 0.1 runs it. The set stays `draft` until the manifest says GO or CAUTION and the operator approves.

## Open items I could not place (operator)

`decisions-needed.md`: D1 (decided, consequences), D2 to D18, the operator's open design questions, the D15 security-reviewer ruling, L1 to L8 (providers), C1 to C6 (collections and embeddings), S1 to S8 (conversations), P1 to P9 (added by product-manager). Inputs folded in: `design-input-hybrid-skills-ui.md` (amendments A1 to A22, conflicts K1 to K22) and `design-input-hybrid-skills-data.md` (its section 4 amendments and section 6); both are advisory, written by other agents, and the skills they study target Tauri and Flutter apps, not this plugin.
