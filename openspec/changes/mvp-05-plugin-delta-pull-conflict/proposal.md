## Why

After mvp-04 the plugin can publish but cannot pull, so nothing inside Obsidian shows sync working end to end. This change adds the plugin's pull on top of the shared engine (mvp-03), ports the on-load catch-up, and defines Release 1 (v0.2.0). The operator's rule for a release is functionality demonstrated inside Obsidian on at least one platform, not a CLI milestone, so the feature operation is a real pull with a real conflict in Obsidian desktop on macOS.

The uncomfortable parts, stated up front:
- v0.2.0 is fixture-only. Encryption arrives in mvp-06, so the release can only sync synthetic fixture vaults and must not be used on real notes. A release you cannot use on your notes is a demo of mechanics; the release notes say that.
- The Obsidian file adapter cannot do everything the pull contract assumes. It has no `lstat`, so the plugin cannot detect a symbolic link and the mvp-03 rule "never write through a symlink" cannot be fully met here. It has no partial read, so large files cost whole-file memory. Its `rename` may not replace an existing file. This change specifies exactly what the plugin does about each and what it still cannot guarantee.
- A GitHub release is an outward-facing act. Nothing in this change tags, pushes or publishes without the operator's explicit approval, and the cadence publication receipt cannot honestly exist until a real public artifact does.

Phase goals 1, 2 and 4.

## What Changes

- New "IPFS Sync: Pull" command, a Pull ribbon icon, and status notice and status-bar content, running the mvp-03 pull engine through the Obsidian host. No node mutation.
- New on-load catch-up (per-device opt-in) that pulls once after the workspace layout is ready.
- New plugin implementation of the file-system members added in mvp-03 (`lstat`, `rename`, `append`) and of `readRange`, `stat`, `mkdir`, `remove` and `list` with atomic write through `.ipfs-sync/tmp/` and a configurable per-file read cap.
- New settings: pull IPNS name (default: the owned key's ID), catch-up on load, read cap, and a view of the last pull and publish summaries.
- Removal of any remaining whole-tar download code from the plugin.
- Release 1 (v0.2.0): version bump, artifacts from `dist/plugin/`, SHA-256 checksums, demo evidence, a local release record, and an optional GitHub release that requires explicit operator approval.
- Feature operation script `tools/feature-op-mvp-05.mjs` with two throwaway fixture vaults.

## Capabilities

### New Capabilities
- `plugin-pull`: the pull command, guard, catch-up, progress and node read-only behaviour inside Obsidian.
- `obsidian-fs-semantics`: how the Obsidian bridge implements the pull file-system contract, its limits, and the atomic write.
- `plugin-pull-settings`: the added settings and the last-summary view.
- `release-1`: the v0.2.0 release procedure, receipt, approval gate and fixture-only statement.

### Modified Capabilities
<!-- none: earlier changes' specs are not in openspec/specs/. The plugin-specific refinement of the pull guard is stated in plugin-pull. -->

## Impact

- Code: `src/plugin/` (pull runner, bridge members, settings model and view model, settings tab, plugin shell), `tools/feature-op-mvp-05.mjs`, release tooling under `tools/`, README and CHANGELOG (documentation-specialist), `manifest.json` and `package.json` version fields (release task only).
- No new runtime dependency. `src/sync`, `src/kubo` and `src/core` are used as they are after mvp-03 and mvp-04; additive changes only, recorded in design.md.
- Node: pulls perform no mutation; the feature operation publishes only to `/obsidian-vault-sync/mvp05-demo`.
- External: a GitHub release on `Prometheus-AGS/obsidian-ipfs-sync` only with explicit operator approval.
