# Capability catalog

UCAN ability strings for this project. Format `with: resource`, `can: ability`.

| Ability | Resource | Granted to | Notes |
|---|---|---|---|
| `vault/sync` | `did:key:<device>` | paired devices | publish/pull via kubo path |
| `vault/sync/direct` | `did:key:<device>` | paired devices | WebRTC/iroh direct links |
| `vault/read` | `ipfs://<cid>` | agents | read-only, per-CID or per-manifest |
| `ipfs/add` | `mfs:/obsidian-vault-sync/` | agents + containers | spec 008 host function `ipfs_add` |
| `store/vector` | `pglite:vault` | local agents | embedding pipeline writes |
| `store/graph` | `surreal:vault` | local agents | graph writes |
| `mcp/invoke` | `mcp://<server>#<tool>` | agents | hash-pinned tool only |
| `skill/run` | `skill://<name>` | sandbox | WASI spawn, capability dirs from attenuation |

Rules: attenuation only narrows (resource prefix or subset); `*` abilities are
forbidden in delegations; every grant logs to the Karpathy knowledge log
(spec 007) with the UCAN CID.
