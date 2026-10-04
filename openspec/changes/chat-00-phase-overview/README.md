# chat-00-phase-overview (phase `chat-react-shell`)

Status: **PLANNED, NOT ACTIVE.** Written 2026-10-02 by product-manager. The active KBD position stays `mvp` / 07a. Nothing in `chat-00` to `chat-05` is dispatched, and no KBD phase named `chat-react-shell` exists yet. The lead creates it after the `mvp` reflection closes (after mvp-10). Phase order for this change set: Spec (these files, draft), Plan (after the ZeeSpec gate below and operator approval), Execute, Reflect. Reviewers stay dormant until the phase gate (`chat-00/tasks.md` 0.6).

## Goal

A chat view inside the Obsidian plugin, on desktop and mobile, that talks to an AG-UI endpoint (spec 002), renders the full spec 010 contract, keeps conversations on the device as entities, and hosts native A2UI surfaces inside the transcript. React is used for the chat shell only. The sync core, the A2UI renderer and everything under `src/sync`, `src/kubo`, `src/crypto`, `src/core` stay React-free.

## Operator decisions encoded (2026-10-02, not reopened here)

1. React for the chat shell only. A2UI surfaces stay native (spec 002 option 1). New phase after the MVP, not before mvp-10.
2. Stack: React 19, Zustand, `@prometheus-ags/prometheus-entity-management` 4.0.2, assistant-ui, shadcn/ui on Base UI (`shadcn init --base base`). Layering: components, then hooks/view models, then stores, then services/APIs, then external. Components import only hooks; hooks import stores and PEM React hooks, never services; stores call services; services import no React, zustand or store. The sync core never imports React.
   Operator rule, 2026-10-04: "components must NOT talk to stores — only through hooks, and hooks talk to stores. Stores talk to APIs." Recorded in `.claude/rules/typescript.md` (Layering rule) and enforced by chat-02 task 2.1.
3. Conversations persist as entities through the entity graph's PGlite persistence. Messages, tool calls and runs are our own entity types; the library has no chat model.
4. The 300 KB gz bundle limit is waived for the chat code. It is replaced by a measured real-iPhone cold-start gate (before and after numbers, operator sign-off, threshold set from the spike baseline). Chat code is evaluated lazily from inside `main.js`. Fallback: a second plugin.
5. We write our own adapter from our AG-UI client to assistant-ui's external-store runtime. No `@assistant-ui/react-ag-ui`.
6. The spike on the operator's iPhone gates everything (chat-01). BRAT pre-release flow; tag without `v`; one pre-release per spike build; the operator approves each outward release.

## Scope

In: chat as an Obsidian `ItemView` (desktop pane, mobile full view); one configured AG-UI endpoint; spec 010 rendering (decisions 1 to 12); entity persistence; opt-in transcript export to a vault note (spec 009 item 4, open question 2); native A2UI surface host in the transcript with actions to `/{run_id}/a2ui/actions`.

Out (not scheduled, each would need its own change): popup modal, bottom sheet, global hotkey and gestures (spec 009 surface table); agent picker and manifest-driven agents (spec 005); local lanes and offline queue; vault Q&A tools and the MCP tool executor (spec 008); slash commands; voice; automatic Karpathy records (spec 007); agent management UI; web companion page; syncing chat data through the vault.

## Dependencies

- mvp-10 closed (phase order). 07b task 4.1 (release descriptor refactor): `tools/release` hard-codes 0.2.0 today (mobile-feasibility reflection), so the spike pre-release procedure (chat-01 1.1) needs it or a documented manual form.
- mvp-08 PGlite decisions: store layout, size budget, one database or two, and its iPhone PGlite plus ONNX memory run (mvp-08 README acceptance gate). chat-01 S5 reuses that run and does not repeat it if it exists.
- UAR endpoint facts, which spec 002 still lists as open: exact AG-UI endpoint, auth model, CORS origin allowlist, wire names for the non-core chunk types. Owner: uar-engineer (chat-03 2.1, chat-01 1.6).
- Operator pins in `versions.toml` (list below). Agents cannot edit that file.

