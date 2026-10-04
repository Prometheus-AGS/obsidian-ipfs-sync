Release 1 (fixture-only). This release must not be used on real notes. It syncs synthetic fixture vaults only, refuses any other vault, and has no encryption: everything it publishes to your kubo node is readable by anyone who obtains the CID.

## IPFS Sync 0.2.0

Adds pull with conflict handling in the Obsidian plugin: it fetches the published vault from your own kubo node by delta and keeps your local bytes when both sides changed, saving the remote version as a conflict copy.

## Known limitations

- Symbolic links are not detected by the plugin.
- A per-file read cap applies (default 64 MB, configurable 8 to 1024 MB).
- Remote deletions are not applied on pull.
- Mobile is not verified.
- No encryption. Do not point this at a vault that holds real notes.

## Requirements

- Obsidian 1.12.3 or later (the plugin appends large files in chunks).
- Your own kubo node. Do not expose its RPC port to the internet.

## Assets and SHA-256

```
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  main.js
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  manifest.json
```

## Not verified

- First unverified claim.
- Second unverified claim.

## Release status

This is a pre-release and is not the latest stable release for real-note use. The plan for the encryption release is in https://github.com/Prometheus-AGS/obsidian-ipfs-sync/tree/main/openspec/changes/mvp-06-encrypted-vault-publish.

Tag: v0.2.0
