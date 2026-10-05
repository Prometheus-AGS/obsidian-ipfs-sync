## Context

Read 2026-10-04: `docs/design/control-center.html` (rows, aliases, the key-derivation select at line 121, the status chip toggle at line 149), concept C, `docs/011-mvp-decisions.md` Q7, the 07b `plugin-key-management-ui` spec, `src/plugin/` file names (`encryption-settings.ts`, `encryption-settings-model.ts`, `settings-tab.ts`, `settings-view-model.ts`, key dialogs). Not read in detail: the bodies of the key dialogs; the owner reads them before hosting.

## Row registry

Each row is a registered entry: id, section, name, description, aliases, a renderer, and an availability function (backing code present, platform). Search filters by name, description and aliases and shows matching counts beside section names. A row whose availability is false is absent. Only rows with backing code register in each slice, so the control center grows as engines ship.

## Hosting the 07b rows (coexist, D3)

The Security section's vault key rows (Lock now, Change passphrase, Increase cost, Accept changed key slots, Prune history) are produced by the same model that feeds the native tab (`encryption-settings-model.ts` builds the rows from a status source) and open the same dialog classes. The control center passes the same status source and callbacks. No dialog or model file is edited. The key-derivation cost row shows the current cost and opens the increase-cost dialog; it is never an inline select. The 07b dialogs keep their own focus rules; convergence with D5 is a separate change after the 07b review closes.

## Sections and rows in this phase

- Sync: rows that exist in the settings tab today (node URL, pull name, auto-publish interval, and the rest as the model exposes them), bound to the same settings store.
- Security: the vault key rows above. Device DID, QR, paired devices, grants, Revoke: absent (D4).
- Agents: the provider settings component of slice 02; later skill permissions when a runtime exists.
- Direct links: absent.
- Data: collections (slice 03), later index rows (slice 09) and conversation controls (slice 11); the copy separates rebuildable from not rebuildable (D15).
- Appearance: status chip toggle (hidden on mobile), collapse defaults for thinking and tool calls, density.

## Node section (operator decision 2026-10-04, P9)

The Sync section has a "Node" group: the node URL field is empty on a fresh install with no default and no placeholder naming a real host. When the configured URL's host equals a retired default host, the field shows `RETIRED_DEFAULT_WARNING` beside it and once at load, using `isRetiredDefaultHost` and the warning from `src/core/config/retired-default-hosts.ts` through a host port (file read 2026-10-04; KBD task 46 on `main` owns the removal of the built-in default and was not read by me). Until a URL is set the section says publishing and pulling are unavailable and why. The native tab's node URL field is bound to the same settings model. This slice hard-codes no host.

## Dialog checklist and navigation (A15, A16, A17)

The dialog acceptance checklist of `design-input-hybrid-skills-ui.md` s.2.5 (contrast on resolved colours in default light, default dark and one different accent; accessible names; tab order and no trap; Cancel precedes confirm and takes initial focus unless a field is required; 24 px AA floor and 44 px mobile preference; status never by colour alone; reduced motion; the keyboard walk and a screen-reader pass as evidence, axe not sufficient) is the review list for `ConsequenceDialog` and this view. A gate checks that no `src/ui` file renders passphrase or key material. A shadcn Dialog is for in-view popovers only and sets `initialFocus` explicitly; it never wraps a 07b dialog. Responsive switches use container width. The mobile section list stays a horizontal scroller; no bottom bar is added (Obsidian owns app-level navigation).

## Mobile

Single column with the section list as a horizontal scroller; 44 px targets; rows meaningless on mobile hidden by `Platform.isMobile`.

## Consequence dialogs

Obsidian `Modal`s (P4), Cancel first and focused except where a field is required (D5 rule). Only for actions that exist in this phase (for example clear conversations, wipe local stores when they exist).