## Ordering and gates

```
chat-01 spike  --G1 go/no-go (operator signs)-->  chat-02 foundation  -->  chat-03 shell + entities
                                                                              |-->  chat-04 spec 010 rendering
                                                                              |-->  chat-05 A2UI host
                                                  phase gate (once): bdd integration gate, then independent review, then operator device run
```

chat-02 does not start before G1 reads `go` or `go with fallback`. chat-05 tasks 1.1 and 1.2 (uar-engineer, `src/agents/`) may run beside chat-03 because the paths are disjoint. Every other cross-change edge is in the `Requires` lines. One writer at a time for `package.json`, the lockfile, `esbuild.*`, `tsconfig*`.

| Change | Delivers | Main owners |
|---|---|---|
| chat-01 | Device results, G1 decision, measured threshold | operator, uiux-lead, data-engineer, uar-engineer, release-deployment-lead |
| chat-02 | Build, layering lint, gates, lazy mount lifecycle | ipfs-engineer, uiux-lead, release-deployment-lead, identity-security-engineer |
| chat-03 | Entities, stores, AG-UI client, runtime adapter, shell, export | data-engineer, uar-engineer, uiux-lead |
| chat-04 | Spec 010 decisions 1 to 12, mixed-turn fixture | uiux-lead, bdd-engineer |
| chat-05 | Native A2UI host in the transcript, actions | uar-engineer, uiux-lead, data-engineer |

## Exit criteria (phase)

