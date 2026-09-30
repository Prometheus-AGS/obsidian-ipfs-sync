## Purpose

Defines how the fixture-only guard is centralised and then removed on a branch, so that the tree an independent reviewer reads and the build an operator runs are the tree and the build that would ship. It replaces the first draft, whose "two small modules" did not exist (the policy sat in about fourteen files), whose permissive no-op dropped an unrelated symlink check, and whose removal step changed files that the review hash covered.

## ADDED Requirements

### Requirement: Fixture policy lives in two modules
Before removal, the entire fixture policy SHALL live in exactly two modules: `src/sync/publish-guard.ts` (marker states and parsing, legacy-marker text, the publish refusal and its hint, the publish notice, and the settings and help copy about fixture-only publishing) and `src/sync/pull-guard.ts` (the destination rules, the marker writer, the pull notice). The three marker constants (`FIXTURE_MARKER`, `FIXTURE_MARKER_VALUE`, `PULLED_MARKER_VALUE`) SHALL live in `src/sync/fixture-constants.ts`, a file with no imports, so that `fixtures/generate-fixture-vault.ts` (run by `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON`, which cannot load a module with extensionless imports) and `pnpm fixture:generate` keep working; `publish-guard.ts` re-exports them. `src/core/config` SHALL export no fixture-policy symbol. Every caller (CLI commands, plugin runners, the vault opener, settings copy, notices, the publish session, the WebView probe entries, the fixture generator and `tests/unit/fixture-vault.test.ts`) SHALL import from the new locations. The earlier `src/sync/fixture-marker.ts` SHALL be folded into them and deleted. This isolation SHALL NOT change behaviour.

#### Scenario: One place
- **WHEN** the source is searched for the marker values, the review-pending wording and the fixture-only copy
- **THEN** they appear only in the constants file, the two guard modules and tests

#### Scenario: Fixture generator
- **WHEN** `pnpm fixture:generate` runs after the centralisation
- **THEN** it writes the synthetic vault and its `fixture` marker exactly as before, and `fixture-vault.test.ts` passes

#### Scenario: Behaviour unchanged
- **WHEN** the isolation is done
- **THEN** every guard test of the earlier changes passes with only import-path edits, and `pnpm probe:webview` passes

### Requirement: The state-folder safety check is separate and survives removal
The refusal to write through a symbolic-link state folder (`findSymlink` over the temp directory, today inside both destination rules) SHALL live in `src/sync/state-folder-guard.ts` with no dependency on the fixture policy, SHALL be called by every pull irrespective of policy from the first step of the pull orchestration (`encrypted-pull.ts`), outside any function that the removal commit rewrites, and SHALL remain after the policy modules become permissive.

#### Scenario: Symlinked state folder after removal
- **WHEN** `.ipfs-sync/tmp` is a symbolic link and a pull runs on the post-removal tree
- **THEN** the pull refuses before writing

#### Scenario: Call site independent of policy
- **WHEN** both destination rules are replaced by permissive versions in a test
- **THEN** the pull still refuses a symlinked state folder, because the check is called from the orchestration's first step

### Requirement: Removal is a reviewed diff on a branch
The post-removal code SHALL be prepared on a branch cut from `main` after every other change task is closed, as one removal commit that replaces the contents of the two modules with permissive versions and adapts the tests, probe entries and copy listed below. The permissive modules SHALL keep every export name and signature (`assertPublishMarker` and `assertFixtureVault` return without checking; `assertPullDestination` and `assertVaultPullDestination` return `{ needsMarker: false }`; `writeFixtureMarker` does nothing; notice and copy constants carry neutral text) so that callers do not change. The independent review SHALL read this branch tree. `main` SHALL keep the guard until the release commit. The release SHALL be gated, not the code.

#### Scenario: Diff is small
- **WHEN** the branch is compared with `main`
- **THEN** the source differences are the two modules, the named tests, the probe entries, the version bump and copy that came from the modules

#### Scenario: Names kept
- **WHEN** the permissive modules are compared with the originals
- **THEN** every export name and signature is the same

### Requirement: What removal changes
After removal, publishing SHALL be allowed for any vault (encryption remains mandatory), pulling SHALL be allowed into any directory subject to the existing conflict policy, the marker file SHALL have no meaning to publish or pull, the review-pending notices and fixture-only copy SHALL no longer appear in the plugin, the CLI help or the settings tab, and the pull SHALL no longer write a marker.

#### Scenario: Real vault
- **WHEN** a vault without a marker is published with a valid passphrase after removal
- **THEN** it is published encrypted

#### Scenario: Pull into an existing vault
- **WHEN** a non-empty vault pulls
- **THEN** the pull proceeds and preserves local edits as conflict copies

#### Scenario: Copy
- **WHEN** the settings tab and `--help` are read on the branch
- **THEN** they do not say that only fixture vaults can be used

### Requirement: Tests and probe entries that change are named
The removal commit SHALL adapt these candidates from a search of 2026-09-30 (the engineer records the exact set that fails before the change): `tests/unit/fixture-marker.test.ts` (split: the pre-removal suite stays on `main`, `guard-permissive.test.ts` is added on the branch), `node-safety.test.ts`, `fixture-vault.test.ts`, `encrypted-publish-guards.test.ts`, `cli-publish.test.ts`, `cli-init.test.ts`, `plugin-publish-runner.test.ts`, `plugin-publish-session.test.ts`, `plugin-publish-review5.test.ts`, `plugin-pull-runner.test.ts`, `plugin-pull-entry.test.ts`, `plugin-encrypted-entry.test.ts`, `plugin-entry.test.ts`, `plugin-settings-tab.test.ts`, `plugin-settings-tab-pull.test.ts`, `plugin-vault-opener-review5.test.ts`, and the helper `tests/helpers/publish-rig.ts`. The WebView probe entries `tools/webview-probe-entry.ts` and `tools/webview-probe-kubo-core-entry.ts` SHALL import `assertFixtureVault` from `src/sync/publish-guard` (changed during centralisation) and SHALL keep importing the same name after removal.

#### Scenario: Probe after removal
- **WHEN** `pnpm probe:webview` runs on the branch
- **THEN** it passes with the unchanged import names

#### Scenario: Permissive suite
- **WHEN** the branch tests run
- **THEN** `guard-permissive.test.ts` asserts that publishing without a marker, pulling into a non-empty directory and the absence of fixture copy all hold, and the state-folder symlink refusal still fires

### Requirement: No other behaviour change
The removal commit SHALL change nothing else. Release text (README, CHANGELOG, runbook, DESIGN section 8.9) SHALL be updated by a separate docs commit on the branch, which is outside the hashed scope.

#### Scenario: Diff review
- **WHEN** the reviewer reads the removal commit
- **THEN** every changed hunk is explained by one of the items above
