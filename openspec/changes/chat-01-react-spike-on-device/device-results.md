# Device results, chat-01 spike (template, nothing run)

Created 2026-10-02 as a template. Every row below is "not run". Fill it in from operator screenshots, screen recordings and reports, as the mobile-feasibility file did (`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/device-results.md`). A row without evidence stays "not run". An agent never writes a result it did not observe; it writes "operator-reported" or "not run".

Device: _(model, iOS version, Obsidian version and build; previous device was iPhone, iOS 27.2 beta, Obsidian 1.13.7 build 365)_
Spike pre-releases created (for cleanup in 1.13): _(none)_

## Startup threshold (signed before any B1 or B2 number is read)

Rule: _(operator writes the rule and numbers here after the B0 runs; timestamp and signature)_

## Results

| Check | Build | Result | Evidence |
|---|---|---|---|
| S1 baseline cold start, 5 runs, both numbers | B0 | not run | |
| S1 chat lazy (closure), 5 runs, both numbers | B1 | not run | |
| S1 chat lazy (string), 5 runs, both numbers | B2 | not run | |
| S1 eager control, 5 runs | B1 `eager` | not run | |
| S1 app killed with chat view open, then launch | B1, B2 | not run | |
| S2 Thread in ItemView: scroll, composer, keyboard, safe area, 44 pt, rotation | B1 | not run | |
| S3 CSS cascade C1 to C5, desktop | B1 | not run | |
| S3 CSS cascade C1 to C5, iPhone, theme switch | B1 | not run | |
| S4 portals and focus: desktop main window, desktop popout window, iPhone | B1 | not run | |
| S5 PGlite: load time, 500 messages, force-quit, hydrate, `persist()`, `estimate()` | B3 | not run | |
| S6 SSE: incremental chunks, background and foreground, cancel | B3 | not run | |
| S7 Obsidian minimum iOS and plugin floor (documentary) | none | not run | |
| S8 Android: S1 to S6 | B1, B2, B3 | not run | |

## Endpoint facts recorded by 1.6

_(endpoint, auth model, CORS origins actually seen from desktop and mobile; spec 002 open questions 1 and 2)_

## Decision (G1)

| Decision | Outcome | Evidence rows | Notes |
|---|---|---|---|
| Persistence (PGlite entities) | not decided | | |
| Startup budget | not decided | | |
| UI feasibility | not decided | | |

Still unverified after the spike: _(list)_
