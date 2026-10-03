# Assessment: React + assistant-ui + Zustand + shadcn(Base UI) chat stack for the Obsidian plugin

Date 2026-10-02. Read-only research; scratch builds in
`/private/tmp/claude-501/-Users-gqadonis-obsidian--ipfs-sync/649e61e6-bc8a-42a6-89a8-c16e83bbae4a/scratchpad/chat-stack`.
Nothing was installed in the repo. All versions below were read from `npm view` on 2026-10-02.

## Verdict (and the uncomfortable finding)

**Viable on iOS functionally. Not viable inside the 300 KB gz budget as a single main.js.**

The uncomfortable finding: the stack does not fit the budget, and the only package that
gives AG-UI "for free" is the biggest line item.

- Plugin today: 105 KB gz. Chat stack alone (React + Zustand + assistant-ui + Base UI + markdown
  + GFM + DOMPurify, no AG-UI package): **251 KB gz / 810 KB raw**. Combined: about **356 KB gz**,
  about 1.2 MB raw. That is about 56 KB over the 300 KB gz budget before any Tailwind CSS,
  shadcn component code, syntax highlighting, mermaid or KaTeX.
- With `@assistant-ui/react-ag-ui` (pulls `@ag-ui/client`, `@ag-ui/core`, `@ag-ui/proto`, rxjs):
  chat stack **351 KB gz alone**, combined about **456 KB gz**. Over budget by about 150 KB.
- React DOM is 69 KB gz of that and is not removable. `@assistant-ui/core` is 179 KB raw
  (about 60 KB gz) and is pulled in even by a trivial ExternalStoreRuntime thread.
- The budget is a web page-load budget. A plugin bundle loads from local disk, so the cost
  that hurts is parse/eval on every app start on a phone, not download. That is exactly the
  unmeasured risk (see spike list). The community release only ships `main.js`, `manifest.json`,
  `styles.css` (https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin), so a
  separate lazy chunk file is not a supported distribution path (BRAT asset handling: could not confirm).
  Lazy loading must happen inside main.js (e.g. chat code kept as a string/closure and
  evaluated on first open), which defers parse cost but not file size.

