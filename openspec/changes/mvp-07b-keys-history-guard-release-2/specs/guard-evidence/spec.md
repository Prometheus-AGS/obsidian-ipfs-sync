## Purpose

Defines what must be true before a release that can publish real notes is produced, and how a checker decides it: one hash over everything that ships and everything that judges the release, hashes of the built files from a reproducible clean-export build, a machine-readable review record, an operator-run record and a phone-timing record each bound to that hash, required lists held in the checker and not in the records, a trust anchor outside the repository, and a statement that all three records are attestations and not proofs. It replaces the first draft's three self-declared evidence items, whose hash left out the build inputs and the tools, and which could be satisfied by text the team wrote. Correction 2 (2026-09-30) tightens the tree hash, the build, the record's binding and authentication, and moves every required list into the checker.

## ADDED Requirements

### Requirement: Tree hash over the scope
The checker SHALL compute a tree hash T over the tracked files in this scope: `src/**`, `cli/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` (when tracked), `esbuild.config.mjs`, `esbuild.options.mjs`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.src.json`, `manifest.json`, `tools/check-guard-preconditions.mjs`, `tools/hook-isolation.mjs`, `tools/record-phone-timing.mjs`, `tools/release-mvp-07.mjs`, `tools/release/**`, `tools/feature-op-mvp-07.mjs` and every file under `tools/feature-op-mvp-07/` (narrowed 2026-10-03; the committed 07a files `tools/feature-op-mvp-07a.mjs` and `tools/feature-op-mvp-07a/` are outside the glob; every `tools/` file the operator-run script imports, including a reused 07a module, is in the scope by exact path). The file set SHALL be the output of `git ls-tree -r -z HEAD` intersected with the scope, and the hashed content SHALL be the blob bytes from the object database, so that `.gitattributes` filters and line-ending settings of a working tree do not enter T. Inside the scope, `git ls-files --others --exclude-standard` and `git ls-files --others --ignored --exclude-standard` SHALL both list nothing; the index and the working tree SHALL equal `HEAD` (`git diff --cached --quiet`, `git diff --quiet`); no scoped entry SHALL carry an `assume-unchanged` or `skip-worktree` flag; every mode SHALL be `100644` or `100755` (a symbolic link or submodule fails); no file SHALL be excluded by name (test files under `src/` are hashed); a path containing a tab or newline SHALL fail. Each line SHALL be `<posix path>\t<git mode>\t<sha256 hex of the blob bytes>\n`, lines SHALL be ordered by the path compared by UTF-16 code unit, and T SHALL be the SHA-256 of the UTF-8 bytes of the concatenated lines. `--print-tree-hash` SHALL print T and the file count read-only, and `--list` SHALL print the lines. A known-answer vector in the checker's tests SHALL pin the algorithm.

#### Scenario: Stable hash
- **WHEN** T is computed twice on an unchanged commit, once in a checkout with different line-ending settings
- **THEN** both give the same value

#### Scenario: Hidden file
- **WHEN** an untracked file exists under `src/`
- **THEN** the check fails and names it

#### Scenario: Ignored file
- **WHEN** a file `src/feature/main.js` exists on disk, is matched by `.gitignore` line 2 (`main.js`), and is not tracked
- **THEN** the check fails and names it, because the build would still compile it

#### Scenario: Index differs from HEAD
- **WHEN** a scoped file is staged with content that differs from `HEAD`, or carries `skip-worktree`
- **THEN** the check fails

#### Scenario: Symbolic link
- **WHEN** a symbolic link exists inside the scope
- **THEN** the check fails

#### Scenario: Test file under src
- **WHEN** a `*.test.ts` file under `src/` changes
- **THEN** T changes

#### Scenario: Exec bit
- **WHEN** the git mode of a scoped script changes
- **THEN** T changes

### Requirement: Build hashes from a clean export
The checker SHALL export the tree of `reviewedCommit` (`HEAD` before a record exists) into a fresh temporary directory with a fresh detached worktree using `core.autocrlf=false` and `core.eol=lf`, SHALL compare every scoped file there with its blob bytes and fail on a difference, and in that directory, with a scrubbed environment (an allow-list of `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `PNPM_HOME` and `CI=true`; `NODE_OPTIONS`, `OBSIDIAN_PLUGIN_DIR`, every `npm_config_*` and every `ESBUILD_*` variable removed) SHALL run `pnpm install --frozen-lockfile` and `pnpm build`, hash `dist/plugin/main.js`, `dist/plugin/manifest.json`, `dist/plugin/styles.css` (only if produced) and `dist/cli/ipfs-sync.mjs`, remove that directory's `dist/`, build again, and require the two sets of hashes to be identical. The hashes of this build are B. A default run SHALL write nothing inside the repository. The `--build` mode SHALL copy the verified outputs into the repository's `dist/plugin/` and `dist/cli/` only (never `dist/release/`) and write `dist/.guard-build.json` with T and B. The checker SHALL record the Node and pnpm versions it ran with and SHALL require the Node version to satisfy `engines.node` of `package.json`.

#### Scenario: Reproducible
- **WHEN** the two builds produce identical bytes
- **THEN** B is recorded and the check continues

#### Scenario: Non-reproducible
- **WHEN** the two builds differ
- **THEN** the check fails and names the differing file

#### Scenario: Lockfile drift
- **WHEN** `pnpm install --frozen-lockfile` fails
- **THEN** the check fails

#### Scenario: Attribute filter changes a file
- **WHEN** an export differs from a blob because of a `.gitattributes` rule
- **THEN** the check fails and names the file

#### Scenario: Release output survives
- **WHEN** `--build` runs while `dist/release/v0.3.0` exists
- **THEN** `dist/release/` is unchanged

#### Scenario: Environment cannot redirect the build
- **WHEN** `NODE_OPTIONS` and `OBSIDIAN_PLUGIN_DIR` are set in the caller's environment
- **THEN** the build does not see them

### Requirement: Item A, the review record
The checker SHALL read `openspec/changes/mvp-07b-keys-history-guard-release-2/review-final-<T8>.md`, where T8 is the first 8 hex characters of T, and parse the JSON object between `<!-- guard-review:v1 -->` and `<!-- /guard-review -->` with the fields `reviewer`, `verdict`, `reviewedCommit`, `treeSha256`, `treeFileCount`, `buildSha256`, `checkerSha256`, `checklistTests`, `coverage`, `counts` and `findings`. It SHALL require `reviewer` to be `security-reviewer` and `verdict` to be `approved`; the counts SHALL equal the counts derived from `findings`; every critical or high finding SHALL have status `fixed`; every medium or low finding SHALL be `fixed` or `accepted` with a reason, and accepted findings SHALL be printed; `treeSha256` SHALL equal T and `treeFileCount` the file count; `buildSha256` SHALL equal B; `checkerSha256` SHALL equal the SHA-256 of `tools/check-guard-preconditions.mjs`; each `checklistTests` hash SHALL equal the current hash of that test file. `coverage` SHALL hold one entry `{path, read}` for every file under `src/`, `cli/` and the scoped `tools/` paths that `--print-tree-hash --list` prints; a listed file without an entry, an entry repeated, or an entry for a path outside the list SHALL fail; the checker SHALL print every file declared unread and the release notes SHALL state their count. The record SHALL be authenticated by one of: (a) git-history binding: the file name's T8 equals the record's `treeSha256`; the last commit E that touched the file descends from `reviewedCommit` and changed only that file; the file at `HEAD` equals the file at E; T computed from the git objects of `reviewedCommit` equals `treeSha256`; the checker prints E and the number of commits that touched the file; or (b) an SSH signature `review-final-<T8>.md.sig` that verifies with `ssh-keygen -Y verify -f <allowed-signers> -I operator -n ipfs-sync-review -s <record>.sig` with the record on standard input, against the trust anchor of the next requirement. The checker SHALL print which form it found and, for (b), the signer fingerprint. The record SHALL describe the final tree after the batched fix cycle and the confirmation read, and the lead's disposition SHALL be in the same commit. A fix that changes T SHALL produce a new file with a new T8 and SHALL NOT be a second commit on the old file.

#### Scenario: Code changed after review
- **WHEN** a scoped file differs from what was reviewed
- **THEN** T differs from `treeSha256` and item A fails

#### Scenario: Open high finding
- **WHEN** the record lists a high finding that is not `fixed`
- **THEN** item A fails

#### Scenario: Count contradicts findings
- **WHEN** `counts.high` is 0 and a high finding is listed
- **THEN** item A fails

#### Scenario: Defect loop does not dead-end
- **WHEN** the first fix changes T after a record exists
- **THEN** a new `review-final-<T8'>.md` for the new tree can be committed and authenticated by form (a), and the old file is left as history

#### Scenario: Record edited after its first commit
- **WHEN** the record has more than one commit
- **THEN** form (a) still passes if its other conditions hold, the checker prints the commit count, and the release procedure requires the operator to type it (see `release-2`)

#### Scenario: Checker changed after review
- **WHEN** `tools/check-guard-preconditions.mjs` differs from `checkerSha256`
- **THEN** item A fails

#### Scenario: File not covered
- **WHEN** a file under `src/` is missing from `coverage`
- **THEN** item A fails and names it

#### Scenario: File declared unread
- **WHEN** a file is listed with `read: false`
- **THEN** item A passes that entry, the checker prints it, and the release notes count it

### Requirement: The trust anchor for the signature form is operator-owned
The allowed-signers file and the enrolled fingerprint SHALL live at fixed paths in the per-user state directory (`<dir>/trust/allowed-signers` and `<dir>/trust/review-signer.json`), the directory mode 0700 and the files 0600, owned by the current user, neither a symbolic link, and outside the repository (the checker SHALL resolve real paths and refuse a trust directory inside the repository root). The allowed-signers file SHALL hold one entry `operator namespaces="ipfs-sync-review" <key>`, and the checker SHALL require the fingerprint of that key to equal the enrolled fingerprint. No environment variable and no command-line flag SHALL select another allowed-signers file or trust directory; when `IPFS_SYNC_ALLOWED_SIGNERS` is set, the checker and `release-mvp-07 record` SHALL exit 2. Enrolment SHALL be `node tools/check-guard-preconditions.mjs --enrol-signer <public key file>`, SHALL require standard input and output to be terminals, SHALL print the key's fingerprint and a nonce, and SHALL write the two files only after the operator retypes the fingerprint and the nonce. The documentation SHALL state that the signing key must not be readable by an agent (a passphrase-protected key, a hardware key, or an account the agents cannot read) and that the checker cannot test this. The signer fingerprint SHALL be printed in the checker output and written into the release notes.

#### Scenario: Agent-made key
- **WHEN** a key and an allowed-signers file are created inside the repository or given by environment variable or flag
- **THEN** the checker does not use them, and with the variable set it exits 2

#### Scenario: Fingerprint mismatch
- **WHEN** the allowed-signers key's fingerprint differs from the enrolled one
- **THEN** form (b) fails

#### Scenario: Enrolment needs a terminal
- **WHEN** enrolment runs with a pipe on standard input
- **THEN** it exits 2 and writes nothing

#### Scenario: Wrong namespace
- **WHEN** a signature was made in another namespace
- **THEN** form (b) fails

### Requirement: Item B, the operator-run record
The checker SHALL read `feature-op-mvp-07.json` from the per-user state directory's `feature-ops/` folder and SHALL require: the directory and file owned by the current user, the directory mode 0700 and the file mode 0600, neither a symbolic link; `mode` `manual` and `passed` true; `finishedAt` at most 14 days before the check; `treeSha256` equal to T; the recorded sha256 of the installed `main.js`, `manifest.json` and `styles.css` (where present) of each throwaway vault and of the CLI bundle equal to B; every required assertion id present, passed and of the required kind (`machine` or `operator-observed`), where the required ids and kinds are held in the checker and not read from the record; and a `transcriptSha256` equal to the hash of the transcript stored beside the record. A record from `--verify-only` SHALL be refused. The per-user directory SHALL be computed by one function (exported by the checker and used by the recorder and the operator-run script), and a test SHALL require it to equal the CLI's device-store directory for the same environment.

#### Scenario: Simulated run
- **WHEN** the record was produced by the verify-only mode
- **THEN** item B fails

#### Scenario: Result for other code
- **WHEN** the record's `treeSha256` or an installed-file hash differs from the current values
- **THEN** item B fails

#### Scenario: Stale run
- **WHEN** `finishedAt` is older than 14 days
- **THEN** item B fails

#### Scenario: Wrong owner or mode
- **WHEN** the directory is group-writable or owned by another user
- **THEN** item B fails

#### Scenario: Shortened assertion list
- **WHEN** a record omits one required id, or carries it with kind `machine` where `operator-observed` is required
- **THEN** item B fails

#### Scenario: Ids match the spec
- **WHEN** the checker's required list is compared with the ids named in the `release-2` spec and the list exported by the operator-run script
- **THEN** the three are equal

#### Scenario: Path agreement
- **WHEN** the per-user directory is computed for six environment fixtures by the checker's function and by the CLI's
- **THEN** the results are equal in every case

### Requirement: Item C, phone timing or recorded acceptance
The checker SHALL require a record written by `tools/record-phone-timing.mjs` in the per-user `feature-ops/` folder with the same owner and mode checks, which is either `kind: "measured"` with `completed: true`, parameters exactly `m=65536 KiB t=3 p=1`, seconds greater than 0 and under 3, a `longestGapMs` under 100 (thresholds of the mobile-feasibility phase, 2026-10-03, in place of the earlier 600 s bound), the device and OS, `nonceVerified: true`, a `finishedAt` within 14 days, and a `pluginMainJsSha256` equal to B's `main.js` hash; or `kind: "acceptance"` with `nonceVerified: true`, the operator's typed phrase, the date, the statement, a `treeSha256` equal to T, a `pluginMainJsSha256` equal to B's `main.js` hash, and a date within 14 days; or an SSH-signed statement verified against the trust anchor whose text names T8 and the `main.js` hash prefix. The tool SHALL refuse to write a record unless standard input and output are interactive terminals, SHALL print a random nonce, SHALL require the operator to retype it, SHALL take the plugin build hash as the first 16 hex characters shown by the plugin command, check them against the hash of the local `dist/plugin/main.js` (after the stale-`dist/` check) and record the full local hash. The documentation SHALL state that a terminal and a nonce stop pipes and accidents and do not stop a program that drives a pseudo-terminal. The release notes SHALL list the phone timing as unverified when the record is an acceptance.

#### Scenario: Measured
- **WHEN** the record is a completed measurement bound to the current plugin build
- **THEN** item C passes

#### Scenario: Measurement for another build
- **WHEN** `pluginMainJsSha256` differs from B
- **THEN** item C fails

#### Scenario: Not completed
- **WHEN** `completed` is false or missing
- **THEN** item C fails

#### Scenario: Acceptance
- **WHEN** the record is an acceptance written through the interactive step for the current tree and build
- **THEN** item C passes and the release notes list the timing as unverified

#### Scenario: Acceptance for another tree
- **WHEN** an acceptance was written before a source change
- **THEN** its `treeSha256` differs from T and item C fails

#### Scenario: Stale acceptance
- **WHEN** an acceptance is older than 14 days
- **THEN** item C fails

#### Scenario: Wrong hash prefix typed
- **WHEN** the operator types a prefix that is not the start of the local build's hash
- **THEN** the tool writes nothing

#### Scenario: No terminal
- **WHEN** the recorder runs with a pipe on standard input
- **THEN** it exits 2 and writes nothing

### Requirement: Item D, distribution bundles and hooks
The checker SHALL run `checkDistBundles` on the second build and require `missing` and `violations` to be empty, SHALL require every file under `src/crypto/testing/` to carry a sentinel, and SHALL require the documented lint allowlist entry for `tools/feature-op-*.mjs` to be present.

#### Scenario: Sentinel in a bundle
- **WHEN** a built bundle contains a test-only sentinel
- **THEN** the checker fails

#### Scenario: Testing file without sentinel
- **WHEN** a file under `src/crypto/testing/` has no sentinel
- **THEN** the checker fails

### Requirement: Item E, checklist held in the checker
The checker SHALL hold, as constants, the paths and minimum test counts of the checklist test files (covering the mass-removal guard, `prune-history`, the single-read upload source, history-name order, the permissive guard modules, the plaintext-removal refusals, rewrap and accept, and the maintenance-journal cross-tests) and SHALL run them in the clean export with the project's test runner writing its JSON report to a temporary file. It SHALL require every named file to appear in the report with at least its minimum count, every assertion to have status `passed`, and the report's todo and pending counts to be zero (this excludes skipped, todo and `only` tests), and the sha256 of each file to equal the review record's `checklistTests`. The checker SHALL hold the required limit sentences as exact strings (silent per-file corruption of unchanged files by a node writer, concurrent-publish detection, the evidence files are attestations, the defect loop, the floor limits, rewrap does not revoke) and SHALL require README and DESIGN section 8 to contain them, and SHALL record the sha256 of `README.md`, `CHANGELOG.md`, `DESIGN.md` and `docs/operator/encrypted-vault.md` in the evidence it writes. It SHALL run `pnpm audit --prod --json` in the clean export and require every advisory it reports to match an `accepted` finding that carries the advisory id and an acceptance date in the review record; this match is evaluated at check time and is not bound to T. A run that cannot reach the registry SHALL fail.

#### Scenario: Test file weakened
- **WHEN** a named test file differs from its recorded hash
- **THEN** item E fails

#### Scenario: Skipped test
- **WHEN** a named file contains a skipped, todo or `only` test
- **THEN** item E fails

#### Scenario: Fewer tests than required
- **WHEN** a named file runs fewer tests than its minimum
- **THEN** item E fails

#### Scenario: Named file not run
- **WHEN** a named path matches no test file
- **THEN** item E fails

#### Scenario: Shortened checklist in the record
- **WHEN** the review record's `checklistTests` omits a path the checker requires
- **THEN** item E fails

#### Scenario: New advisory
- **WHEN** `pnpm audit --prod` reports an advisory that has no `accepted` finding in the record
- **THEN** item E fails

#### Scenario: Advisory accepted after review
- **WHEN** an advisory appears after the review and the record gains a dated accepted finding for it in a new commit
- **THEN** T is unchanged and item E passes

#### Scenario: Offline
- **WHEN** the registry cannot be reached
- **THEN** item E fails rather than passes

### Requirement: Checker behaviour
`node tools/check-guard-preconditions.mjs` SHALL exit 0 only if T, B and items A to E pass, exit 1 when any check fails (printing each item, its reason and the evidence form found), and exit 2 on a usage or environment error. It SHALL be a single file importing only Node built-ins and `tools/hook-isolation.mjs` (a test scans its imports), SHALL support `--json` for the release tool, `--print-tree-hash [--list]`, `--build` and `--enrol-signer`, and SHALL NOT have an option that skips or weakens an item; `--no-tests` SHALL make the result not a pass. The runbook SHALL require one run of the checker before the operator run (items A, C, D and E can already pass; item B is reported as not present) and SHALL state the route after a later failure: fix the cause, write a new review record for the new tree, run `--build`, repeat the operator run, and repeat the phone measurement only if `main.js` changed.

#### Scenario: All pass
- **WHEN** every item passes
- **THEN** the exit code is 0 and the output lists T, B and the evidence forms

#### Scenario: One fails
- **WHEN** any item fails
- **THEN** the exit code is 1 and the item is named

#### Scenario: No skipping
- **WHEN** `--no-tests` is used
- **THEN** the exit code is not 0

#### Scenario: Early run
- **WHEN** the checker runs before any operator run exists
- **THEN** item B is reported as missing and items A, C, D and E are reported on their own merits

### Requirement: Defect loop
Any change to a scoped file after the review record or after the operator run SHALL change T and SHALL invalidate items A and B (and item C, through B) until a review record for the new tree is written as a new file and the operator run is repeated. This SHALL apply to a defect found by the operator run in 07a or 07b code, to a fix from the review, and to a change of the checker or the tools in scope. The docs SHALL state this and its cost.

#### Scenario: One-line fix after the run
- **WHEN** a scoped file changes after the operator run
- **THEN** the checker fails items A and B and the release is refused until both are redone

### Requirement: Attestations, not proofs
The README, DESIGN section 8, the runbook and the release notes SHALL state that the review record, the operator-run record and the phone-timing record are attestations, not proofs; that the checker makes forging them more work and leaves a trail; and that a person with repository write access and a terminal can still produce all three.

#### Scenario: Documentation
- **WHEN** the README and the release notes are searched
- **THEN** the exact sentence held in the checker appears in each
