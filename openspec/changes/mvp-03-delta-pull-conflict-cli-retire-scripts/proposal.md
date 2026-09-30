## Why

After mvp-02 a vault can be published but nothing can read it back except the old `scripts/pull.sh`, which downloads the whole snapshot as a tar, overwrites with rsync backup semantics, needs `python3` and `rsync`, and cannot tell a local edit from a stale copy. Pull is the second half of sync: cost must be O(changes), local work must never be lost, and a byte that does not match the manifest must never reach the vault. This change also retires the shell scripts, because they duplicate logic that now lives in `src/sync` and they violate the `no-python` constraint. Phase goals 1 and 2; enables mvp-05 (plugin pull) and mvp-08 (history).

The uncomfortable part: conflict detection needs a record of what this device last synced, and that record is a local file. If it is lost or stale, pull cannot tell a local edit from an old copy, so it must err toward keeping local data as a conflict copy, which can create noise. Also, the old scripts' remote-wins behaviour is being replaced by a three-way decision; a bug there loses user text, which is the one thing this product must not do.

## What Changes

- New command `ipfs-sync pull <vault>`: resolve the publication IPNS name to the published root, read `<root>/manifest.json` through the gateway, compare sha256 with local files, and fetch only missing or changed files through a bounded pool, streaming each to disk.
- New pull target selection: `--name <k51 ID>` (default: the ID of the owned publication key) and `--manifest <currentCID>` to restore a historical manifest from `manifests/`; `--manifest-file <path>` reads a manifest from a local file (used to prove fail-closed behaviour without writing to the node).
- New conflict policy ported from `scripts/pull.sh`: remote wins, a local edit that differs from both the last-synced state and the remote is preserved as `<stem> (ipfs conflict YYYY-MM-DD).<ext>` (the extension is kept so Obsidian still opens it), local files are never deleted, remote deletions are reported only.
- New fail-closed integrity rule: fetched bytes are hashed against the manifest, written to a temporary file and renamed only on match.
- New `excludesHash` divergence handling: mismatch forces a full re-verify and a loud warning on stderr.
- Pull never writes through, replaces or follows a symlink.
- New pull-side plaintext guard mirroring the publish guard, removed in mvp-06.
- New events `pull.complete` and `conflict` on the mvp-02 EventBus.
- Retirement: delete `scripts/publish.sh`, `scripts/pull.sh`, `scripts/excludes.txt`; drop the `bash-32-compatible-scripts` constraint and the `bash -n` trigger; README references updated by the documentation specialist. **BREAKING** for anyone still calling the scripts.
- The kubo client gains one read-only capability: ranged gateway reads.

## Capabilities

### New Capabilities
- `delta-pull`: the `pull` command, target resolution, manifest selection, the fetch pool, read-only guarantee and the plaintext guard.
- `pull-conflict-policy`: the local sync record, the three-way decision, conflict copy naming, no-delete rule and `excludesHash` divergence.
- `pull-integrity`: hash verification, atomic writes and untrusted-path handling.
- `pull-events`: `pull.complete` and `conflict` payloads.
- `script-retirement`: removal of the shell scripts and their constraints and documentation references.

### Modified Capabilities
<!-- none: mvp-02's specs are not in openspec/specs/, so the new events are defined here rather than as a delta -->

## Impact

- Code: new `src/sync/` pull modules (plan, conflict naming, fetch, apply), a ranged gateway read in `src/kubo/`, new `cli/pull-command.ts`, `tools/feature-op-mvp-03.mjs`. `src/core` is softly frozen after mvp-02: only additive changes (new HostBridge members, new event types) are allowed here, recorded in design.md.
- Removed: `scripts/publish.sh`, `scripts/pull.sh`, `scripts/excludes.txt`.
- Docs and constraints: `.kbd-orchestrator/constraints.md`, README lines (documentation-specialist).
- Dependencies: none new (`@noble/hashes` from mvp-02 does incremental hashing).
- Node: pull performs no mutations. It uses `name/resolve`, gateway reads and, if needed, `key/list`.
