## Purpose

Defines how a native A2UI surface lives inside the React chat transcript: the renderer boundary, the rules for untrusted agent content, how actions go back, and what happens to a surface after its run ends. Message kinds and routes follow spec 002 and are confirmed against a running UAR before implementation.

## ADDED Requirements

### Requirement: Native renderer boundary
The A2UI renderer SHALL live in `src/ui/a2ui-native`, SHALL import no React and nothing from `src/ui/chat`, and SHALL expose an imperative `mountSurface(el, handle)` returning `apply` and `dispose`. The chat SHALL host it through a React island that mounts in an effect and disposes in cleanup.

#### Scenario: StrictMode
- **WHEN** the island mounts under StrictMode
- **THEN** one surface and one subscription are live after the double effect

### Requirement: Surface in the transcript
A surface SHALL appear as a message part at its arrival position, inside the chat block chrome, with copy (the surface snapshot as JSON) and collapse behaving as for other blocks. An update message SHALL change the same surface in place.

#### Scenario: Update
- **WHEN** an `updateComponents` message arrives for a displayed surface
- **THEN** the surface changes in place and no second block appears

### Requirement: Untrusted content
The renderer SHALL build DOM with `createElement` and `textContent` only, SHALL NOT set HTML from agent data, SHALL accept link targets only for an allowlisted scheme set, and SHALL set no event-handler attributes from agent data. An unsupported component type SHALL render a visible placeholder naming the type.

#### Scenario: Hostile surface
- **WHEN** a surface carries a `<script>` string as text, a `javascript:` link and an `onclick` property
- **THEN** the DOM holds the script string as a text node, the link is not navigable and no handler is attached

### Requirement: Actions
An action SHALL be posted to `/{run_id}/a2ui/actions` only in response to a user gesture, once per gesture, with the payload shape recorded from UAR. The control SHALL be disabled until the acknowledgement, and a failure SHALL show an error card and re-enable the control. Loading or updating a surface SHALL NOT post anything.

#### Scenario: Double tap
- **WHEN** the user taps an action twice quickly
- **THEN** exactly one request is sent

### Requirement: Persistence and liveness
The last applied surface SHALL be persisted in the message part. When the run is not live, the surface SHALL render read-only with its actions disabled and the reason "this run has ended" (proposed, pending operator confirmation). When the run is live, rehydrating SHALL replace the snapshot with the result of `surface-replay`.

#### Scenario: Reopen after the run ended
- **WHEN** a conversation is reopened and its run has ended
- **THEN** the surface shows the last snapshot, its actions are disabled and the reason is visible

### Requirement: Disposal
Disposing a surface SHALL remove its listeners and abort its subscription.

#### Scenario: Message removed
- **WHEN** a conversation containing a live surface is closed
- **THEN** the listener count returns to its prior value and the realtime request is aborted
