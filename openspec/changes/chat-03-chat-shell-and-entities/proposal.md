## Why

The operator decided that conversations persist as entities through the entity graph's PGlite adapter, and that we write our own adapter from the AG-UI client to assistant-ui. The assessment found that the entity library has no chat model: core ingests only `STATE_SNAPSHOT` and `STATE_DELTA`, and `a2ui-react`'s `useChatSession` keeps messages in React `useState`, "not the entity graph". Everything between the wire and the screen is therefore ours: the entity types, the streaming buffer, the persistence policy, the reducer and the runtime adapter.

The uncomfortable parts:
- **Conversations are not a rebuildable cache.** Spec 006 makes both embedded stores throwaway because they rebuild from the vault. A conversation exists nowhere else. If iOS evicts WebView storage, it is gone. This change detects and reports that, and offers transcript export as the only durable copy. It does not prevent it.
- **Wire names for several chunk types are unconfirmed.** Spec 010 lists `SKILL_ACTIVATION`, `MEMORY_RECALL`, `CITATION`, `CONFIRMATION_REQUEST` and others as chunks. AG-UI core defines text, tool, state, thinking, run, step, custom and raw events. How UAR carries the rest (custom events with a name, or its own types) is not read. The reducer cannot be finished until uar-engineer records it from a running UAR.
- **Persisting every token would wear the device and block the main thread.** The policy flushes at part boundaries and a bounded interval, which means a kill mid-stream loses the tail of the last part. The message then reads "interrupted". That is a deliberate loss, stated here.
- **assistant-ui is 0.15 and moves daily.** The adapter is the one file that knows its runtime shape. A version bump can break it, and only the pin and a type-level contract test stand between us and that.
- **Chat sends text to an endpoint the encrypted-vault threat model does not cover**, and stores it in plaintext on the device. Export writes a transcript into the vault, where it is then published encrypted like any note. A user can also paste note text into chat. The operator doc says so (`chat-00/tasks.md` 0.2b).
- **PEM's PGlite adapter is unread.** Its table layout, whether it hydrates the whole graph at start, and how it shares an instance with the mvp-08 store are unverified. Hydrate cost is measured in 1.3 before the shell is built on it.

## What Changes

- `src/data/chat/`: entity types and guards, a vanilla Zustand chat store, persistence through PEM core and PGlite, interrupted-marker rule, eviction detection, delete and clear-all.
- `src/agents/agui-client/`: `fetch` plus SSE reader, event parser, reducer producing store commands; every event type handled, unknown ones kept visible.
- `src/ui/chat/hooks/`: the adapter (`to-thread-message`, `use-chat-runtime`) over `useExternalStoreRuntime`, the only code that imports assistant-ui's runtime.
- `src/ui/chat/components/`: Thread, composer, conversation list and state screens, mobile layout.
- Settings: chat enable (off by default), endpoint, token, clear all. Transcript export, opt-in, to a vault note.
- BDD scenarios for send, stream, cancel, kill and reload against a stub endpoint.

## Capabilities

### New Capabilities
- `chat-entities`: entity types, persistence policy, interrupted state, eviction detection, deletion, the vault boundary, export.
- `agui-runtime-adapter`: event-to-state mapping, the external-store contract, cancel semantics, unknown events.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/data/chat/`, `src/agents/agui-client/`, `src/ui/chat/`, `src/plugin/` (settings tab additions by uiux-lead, export writer by ipfs-engineer), `features/`, `tests/`.
- Dependencies: none beyond the chat-02 pins. `@ag-ui/core` is used for types only if its type package carries no runtime into the bundle; otherwise the event types are written by hand. Version read at that point; not pinned here.
- Data: a chat database (instance and layout decided with mvp-08), a sentinel in plugin data for eviction detection. Nothing is written into the vault tree except an exported transcript the user asked for.
- Cadence: reviewers dormant until the phase gate.
