## Why

Every number behind the chat stack comes from agent scratch builds, and every hazard is a reading of documentation. The assessment (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/assessment-chat-stack.md`) says the stack is viable on iOS "functionally" and not viable inside 300 KB gz, and ranks startup cost first. The operator waived the 300 KB limit and asked for a measured iPhone gate instead. That gate needs a baseline and a with-chat number from the same device, and its threshold must come from the baseline. This change produces both, plus the answers to the other unverified items, before any production chat code exists.

The uncomfortable parts:
- **The spike can end the phase.** If cold start regresses past the signed threshold with every lazy variant, the fallback is a second plugin, which this set does not design. If PGlite does not persist in the WebView, the operator's persistence decision fails and the options change (below).
- **One iPhone on a beta OS.** The only device used so far is iOS 27.2 beta, Obsidian 1.13.7. It cannot show the iOS 16.4 floor Tailwind 4 needs, and its cold-start numbers do not describe an older phone. No Android device has been used.
- **Peak memory has no known measurement method** on an iPhone from inside a plugin (WebKit has no `performance.memory`). mvp-08 asks for the same number. If no method exists, the record says "survived, no jetsam kill observed" and not a figure.
- **The spike may run after mvp-08 fixed the PGlite layout.** A no-go then reaches back into finished work.
- **Spike pre-releases are public.** The mobile-feasibility child left a public pre-release and test keys on the shared node that still await cleanup. This change creates up to four more pre-releases; each needs the operator's yes to create and to delete.

## What Changes

- Ordered device checks S1 to S8 (below), run on throwaway builds from a branch `chat-spike` that is never merged. Only `device-results.md`, the G1 decision and the measured numbers are carried forward.
- Four spike builds, each one BRAT pre-release (tag without `v`, equal to the manifest version): B0 baseline with timing marks, B1 chat bundle as a closure, B2 chat bundle as an embedded string, B3 adds PGlite and the SSE reader. B1 and B2 carry the Thread, Tailwind and Base UI content so cold start and the UI checks use the same bytes. The count is the plan; the operator may merge builds, but each build is still its own pre-release.
- A threshold rule fixed from the B0 numbers before the B1 and B2 numbers are read.
- G1: three go/no-go decisions (persistence, startup budget, UI feasibility) signed by the operator.

### Ordered checks

| # | Check | Build | What is recorded |
|---|---|---|---|
| S1 | Cold start, chat code lazily evaluated. Baseline, closure, string, and an eager-evaluation control from B1 by a setting. At least 5 force-quit cold launches per variant (a plan choice, not a measured need). Also: app killed while the chat view was open, then launched | B0, B1, B2 | Two numbers per run: in-plugin marks (main.js eval start, onload end, first chat open) and the operator's screen-recording launch-to-workspace-visible. Any 0x8BADF00D report or launch crash |
| S2 | A Thread in an `ItemView` over `useExternalStoreRuntime` with fixture messages and a streamed-token loop | B1 | Scrolling, composer, keyboard open and close with a pinned composer (`visualViewport`), safe area, 44 pt targets, rotation; pass or fail per item with screenshot |
| S3 | CSS cascade against Obsidian's unlayered CSS: C1 prefix only, C2 plus no preflight, C3 plus `important`, C4 plus root-class specificity, C5 shadow root (PM addition, optional). Test, do not assume | B1 | A table per variant of which sentinel elements (`button`, `input`, `textarea`, `h1`, `ul`) are overridden by Obsidian CSS, from a `getComputedStyle` dump the spike command writes to a note in the test vault; `.theme-dark`/`.theme-light` switch; desktop and iPhone |
| S4 | Portals and focus traps: Base UI Dialog and Collapsible with the Portal `container` set from the view's `ownerDocument`; desktop popout window; iPhone. Obsidian `Modal` is not used | B1 | Focus trap, outside tap, back gesture, keyboard with an input inside a dialog, scroll lock; popout window renders the portal in the popout, not the main window |
| S5 | PGlite persistence in the mobile WebView through the entity graph's persistence adapter | B3 | Load time, 500 messages written, force-quit, relaunch, hydrated count, hydrate time, `navigator.storage.persist()` and `estimate()` results, any jetsam kill; method for memory stated, or "no method" |
| S6 | SSE streaming on iOS: `fetch` plus `getReader` against the 1.6 endpoint (answers spec 002 open question 3) | B3 | Per-chunk arrival timestamps showing incremental delivery; behaviour on app background and foreground mid-stream; cancel by `AbortController` |
| S7 | Tailwind 4 needs iOS 16.4: Obsidian's minimum iOS from official docs, and the plugin's floor | none | The documented number with its source, and whether a feature gate is needed |
| S8 | Android pass of S1 to S6 | B1, B2, B3 | Device model, Android and WebView versions, results; or "no device: unverified" |

### G1 go/no-go

- **Persistence.** Go if S5 shows messages survive a force-quit and hydrate in a time the operator accepts. No-go options, for the operator to pick and not decided here: a custom `GraphPersistenceAdapter` over a store other than PGlite; transient Zustand state with opt-in transcript export only.
- **Startup budget.** Go if a lazy variant stays inside the signed threshold on the iPhone in every counted run. Otherwise go with fallback (second plugin) or no-go.
- **UI feasibility.** Go if S2 to S4 pass with at least one S3 variant and S6 shows incremental delivery. If S6 buffers, the options are buffered replies (spec 009 degrade rule) or no-go.

## Capabilities

### New Capabilities
- `chat-spike-gate`: how results are recorded, how the threshold is fixed, what a valid cold-start measurement is, the go/no-go outcomes.

### Modified Capabilities
<!-- none -->

## Impact

- Code: none on `main`. The branch `chat-spike` holds throwaway entries (`src/ui/chat-spike/`) and is not merged.
- Dependencies: none added to `main`. The branch needs the operator's pins (`chat-00` README) to build; if they are not yet in `versions.toml`, the branch uses scratch installs and the record says so.
- Outward: up to four public pre-releases; each creation and each deletion needs the operator's explicit yes.
- Records: `device-results.md` in this directory (template created with this change, all rows "not run").
