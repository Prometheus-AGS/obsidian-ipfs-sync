## Context

Facts checked 2026-10-04: `package.json` (dependencies `@noble/hashes` 2.4.0; devDependencies include `obsidian` 1.13.1, `esbuild` 0.28.2, `typescript` 7.0.2), `esbuild.config.mjs` (line 15 copies `manifest.json`), `tools/release/constants.mjs` and `tools/check-guard-preconditions.mjs` (`dist/plugin/styles.css` optional build output), `versions.toml` (three pins), `src/plugin/index.ts` (status bar item at line 160, eight commands, two ribbon icons), `.claude/rules/typescript.md` (layering rule), `chat-02-foundation-and-layering/design.md` (module layout and layer table). Not read: `esbuild.options.mjs`, `tsconfig*.json` contents (owners read them before editing), `docs/design/index.html` token map.

## Folded from chat-02

Tasks 1.1 to 1.6, 2.1 to 2.5, 3.1 to 3.4 and 4.1 of `chat-02-foundation-and-layering/tasks.md` are executed as written, with these deltas:

| chat-02 | Delta |
|---|---|
| 3.1 `chat-view.ts`, `chat-loader.ts` | become `src/plugin/vault-agent-view.ts` and `vault-agent-loader.ts`. The view hosts a tab strip, not only a chat. `onload` registers the view type, commands and the chip only when the preview gate is on; the constructor creates nothing; `onOpen` evaluates the bundle once and mounts |
| 2.1 layering lint | edge table also covers `src/data/llm`, `src/agents/llm` (slice 02) and `src/data/collections` (slice 03). Components never import `obsidian`; they reach it through props passed by the host |
| 2.5 constraint greps | add: no key material or `Authorization` in any log call; `innerHTML` only in the sanitizer module (slice 05) |
| 1.4, 1.5 styles and shadcn | bound by the styles contract below. shadcn's default theme file is not imported |
| 2.4 size and startup gate | the iPhone cold-start gate also covers a restored open view at launch |
| 0.4 of chat-00 (CI existence) | referenced; decision owner release-deployment-lead |

## Styles contract

One `styles.css`, built output `dist/plugin/styles.css`. Every selector sits under `.ipfs-sync-root` or starts with the prefix chosen by chat-02 1.4. shadcn tokens are defined only on `.ipfs-sync-root`, each as `var()` of an Obsidian variable (table in `decisions-needed.md` D12). No hex or rgb literal, gradient, `@font-face`, or `font-family` other than an Obsidian variable; no redefinition of an Obsidian variable; no `:root` or `body` rule. Accent-filled small text is not used (contrast, D12). Motion: expand 200 ms, collapse 140 ms, ease-out, one `prefers-reduced-motion` rule. Mobile: 44 px targets via the mobile body class (name unverified; the prototype CSS assumes `is-mobile`). The gate is `tools/check-styles.mjs` (new), a plain script with no dependency.

## Shell

```
src/plugin/vault-agent-view.ts    ItemView host: the only file here that extends ItemView; view state holds the active tab
src/plugin/vault-agent-loader.ts  lazy evaluation of the chat bundle (mechanism per chat-01 B1 or B2)
src/ui/mount/mount-vault-agent.tsx  the only file importing react-dom/client for this view
src/ui/shell/components/          tab strip, empty state, Index tab on the stub (components import hooks only)
src/ui/shell/hooks/               use-active-tab, use-index-state (hooks import stores only)
src/data/shell/                   vanilla zustand stores: active tab, index state
src/agents/index-port/            stub service returning { kind: "unavailable" }
```

The stub is a consumer-side port. data-engineer's real service replaces it in slice 09 under the same store contract; the shape is agreed in `tasks.md` 0.11, not decided here. The stub never returns counts. The Index tab on the stub says there is no index on this device and that building one is not available in this version; exact copy lives in a `*-copy.ts` file and is not fabricated data.

Status chip: a status bar element made with `addStatusBarItem()`; its text comes from the index store through a host function in `src/plugin`, not from React. On `unavailable` it states that fact. Clicking opens the Index tab. Phones: no status bar assumed (unverified); the Index tab is the surface.

Preview gate: a boolean in plugin data, default false, no settings row. Off: no view registration, no commands, no chip. Settings schema change by ipfs-engineer (`src/plugin/settings-store.ts` pattern).

Layering for the shell: component, hook, store, service. The host files may import stores and the loader; they import no component.

## Amendments folded from the hybrid-skills UI input (advisory; `design-input-hybrid-skills-ui.md`)

- A1, one source for the active tab: `ItemView.getState` and `setState` (present in obsidian.d.ts) are the source; the store holds a read projection updated by the host. No second writable copy. The input reads mirroring navigation state in a store as a red flag.
- A9, one graph per concern is created in the store layer and the same `GraphStore` is passed to every React root's `GraphStoreProvider` (view, quick-ask Modal, settings tab, sheet). Nothing relies on the ambient active store; which store a module-level value resolves to with several providers mounted is unverified.
- A10, a typed `HostPorts` context created by `src/plugin` (open a note, notice, platform facts, key store, `requestUrl`, retired-host check) replaces Obsidian's `AppContext<App>`; only hooks read it, so components still import no `obsidian`. The mount keeps Obsidian's documented shape (`createRoot(contentEl)`, `unmount` in `onClose`).
- A11, popout: besides `ownerDocument` at mount, recompute the portal container when the element migrates windows (`onWindowMigrated`, `el.win`, `el.doc`; present in obsidian.d.ts per the input; behaviour unverified).
- A16, responsive switches use container width (a container query or a measured width), not viewport or OS; Tailwind 4 container-query support is unverified and the spike confirms it. The quick-ask host choice alone uses `Platform.isMobile`.
- A3, components never branch on theme: no `dark:` utility and no `.theme-dark` selector outside the token block.
- A4, contrast: `--text-on-accent-inverted` is mapped beside `--text-on-accent` (Obsidian picks one by accent lightness); a light accent is measured as well as the default; the spike dump resolves which font variables exist (`--font-interface` and `--font-monospace` are not on the Typography page the input read, which lists `-theme` names); radius values 4, 8, 12 and 16 px are from the Radiuses page.
- A2, `check:layering` fixtures copied from the hybrid examples, each failing alone: a hook importing a service; a hook importing another feature's store; a store importing React-bound `zustand` `create` instead of `zustand/vanilla`; a component importing `obsidian`.
- The hybrid skills' tokens generator, hex palette, Flat 2.0 and activation hooks are not adopted (D17).
- A feature descriptor (id, tabs, commands) is a typed constant read by the shell; a per-tab error boundary proves a lazy-load failure does not take the view down. Nothing more (no manifest validator; there is no second consumer).
