# Review 6.4: independent review of the read side (mvp-07a)

Reviewer: security-reviewer, three independent static passes (read only, nothing executed, cross-model judge not run, single-reviewer reads). Saved by the lead as a condensed record (2026-10-03). Full condensed findings per pass: `review-final-A.md` (sync core), `review-final-B.md` (B1 path policy, B2 CLI and plugin), `review-final-C.md` (task-33 script delta safety check against mvp-06 `review-5b.md`).

## Verdicts
| Section | Verdict | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| A. Sync core (read side, publisher deltas) | PASS-WITH-FIXES | 0 | 0 | 2 | 6 |
| B1. Path policy (`path-hardening`, tasks 3.1a, 3.1b, 3.2) | PASS-WITH-FIXES | 0 | 0 | 2 | 4 |
| B2. CLI and plugin surfaces | PASS-WITH-FIXES | 0 | 0 | 3 | 2 |
| C. Task-33 script, delta safety check | PASS-WITH-FIXES | 0 | 0 | 2 | 8 |

Open critical and high findings: zero. The pull side accepted no forged, replayed-below-the-record or truncated data and wrote nowhere outside the temp, destination and conflict-copy paths in any reviewer's reading. The Mediums are: publish-side overlap window (A-01) and sequence floor not consulted by publish (A-02); quadratic path-policy work (B1-01, B1-02); the plaintext v1 route bypassing the path policy (B2-01); unescaped node-supplied error text (B2-02); whole-body buffering under a hostile gateway (B2-03); lost IPNS pointer on a transient resolve failure and no post-run pointer/restore step (C M-01, M-02).

## Lead disposition (2026-10-03)
One batched fix cycle (owners per finding, disjoint files), then a confirmation read. No further review cycle beyond the confirmation. The 07b operator run and the next phase gate are the next checks.

FIX NOW (all Mediums, and the Lows that trace to a named scenario):
- A-01, A-02, A-03, A-08 (identity-security-engineer): refuse a commit when the existing `manifest.enc` authenticates at an equal or higher sequence from another identity, and read the name before assessing; consult the sequence floor on every publish and in repair; restore in the D-1 withdrawal only the manifest inside the root the failed recheck resolved and keep the original refusal; serialise `raiseFloor`.
- B1-01, B1-02, B1-05 (display escape only), A-05, A-06, A-07 (ipfs-engineer, src/sync and pull core): depth, length and segment caps in `shapeRefusal` and the decoder, incremental prefix and linear group handling in both matchers, escape default-ignorables in display, re-check before the conflict-copy rename, remove restore-written paths from `unmaterialized`, token check on the pull and sweep locks.
- B2-01, B2-02, B2-04, B2-05, B1-04(a) (ipfs-engineer, plaintext route, display sinks, plugin runner): run the path policy on the v1 route (or refuse it), escape node-supplied text at both sinks, settle the unlock dialog with the real outcome, escape v1 printing, re-apply the folder protection after `realpath`.
- C M-01, M-02, L-01, L-02, L-04, L-05, L-06, L-07, L-08, L-03 (ipfs-engineer, tools/feature-op-mvp-07a): resolve-failure handling for the pre-run pointer, post-run pointer in the result, self-test against a dead upstream, environment allowlist, register `distUnchangedDuringRun` as a check, scrub and https checks, drop the tautological audit line, realpath and signal cleanup, refuse win32.
- Plan text (product-manager, documentation-specialist): B1-03 state in the spec that decoder strictness is intended and fails closed; the M-02 restore step in the operator runbook; B2-03 residual documented plus a 07b task (streaming transport on desktop, probe every size class, abort after the first Range-ignoring answer); B1-06 `PATH_FOLD_UCD_DIR` regeneration test recorded in the phase gate commands.

DEFERRED OR ACCEPTED (recorded, not fixed here):
- A-04 (not-found at the start accepted as a baseline): accepted for 07a. The node finding (2026-10-01) is that not-found and timeout are indistinguishable, so a stricter rule cannot be tested; a hostile node can always do this; revisit in the 07b operator run.
- B1-04(b) (Obsidian adapter cannot see symlinks): accepted residual, as the spec states.
- B1-05 bidi-override refusal: operator decision pending (display escaping extended now; refusing bidi names as unsafe/shape is not done).
- B2-03 itself (transport buffering): accepted as a documented residual for 07a; mitigation is a 07b task.

