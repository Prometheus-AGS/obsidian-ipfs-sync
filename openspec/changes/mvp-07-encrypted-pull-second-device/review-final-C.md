# Review 6.4, pass C: task-33 script delta safety check (security-reviewer)

Reviewer: security-reviewer. Static read only; nothing executed; cross-model judge not run (single-reviewer read). Saved by the lead as a condensed record (2026-10-03). To be merged into review-final.md.

VERDICT: PASS-WITH-FIXES. Critical 0, High 0, Medium 2, Low 8.

The request policy, proxy confinement, per-device state isolation, argument gating, tamper isolation and the new `--cli` option hold on a static read. The two Mediums concern the one irreversible effect of the run: the IPNS pointer of the operator's real key `obsidian-vault-sync`.

## Findings
- **M-01 MEDIUM** `tools/feature-op-mvp-07a/run.mjs:33`. `recordPreRun` turns any `nameResolve` failure into "unresolved" and continues, so a transient failure looks like "never published". If resolution times out, publish #1 repoints the key and the previous pointer is lost from stdout and the result JSON. Fix: on the shared-node path accept "unresolved" only for an error that means never published; otherwise retry then refuse; optional explicit `--accept-unresolved-pointer`. Owner ipfs-engineer.
- **M-02 MEDIUM** `policy.mjs:102-106`, `constants.mjs:12`, `shared-phase.mjs:84-94,146,164`. The run publishes three times to the product's default key `obsidian-vault-sync`; afterwards the operator's real name points at the demo vault. Only the before-pointer is recorded; no post-run pointer, no documented restore step. Accepted in 5b by recording the pointer: residual, not new. Fix: record `postRun` (`name/resolve` after the run) in the result; add the exact restore step (or the pointer line) to the operator runbook; note that the real vault must not publish with this key during the run. Owners ipfs-engineer, documentation-specialist.
- **L-01** `proxy.mjs:151-172`, `run.mjs:85`. `proxySelfTest` is live fire (key/rm of the production key, pin/rm, files/mv, files/rm of foreign paths) through the real proxy; only the policy stops it. Fix: run the self-test against a second proxy whose upstream is a dead loopback address. Owner ipfs-engineer.
- **L-02** `policy.mjs:236-243`. `childEnv` strips only `IPFS_SYNC_*`; NODE_OPTIONS, NODE_PATH, proxy variables and the auth variables pass through (auth variables even in `--local-stub`, including to a `--cli` binary). Fix: allowlist environment; drop auth variables in `--local-stub`. The shared-node run cannot be pointed at another binary (`CLI` from `import.meta.url`; `--cli` refused without `--local-stub`).
- **L-03** `cli/device-store-node.ts:36` vs `children.mjs:55-60`. On win32 the store reads LOCALAPPDATA, ignoring XDG_STATE_HOME, so the "child can never touch the real device id or floor" guarantee fails on Windows. Fix: set LOCALAPPDATA per run on win32 or refuse win32.
- **L-04** `run.mjs:152-153`. `distUnchangedDuringRun` is printed/stored but is not a `check()`; never computed if the run throws. Fix: register it as a check.
- **L-05** `shared-phase.mjs:79`, `hostile-phase.mjs:58`. The vault-id failure path prints raw `firstLine(init.stdout)`; hostile-phase detail may call `scrubbedDetail` with empty secrets. Fix: pass through `scrubbedDetail(init, S.secrets)`.
- **L-06** `policy.mjs:49-56`. `isAllowedUpstream` checks hostname only; `http://` to the shared host would forward the Authorization header in cleartext. Fix: require https for the non-loopback host.
- **L-07** `audit.mjs:30`. "all N mutating requests were allowed" can never fail (`mutating = allowed && isMutating`). Fix: delete or replace with an explicit expected command set.
- **L-08** `arguments.mjs:52`, `shared-phase.mjs:73`, `run.mjs:140`. `--out` and passphrase-path guards are lexical (no realpath); only SIGINT cleans the work directory (SIGTERM/SIGHUP leave the 0600 passphrase file in the 0700 temp dir). Low impact. Fix: realpath; handle SIGTERM/SIGHUP.

## review-5b conditions
1 policy unchanged in substance MET; 2 only the proxy reaches the node MET; 3 tamper hooks stub-only MET; 4 `--cleanup` validation MET; 5 passphrase and result file MET (L-05, L-08); 6a R5-09 pre-run IPNS pointer PARTIAL (M-01); 6b R5-10 dist sha256 MET (L-04); 7 unit test pins the policy MET (not run by reviewer); F-01 vetted URL is the forwarded URL MET; F-02 re-scrub before print PARTIAL (L-05); `--allow-stale-build` refused on the shared-node path MET; unused circular import MET; fresh `pnpm build` before the run: OPERATOR CONDITION (mtime check `checkBuildFresh`).

Eight checks (policy, confinement, argument validation, secrets, pre-run recording, hostile phase stub-only, mutation outside the demo root, dropped protections): all hold with the findings above. Dropping mvp-06's fault injection and layout inspection weakens no safety property (functional coverage of publish resume and at-rest plaintext inspection reduced; wire scanning retained; needles under 5 bytes excluded).

INFO: the notes say no pull was seen sending files/stat or files/ls, yet both are in `PULL_READ_COMMANDS`; harmless (scope enforced by policy).

## Could not verify
Nothing executed (no tests, dry-run or stub); whether this kubo reads `arg` from the POST body or parses malformed escapes like URLSearchParams; whether the CLI/kubo follow redirects (a gateway 3xx with an absolute Location could let a child GET a non-proxy host; not rated without a verified path); that `dist/cli/ipfs-sync.mjs` matches the reviewed source (sha256 recorded, compared to nothing); `generateVault` runs the fixture generator with the full unstripped environment (no network code found; dependencies not traced); real shared-node behaviour (`files/write` overwrite, `name/publish` TTL, 3xx).
