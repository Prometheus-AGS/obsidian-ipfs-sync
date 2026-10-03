## Why

The operator kept A2UI native (spec 002 option 1) and made React the chat shell only. That leaves a seam: a React transcript has to host a non-React renderer, and agent-supplied UI has to reach the DOM without becoming an injection path. Nothing exists yet: `src/` has no A2UI code, and the UAR endpoints are known only from spec 002's reading of UAR source on 2026-09-29 (A2UI v0.9.1, profile `uar.a2ui/1`, catalog `urn:uar:a2ui:catalog:1`, routes `GET /{run_id}/a2ui/surface-replay`, `POST /{run_id}/a2ui/messages`, `POST /{run_id}/a2ui/actions`, SSE fan-out). Not re-read for this set.

The uncomfortable parts:
- **The catalog is not enumerated in our inputs.** Which basic-catalog components exist, what each needs and which subset to render natively (spec 002 open question 4) are unknown here. Task 1.1 reads them from a running UAR before any renderer is written.
- **Whether the AG-UI run id equals the id in the A2UI routes is unverified.** The action path uses `{run_id}`. If the two differ, the client needs a mapping the wire does not obviously carry.
- **A surface outlives its run only as a picture.** If the UAR run ends or the instance restarts, `surface-replay` has nothing to replay, yet the conversation is persisted. The proposed rule: persist the last surface snapshot as read-only and disable its actions with a visible reason once the run is not live. The operator confirms (spec 002 open question 5 asked whether surface state persists at all).
- **An agent controls this UI.** A surface can say anything and offer buttons. Rendering by `textContent` only, a link scheme allowlist, no HTML in the native renderer and actions that fire only on a user gesture are the whole defence. The independent reviewer reads this module as a hostile-input boundary.
- **Two renderers, two sanitization paths.** Markdown HTML goes through DOMPurify (chat-04). A2UI never carries HTML in the native renderer. If the catalog has a component that needs rich text, the options are plain text or the sanitizer; the owner does not add a second path.
- **The A2UI action payload shape is not read.** The A2UI v0.9 specification page was not fetched for this set; the owner reads it and the UAR route source, and a mismatch is reported, not worked around.

## What Changes

- `src/agents/a2ui-client/`: replay, realtime subscription and action posting; no React.
- `src/ui/a2ui-native/`: DOM renderer for the chosen catalog subset and the message kinds `createSurface`, `updateComponents` (JSON-Patch), `data`, `delete`; imperative `mountSurface(el, handle)`; no React import.
- `src/ui/chat/components/a2ui-surface-block.tsx`: the React host island (ref element, mount in an effect, dispose on cleanup) inside block chrome, replacing chat-04 11.1's placeholder.
- Surface snapshot persistence as an `a2ui-surface` message part, liveness rule, action flow with ack, failure and double-submit handling.
- BDD scenarios against a stub UAR.

## Capabilities

### New Capabilities
- `a2ui-chat-host`: native renderer boundary, the host island, untrusted-content rules, action posting, persistence and liveness.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/agents/a2ui-client/`, `src/ui/a2ui-native/`, `src/ui/chat/components/`, `src/data/chat/` (part shape from chat-03 1.1 extended only if the snapshot needs fields), `features/`, `tests/`.
- Dependencies: none. `@a2ui/react` and `@prometheus-ags/a2ui-react` are not used (the first is the React renderer; the second adds about 1.97 MB unpacked and `zod`).
- Reuse: the native renderer imports no React and no chat code, so a later non-React host (spec 009's web companion, spec 008 served endpoints) can use it unchanged. That reuse is not built or verified here.
- Cadence: reviewers dormant until the phase gate; the renderer and the action path are in the independent review scope (`chat-00/tasks.md` 0.7).
