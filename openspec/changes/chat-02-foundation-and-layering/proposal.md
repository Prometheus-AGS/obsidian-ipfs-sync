## Why

Today the repository has no JSX, no React, no CSS output, one runtime dependency (`@noble/hashes` 2.4.0), a `webview-import-probe` that bundles only `src/kubo` and `src/core` plus three probe entries, and no CI (`.github/` does not exist). The operator's rule is that the sync core never imports React. A rule that no tool enforces is a wish. This change puts the build, the enforcement and the lifecycle rules in place before any chat feature code, so chat-03 to chat-05 land inside them.

The uncomfortable parts:
- **The size gate cannot protect cold start.** CI can compare bytes against a recorded number. It cannot measure an iPhone. The real gate is operator-run, so a regression is caught at the phase gate or later, not on each change.
- **There is no CI to host the gates.** `chat-00/tasks.md` 0.4 decides whether one is created. Until then the gates are `pnpm` scripts that someone has to run.
- **Lazy evaluation may not hold.** Obsidian restores an open view at launch. If the chat view was open when the app was killed, the chat code evaluates during start. The mitigation depends on a spike result that does not exist yet (chat-01 S1).
- **shadcn generates code into our tree.** `shadcn init --base base` writes components, a `components.json` and may add dependencies and edit config. That code is reviewed like ours, and it must follow our file naming and constraint greps.
- **`eval` is a security-sensitive primitive.** If the string-embedding variant wins in the spike, the plugin evaluates its own embedded code. The loader is one file, grep-gated, and read by the independent reviewer. Whether community-plugin review accepts it is not our concern now (BRAT distribution) and is not verified.

## What Changes

- Dependencies added at the operator's pins (`chat-00` README). One writer for `package.json` and the lockfile. `pnpm audit --prod` baseline recorded.
- `esbuild.*` and `tsconfig*` gain the JSX loader, `jsx: react-jsx`, `define` for `process.env.NODE_ENV`, a separate chat bundle (IIFE) embedded into `main.js` in the form the spike chose, and a Tailwind CLI step emitting `styles.css`.
- `tools/check-layering.mjs`, `tools/check-chat-constraints.mjs`, extended `tools/hook-isolation.mjs`, extended `tools/webview-import-probe.mjs` with a chat entry and a chat size limit taken from the spike measurement.
- `tools/chat-size-gate.mjs` and the iPhone cold-start gate procedure for the release candidate.
- `src/plugin/chat-view.ts`: an `ItemView` that registers cheaply in `onload`, evaluates and mounts only on open, unmounts in `onClose`, handles popout windows, and survives StrictMode.
- A feature gate for WebViews below the floor chat-01 S7 finds, if the floor is above Obsidian's minimum.
- Design notes in `design.md`: module layout, layer table, lazy mechanism.

## Capabilities

### New Capabilities
- `chat-shell-boundaries`: layering, React confinement, sanitizer and window-global rules, the constraint greps.
- `chat-lifecycle-and-startup`: lazy evaluation, mount and unmount, popout windows, StrictMode, the startup gate, the platform floor gate.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `package.json`, lockfile, `esbuild.*`, `tsconfig*`, `tools/`, `src/ui/`, `src/plugin/chat-view.ts`, one wiring edit in `src/plugin/index.ts` (register view and command only), `components.json`, generated shadcn files under `src/ui/chat/components/ui/`.
- Dependencies: the pin list in `chat-00`. About 204 packages in the measured set; `radix-ui` and `zod` 4 arrive transitively through assistant-ui.
- `main.js` grows by the chat bundle. The 300 KB gz limit is waived for chat code only; the non-chat plugin code keeps its existing checks.
- Release assets gain `styles.css`.
- Cadence: reviewers dormant; one whole-tree gate at the phase boundary (`chat-00/tasks.md` 0.6).
