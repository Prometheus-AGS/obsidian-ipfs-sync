# Task 33 notes: feature operation `tools/feature-op-mvp-07a.mjs`

Owner: ipfs-engineer. The script has NOT been run against the shared node. Only `node --check`, `--dry-run` and `--local-stub` were run, and none of them contacts the shared node (the stub is a loopback server inside the script).

## Request policy (the exact allowlist)

Copied from the mvp-06 operation with the demo prefix changed to `/obsidian-vault-sync/mvp07a-demo/<runid>` (run id `^[a-z0-9-]{8,}$`). Pull adds no command to it.

| Command | Condition |
| --- | --- |
| `files/stat`, `files/ls` | the demo root itself, a path below it, or an `/ipfs/<cid>[/...]` path |
| `ls` | exactly one `/ipfs/<cid>[/...]` path |
| `key/list` | no `arg` |
| `name/resolve` | exactly one `arg`, a key ID, optionally `/ipns/`-prefixed |
| `files/write`, `files/rm` | strictly below the demo root |
| `files/mkdir` | the demo root or below |
| `key/gen` | `arg` is exactly `obsidian-vault-sync` |
| `name/publish` | `key=obsidian-vault-sync` once, and a CID the node reported for the demo root |
| `pin/add` | a CID the node reported for the demo root |
| gateway | `GET` or `HEAD` of `/ipfs/<cid>[/path]`, no dot segments, no `//`, no backslash |

The request allowlist above is unchanged by the review-final fixes (see "Review-final pass C fixes" below). Refused: every other command, in particular `key/rm`, `key/rename`, `key/import`, `key/export`, `pin/rm`, `pin/update`, `files/mv`, `files/cp`, `repo/gc`; any parameter that contains `/obsidian-vault-staging`; any path outside the demo root (including `/obsidian-vault-sync/mvp06-demo/...`); any foreign key name; a request target that does not start with a single `/` or holds `//` or a backslash (raw or percent-encoded). The forwarded path is the vetted parsed URL, not the raw request line.

## Reads added for pull (and pinned by `tests/unit/feature-op-mvp-07a-helpers.test.ts`)

No command is added. A pull sends only these (observed in the proxy log of the `--local-stub` run, per pull: `key/list`, `name/resolve`, `ls`, gateway):

