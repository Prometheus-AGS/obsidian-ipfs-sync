## Why

Spec 011 Q7 and the design call for one searchable control center with six sections (Sync, Security, Agents, Direct links, Data, Appearance) and consequence dialogs for anything destructive (`docs/011-mvp-decisions.md` Q7; `docs/design/control-center.html`). The plugin has a native settings tab with an Encryption section and the 07b key dialogs, built and wired. This slice builds the control center without replacing them.

The uncomfortable parts:
- **The 07b dialogs and Encryption section are not replaced silently.** The 07b spec says the key actions live "in the existing plain tab" and "SHALL keep the tab plain" (`mvp-07b-keys-history-guard-release-2/specs/plugin-key-management-ui/spec.md` lines 53 and 60). The recommended resolution is coexist (D3): the native tab stays, the control center's Security section calls the same dialog classes and the same view models (`src/plugin/encryption-settings-model.ts`, the key dialogs) and copies none of their logic. Replace-versus-coexist stays the operator's decision. The prune, mass-removal and cost-confirm dialogs are triggered by publish and key actions, not by settings rows; this slice does not touch them.
- **Most of the six sections have no engine behind them.** Security's devices, grants, QR pairing and Revoke, and Direct links (WebRTC, iroh), have no code (`grep -rli "ucan\|spake\|did:key\|webrtc" src` finds nothing, 2026-10-04). Those rows are absent, not disabled (D4). The Revoke copy in the prototype misstates the trust effect against 07b semantics.
- **The key-derivation cost row in the prototype is an inline select.** An inline select hides a rewrap. The row opens the 07b increase-cost dialog.
- **A setting in two places is a hazard.** Under coexist, each setting is bound to one model; two sources of truth would drift.
- **Data and Agents rows need the data and runtime phases and slices 02 and 03.** They arrive as those ship.
- **Prototype CSS is not copy-ready** (D12); styles follow slice 01's contract.

## What Changes

- A control center view with search (name, description, aliases), section list, single column on mobile.
- Core rows with backing code: Sync (node URL, pull name, auto-publish interval, existing settings), Security (vault key rows hosted from the 07b model and dialogs), Appearance (status chip toggle, collapse defaults, density), hidden on mobile where meaningless.
- Agents section hosting slice 02's provider settings component; Data section hosting slice 03's collections and, later, index rows and conversation controls.
- Consequence dialogs only for actions that exist.

## Capabilities

### New Capabilities
- `control-center`: searchable sections, hosted rows, coexistence with the native tab, absent rows.

### Modified Capabilities
<!-- none: the 07b requirement text is untouched under coexist -->

## Impact

- Code: `src/ui/control-center/` (components, hooks), `src/data/control-center/` (store: search state, row registry), host view `src/plugin/control-center-view.ts`, a settings-tab button, reuse of `src/plugin/encryption-settings-model.ts` and key dialog classes without edits, copy files, `features/`, `tests/`.
- Dependencies: none.
- Cadence: reviewers dormant until the phase gate; the security review checks that no 07b file changed and no key logic was copied.

Blocked on: slice 01; 07b closed (so no review reopens); D3 and D4 answered; slice 02 for Agents; slice 03 and the data phase for Data rows.