## Status
Every finding has a status above. Confirmation read: pending after the fix cycle. Shared-node run of `tools/feature-op-mvp-07a.mjs`: only after the confirmation read passes and the operator approves; conditions carried from pass C: a fresh `pnpm build` immediately before, the printed `previous IPNS pointer` line saved, and the restore step known. Defects found later by the 07b operator run reopen the owning task here and are fixed under a 07b task.

## Confirmation read (security-reviewer, static, single-reviewer, nothing executed; 2026-10-03)
VERDICT: PASS-WITH-FIXES. Critical 0, High 0, Medium 2 (N-01, N-02), Low 3 (A-08 residual, N-03, N-04). No FIX NOW finding is NOT FIXED; two are PARTIAL (A-08, M-02). Condensed per-finding result:
- CONFIRMED: A-01, A-02, A-03, A-05, A-06, A-07, B1-01, B1-02, B1-03 (spec), B1-04(a), B1-05 (display part), B1-06 (recorded), B2-01, B2-02, B2-03 (residual and 07b 2.3), B2-04, B2-05, C M-01 (caveat: not-found and timeout indistinguishable on the node; the flag can be passed by mistake by design, off by default), C L-01 to L-08 (L-08 caveat: a signal exit skips the post-run print).
- A-08 PARTIAL (Low): `cli/publish-command.ts:139` builds its own `{get,set}` wrapper with no `exclusive`, so a CLI publish raises the floor unlocked (via `publish-session.ts:110`) and can race a locked pull. Fix: use `createLazyDeviceStore(ctx.env)` keeping the `ctx.deviceStore` override; same in `cli/abandon-command.ts:98-99`.
- C M-02 PARTIAL: see N-02.
- N-01 MEDIUM (`encrypted-manifest.ts:210-217`, `publish.ts:153`, `cli/publish-command.ts:217-219`): the new path limits (4096/255/128) apply to the publisher's own manifest; the refusal is a path-free `ManifestFormatError` and the CLI prints "written by a newer or incompatible version ... update ipfs-sync", which blames the node and does not name the file (e.g. a 85+ CJK-character title is over 255 UTF-8 bytes). Fails closed. Fix: catch the limit refusal on the publisher side and name the local path (escaped), or exclude over-limit local paths with a warning; never reuse the "newer or incompatible version" text for a writer-side cap failure; state the consequence in the spec.
- N-02 MEDIUM (`docs/operator/encrypted-vault.md:437-446` vs `tools/feature-op-mvp-07a/policy.mjs:338-344`): the runbook says the restore step "is not available yet" (07b 4.9) and "do not improvise a raw name/publish call", while the script prints exactly such a command after the run; (b) `restoreInstruction` says "nothing to restore" for an accepted-unresolved pointer too; (c) a signal exit skips the post-run print (the pre-run line is still the saved record). The printed command `ipfs name publish --key=obsidian-vault-sync /ipfs/<cid>` matches kubo's documented CLI form (inference; nothing run; default lifetime and TTL are not the product's 5m TTL; needs node keystore access; unverified against the shared node's kubo). Fix: reconcile runbook and script; distinguish accepted-unresolved; fix the section name that 4.9 refers to.
- N-03 LOW (`cli/device-store-node.ts:99-108,126-129`): stale-lock takeover re-checks inode and mtime then `rm`; two waiters can both pass and the second deletes the first's fresh lock; release compares inode numbers which a filesystem may reuse. Effect: a lost floor update only after a stale-lock crash. Fix: random token in the lock file compared before `rm` in takeover and release.
- N-04 LOW (`publish-commit.ts:131` with `device-store-node.ts:131-136`): the floor raise runs after `name/publish`; a lock wait that fails after 10 s throws "nothing was written" after the publication happened. Fix: map that failure to a message saying the publication happened and the next run completes it; do not move the raise before publish.
Reviewer's gate: before the shared-node run resolve N-02 and the one-line A-08 wiring fix; the rest may follow in 07b. Could not verify: nothing executed; kubo CLI syntax and the shared node's name/resolve and timeout behaviour; real Obsidian and NTFS semantics; that dist matches the source; whether any unread file reintroduces an unlocked floor write.

### Lead disposition of the confirmation read
Accepted. One more batched correction (no further review cycle; the confirmation read for these items is a self-check by the gate and the operator run): A-08 wiring, N-03, N-04, N-01 (code, identity-security-engineer), N-01 spec and N-02 script (ipfs-engineer, product-manager), N-02 runbook (documentation-specialist). The shared-node run needs the operator's approval AND a restore command the operator has tested on a throwaway key first.