| Read | Used for |
| --- | --- |
| `key/list` (POST `/api/v0/key/list`) | the ID of the owned key `obsidian-vault-sync` (default target) |
| `name/resolve` (`arg=/ipns/<id>`, `nocache=true`) | the root the name serves |
| gateway `GET /ipfs/<root>/keyslots.json` (a one-byte `Range` probe, then the whole file) and `GET /ipfs/<root>/manifest.enc` | root screen, unlock, manifest |
| `ls` of `/ipfs/<root>` | the root's entries (key slots and manifest present) |
| `ls` of `/ipfs/<manifest.rootCID>/<xx>` | blob lengths per prefix folder |
| gateway `GET /ipfs/<manifest.rootCID>/<xx>/<52 characters>` | one request per blob |
| `ls` of `/ipfs/<root>/manifests` and gateway `GET` of one history entry | only with `--manifest`, `--list-versions` and fork resolution (not in the script's shared-node path) |

`files/stat` and `files/ls` stay on the list for publish (the script's own read-only view and the CLI's publish use them) but no pull command was observed sending them. A pull's slice of the proxy log is audited by `pullTraceProblems`: every entry must be allowed, not mutating, and one of `key/list`, `name/resolve`, `ls`, `files/stat`, `files/ls`, gateway.

## Deviations from the mvp-06 operation

1. Demo prefix `mvp07a-demo`; own lock file `ipfs-sync-feature-op-mvp07a.lock`; own default result file `feature-op-mvp-07a.json`. The config file `ipfs-sync-feature-ops/config.json` is the same path as mvp-06's on purpose: it records the ID of the same key.
2. Two devices (A and B), each with its own config file, vault directory, device label (`IPFS_SYNC_DEVICE`: `fop07a-a`, `fop07a-b`) and per-user state directory (`XDG_STATE_HOME`, outside the repository, judged on the real path; the runner refuses to start without one so a child can never reach the operator's real device id or sequence floor). The script refuses to run on win32, where the device store ignores `XDG_STATE_HOME` (L-03). B gets the key through `--owned-key <id>` for the run only.
3. New option `--cli <file>` (only with `--local-stub`; refused with `--dry-run`, `--cleanup` and on the shared-node path): drives a bundle built outside `dist/`. Reason: `dist/cli/ipfs-sync.mjs` is older than the 07a sources and does not hold the encrypted pull, and this task may not run `pnpm build`. The shared-node path always drives `dist/cli/ipfs-sync.mjs` with the freshness guard, `distSha256` and `distUnchangedDuringRun`.
4. No mid-publish fault injection, no key-slot or layout inspection (mvp-06's own checks); the manifest is decoded only to compare sequence, device, paths and hashes.
5. The proxy log entry of a gateway request carries the path in `arg`, so a pull's trace can be read.
6. Tamper kinds are the six of the task; `--tamper` acts once on one in-memory copy (`tamperOnce`).
7. `--resolve-fork` is not driven to its merge: a child has no terminal, so the CLI answers the question "no". The script checks the fork refusal by name and that `--resolve-fork` without a terminal changes nothing and sends no request.

## Review-final pass C fixes (review-final-C.md; owner ipfs-engineer)

Each fix was written test first (`tests/unit/feature-op-mvp-07a-helpers.test.ts`, 28 tests failed before the code, all pass after). Request-policy table: no change. The upstream rule and the child environment changed (rows L-02 and L-06).

| Finding | Change |
| --- | --- |
| M-01 pre-run pointer | `resolvePreviousPointer` (policy.mjs). Shared-node path: only the node's recorded never-published answer (HTTP 500, `Message` "could not resolve name", the one text in `src/kubo/ipns.ts`) becomes "unresolved". Any other failure is retried 3 times (2 s apart) and then the run refuses before the first mutation, naming the new opt-in `--accept-unresolved-pointer` (shared-node run only; refused with `--local-stub`, `--dry-run`, `--cleanup`). Stub path unchanged: any failure is "unresolved". Residual: on that node "not found" and "timed out" are indistinguishable (see `ipns.ts`), so a timeout that answers with the same text is still accepted as never published. |
| M-02 post-run pointer | `recordPostRun` runs in the finally of the run: key/list and name/resolve after the run, stored as `postRun` ({ keyId, pointer }) and `restore` (the exact text) in the result JSON and printed next to the `preRun` line. The text is `ipfs name publish --key=obsidian-vault-sync <recorded /ipfs/ path>`, or "nothing to restore" when nothing was recorded, plus: the real vault must not publish with this key during the run. A recorded pointer that is not a plain `/ipfs/<cid>` path is never put into a command. The script does not restore (name/publish stays limited to the demo root's CIDs). The operator-runbook line is the documentation-specialist's. |
| L-01 self-test | `proxySelfTest` builds a second proxy with the same policy whose upstream is the dead address `http://127.0.0.1:9` (`DEAD_UPSTREAM`). Out-of-policy requests are expected 403 and none may be allowed to forward; a control read (`key/list`, in policy) must come back 502 from the dead upstream, which proves the address is dead and the proxy would have forwarded. The main proxy's log is no longer touched by the self-test. |
| L-02 child environment | `childEnv` is an allowlist: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, plus the run's own `IPFS_SYNC_DEVICE`, `XDG_STATE_HOME`, `IPFS_SYNC_PASSPHRASE_FILE`. `NODE_OPTIONS`, `NODE_PATH`, proxy variables and all other `IPFS_SYNC_*` are dropped. The auth variables `IPFS_SYNC_(RPC_|GATEWAY_)?AUTH_*` pass on the shared-node path only; with `--local-stub` (also with `--cli`) they are dropped. The fixture generator child gets the same allowlist. |
| L-03 win32 | `win32Refusal`: the script exits 2 on win32 before anything else (`cli/device-store-node.ts` is not touched). |
| L-04 dist unchanged | `distUnchangedDuringRun` is a registered check (`... was unchanged during the run`), computed in the finally, so a run that throws still reports it. |
| L-05 scrubbing | The vault-id failure detail and the hostile-phase stub-setup detail go through `scrubbedDetail` with the secrets list plus both spellings read from the passphrase file (`withPassphraseSpellings`), so an empty secrets list no longer leaks. |
| L-06 https | `isAllowedUpstream`: the shared host is accepted over `https:` only; `http://ipfs.prometheusags.ai` is refused with and without `--local-stub`. Loopback over http stays allowed with `--local-stub`. |
| L-07 audit | The tautological "all N mutating requests were allowed" line is replaced by `mutationLogProblems`: it re-checks the proxy log against the explicit expected set (`files/write`, `files/mkdir`, `files/rm`, `key/gen`, `pin/add`, `name/publish`) from command names and arguments, not from the policy's `mutating` flag: file paths strictly below the demo root (mkdir: at or below), `key/gen` for `obsidian-vault-sync` only, `name/publish` with `key=obsidian-vault-sync` and an `/ipfs/<cid>` value, and no entry (read or write) naming the staging root. Refused entries stay with the violations check, so each tamper still fails exactly its own check. |
| L-08 realpath and signals | `realpathLoose` resolves the nearest existing ancestor and follows a dangling symlink; `isOutsideRepo` compares both the written and the real path with the repository and its real path. Used for `--out` (the written path is the real path), the passphrase-file check and the per-device state directory. SIGINT, SIGTERM and SIGHUP all remove the work directory (the 0600 passphrase file) and exit 130, 143 and 129. |

## Confirmation-read fix N-02, script side (review-final.md, Confirmation read; owner ipfs-engineer)

Written test first (6 new or changed tests in `tests/unit/feature-op-mvp-07a-helpers.test.ts` failed before the code; 68/68 pass after). Request-policy table: no change.

| Part | Change |
| --- | --- |
| (a) wording | `restoreInstruction` prints the same words as the operator runbook: the kubo CLI form `ipfs name publish --key=obsidian-vault-sync /ipfs/<cid>` (only when the recorded pointer passes the existing `/ipfs/<cid>` check), "run on the node with access to its keystore", saved pointer only, "default lifetime and TTL differ from the product's 5m TTL", and "unverified: test this form on a throwaway key before relying on it". Still no command from an untrusted pointer. The script never runs it. |
| (b) three cases | Recorded pointer: the command. Key absent, or name never published: "nothing to restore: the key did not exist before this run" (the parenthesis says which). Accepted-unresolved (`--accept-unresolved-pointer` after a read failure): "the previous pointer is UNKNOWN and could not be recorded, so it cannot be restored from this run". `resolvePreviousPointer` takes an `onPointerUnknown` callback, called only on that opt-in path; `recordPreRun` stores `preRun.pointerUnknown: true` in the result JSON, so the two "unresolved" origins are no longer conflated. |
| (c) signals | SIGINT, SIGTERM and SIGHUP now run `signalPostRun` before cleanup and exit: key/list and name/resolve, then the same post-run print and restore text, bounded by `SIGNAL_POST_RUN_TIMEOUT_MS` (5000) through `bestEffortPostRun` (never rejects, clears its timer). A failure or timeout prints "post-run pointer NOT recorded (<reason>)" with the restore text built from the pre-run record. A signal before the pre-run line prints that no mutating request had been sent. Skipped when the finally already started the post-run record. Exit codes 130/143/129 and work-directory removal are unchanged; a second signal falls through to the default action (the `once` handler is spent), so it still kills a stuck process. |

Verification (one run, scratch bundle outside the repo, no node contacted, `dist` not rebuilt): `node --check` on all files; `--dry-run` exit 0; `--local-stub --cli <scratch bundle>` 79/79 checks, exit 0; `--local-stub --tamper hash-mismatch` exit 1 with exactly one FAIL (the first-pull sha256 check); helper test 68/68; `pnpm typecheck` exit 0. A SIGTERM sent to a live stub run printed the pointer lines and the restore text and exited 143. Not verified: the printed kubo command itself (never run), the runbook text (another agent's), SIGINT and SIGHUP live (same handler as SIGTERM), a signal during a hung node (covered by the unit test of the timeout only).

## Not verified by this task

The shared-node run; the in-app plugin pull; large-file pull and Range behaviour on the shared node; fork resolution's merge through the CLI; behaviour on another platform's device. The cadence feature checkpoint runs the script against the shared node after 6.4 has passed.
