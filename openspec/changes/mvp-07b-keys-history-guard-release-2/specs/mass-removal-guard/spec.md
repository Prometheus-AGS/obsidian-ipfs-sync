## Purpose

Defines the publish-side guard that stops a publish which would remove all or more than half of the manifest's entries unless the user confirms, and states what it does not catch. It carries review-3 item W-15 and is a precondition of the release.

## ADDED Requirements

### Requirement: A publish that removes most of the vault stops
After the diff and before any write, the publish SHALL split the planned removals into removals caused by the exclusion list (baseline paths that match the effective exclusion list, for example `.obsidian/*` entries of an older build on the first publish after the exclusion change) and all others. The exclusion-driven group SHALL be listed and counted in the message and SHALL count in neither the numerator nor the denominator; entries carried forward by the publisher (paths this device could not restore) SHALL count as kept. The publish SHALL refuse with a typed error when the other removals equal every remaining entry, or exceed half of the remaining entries of a manifest that had at least two, unless the caller confirmed. The CLI SHALL confirm through an interactive yes or `--allow-mass-removal`; the plugin SHALL confirm through a dialog on a manual publish. A timer publish SHALL NOT open a dialog and SHALL refuse. The refusal SHALL say how many entries would be removed and that an unmounted or emptied vault directory looks the same.

#### Scenario: Vault emptied
- **WHEN** the vault directory is emptied and publish runs without confirmation
- **THEN** it stops before any node write and asks for explicit confirmation

#### Scenario: Three of ten
- **WHEN** a publish removes 3 of 10 entries
- **THEN** it proceeds

#### Scenario: More than half
- **WHEN** a publish removes 6 of 10 entries
- **THEN** it stops unless confirmed

#### Scenario: Timer publish
- **WHEN** an unattended timer publish would remove most entries
- **THEN** it refuses without a dialog and leaves the node unchanged

#### Scenario: Single-file vault
- **WHEN** a one-entry manifest loses its only file
- **THEN** the publish stops (it removes all entries)

#### Scenario: Upgrade day in a small vault
- **WHEN** a vault of five entries, three of them `.obsidian/*` files from an older build, is published after the exclusion list began to cover `.obsidian/`
- **THEN** the three removals are reported as caused by the exclusion list, they do not count toward the threshold, and the publish proceeds without a confirmation

#### Scenario: Exclusion removals and a real mass removal together
- **WHEN** the same vault also lost both of its two remaining notes
- **THEN** the publish stops, the message counts the two note removals against the two remaining entries, and does not blame the exclusion list

#### Scenario: Carried entries are kept entries
- **WHEN** a Windows device carries `CON.md` and loses two of its other four files
- **THEN** the entries counted as remaining include `CON.md`, and two of five removals proceed without a stop

### Requirement: Stated limits
The README, DESIGN section 8 and the release notes SHALL state that removal of 49 percent of the entries is silent, and that the publisher does not detect silent per-file corruption of unchanged files by someone with write access to the node (W-14).

#### Scenario: Documentation
- **WHEN** the README and DESIGN section 8 are searched
- **THEN** both limits are stated in the exact sentences the checker holds
