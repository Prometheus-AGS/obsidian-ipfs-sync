## Why

Everything the project publishes today is plaintext on a node that anyone on the internet can write to. Release 1 (v0.2.0) is therefore fixture-only, and the fixture guard is the only thing standing between a real vault and public storage. That guard stays in this change: encryption is implemented here but is not independently reviewed or verified in Obsidian, so real notes still do not leave the device until mvp-07 lifts the guard. Phase goal 7 says vault content, paths and manifest are encrypted on the device before they reach the node, a second device unlocks with a passphrase, and tampering fails closed. This change delivers the publish half: an encrypted vault is written to the node, and nothing readable leaves the device. Pull and the second-device unlock are mvp-07.

This is the most security-sensitive change in the project. The uncomfortable parts:
- **Keyslots are public.** `keyslots.json` sits beside the data, so anyone who obtains the root CID can attack the passphrase offline, permanently. The only barrier is the passphrase's strength and Argon2id's cost: passphrases are generated (115 bits) and the KDF costs 64 MiB / 3 iterations, because old roots stay pinned forever and cost cannot be raised retroactively. A weak passphrase makes the encryption decorative.
- **There is no recovery.** A lost passphrase, or a deleted `keyslots.json` with no local copy, means the vault is unreadable forever. This is by design and must be said in the dialog, not in a footnote.
- **Rollback is detected, not prevented.** An open-write node can serve an older, valid root. This change records a monotonic `sequence`; the pulling device that enforces it arrives in mvp-07. Until then nothing rejects a rollback.
- **Metadata still leaks**: file count, approximate sizes, publish timing, which encrypted files change, and access patterns.
- **The plugin's passphrase UX is unit-tested here but has no in-app run until mvp-07's operator session.** This is a deliberate trade-off recorded below.

## What Changes

- New `src/crypto/` (pure, WebView-safe): HKDF-SHA256, AES-256-GCM and HMAC-SHA256 from WebCrypto; Argon2id from `@noble/hashes` 2.4.0 (already a dependency); no hand-rolled primitives.
- New key model: a random 256-bit vault content key (VCK) and a random 128-bit `vaultId`; the VCK is wrapped in a passphrase key slot (Argon2id 64 MiB, 3 iterations, with a key commitment) recorded in plaintext `keyslots.json` in the MFS root. Passphrases are generated only (25 symbols: 23 random, 115 bits, plus a 2-symbol check); user-chosen passphrases are deferred.
- New encrypted blob format: per-file key from HKDF, AES-256-GCM over 8 MB segments, associated data binding vault, header, the blob's node name, segment index and final-segment flag.
- New opaque node names: `current/<2-char prefix>/<base32 HMAC-SHA256 of the vault path>`.
- New manifest v2, encrypted as `manifest.enc` (latest) and `manifests/<currentCID>.enc` (history), with a monotonic `sequence`.
- Publish is encrypted unconditionally. Plaintext manifest v1 publishing is deleted from the CLI and plugin. Publish requires a passphrase ("passphrase required" otherwise). The fixture-only guard STAYS in this change: a vault without the `.ipfs-sync-fixture` marker is still refused in both the CLI and the plugin, with a message that encryption is not yet independently reviewed or verified in Obsidian. mvp-07 removes the guard as an explicit task after the security-reviewer's sign-off and the in-app run. **BREAKING** for anyone publishing fixtures in plaintext.
- Publish refuses an MFS root that already holds a plaintext (v1) publication.
- Pull keeps reading manifest v1 until mvp-07 (exactly: the v1 manifest path of the pull engine and the fixture-only destination guard). Pointed at an encrypted root it stops with a clear "encrypted vault" error.
- CLI: passphrase from `IPFS_SYNC_PASSPHRASE`, a 0600 `IPFS_SYNC_PASSPHRASE_FILE`, or a no-echo prompt, never a flag; a vault is created only by `ipfs-sync init`, which generates the passphrase itself (interactive with re-entry, or `--passphrase-file <path>` written 0600); `publish` never creates a vault. Plugin: one prompt per session, VCK kept in memory only, first-time setup with double entry and an explicit no-recovery consequence dialog.
- Robust publish: a local journal with an exact resume protocol, an explicit `--repair`, a diagnose-first baseline check (rewrite only what differs), scoped immutable read-back before pin and publish, writer-side and reader-side size caps (manifest 64 MiB, 100,000 entries), a best-effort lock file with heartbeat, and per-root state, journal and key-slot copies.
- Two marker values: `fixture` enables publish; `pulled-fixture` (created by pull) does not. Pull latches `encryptedSeen`, needs `--allow-plaintext-v1` for v1, and refuses `.obsidian/*` paths.
- Tests: known-answer vectors for every primitive, an independent reference decryptor, and property tests for tampering. An early independent security gate reviews the crypto code before any wiring starts, and a second review point follows the wiring.
- Feature operation `tools/feature-op-mvp-06.mjs`, fully automated, read-only verification of the ciphertext on the shared node.
- Documentation: threat model and format specification in DESIGN.md section 8 (documentation-specialist).

## Capabilities

### New Capabilities
- `crypto-primitives`: the primitive wrappers, key handling, randomness, error types and known-answer test obligations.
- `key-slots`: VCK and `vaultId`, the passphrase slot with key commitment, KDF parameters with floors and ceilings, caps, unlock, first-time setup, the generated and user-chosen passphrase rules.
- `encrypted-blobs`: blob format, opaque names and their tamper-resistance properties.
- `manifest-v2`: the encrypted manifest, `sequence`, layout in the MFS root.
- `encrypted-publish`: the publish flow, guard change, layout refusals, delta behaviour, no plaintext on the wire.
- `passphrase-input`: CLI and plugin passphrase handling, dialogs, memory handling, responsiveness.
- `threat-model`: what is protected, what is deliberately not, and what a node operator can and cannot do.

### Modified Capabilities
<!-- none: earlier changes' specs are not in openspec/specs/. Where this change replaces earlier behaviour (fixture-only publish, manifest.json), it is stated in encrypted-publish. -->

## Impact

- Code: new `src/crypto/`; `src/sync/` (encrypted publish path, vault keys, manifest v2, state v2), `cli/` (passphrase input, publish wiring), `src/plugin/` (session keys, dialogs, settings display), `tools/feature-op-mvp-06.mjs`, tests; DESIGN.md section 8, README, CHANGELOG (documentation-specialist).
- Removed: plaintext manifest v1 publishing (CLI and plugin). Kept: the fixture marker guard for publish, until mvp-07.
- Dependencies: none added. `@noble/hashes` 2.4.0 is already pinned and exports `argon2.js`, `hkdf.js`, `hmac.js`, `sha2.js` (checked in `node_modules`).
- Node: writes only under the configured MFS root; the feature operation uses a per-run root `/obsidian-vault-sync/mvp06-demo/<runid>` and the existing owned key.
- Trade-off: encrypted publish from the plugin is unit-tested here but has no in-Obsidian run until mvp-07's operator session (which does encrypted publish from the plugin and encrypted pull in a second vault).