1. chat-01 G1 recorded as go (or go with fallback) with the device numbers and the operator's signature.
2. One whole-tree gate run: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm probe:webview` (extended), the layering lint, the constraint greps, the size gate. Commands and output pasted.
3. iPhone cold-start gate on the release-candidate build, before and after, inside the threshold the operator signed in chat-01. Operator-run.
4. The mixed-turn fixture passes the BDD scenario on the fixture page, and the operator sees it complete in real Obsidian desktop and on the iPhone (Android if a device exists; otherwise recorded unverified).
5. A conversation survives killing and reopening the app on the iPhone, and an interrupted stream shows an interrupted marker.
6. A native A2UI surface renders in a transcript and one action posts to `/{run_id}/a2ui/actions` against a stub or UAR.
7. Independent review (security-reviewer, plus UI review with `prometheus-ui-review`) has no open critical or high finding. The builder's own review does not count.
8. Spec deltas and docs landed (`chat-00/tasks.md` 0.2).

## Evidence versus inference

| Statement | Class | Source |
|---|---|---|
| Bundle sizes: react+react-dom 69 KB gz, +assistant-ui 164, +base-ui 189, +markdown 228, +gfm/dompurify 251 (810 KB raw); plugin today 105 KB gz; AG-UI package adds about 100 KB gz | Evidence, agent-measured in scratch builds (esbuild 0.28.2) | `assessment-chat-stack.md` section 4 |
| PEM core 7.1 KB gz; React barrel with 4 imports 29.7 KB gz (tailwind-merge and table-core dragged in) | Evidence, agent-measured | `assessment-entity-management.md` |
| Package versions | Evidence, agent-read from `npm view` on 2026-10-02; re-verify at pin time | both assessments |
| Argon2id on the iPhone 980 to 1143 ms; BRAT pre-release install works; plaintext 50 MB pull works | Evidence, operator-reported, not reproduced by an agent | `device-results.md` |
| Tailwind `@layer` output loses to Obsidian's unlayered CSS | Inference from cascade rules; never tested | assessment section 3 |
| Parse and eval cost on every app start is the cost that matters on a phone | Inference; no device number exists | assessment, verdict |
| Larger `main.js` raises the iOS launch-watchdog risk | Inference; the only crash seen was a file-provider hang (0x8BADF00D), cause of the first trigger unexplained | `device-results.md` |
| Lazy evaluation inside `main.js` defers parse cost | Inference; mechanism (closure vs string eval) untested on iOS | chat-01 |
| PGlite works in the mobile WebView | Unverified | decision log 2026-10-02 |

## Required operator actions

Pins for `versions.toml`. "Agent-read" means an agent read it from `npm view` on 2026-10-02; none is verified by the lead. Re-verify each against npm at pin time, pin exact (no ranges), and run `pnpm audit` after.

| Package | Intended pin | Source | Note |
|---|---|---|---|
| `react`, `react-dom` | 19.3.0 | agent-read; scratch builds used it | peers of PEM are `>=19 <20` |
| `@types/react`, `@types/react-dom` | not read by any agent | read at pin time | must match 19.x |
| `zustand` | 5.0.15 | agent-read | assistant-ui needs ^5.0.15, PEM core ^5.0.14; expect one copy (`pnpm why zustand`) |
| `@prometheus-ags/prometheus-entity-management` | 4.0.2 | operator decision; agent-read from registry | alias of `entity-graph-react` ^4.0.2; core 4.0.2, `immer` ^11.1.15 come with it; ESM only. Supersedes the 3.x hybrid-mobile-architecture note |
| `@assistant-ui/react` | 0.15.23 | agent-read | pre-1.0, published daily; exact pin. Hard-depends on the `radix-ui` umbrella (^1.6.7) and `zod` ^4.6.5, so both enter the lockfile |
| `@assistant-ui/react-markdown` | 0.14.18 | agent-read | brings `react-markdown` ^10.1.0 |
| `@base-ui/react` | 1.8.0 | agent-read (published 2026-09-04) | not `@base-ui-components/react` |
| `tailwindcss` | 4.3.3 | agent-read | needs Safari 16.4 (iOS 16.4) |
| `@tailwindcss/cli` | not recorded | read at pin time | same line as `tailwindcss` |
| `shadcn` (CLI, dev only) | 4.21.1 | agent-read | local devDependency; not run through a remote one-off |
| `remark-gfm`, `dompurify` | not recorded | read at pin time | both were in the 251 KB measurement |
| Pending decisions, no pin yet | | | mermaid, KaTeX, syntax highlighter (chat-04 3), icon library, anything `shadcn init --base base` adds (chat-02 1.1) |
| PGlite | owned by mvp-08 | | chat reuses that pin |

Must not appear in the lockfile as direct dependencies: `@assistant-ui/react-ag-ui`, `@assistant-ui/react-ai-sdk`, `@prometheus-ags/a2ui-react`, `@a2ui/react`, `@ag-ui/client`, `@tanstack/react-query`.

Other operator actions: approve each spike pre-release and each deletion (chat-01 1.1, 1.13); run the device checks in order; sign the startup threshold after the baseline is recorded and before the with-chat number is read; sign G1; answer the open items below; provide or approve an SSE endpoint the phone can reach over HTTPS (chat-01 1.6); approve the second-plugin fallback if G1 or the release-candidate gate demands it.

## Risks (ranked)

1. **Cold start and the iOS launch watchdog.** A 1.2 MB raw `main.js` is read from the file provider on every launch, chat or not, because Obsidian restores plugins at start. The one crash we saw was a file-provider hang. Lazy evaluation defers parse, not file size. If the view was open when the app was killed, Obsidian restores it at launch and the lazy path is bypassed (chat-01 S1, chat-02 3.1).
2. **Chat store is not a cache.** Spec 006 says both stores are throwaway caches, safe because they rebuild. Conversations do not rebuild. If iOS evicts the WebView's storage, they are gone. Spec 006 must say so for chat, and the user must see an honest notice. Transcript export is the only durable copy.
3. **PGlite in the mobile WebView is unverified**, and the spike may land after mvp-08 has fixed the store layout. A no-go may force changes in mvp-08 output.
4. **CSS cascade** against Obsidian's unlayered stylesheet; untested fixes.
5. **Pre-1.0 churn** in assistant-ui. Contained to one adapter file and an exact pin.
6. **iOS keyboard, focus trap and portals** in WKWebView and in popout windows.
7. **Radix is still in the graph** (assistant-ui hard dependency) and the lockfile grows to about 204 packages in the measured set; `pnpm audit` will see all of them.
8. **Mermaid, KaTeX, highlighter bytes are unmeasured.** Lazy loading inside `main.js` means they ship in `main.js`. Loading code from a CDN at runtime is not an option for a plugin.
9. **Privacy.** The product's headline is encrypted-only publish. Chat is the first feature that sends user-typed text to a third endpoint, and the local chat store is plaintext on the device. The encrypted-vault threat model (DESIGN section 8) does not cover chat data. The operator doc must say so.
10. **Evidence is thin.** One iPhone on a beta OS (iOS 27.2 beta). It cannot show the iOS 16.4 floor or generalise to older devices. No Android device has been used.
11. The waiver can turn out to be wrong: the gate may fail, the fallback is a second plugin with its own install, settings and state sharing, which this change set does not design.

## Unverified

Everything on a device for this phase; Obsidian's minimum iOS version and whether it clears Safari 16.4; whether BRAT downloads `styles.css` from a pre-release as documented (never exercised with a real `styles.css`); whether `eval` or `new Function` of an embedded string works in the iOS WebView; Obsidian deferred-view behaviour on restore; Obsidian mobile's request origin for CORS; whether assistant-ui's registry Thread needs Tailwind features outside Tailwind 4; the table layout and hydrate behaviour of PEM's PGlite adapter; whether UAR emits the non-core chunk types and under which wire names; Preact aliasing (not tested); whether Android is available to the operator.

## ZeeSpec gate (before this set is approved for planning)

Status: **not run as a scored interrogation.** The skill writes state under `.zeespec/` and needs the operator's answers to 60 questions, which are not available in this session. A first-pass gap list from the inputs, unscored:

- What: entity model beyond message, run, tool call (conversation entity added by PM; typed parts proposed); retention numbers; whether chat shares a database with sync history.
- Where: SSE endpoint reachable from a phone; CORS origins; where chat data lives on disk on desktop (it must not be inside the published tree).
- Who: who may see chat data on a shared device; token storage for the endpoint; reviewer roles at the gate.
- When: lazy-evaluation trigger; stream flush points; restore-at-launch behaviour.
- Why: threshold rule, set from the baseline; what counts as an unacceptable cold-start regression.
- How: wire names for non-core chunks; catalog subset for A2UI; surface persistence after a run ends.

`chat-00/tasks.md` 0.1 runs the interrogation. The set stays `draft` until its manifest says GO or CAUTION and the operator approves.

## Open items I could not place (operator)

1. PEM React barrel (29.7 KB gz, drags tailwind-merge and table-core) versus `entity-graph-core` plus our own thin hooks. The operator pinned the barrel package and did not answer the size question. chat-02 1.6 measures; decision needed if the extra bytes persist.
2. Spec 009 says the popup is one code path, an A2UI surface host with a chat catalog. Decision 1 above makes the chat chrome React and keeps A2UI native, so spec 009's sentence is superseded for the chat view; the popup and bottom sheet are out of scope. Spec delta in 0.2.
3. Whether the PGlite-only sub-check of chat-01 runs early, during mvp-08, so mvp-08's store layout can use the answer. Default in this set: it does not (phase order).
4. Optional spike variant, added by PM and not in the operator's list: render the chat root inside a shadow root to avoid the cascade fight. Drop it if the operator objects (chat-01 1.4).
5. Whether the chat store gets any backup beyond opt-in transcript export (risk 2).
6. Mermaid and KaTeX: embed in `main.js` at a measured cost, or render source with a placeholder (chat-04 3.2).
7. The version number and release name of the chat release.
