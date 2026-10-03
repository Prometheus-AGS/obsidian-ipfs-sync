# phone-test-big-fixture (mobile-feasibility)

Role: ipfs-engineer. Date: 2026-10-02. Large plaintext fixture published with the released v0.2.0 CLI (extracted from dl-v020/ipfs-sync-cli-0.2.0.tgz, Node v24). No repo edits.

## Values for the plugin
- Pull IPNS name: k51qzi5uqu5di138ouk0s7v7guidlj8tbx4wg81rgtpt9z5bdbatv9f2ce0qev
- Root CID (IPNS value): bafybeiduwbyjsy67sn3njb62hdmimypv55yibrmq5flitslhqqqd4ytiwq
- current/ CID: bafybeiee45uwojkewzejv226cq6mfnwfumrf2g4yo2mixefuontzbh2my4
- MFS root: /obsidian-vault-sync/phone-test-big
- Key name: obsidian-vault-phone-test-big
- RPC and gateway: https://ipfs.prometheusags.ai (auth none)

## Fixture (scratch = /private/tmp/claude-501/-Users-gqadonis-obsidian--ipfs-sync/649e61e6-bc8a-42a6-89a8-c16e83bbae4a/scratchpad/phone-test-big)
Vault `vault/`: `.ipfs-sync-fixture` (`fixture`, 7 bytes), `Welcome.md`, `Second note.md`, `notes/Third.md`, `notes/Fourth.md`, `big/blob-50mb.bin`, `big/blob-5mb.bin`. Both blobs from `head -c N /dev/urandom` (incompressible, dummy data).

| file | bytes | sha256 |
|---|---|---|
| big/blob-50mb.bin | 52428800 | 1ce6390509f2bac790f3d09f012e6db41268e79441454bed38d70b26fc14fa15 |
| big/blob-5mb.bin | 5242880 | 780a078762a630d87a3a49b696d461fed215f454988be18fa58e0d1e493fcca4 |

## Read cap
v0.2.0 `src/plugin/read-cap.ts`: DEFAULT_MAX_READ_MB = 64, range 8 to 1024 (MB = 1024*1024 bytes). The 50 MB file is 52428800 bytes; the cap is 67108864 bytes. It does NOT exceed the default, so no setting change is needed for these fixtures. The plugin setting is "Read cap (MB)" (`maxReadMb`); a user only needs to raise it for files above 64 MiB. Per the setting text, a file above the cap makes pull count it as failed (publish skips it).

## Commands
1. Read-only pre-check: `key/list` and `files/ls?arg=/obsidian-vault-sync` showed neither `obsidian-vault-phone-test-big` nor `phone-test-big` (existing keys: self, consult-capture, gomark-relay-lab, obsidian-vault, obsidian-vault-phone-test-1, obsidian-vault-sync, operator-model-max, prince-live).
2. `node cli/package/dist/cli/ipfs-sync.mjs publish vault --rpc-url https://ipfs.prometheusags.ai --gateway-url https://ipfs.prometheusags.ai --mfs-root /obsidian-vault-sync/phone-test-big --key obsidian-vault-phone-test-big --config $S/ipfs-sync.config.json` (run from $S). Result: 6 written, 0 removed, key created and recorded in config ownedKeys, exit 0, wall 41.7 s from this Mac (upload of ~57 MB).
3. `... pull pulled --name k51...qev --rpc-url ... --gateway-url ... --mfs-root ... --key ... --config ...`. Result: 6 fetched, 0 unchanged, 0 conflicts, 0 failed, exit 0, wall 3.5 s.

## Verification
- `name/resolve?arg=k51...qev` -> `/ipfs/bafybeiduwbyjsy67sn3njb62hdmimypv55yibrmq5flitslhqqqd4ytiwq`.
- `ls` root: current/, manifest.json (1523 B, bafkreico45yyqbl66wnpgyazupvhnjkqvq7vtyo5krx3id6dnjsqh2uioy), manifests/.
- Gateway GET of `/ipfs/<root>/current/big/blob-50mb.bin` from this Mac: `curl -w` -> http=200 size=52428800 time=2.746 s (about 19.1 MB/s). Downloaded file sha256 equals the published sha256. Two repeats: 1.863 s and 2.653 s. These are from a fast wired or Wi-Fi Mac to a node that just received the data; they are not phone-network numbers.
- Range `bytes=0-1048575` with `Origin: app://obsidian.md`: HTTP/2 206, `content-range: bytes 0-1048575/52428800`, content-length 1048576, accept-ranges bytes, `access-control-allow-origin: *`, `access-control-expose-headers` includes Content-Range, `access-control-allow-headers` includes Range. The 1 MiB body is byte-identical to the first 1 MiB of the source (cmp).
- CLI v0.2.0 pull into second dir: sha256 of both pulled blobs match the table; `diff -r -x .ipfs-sync -x .ipfs-sync-fixture vault pulled` printed nothing (DIFF_CLEAN).
- Node time for the full 50 MB download from this Mac: 2.75 s via gateway (curl), and the whole CLI pull of all 6 files took 3.5 s.

## Unverified and caveats
- Phone pull itself (iPhone, plugin v0.2.0), including whether Obsidian mobile survives holding a 50 MB buffer; the 64 MB default is documented in read-cap.ts as a proposal, not a measurement.
- OPTIONS preflight was not tested.
- Gateway timings are likely warm: the node holds the blocks locally after publish. Cold or remote retrieval was not measured.
- The fixture is public on an unauthenticated node; dummy random bytes only.
- Fixture contains Welcome.md plus three further notes (Second note, Third, Fourth), one more than the "3 small notes" literal reading if Welcome is excluded.
- Left on the node: key obsidian-vault-phone-test-big and MFS root /obsidian-vault-sync/phone-test-big (about 57 MB pinned/stored; cleanup via key/rm and files/rm needs operator approval). phone-test-1 was not touched.
