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
fdcd82cc9be5bb7982c06638f8fa0b24eaddb3220feca468ff40fe7fa22b98dd  main.js
c81c55ac99d7178a652cd7d59bddabacfc9d62fafc7101bb5e70586f0fa38b5c  manifest.json
b22706ae5ae3d4dc3c5ee61960d588f9df7159299a8b24a68dea9a024552e4c7  styles.css
fd91cea57fe7bc8ee794a11efdb5dc71669834509e6e5c86d09f8f2e21b6de5c  ipfs-sync-cli-0.2.0.tgz
```

## Not verified

- Mobile (iOS and Android) has not been run.
- An authenticated kubo endpoint has not been exercised.
- Symlink and rename behaviour on Windows and Linux.
- The crash window of remove-then-rename.
- Large-file behaviour above the tested sizes; the 64 MB default cap is unproven.

## Release status

This is a pre-release and is not the latest stable release for real-note use. The plan for the encryption release is in https://github.com/Prometheus-AGS/obsidian-ipfs-sync/tree/main/openspec/changes/mvp-06-encrypted-vault-publish.

Tag: v0.2.0
