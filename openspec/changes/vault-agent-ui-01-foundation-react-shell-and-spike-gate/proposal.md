## Why

The operator decided on React 19, shadcn/ui and assistant-ui for chat (D1). Nothing React exists in the repository: `package.json` has one dependency, `@noble/hashes` 2.4.0; `src/` has `core crypto kubo main.ts plugin sync`; `styles.css` does not exist and `esbuild.config.mjs` copies only `manifest.json` (all read 2026-10-04). The `chat-react-shell` plan already covers the spike (`chat-01`), the build and lifecycle foundation (`chat-02`) and the layering lint. This slice folds them in, adds the styles contract that keeps the "user's accent is the only accent" rule alive under shadcn (D12), and adds the Vault agent view shell that every later slice fills.

The uncomfortable parts:
- **G1 can say no.** React inside Obsidian on an iPhone has never been measured. The spike (`chat-01` 1.14) can return `no-go`. The fallback in `chat-00` (a second plugin) is not designed. Nothing React-shaped lands before G1 reads `go` or `go with fallback`.
- **chat-01 and chat-02 are not sized by me.** They hold 14 and 17 tasks. This slice's own estimate (6 agent-days) excludes them.
- **The token map is a design claim until the spike measures it.** Tailwind output losing to Obsidian's unlayered CSS is inference (`chat-00` README). The mapping in D12 is a plan; chat-01 S3 tests whether it holds.
- **Any new file under `src/ui/` or `styles.css` before 07b closes reopens the exact-tree review** (`mvp-07b-keys-history-guard-release-2/tasks.md` 6.5). The start condition prevents it.
- **The shell shows tabs with nothing behind them.** Search, Chat and Index have no backing data yet. The preview gate keeps this out of releases.
- **The design copies still say "no React".** Until `tasks.md` 0.3 lands, `docs/design/` contradicts the code.

## What Changes

- Section 1: the `chat-01` spike runs unchanged; G1 gates sections 2 to 5. Deltas for the spike branch are listed in `decisions-needed.md` D1.
- Section 2: `chat-02` tasks 1.1 to 4.1, folded in by id with the renames and deltas in `design.md`.
- Section 3: `styles.css` contract and the styles gate; the shadcn token map (D12).
- Section 4: Vault agent view host and lazy mount, tab strip as view state, a stub index port with an honest `unavailable` state, the Index tab on the stub, the status chip, commands, the preview gate.
- Section 5: release plumbing for `styles.css`.

## Capabilities

### New Capabilities
- `vault-agent-styles`: the single stylesheet, the token map, the gate.
- `vault-agent-shell`: the view host, lazy mount, tabs, preview gate, stub index state, status chip.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/ui/` (new), `src/plugin/vault-agent-view.ts`, `src/plugin/vault-agent-loader.ts` (new), one registration edit in `src/plugin/index.ts`, `styles.css` (new), `tools/` scripts, `esbuild.*`, `tsconfig*`, `package.json`, lockfile (single writer, only after operator pins), `tests/`, `features/`.
- Dependencies: the pins of `chat-00` README, entered by the operator (`tasks.md` 0.5). None assumed present.
- Cadence: reviewers dormant until the phase gate.

Blocked on: operator pins; D12 answers (`minAppVersion` and `color-mix`); G1 for sections 2 to 5; `tasks.md` 0.3 for the design copies.
