## Context

Draft 2026-10-02. Facts checked by opening files on 2026-10-02: `package.json` (one dependency, `typescript` 7.0.2, `esbuild` 0.28.2, `vitest` 5.0.2, scripts `build`, `typecheck`, `probe:webview`), `esbuild.config.mjs` (builds plugin and CLI, copies `manifest.json`), `tools/webview-import-probe.mjs` (bundles with `bundle`, `external` for `obsidian`, `electron`, `node:*` and built-ins; fails on any other external; limit 60 KB raw for `kubo-core`; its `common` options have no `minify`, `jsx` or `define`), `src/` (`core`, `crypto`, `kubo`, `plugin`, `sync`, `main.ts`; no `src/ui`, `src/data`, `src/agents` yet), `.claude/rules/typescript.md` (kebab-case for every `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`; layering UI, hooks, stores, services, external). Not read: `esbuild.options.mjs`, `tsconfig*.json` contents (the owner reads them before editing).

## Module layout (proposal; the owners confirm against the code before creating)

```
src/ui/chat/components/        React components, kebab-case .tsx; shadcn output in components/ui/
src/ui/chat/hooks/             hooks and view models; the only place PEM React hooks and assistant-ui runtime hooks are called
src/ui/chat/mount/             mount-chat-root.tsx: the only file importing react-dom/client
src/ui/chat/sanitize/          the only module that calls DOMPurify (chat-04)
src/ui/a2ui-native/            native A2UI DOM renderer; imports no React (chat-05)
src/data/chat/                 entity types, vanilla Zustand stores, persistence wiring; imports no React
src/agents/agui-client/        AG-UI fetch and SSE service and event reducer; imports no React and no Zustand
src/agents/a2ui-client/        A2UI replay, realtime and actions service; no React (chat-05)
src/plugin/chat-view.ts        ItemView shell; with chat-loader.ts the only Obsidian-aware files in the chat feature
```

## Layers and allowed imports

| Layer | Paths | May import | May not import |
|---|---|---|---|
| UI | `src/ui/chat/components`, `src/ui/chat/mount` | react, react-dom, assistant-ui, Base UI, hooks (the only project layer a component imports) | stores, services, PEM, `zustand`, `obsidian` (reach Obsidian through props or hooks) |
| Hooks and view models | `src/ui/chat/hooks` | react, PEM React hooks, assistant-ui runtime, stores (selectors and store actions) | services, components |
| Stores | `src/data/chat` | zustand/vanilla, PEM core, services (they call them), data modules of `src/data` (PGlite) | react, any UI path |
| Services | `src/agents/*-client` | `fetch`, event types | react, zustand, stores, UI |
| External | endpoint, PGlite, vault adapter | | |
| Sync core | `src/sync`, `src/kubo`, `src/crypto`, `src/core` | each other as today | react, zustand, assistant-ui, `src/ui`, `src/data/chat`, `src/agents` |

Cross-feature imports stay prohibited; the chat feature talks to sync through the `EventBus` or through values the plugin shell passes in. `src/plugin/chat-view.ts` may import `src/ui/chat/mount` (lazily) and the plugin seams.

## Lazy evaluation

Obsidian ships `main.js`, `manifest.json`, `styles.css` only. The chat bundle is built separately (IIFE, minified) and embedded into `main.js` in the form chat-01 selects: a closure defined but not called, or a string evaluated on first open. `onload` registers the view type, a ribbon icon and a command and does nothing else. The first `onOpen` evaluates the bundle once and keeps the result. The loader is one file (`src/plugin/chat-loader.ts`); it is the only file allowed `eval` or `new Function`, if the string form is chosen.

## Build topology

1. `esbuild` builds the chat bundle: entry `src/ui/chat/mount/mount-chat-root.tsx`, `jsx: automatic`, `define process.env.NODE_ENV`, `external: obsidian`.
2. A generated module wraps that output (closure or string) and the plugin build imports it.
3. `@tailwindcss/cli` builds `styles.css` from a source stylesheet using the spike's winning variant; output copied next to `main.js` like `manifest.json`.
4. The sync core and CLI builds do not see steps 1 to 3.

## Decisions to take from chat-01

Closure versus string; which S3 cascade variant; whether the restore-at-launch case needs a mitigation; the numeric chat bundle limit for the probe and the size gate; the platform floor. Until G1 is signed these are placeholders in the tasks, not choices.
