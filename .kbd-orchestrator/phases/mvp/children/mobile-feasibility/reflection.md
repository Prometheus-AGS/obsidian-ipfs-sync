# Reflection: mobile-feasibility

Closed 2026-10-02. Evidence: `device-results.md`, `assessment-clients.md`, `assessment-install.md`, `assessment-crash-desktop.md`, `argon-probe-build.md`, `phone-test-fixture.md`, `phone-test-big-fixture.md`.

## Delta between plan and delivery

- Goal 1 (decide how encrypted pull and publish work on iOS and Android): decided for iOS in principle only. The HTTPS plugin design is kept. The encrypted pull and publish were NOT run on a phone, because 07a has no pull yet. Android was not tested at all.
- Goal 2 (install and run on a real device): met for iPhone via BRAT. Android not done. The first manual-copy route (iCloud vault) hung on load; BRAT with a pre-release worked.
- Goal 3 (measure Argon2id, memory, requestUrl): Argon2id measured (980-1143 ms at 64 MiB t=3 p=1, gap 17-21 ms; pass). requestUrl worked for a 50 MB plaintext pull. Memory above 50 MB, Range behaviour from the phone, time of the 50 MB pull, and suspend behaviour were not measured.
- Goal 4 (evaluate native or embedded IPFS clients): done as a desk study. Recommendation: keep HTTPS gateway. Helia, a native companion and iroh rejected for now; not tested.
- Goal 5 (report which 07a/07b tasks change): see below.

## Uncomfortable findings

- The first crash on the phone is unexplained. The relaunch loop was an iOS file-provider hang (0x8BADF00D) cleared by a restart; the log does not show what started it. The plugin was not shown innocent, only not shown guilty.
- Nothing installed on a phone today syncs encrypted notes. That remains true until 07a delivers pull.
- The agent that built the probe loosened a guard in `tools/hook-isolation.mjs` in a throwaway worktree. Not carried anywhere.
- Two outward actions happened: plaintext fixtures on the shared open-write node, and a public pre-release `0.2.1-probe.1`. Cleanup is pending operator approval.

## Changes to 07a and 07b

- 07a: no task changes required by this phase. Optional: read blobs with `fetch` instead of `requestUrl` in the plugin blob source (5.3); the 50 MB pull worked without it, so not blocking.
- 07a/DESIGN: sections 2, 3 and 6 assume phones reach a Helia daemon over WSS; that does not match the node (relay-only addresses, HTTPS gateway). To be corrected in task 6.2 (docs). README line 414 treats the RPC CORS 403 as applying to all node requests; the gateway path answers with open CORS.
- 07b: operator phone run (7.1/7.2) stays. Add Android and a suspend/background test. Add an encrypted pull run on the phone before guard removal.
- Process: phone install route that works is BRAT with a distinct pre-release tag. `tools/release` hard-codes 0.2.0 and cannot cut a second release.

## Not verified

Everything on Android; encrypted paths on any phone; whether the 50 MB pull stayed responsive; the contents of `ipfs-sync-argon-probe.md` (notice text only was seen).