Second uncomfortable finding: "shadcn with Base UI, not Radix" is only partly true with
assistant-ui. `@assistant-ui/react` 0.15.23 has a **hard runtime dependency on the `radix-ui`
umbrella package** (36 imports in dist: DropdownMenu, Popover, Slot, Direction). Tree-shaking
cuts it to about 2.5 KB (`@radix-ui/react-slot` only) for a Thread, but it stays in
node_modules and the lockfile, and the Dropdown/Popover/AssistantModal primitives drag Radix in
if used. `@assistant-ui/react-markdown` additionally depends on `@radix-ui/react-primitive`
and `react-use-callback-ref`. Your own shadcn components can be 100 percent Base UI; the
library underneath is not Radix-free. Radix is also not exposed as a failure: assistant-ui
documents that its primitives accept both `asChild` and Base UI's `render` prop
(https://www.assistant-ui.com/docs/base-ui.md).

Third: assistant-ui is pre-1.0 (0.15.x) and `@assistant-ui/react-ag-ui` is 0.0.63. Both were
published within the last day (modified 2026-10-02). Expect API churn.

## 1. assistant-ui, Zustand

| Package | Version (npm, 2026-10-02) | Notes |
|---|---|---|
| `@assistant-ui/react` | 0.15.23 | peers react/react-dom `^18 \|\| ^19`. Deps: zod ^4.6.5, zustand ^5.0.15, `radix-ui` ^1.6.7, assistant-cloud, assistant-stream, @assistant-ui/{tap,core,store}, safe-content-frame, react-textarea-autosize |
| `@assistant-ui/react-markdown` | 0.14.18 | wraps `react-markdown` ^10.1.0 (remark/rehype/micromark). No GFM, no highlighter bundled |
| `@assistant-ui/react-ag-ui` | 0.0.63 | `useAgUiRuntime`, `useAgUiInterrupts`, `useAgUiState`, `useAgUiSendA2uiAction`. Deps: `@ag-ui/client` ^0.0.59, fast-json-patch, `@assistant-ui/react-generative-ui` |
| `@assistant-ui/react-ai-sdk` | 1.4.14 | needs `ai` ^7; not relevant |
| `zustand` | 5.0.15 | assistant-ui already depends on it, so one copy |
| `react` / `react-dom` | 19.3.0 | assistant-ui supports 18 or 19 |
| `@base-ui/react` | 1.8.0 | see section 2 |

- React 19: compatible by peer range; measured builds used 19.3.0 with no errors.
- Runtimes (skill + docs): `useExternalStoreRuntime` (Redux/Zustand), `useLocalRuntime`,
  `useAgUiRuntime`, `useA2ARuntime`, `useLangGraphRuntime`, `useChatRuntime` (AI SDK).
  https://www.assistant-ui.com/docs/runtimes/custom/external-store.md
- Styling: the `@assistant-ui/react` primitives are unstyled. The styled Thread/Message
  components come from the shadcn-style registry (`components/assistant-ui/*`), which are
  Tailwind-based. The docs page I fetched did not state a Tailwind requirement explicitly
  (could not confirm), but the registry components use Tailwind classes.
- Base UI: shadcn styles starting with `base-` use Base UI; registry components compose the
  primitives with `asChild`/`render` so one implementation serves both flavors
  (https://www.assistant-ui.com/docs/base-ui.md).

### Clean-architecture feed for ExternalStoreRuntime from Zustand

Chat entities and run state live in a framework-free store; the adapter is the only React-aware seam.

```
UI (assistant-ui primitives, shadcn)
  -> hook layer: useChatRuntime() = useExternalStoreRuntime({messages, isRunning, convertMessage, onNew, onCancel, setMessages})
  -> store: Zustand vanilla store (createStore, not React-bound) holding normalized AG-UI-derived messages, runState
  -> service: AgUiSession (fetch+SSE reader, event reducer) pure TS, no React, no zustand import
  -> external: UAR endpoint (/ag-ui/stream)
```

- Reducer in the service layer maps each AG-UI event to an immutable message-state patch
  (spec 010 item 2: every chunk type renders). The store only applies patches.
- `convertMessage` maps store message -> `ThreadMessageLike` (text part, reasoning part, tool-call
  part, custom data parts for skill activation / memory recall / citations).
- `onNew` calls the service (command), never mutates the store directly. `onCancel` aborts the fetch.
- Use `createStore` from `zustand/vanilla` and `useStore(store, selector)` in the hook so the
  store and service are unit-testable without React. Docs show the plain `create` hook form
  (https://www.assistant-ui.com/docs/runtimes/custom/external-store.md); the vanilla form is
  my recommendation, not a documented pattern.
- Alternative: skip `@assistant-ui/react-ag-ui` (about +110 KB gz, rxjs, protobuf) and write a
  small SSE reducer yourself, feeding ExternalStoreRuntime. Costs code you must own; saves
  budget. Spec 002 already says plain fetch+reader is sufficient for AG-UI.

## 2. shadcn/ui with Base UI

- Officially supported. Changelog (https://ui.shadcn.com/docs/changelog): Base UI docs
  January 2026; blocks for Radix and Base UI February 2026; a July 2026 entry titled
  "Base UI as the Default" (read through a summarizer, treat the wording as unconfirmed).
- CLI: `shadcn init` has `-b, --base <base>` with values `base`, `radix`, `aria`
  (https://ui.shadcn.com/docs/cli). Styles prefixed `base-` (e.g. `base-nova` in components.json)
  select Base UI. shadcn CLI npm version 4.21.1. The shadcn MCP `base` item search returned
  nothing; I could not verify registry contents via MCP. The installed `shadcn` skill documents
  `base` vs `radix` in components.json and `rules/base-vs-radix.md`; the
  `anthropic-skills:radix-to-base-ui-migration` skill exists but is only needed if Radix
  components are added by mistake.
- `@base-ui/react` 1.8.0 (2026-09-04); stable 1.0.0 on 2025-12-11
  (https://base-ui.com/react/overview/releases). Old package `@base-ui-components/react`
  stops at 1.0.0-rc.0; use `@base-ui/react`. Deps: floating-ui, `@base-ui/utils`, use-sync-external-store.
- Size, measured: Dialog + Collapsible import added about 25 KB gz (raw +74 KB; `@base-ui/react`
  57 KB + utils 13 KB raw in the minified output). More primitives add more.
- Portals: `Dialog.Portal` takes `container` (HTMLElement | ShadowRoot | ref), default `<body>`
  (https://base-ui.com/react/components/dialog.md via Context7 `/websites/base-ui_react`).
  Base UI uses `ownerDocument` in 41 files and bare global `document.`/`window.` in 2 (grep of
  node_modules). Good for popout windows if you pass `container` explicitly.
- Quick-start recommends `isolation: isolate` on the app root for portals.

## 3. Tailwind in an Obsidian plugin

- Tailwind 4.3.3. Browser floor: Chrome 111, Safari 16.4, Firefox 128
  (https://tailwindcss.com/docs/compatibility). It relies on cascade layers, `@property`,
  `color-mix`. Safari 16.4 means iOS 16.4+. Check this against the plugin's iOS support claim
  (`minAppVersion 1.12.3`; Obsidian's own iOS minimum could not be confirmed).
- Emit a scoped `styles.css`: Obsidian loads `styles.css` from the plugin folder; it is an optional
  release file. Build with `@tailwindcss/cli`, output `styles.css`.
- Preflight off, prefix on. Verified in scratch (output 756 bytes for a 1-class sample):
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss/theme.css" layer(theme) prefix(ipfs);
  @import "tailwindcss/utilities.css" layer(utilities) prefix(ipfs);
  ```
  Emits `.ipfs\:flex{...}`, theme variables as `--ipfs-spacing` etc. (prefix applies to variables
  too), and `ipfs:data-[open]:` variants work. `prefix()` goes on both imports
  (https://tailwindcss.com/docs/preflight).
- Hazard I derived from cascade rules, not tested on device: Tailwind output is inside `@layer`,
  and **unlayered CSS beats layered CSS regardless of specificity**. Obsidian's own stylesheet is
  unlayered, so its `button`, `input`, `textarea`, `h1..h6`, `ul/ol` rules will override utilities
  on those elements. Mitigations: `important` flag on the utilities import, or build without layers
  (post-process), or scope all chat markup under a root class with extra specificity. Spike it.
- shadcn components assume `cssVariables` tokens (`--background`, `--primary`...). Map them to
  Obsidian variables in the chat root, e.g. `--background: var(--background-primary)`,
  `--foreground: var(--text-normal)`, `--border: var(--background-modifier-border)`,
  `--primary: var(--interactive-accent)`. Obsidian toggles `.theme-dark`/`.theme-light` on body,
  so Tailwind's `dark:` must be configured with a custom variant on `.theme-dark`, not
  `prefers-color-scheme` (the default output above uses the media query).
- Mobile safe area: use `env(safe-area-inset-bottom)` (verified it passes through arbitrary values),
  44 pt targets via `min-h-11 min-w-11` (11 x 4 px = 44 px).
- shadcn `prefix` option exists in components.json (https://ui.shadcn.com/docs/components-json);
  `style` currently documented as `new-york`/`base-*`.

## 4. Measurements (esbuild 0.28.2, minify, es2022, cjs, platform browser, NODE_ENV=production, external obsidian)

Entries in `.../chat-stack/e/`; script `build.mjs`. Raw/gzip bytes, brotli also noted.

| Step | Raw | Gzip | Delta gz |
|---|---|---|---|
| 1 react + react-dom/client | 222,732 | 69,067 | base |
| 2 + zustand | 223,455 | 69,390 | +323 |
| 3 + @assistant-ui/react (Thread, Message, Composer primitives, ExternalStoreRuntime) | 541,815 | 164,114 | +94,724 |
| 4 + @base-ui/react (Dialog, Collapsible) | 615,891 | 188,996 | +24,882 |
| 5 + @assistant-ui/react-markdown | 740,931 | 227,811 | +38,815 |
| 5b + remark-gfm + dompurify | 809,830 | 250,686 | +22,875 |
| 6 AG-UI package alone (react + aui + react-ag-ui + @ag-ui/client) | 871,028 | 240,955 | n/a |
| 7 everything (5b + AG-UI package) | 1,218,069 | 351,459 | +100,773 over 5b |

Plugin today 105 KB gz => with 5b about 356 KB gz; with step 7 about 456 KB gz. Budget 300 KB.
Largest raw contributors at step 5b: react-dom 210 KB, `@assistant-ui/core` 179 KB,
`@assistant-ui/react` 64 KB, `@base-ui/react` 57 KB, dompurify 30 KB, micromark 27 KB.
At step 7: `@ag-ui/client` 116 KB, `react-ag-ui` 84 KB, `@ag-ui/core` 73 KB, `@ag-ui/proto` 51 KB.
Not included: Tailwind CSS (small), shadcn component source, code highlighter, mermaid, KaTeX, lucide icons.
Not tested: Preact/compat aliasing (could not confirm assistant-ui works under it).

No Node built-ins: esbuild with `platform: browser` produced no external imports other than
`obsidian` in every entry, including the AG-UI package. No `new Worker`, `WebAssembly` or
`SharedArrayBuffer` in `@assistant-ui/*` or Base UI (grep). Mermaid/KaTeX would need their own check.

## 5. Obsidian hazards

- Popout windows: `window`/`document` globals point to the main window. In assistant-ui these appear
  only in `SelectionToolbarRoot`, `makeAssistantVisible`, `CloudRendererHost`, `useMediaQuery`
  (`window.matchMedia`); all avoidable by not importing them. Base UI is `ownerDocument`-aware, but
  its Portal defaults to the main `document.body`; always pass `container` from the view's
  `contentEl.ownerDocument.body` or a ref in contentEl. Plugin code must use `activeDocument` /
  `el.doc`, not bare `document`. Obsidian `registerDomEvent` takes a window argument.
- ItemView lifecycle (https://docs.obsidian.md/Plugins/Getting+started/Use+React+in+your+plugin):
  `createRoot(this.contentEl)` in `onOpen`, `root.unmount()` in `onClose`. StrictMode double-invokes
  effects only in dev; do not wrap in StrictMode in shipped builds, but test with it once since
  assistant-ui runtime hooks subscribe in effects. A deferred view (Obsidian 1.7.2+) can exist
  without being opened: do not create the Zustand store or start SSE in the constructor. (I could
  not fetch the deferred-views doc page; this is from memory, unconfirmed.)
- Do not use `Modal` for the chat if it contains Base UI popups; Obsidian's modal has its own
  focus and outside-click handling. Spec 009's mobile bottom sheet will be custom DOM in a view or
  a container appended to the workspace. Untested.
- Mobile keyboard/viewport: iOS WKWebView keyboard behavior with a pinned composer needs
  `visualViewport` handling; assistant-ui `ComposerPrimitive.Input` uses `react-textarea-autosize`.
  Untested; spike.
- iOS focus traps/portals: Base UI Dialog uses a floating-ui focus manager; WKWebView plus Obsidian's
  own focus handling is the highest-risk interaction. Untested.
- CSP/eval: React, Base UI, react-markdown need no eval; no `dangerouslySetInnerHTML` or
  `innerHTML` found in `@assistant-ui/react`, `react-markdown`, `@assistant-ui/react-markdown`,
  or `@base-ui/react` (grep). Spec 010 HTML/SVG still needs DOMPurify and a repo grep gate
  (`dangerouslySetInnerHTML`, `innerHTML`) per `~/.claude/rules/web/security.md`.
  `safe-content-frame` (an iframe sandbox helper) is a dependency of `@assistant-ui/react`; it is
  not in the measured bundle, but any MCP-app/sandbox feature would use iframes.
- `process.env`: define `process.env.NODE_ENV` as in the probe. `@assistant-ui/core` reads
  `process.env.NEXT_PUBLIC_ASSISTANT_BASE_URL` guarded by `typeof process !== "undefined"`; harmless.
- `tools/webview-import-probe.mjs`: uses `bundle:true`, `external: [obsidian, electron, node:*, builtins]`
  and fails on any non-allowed external import. Add a chat entry (`tools/webview-probe-chat-entry.tsx`)
  with the JSX loader and a size check. Its current `common` options lack `minify`, `jsx`, and
  `define`; the 60 KB `kubo-core` limit is unaffected. Add a separate chat limit.
- Dependency discipline: 204 packages for the measured set (`npm i` output), including
  `radix-ui`, `zod` 4, `rxjs` (via ag-ui). `pnpm audit` is already run in this repo; it will see these.

## 6. Ranked risks and first spikes on a real iPhone (BRAT pre-release)

Risks, highest first:
1. **Startup cost on iOS**: 356 to 456 KB gz (about 1.2 to 1.5 MB raw) parsed at plugin load;
   plus the existing plugin. Unmeasured on device. Mitigation: evaluate chat chunk lazily on first
   open of the view; prefer not shipping `react-ag-ui`.
2. **CSS cascade fight with Obsidian's unlayered styles** plus the Safari 16.4 floor for Tailwind 4.
3. **Pre-1.0 churn** in assistant-ui 0.15 and react-ag-ui 0.0.x (daily releases).
4. **iOS keyboard, focus trap and portal behavior** in WKWebView and in popouts.
5. **Radix still in the dependency graph** despite the Base UI decision.
6. Spec 010 coverage (every AG-UI chunk, skill activation card, collapsibles) is custom work on top;
   assistant-ui gives message parts and tool UIs, not these cards.

Spike order (each is a BRAT pre-release of a throwaway entry, behind a command):
1. **Cold-start spike**: build the step-5b bundle as the plugin's main.js plus the existing plugin;
   record time-to-load on the oldest supported iPhone/iOS and Android mid-range. Compare with and
   without lazy evaluation. This decides the verdict.
2. **ExternalStoreRuntime thread** (static fixture messages including a streamed-token loop) in an
   ItemView on iPhone: scrolling, composer, keyboard, safe-area, 44 pt targets.
3. **Tailwind prefix/no-preflight styles.css**: verify `button`/`input` in Obsidian are not
   overriding utilities; verify `.theme-dark` switching and iOS version floor.
4. **Base UI Dialog/Collapsible with `container` in contentEl**, in a popout window on desktop and
   on iPhone (focus trap, outside click, Escape/back gesture).
5. **SSE `fetch` streaming** against UAR on iOS WKWebView (already an open question in spec 002).

## Open items I could not confirm

- Whether BRAT downloads extra release assets beyond main.js/manifest/styles.css.
- Obsidian's own minimum iOS version, and whether it clears Safari 16.4.
- Whether assistant-ui's registry Thread component needs Tailwind features outside Tailwind 4.
- The exact content of the shadcn "Base UI as the Default" changelog entry (summarizer only).
- shadcn registry items for assistant-ui (MCP search for `base` type returned none).
