## Purpose

Defines when chat code runs, how the view mounts and unmounts, and the startup gate that replaces the waived 300 KB limit. The numeric threshold is not in this spec: it comes from the chat-01 baseline and the operator's signature.

## ADDED Requirements

### Requirement: Nothing in onload
The plugin's `onload` SHALL register the chat view type, a ribbon icon and a command, and SHALL NOT evaluate the chat bundle, create a React root, create a store, open a database or start a request. The view constructor SHALL do none of those either.

#### Scenario: Plugin starts with chat unused
- **WHEN** the plugin loads and the chat view is never opened
- **THEN** the chat-loader call count is zero and no chat entity database is opened

### Requirement: Mount on open, unmount on close
`onOpen` SHALL evaluate the chat bundle at most once per plugin lifetime, create the root on the view's `contentEl`, and render. `onClose` SHALL unmount the root, dispose store subscriptions and abort any in-flight request.

#### Scenario: Reopen
- **WHEN** the view is closed and opened again
- **THEN** the bundle is not evaluated a second time, a new root is created, and the previous root's subscriptions are gone

### Requirement: Popout windows
Portal containers, DOM event registration and sanitizer instances SHALL belong to the window that owns the view's element. A dialog opened in a popout window SHALL render in that window.

#### Scenario: Dialog in a popout
- **WHEN** the chat view is in a popout window and a dialog opens
- **THEN** the portal node's `ownerDocument` is the popout's document

### Requirement: StrictMode
The development build SHALL run under React StrictMode. The production bundle SHALL NOT include the wrapper. Runtime hooks SHALL be idempotent under double invocation of effects.

#### Scenario: Double effect
- **WHEN** the root mounts under StrictMode
- **THEN** exactly one store subscription and, after a send, exactly one stream are active

### Requirement: Startup gate
A chat release candidate SHALL NOT be released unless the operator has recorded, on the iPhone, cold-start numbers before and after chat is included, measured with the chat-01 S1 method, and they are inside the threshold the operator signed in chat-01. The static size gate SHALL fail when `main.js` or the chat bundle exceeds `tools/chat-budget.json`, whose values come from the chat-01 measurement.

#### Scenario: Over the threshold
- **WHEN** a counted cold-start run exceeds the signed threshold
- **THEN** the release candidate is refused and the options are a mitigation, the second-plugin split, or a new operator decision

### Requirement: Platform floor
If the chat floor is above Obsidian's minimum supported OS, the plugin SHALL detect the missing capability, show a notice naming it, and SHALL NOT evaluate the chat bundle. Sync features SHALL be unaffected.

#### Scenario: Missing capability
- **WHEN** the detector reports no cascade-layer support
- **THEN** opening the chat view shows the notice and the loader is not called
