## Purpose

Defines the import boundaries and the banned constructs for the chat shell, so that React stays inside the chat feature, the sync core stays free of it, and agent-supplied content cannot reach the DOM unsanitized.

## ADDED Requirements

### Requirement: Layering
Chat code SHALL follow the order UI, hooks and view models, stores, services, external. A component SHALL NOT import a store or a service. A store SHALL NOT import React or any UI path. A service SHALL NOT import React, Zustand, a store or any UI path. The layering lint SHALL fail on each violation with file, line and rule.

#### Scenario: Component calls a service
- **WHEN** a file under `src/ui/chat/components` imports from `src/agents`
- **THEN** `check:layering` exits non-zero and names the rule

### Requirement: Sync core isolation
`src/sync`, `src/kubo`, `src/crypto` and `src/core` SHALL NOT import `react`, `react-dom`, `zustand`, `@assistant-ui/*`, `@base-ui/react`, `src/ui`, `src/data/chat` or `src/agents`. The `probe:webview` sync-core entries SHALL assert that none of those packages appears among their bundled inputs.

#### Scenario: React reaches the core
- **WHEN** a file in `src/core` imports `react`
- **THEN** both the layering lint and `pnpm probe:webview` fail

### Requirement: React confinement
`react` and `react-dom` SHALL be imported only under `src/ui`. `react-dom/client` SHALL be imported only by `src/ui/chat/mount/mount-chat-root.tsx`. `src/ui/a2ui-native` SHALL import no React.

#### Scenario: Native renderer imports React
- **WHEN** a file under `src/ui/a2ui-native` imports `react`
- **THEN** the layering lint fails

### Requirement: Banned constructs
The tree SHALL NOT contain `dangerouslySetInnerHTML`. `innerHTML`, `outerHTML` and `insertAdjacentHTML` SHALL appear only under `src/ui/chat/sanitize/`. Agent-supplied HTML SHALL reach the DOM only through that module's DOMPurify call, built for the window that owns the target element. `src/ui` and `src/data/chat` SHALL NOT use bare `document.` or `window.` globals, `localStorage` or `sessionStorage`. `eval` and `new Function` SHALL appear only in `src/plugin/chat-loader.ts`. No file under `src/` SHALL import `radix-ui` or `@radix-ui/*` directly.

#### Scenario: Agent HTML
- **WHEN** an agent message contains `<img src=x onerror=alert(1)>`
- **THEN** the rendered DOM contains no `onerror` attribute and no script execution occurs

#### Scenario: Banned call added
- **WHEN** a file adds `el.innerHTML = value` outside `src/ui/chat/sanitize/`
- **THEN** `check:chat` exits non-zero

### Requirement: File naming
Every `.ts` and `.tsx` file under chat paths, including shadcn-generated files, SHALL be kebab-case.

#### Scenario: Generated file
- **WHEN** a generated component file has an upper-case letter in its name
- **THEN** the naming check from `.claude/rules/typescript.md` prints it and the task is not closed
