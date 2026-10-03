# phone-test-fixture (mobile-feasibility)

Role: ipfs-engineer. Date: 2026-10-01. Plaintext fixture published with the released v0.2.0 CLI.

## Values for the plugin
- Pull IPNS name: k51qzi5uqu5dm2m0wjxsayst4k1h0qqb9ylbhbk1wjezwlixsnhm9v2d33s4ue
- Root CID (IPNS value): bafybeidfvs3opb7354ocdrciodueakemgoh4efz53zn4olxthi2gsqymk4
- current/ CID: bafybeigpbk3lay3s3mm6i7hrvtf6wcgii4mv67wkz65hg4j6ymcrxie6we
- MFS root: /obsidian-vault-sync/phone-test-1
- Key name: obsidian-vault-phone-test-1 (deviation: the CLI requires ^obsidian-vault(-[a-z0-9-]+)?$, so `phone-test-1` is rejected)
- RPC and gateway: https://ipfs.prometheusags.ai (auth none; node accepted unauthenticated writes)

## Commands (scratch = /private/tmp/claude-501/-Users-gqadonis-obsidian--ipfs-sync/649e61e6-bc8a-42a6-89a8-c16e83bbae4a/scratchpad/phone-test)
1. `shasum -a 256 -c SHA256SUMS` in dist/release/v0.2.0: tgz, main.js, manifest.json all OK. `tar -xzf ipfs-sync-cli-0.2.0.tgz -C $S/cli`. Node v24.16.0.
2. Read-only: `curl -X POST .../api/v0/key/list` (existing: self, consult-capture, gomark-relay-lab, obsidian-vault, obsidian-vault-sync, operator-model-max, prince-live), `files/ls?arg=/obsidian-vault-sync` (mvp02..06-demo, mvp06-probe, publish-real-20260929). Neither chosen name existed.
3. Fixture vault $S/vault: .ipfs-sync-fixture (`fixture`), Welcome.md, Second note.md, notes/Third.md, notes/nested/Deep note.md, notes/range-test.txt (3000 bytes of x). 24 KB on disk.
4. `node cli/package/dist/cli/ipfs-sync.mjs publish vault --rpc-url https://ipfs.prometheusags.ai --gateway-url https://ipfs.prometheusags.ai --mfs-root /obsidian-vault-sync/phone-test-1 --key obsidian-vault-phone-test-1 --config $S/ipfs-sync.config.json`
   Result: 5 added, key created and recorded in $S/ipfs-sync.config.json (ownedKeys), exit 0.
5. `node ... pull pulled --name k51...v2d33s4ue --rpc-url ... --gateway-url ... --mfs-root ... --key ... --config ...`
   Result: 5 fetched, 0 conflicts, 0 failed, exit 0. `diff -r -x .ipfs-sync -x .ipfs-sync-fixture vault pulled` printed nothing (DIFF_CLEAN).
   Note: v0.2.0 has no `--allow-plaintext-v1` flag (HEAD only); first attempt exited 2 for that reason.

## Verification
- name/resolve k51... -> /ipfs/bafybeidfvs3opb7354ocdrciodueakemgoh4efz53zn4olxthi2gsqymk4
- ls root: current/, manifest.json (1317 B, bafkreienp2r55m5qmyjpmrgpqccgo4ocx3sekmmkcy2kwfu5impz5caaeu), manifests/<current CID>.json
- GET /ipfs/<root>/current/Welcome.md -> 200, body "Hello from phone-test-1"
- Range `bytes=100-199` on current/notes/range-test.txt (Origin app://obsidian.md): HTTP/2 206, content-range: bytes 100-199/3000, content-length 100, accept-ranges: bytes, access-control-allow-origin: *, access-control-expose-headers includes Content-Range, access-control-allow-headers includes Range.
- Same with Origin capacitor://localhost, bytes=0-9: 206, content-range bytes 0-9/3000, ACAO *.

## Unverified
- Phone pull itself (iPhone, plugin v0.2.0). Gateway manifest.json GET status was not fetched separately via the gateway (it is listed via RPC ls and the CLI pull read it through the gateway successfully).
- OPTIONS preflight was not tested.
- The fixture is public on an unauthenticated node; dummy text only.
- Left on the node: key obsidian-vault-phone-test-1 and MFS root /obsidian-vault-sync/phone-test-1 (cleanup via key/rm and files/rm needs operator approval).
