## Purpose

States what the encryption protects, what it deliberately does not, and what an operator of the open-write node can and cannot do to a published vault, so users and reviewers judge the feature by its real guarantees and not by wording that outruns the implementation.

## Non-goals

- Hiding the number of files, the exact size of each file (blob length equals plaintext length plus a fixed overhead, and padding is not implemented), when and how often a vault is published, which encrypted files change, the IPNS/DHT access pattern, or the existence of the vault.
- Preventing an open-write node from serving an older valid root (rollback) or withholding updates (freeze). Nothing on the read side enforces the sequence in this change.
- Protecting a device whose memory, environment or files are compromised, or other code running in the same application context.
- Forward secrecy and revocation: the VCK never rotates in this change, a passphrase change does not revoke old passphrases or old copies of the key slot, and a leaked passphrase exposes every state ever published, including states kept in old pinned roots.
- Deleting history: removing a note removes its blob from the current tree; earlier roots stay pinned on the node.
- Recovery of a lost passphrase or lost key slots.
- Device-to-device pairing, passphrase change, additional key slots and multi-writer merge (later changes).
- Private swarms, relays, or hiding network addresses.
- Treating the fixture marker as protection: it is an accident guard that anyone who can create a file can defeat.
- User-chosen passphrases: deferred. They would need an algorithmic repetition rule, Unicode-category character classes, a leet-folded blocklist and a separate explicit acknowledgement flag, and are not offered in this change.
- Encrypting or hiding the local state and journal: they are plaintext in `.ipfs-sync/`.

## ADDED Requirements

### Requirement: What the node operator can and cannot do
The documentation SHALL state that an operator or any other writer of the node CAN: read every ciphertext, the key slots, the number of blobs and their exact sizes (so a file of a known length is recognisable), and the timing of publishes; see which encrypted blob names are rewritten and when; delete, corrupt, replace, withhold or add any object; replay any genuine older object (an old blob, an old manifest, an old key-slot file, an old root), because a genuine old object authenticates; serve an older valid root; and attack the passphrase offline using the public key slot at the cost of the key-derivation function, until the passphrase is guessed. It SHALL state that such an operator CANNOT, without the passphrase and short of guessing it: read file names, paths, contents or the manifest; create new content that authenticates under the vault key; learn the vault key from the stored data; or make a publisher encrypt under a different vault key without the key-slot comparison, commitment or authentication checks refusing it. It SHALL state that authentication covers the contents of blobs and manifests and does not cover deletion, missing objects, extra files or the unauthenticated parts of the layout (the key-slot file is checked against the local copy and its own authentication, and directory names are not authenticated). It SHALL also state that the publisher cannot detect silent per-file corruption of unchanged files by a node writer: untouched blobs are not re-verified, so a replaced blob is only noticed by a reader that decrypts it. It SHALL state that moving a blob between paths or replaying an old blob is detected only by a reader that applies the reader requirements, which this change specifies and tests at the crypto layer and which the pull engine applies from the next change.

#### Scenario: Documentation content
- **WHEN** DESIGN.md section 8 and the README are read
- **THEN** each of the CAN and CANNOT statements above appears, together with the non-goals

### Requirement: Real notes are refused before verification
Until the encrypted pull change removes the guard after independent review, an in-Obsidian run and a phone timing of the key derivation (or an explicit, informed operator acceptance), this tool SHALL refuse to publish a vault lacking a marker of value `fixture`, in the CLI and the plugin. The documentation SHALL say that anyone who can create the marker file can override this, and that encryption is implemented but not yet independently reviewed or verified in Obsidian.

#### Scenario: Documentation
- **WHEN** DESIGN.md section 8 and the README are read
- **THEN** they state that until the guard is removed the tool refuses unmarked vaults, and that the marker can be created by anyone

#### Scenario: Enforcement
- **WHEN** a publish is attempted on a vault without the marker
- **THEN** no request reaches the node

### Requirement: Offline guessing is the residual risk
The documentation and the setup interface SHALL state that anyone who obtains the root CID can fetch the public key slot and test passphrase guesses offline, permanently, that passphrases are generated (115 random bits plus a 10-bit typo check) for that reason, and that a passphrase change or slot rewrap does not revoke old passphrases or old copies of the slot.

