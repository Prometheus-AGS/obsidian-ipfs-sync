## Why

Agent mode renders every AG-UI chunk per spec 010 (`docs/010-agentic-ui-rendering.md`, `.agents/skills/ui-markdown-agents/SKILL.md`) with skill activations always visible, error cards, and approval cards for mutating tools (`docs/design/vault-agent-ui-concept.md` A2b; `docs/design/agent-panel.html:122-180,329-396`). This slice takes the rest of `chat-04` (chunk registry and cards) and wires the lane chip from the stream.

The uncomfortable parts:
- **There is no agent runtime.** `src/` has no AG-UI client, no lane field and no skill, memory or confirmation events. `chat-03` tasks 2.1 and 2.2 plan the wire contract and client under `chat-react-shell`, which is not active. How UAR names skill activation, memory recall, citation and confirmation chunks has not been read; spec 002 still lists the endpoint, auth and CORS as open. This slice cannot start without the runtime phase.
- **A bare LLM endpoint gives text only** (L8). Skill, tool and memory chunks come from UAR or, later, slice 10. Until then Agent mode with a slice 02 provider is plain chat, labelled as such.
- **The approval card is the only control against injected instructions.** Retrieved note text can carry instructions. Per-call approval for every mutating tool (write, move, `ipfs_add`) is the v1 rule (D16 question 3); "always allow" is deferred. How a confirmation response returns to the agent is not specified anywhere I read.
- **A skipped remote tool offline has a state but no screen** for "Queued until online" (report c.1). The offline queue is a runtime-phase feature.
- **Every unknown chunk must render.** A dropped chunk type is a bug (spec 010 decision 2); the registry is exhaustive by type check.
- **Agent text is untrusted.** Skill bodies, tool arguments and results, thinking and errors can contain anything. Text nodes and the one sanitizer only.

## What Changes

- Section 1: the chunk registry, cards and rules of `chat-04` not taken by slice 05: tasks 2.1 to 2.3, 6.1, 7.1, 8.1, 9.1, 11.1, 12.1, 12.2.
- Section 2: Agent mode shell: scope bar, composer with `[[` suggester and slash commands, conversation switcher (session only until slice 11), offline states, lane chip from the stream.
- Section 3: confirmation (approval) flow.
- Section 4: A2UI slot; the chat-05 tasks stay as they are and follow this slice.

## Capabilities

### New Capabilities
- `agent-mode-chat`: chunk coverage, skill visibility, approvals, lane from the stream, offline states.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/ui/chat/components/` (registry, cards), `src/ui/chat/hooks/`, `src/data/chat/` (store gains agent parts), `src/agents/agui-client/` (runtime phase, `chat-03` 2.1 and 2.2, stays as-is), `src/plugin/` host functions, `features/`, `tests/`.
- Dependencies: none beyond slice 05.
- Cadence: reviewers dormant until the phase gate; approval path and untrusted sinks in the security review scope.

Blocked on: slice 05 section 1; the runtime phase (`chat-03` 2.1 wire contract and 2.2 client; a per-turn lane and model field; a confirmation response path; cancel; offline queue state); D9; for A2UI, `chat-05` 1.1 and 1.2.
