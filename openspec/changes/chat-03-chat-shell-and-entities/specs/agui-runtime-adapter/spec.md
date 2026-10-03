## Purpose

Defines how AG-UI events become store state and how that state feeds assistant-ui's external-store runtime. The adapter is ours; it replaces `@assistant-ui/react-ag-ui`, which would add about 100 KB gz and `rxjs`.

## ADDED Requirements

### Requirement: Own client, no packaged adapter
The AG-UI client SHALL use `fetch` and `response.body.getReader()` and SHALL NOT depend on `@ag-ui/client`, `@assistant-ui/react-ag-ui` or `rxjs`. The service layer SHALL import no React and no Zustand.

#### Scenario: Bundle check
- **WHEN** the chat bundle is searched for `rxjs`
- **THEN** nothing is found

### Requirement: Event mapping
The reducer SHALL map: run start to a `running` run; text message start, content and end to a `text` part; tool call start, args, end and result to a tool call entity and a `tool-call` part; state snapshot and delta to a `state` part; thinking events to a `thinking` part; run finish to `finished`; run error to an `error` part and a run status `error`; the non-core kinds (skill activation, memory recall, citation, confirmation request and response, data, error) to their part kinds by the wire names recorded in `wire-contract.md`. Parts SHALL append in arrival order with no regrouping. An event the table does not cover SHALL become an `unknown` part.

#### Scenario: Interleaving
- **WHEN** the stream carries text, a tool call, then text
- **THEN** the message holds three parts in that order

### Requirement: Runtime contract
The hook layer SHALL call `useExternalStoreRuntime` with messages converted to `ThreadMessageLike`, `isRunning` from run status, `onNew` that sends a command to the service and never writes the store directly, and `onCancel` that aborts the request. The code importing assistant-ui's runtime SHALL be confined to `src/ui/chat/hooks`.

#### Scenario: New message
- **WHEN** the user sends a message
- **THEN** the user message entity is persisted, a run starts through the service, and the store changes only through reducer commands

### Requirement: Cancel keeps partial content
Cancel SHALL abort the request, set the message to `stopped` and the run to `cancelled`, keep the partial content, and make the UI show a terminal "Stopped" marker.

#### Scenario: Cancel mid-text
- **WHEN** the user cancels after 40 characters have streamed
- **THEN** the 40 characters remain, the marker shows, and no further content is appended

### Requirement: Pin discipline
`@assistant-ui/react` SHALL be pinned exactly, and a type-level contract file SHALL fail `pnpm typecheck` when the adapter no longer matches its runtime types.

#### Scenario: Version bump
- **WHEN** the pin is raised and the runtime signature changed
- **THEN** `pnpm typecheck` fails in the adapter files only