#### Scenario: Setup hint
- **WHEN** the setup interface shows the strength hint
- **THEN** it says the key slot is public and guessable offline and that the passphrase is generated for that reason

#### Scenario: Rewrap statement
- **WHEN** the threat-model text is read
- **THEN** it states that only re-encrypting under a new vault key revokes access, and that this is not provided

### Requirement: What the publisher does and does not verify
The documentation SHALL state that the publisher pins whatever is in `current/` at the time of the snapshot (including an object planted during the write window) unless the read-back detects it, that untouched blobs are not re-verified on each publish, that objects on the node are encrypted at rest while local state and journal files are plaintext and must be excluded from third-party sync and backups, and that a dropped connection during a write can leave a truncated blob under the MFS root which the next publish diagnoses.

#### Scenario: Documentation content
- **WHEN** DESIGN.md section 8 and the README are read
- **THEN** each of these statements appears

### Requirement: Generation-only is a guard, not a proof
The documentation SHALL state that the passphrase check makes about 1 in 1,024 arbitrary 25-symbol strings valid by chance, that it therefore catches a mistyped body symbol with probability about 99.9% (and a mistyped check symbol always), never "every typo", and that requiring the generated form guards against typos and accidents and does not prove that the user did not choose or grind the text.

#### Scenario: Documentation
- **WHEN** the README section on passphrases is read
- **THEN** it states this limit

### Requirement: Error classes are stated
The documentation SHALL state that only genuine authentication failures are reported as authentication errors (which callers treat as tampering) and that other platform failures are reported separately so they can be retried.

#### Scenario: Documentation content
- **WHEN** DESIGN.md section 8 is read
- **THEN** it lists the error classes and their meaning

### Requirement: Transport buffering in the plugin is stated
The documentation SHALL state that the Obsidian request transport buffers whole response bodies, so the streaming caps and one-segment memory bounds give no memory protection inside the plugin for what the transport itself has already buffered; Range requests reduce the exposure only against gateways that honour them.

#### Scenario: Documentation content
- **WHEN** DESIGN.md section 8 is read
- **THEN** this limit is listed

### Requirement: Client-side limits are stated
The documentation SHALL state that a non-extractable key object does not stop other code in the same application context from using it (code holding the session's key set can derive and exfiltrate raw file, name and manifest key bytes using the public labels; non-extractability protects only against exporting the base key object), that the passphrase dialog holds the passphrase in a string that cannot be zeroed, that the environment variable is readable by the user's other processes, and that zeroization is best effort.

#### Scenario: Documentation content
- **WHEN** the README section on passphrase handling is read
- **THEN** each of these limits is listed

### Requirement: Observable properties are tested
The properties the specification claims about the node's view SHALL be checked by an automated operation against the shared node using only read-only requests, plus refusal checks against local fixtures: no plaintext title, path or body word appears in any listing, blob, manifest or key-slot file; blobs begin with the format magic and have near-random byte distribution; the key-slot file contains no key material and the vault key does not occur in any stored byte; a second publish after one edit rewrites exactly one blob and increases the sequence; a publish killed after the manifest write resumes without a refusal; hostile objects (oversize key slots, oversize manifests, a modified key commitment, a substituted key-slot file, a `pulled-fixture` marker) are refused, using local fixtures and never by writing hostile objects to the shared node; and only the run's demo root and the owned key changed on the node.

#### Scenario: Feature operation
- **WHEN** the feature operation script runs
- **THEN** each of these checks is printed with its observed result and any failure makes the script exit nonzero

### Requirement: Stated limits stay visible
Where a limit cannot be enforced or verified (mobile timing of the key derivation, zeroization, rollback prevention, the plugin's in-app passphrase flow before its operator run, plugin transport of large binary bodies), the release documentation and the completion report SHALL list it as unverified or unenforced instead of omitting it.

#### Scenario: Unverified list
- **WHEN** the completion report for this change is read
- **THEN** it lists phone Argon2id timing at the default cost, in-app plugin passphrase UX, zeroization and rollback prevention as unverified or unenforced
