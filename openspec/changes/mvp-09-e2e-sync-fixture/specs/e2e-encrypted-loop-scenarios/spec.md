## Purpose

Defines the behavior scenarios the E2E fixture proves against the live node by driving the real built CLI as child processes: the encrypted publish → resolve → pull → conflict loop, the wrong-passphrase refusal, the tampered-segment integrity failure, and the proof that the device-local history recorder recorded the loop. Scenario assertions are the ported policies, not new ones: conflict naming per `src/sync/conflict-name.ts`, the unlock error per `src/crypto/key-slots.ts`, the tamper outcome per the mvp-07/07a feature operations.

## ADDED Requirements

### Requirement: Encrypted publish → resolve → pull
The suite SHALL drive, through the real CLI, a fixture vault on device A through `init --passphrase-file` and `publish` (sequence 1), SHALL assert that `name/resolve` of `obsidian-vault-e2e` returns the published root CID, and SHALL pull into an empty device B with `--accept-first-pull --expect-vault-id --expect-min-sequence 1`. Every published file SHALL arrive with content byte-equal to A's, and the pull SHALL report no conflicts and no failures. No request path, query or body and no child output SHALL carry fixture plaintext or a passphrase spelling (needle scan).

#### Scenario: First publish resolves by name
- **WHEN** device A's publish exits 0 with sequence 1 and a root CID
- **THEN** `name/resolve` of `obsidian-vault-e2e` returns that root CID

#### Scenario: Second device reproduces the vault
- **WHEN** device B pulls A's publish
- **THEN** every published file is fetched with byte-equal content, the pulled root equals A's published root, and the pull's proxy-log slice holds reads only

#### Scenario: Nothing readable crosses the wire
- **WHEN** the publish and pull complete
- **THEN** the needle scan of all request bodies and all child output finds no fixture path, title, body line or passphrase spelling

### Requirement: Pull conflict policy on the live node
The suite SHALL exercise the ported conflict policy: with B holding a local edit to a shared note (never published), A edits the same note and publishes (sequence 2); `name/resolve` returns the new root; B pulls. B's note SHALL hold the remote content afterwards; B's local edit SHALL survive next to it as `<stem> (ipfs conflict YYYY-MM-DD).<ext>` (dated the pull day); no local file SHALL be deleted; untouched files SHALL NOT be rewritten.

#### Scenario: Remote wins, local kept as dated copy
- **WHEN** B pulls a publish that changes a note B edited locally
- **THEN** the note holds the remote content, a `name (ipfs conflict <date>)` copy holds B's edit, and no vault file was deleted

#### Scenario: Untouched files not rewritten
- **WHEN** the conflict pull completes
- **THEN** files outside the conflict keep their pre-pull content and modification times

### Requirement: History recorder proven in the loop
After the conflict pull, the suite SHALL prove once — with a fresh CLI process against device B's per-run state directory, after the publish and pull children have exited — that `ipfs-sync history` lists the pull (with a conflicted count of at least 1) and the conflict record, read from the on-disk database.

#### Scenario: Fresh process reads the run's history
- **WHEN** a new CLI child runs `history` for device B after the conflict pull
- **THEN** its output lists the pull row (conflicted >= 1) and the conflict record, and the proxy log shows no request during the history run

### Requirement: Wrong passphrase fails closed
A fresh device pulling with a wrong passphrase SHALL exit nonzero with the unlock error (`wrong passphrase or damaged key slot`) on stderr, and nothing SHALL change on disk: no pulled vault file, no `.ipfs-sync` state, no sequence floor. No mutation SHALL reach the node during the attempt.

#### Scenario: Wrong passphrase changes nothing
- **WHEN** device C pulls the published root with a passphrase that is not the vault's
- **THEN** the pull exits nonzero naming the unlock failure, C's vault holds no pulled file, no `.ipfs-sync` state and no sequence floor, and the attempt's proxy-log slice holds no mutation

### Requirement: Tampered segment fails closed per file
The suite SHALL prepare a tampered copy of the genuine root through the `prepare-tamper` hostile op in its complete-tree mode (every blob of the genuine tree copied into the tamper tree, exactly one blob with one flipped bit, a new authentic `manifest.enc` at a higher sequence, built with the vault's own passphrase via the test-only unwrap hook), with every preparer write a `files/write` or `files/mkdir` confined to `<runRoot>/tamper`. A fresh device pulling the tampered root with `--root-cid` SHALL exit 1, report the tampered file `integrity-failed`, leave that file absent with no `.ipfs-sync/tmp/` leftovers, and fetch every other file (counts: N-1 fetched, 0 unchanged, 0 conflicts, 1 integrity-failed).

#### Scenario: One flipped bit fails one file
- **WHEN** a fresh device pulls the tampered root
- **THEN** the pull exits 1 with `integrity-failed <path>` on stderr, the tampered file is absent, every other file was fetched (N-1 fetched, 0 unchanged, 0 conflicts, 1 integrity-failed), and no temporary file remains

#### Scenario: The hostile object stays confined
- **WHEN** the preparer runs
- **THEN** the proxy log shows every preparer write was a `files/write` or `files/mkdir` inside `<runRoot>/tamper` and nothing else was mutated
