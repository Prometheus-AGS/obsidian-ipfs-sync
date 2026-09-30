## Purpose

Defines how one vault file becomes one opaque blob on the node, so that content and names are hidden and truncation, reordering, splicing or substitution of segments and blobs is detected by any reader that follows the reader requirements.

## ADDED Requirements

### Requirement: Blob layout
Each encrypted file SHALL be one blob: a 22-byte header followed by one or more segments. The header SHALL contain the 4-byte magic `ISBL` (bytes 0x49 0x53 0x42 0x4C), a 1-byte format version (1), a 1-byte segment-size exponent, and the 16-byte random file identifier. Each segment SHALL be a 12-byte random nonce, the ciphertext and a 16-byte authentication tag. Every segment except the last SHALL hold exactly 2^exponent plaintext bytes (8 MiB for exponent 23, which writers always use); the final segment SHALL hold 1 to 2^exponent plaintext bytes, except that an empty file SHALL be a single 28-byte segment with empty plaintext. A reader SHALL accept exponents 16 to 24 and SHALL refuse any other exponent, any other version and any other magic before decrypting. A reader SHALL refuse a blob shorter than 50 bytes (22 + 28), a final piece shorter than 28 bytes, and any blob whose length is not consistent with segments of the declared size. The error classes SHALL be: a bad magic raises `malformed`; a version or exponent out of range raises `unsupported-format`; a blob shorter than 50 bytes, a final piece shorter than 28 bytes, and a 28-byte final piece that follows other segments (an empty final segment is only valid for an empty file) raise `malformed`; every other failure, including trailing bytes, a short or empty non-final segment, and any authentication failure, SHALL raise the `authentication` error, because those inputs cannot be told apart from tampering. The split between `malformed` and `authentication` is two-sided and is not itself evidence of a particular fault.

#### Scenario: Size arithmetic
- **WHEN** a file of 20 MiB is encrypted
- **THEN** the blob has 3 segments and its length is 22 plus 3 x 28 plus 20 MiB bytes

#### Scenario: Empty file
- **WHEN** an empty file is encrypted
- **THEN** the blob is 22 + 28 bytes and decrypts to an empty file

#### Scenario: Unknown version or exponent
- **WHEN** the version byte is 2 or the exponent is 15
- **THEN** decryption fails with the unsupported-format error before any key derivation

#### Scenario: Malformed structure
- **WHEN** a blob has bad magic, is under 50 bytes, or has a final piece under 28 bytes
- **THEN** decryption fails with the `malformed` error and returns no plaintext

#### Scenario: Empty final piece after other segments
- **WHEN** a multi-segment blob ends with an additional 28-byte final piece
- **THEN** decryption fails with the `malformed` error and returns no plaintext

#### Scenario: Bad magic and unknown exponent
- **WHEN** the magic is wrong, and separately when the exponent is 15
- **THEN** the first raises `malformed` and the second raises `unsupported-format`

#### Scenario: Structurally indistinguishable damage
- **WHEN** a blob has trailing garbage, a short non-final segment or a zero-length non-final segment
- **THEN** decryption fails closed with a typed error and returns no plaintext

#### Scenario: Truncation at every boundary
- **WHEN** a valid blob is cut at every byte position in turn
- **THEN** every truncation fails to decrypt

### Requirement: Per-file key
The key for a blob SHALL be derived with HKDF-SHA256 (32 bytes of output) from the VCK with the raw 16 bytes of the file identifier as salt and the label `ipfs-sync/file/v1` as info, and SHALL be a non-extractable AES-256-GCM key used with a 128-bit tag and a 12-byte nonce exactly. Every encryption of a file, including a rewrite of unchanged content, SHALL use a newly generated file identifier.

#### Scenario: Rewrite gets a new identity
- **WHEN** the same file is encrypted twice
- **THEN** the two blobs have different file identifiers and different keys

### Requirement: Segment authentication
Every segment SHALL be encrypted with AES-256-GCM under a fresh random 96-bit nonce, with associated data made of: the label `ipfs-sync/blob/v1`, the raw 16 bytes of the `vaultId`, the complete 22-byte header, the raw 32-byte HMAC value that names the blob on the node (a reader SHALL first decode the canonical base32 name to these 32 bytes), the segment index as an unsigned 64-bit big-endian integer, and a final-segment flag byte (1 for the last segment, 0 otherwise). Decryption SHALL recompute the associated data from the position of the segment within the blob and from the expected node name, never from data supplied inside the segment.

#### Scenario: Truncation
- **WHEN** the last segment of a multi-segment blob is removed
- **THEN** decryption fails, because the new last segment was authenticated as not final

#### Scenario: Extension
- **WHEN** a valid segment from another position is appended
- **THEN** decryption fails

#### Scenario: Reorder or duplicate
- **WHEN** two segments are swapped, or one segment is repeated
- **THEN** decryption fails

#### Scenario: Splice from another blob
- **WHEN** a segment of the same size is taken from a different file or vault
- **THEN** decryption fails

#### Scenario: Blob moved to another name
- **WHEN** a valid blob is decrypted under the node name of a different path
- **THEN** decryption fails, because the name is part of the associated data

#### Scenario: Old blob replayed under its own name
- **WHEN** an earlier genuine version of the same file's blob is decrypted under the same name
- **THEN** decryption succeeds (it is authentic), and the reader requirements below catch it by comparing the file identifier and hash with the manifest

### Requirement: Streaming decryption contract
Decryption of a blob SHALL be exposed as an iterator that yields a segment's plaintext only after that segment has authenticated. Because a reader must know which segment is the final one, it SHALL be given the blob's total length (from `files/stat` or the equivalent) before decrypting the first segment. The consumer SHALL treat the file as untrusted until the iterator has completed with the final segment, and SHALL write it to a temporary file and move it into place only after completion. A failure at any segment SHALL be reported for the file as a whole.

#### Scenario: Failure after earlier segments
- **WHEN** the third segment of a blob fails to authenticate
- **THEN** the iterator raises the authentication error after yielding the authenticated first two segments, and the consumer discards its temporary file

### Requirement: Decryption is bound to the manifest entry
The public decryption entry point SHALL require the expected file identifier and the expected plaintext size from the manifest entry, SHALL check the header's file identifier against the former, and SHALL require the supplied total blob length to equal the length computed from the expected size and the header's exponent, checked after the header is parsed. Decrypting without those expectations SHALL be possible only through a test-only entry.

#### Scenario: Old genuine blob replayed
- **WHEN** an authentic older blob of the same path is decrypted with the newer entry's file identifier
- **THEN** decryption fails before any segment is decrypted

#### Scenario: Wrong total length
- **WHEN** the supplied total length does not equal the computed blob length
- **THEN** decryption fails before any segment is decrypted

#### Scenario: Expectations required
- **WHEN** the public entry is called without the expected identifier or size
- **THEN** it does not type-check or is refused

### Requirement: Any bit flip fails
Flipping any single bit of a blob (header, nonce, ciphertext or tag) SHALL cause decryption to fail with a typed error.

#### Scenario: Exhaustive small blob
- **WHEN** every bit of a single-segment blob of 100 plaintext bytes is flipped in turn
- **THEN** every variant fails to decrypt

#### Scenario: Sampled large blob
- **WHEN** one bit in every 4 KiB region and every header, nonce and tag bit of a three-segment blob is flipped in turn
- **THEN** every variant fails to decrypt

### Requirement: Wrong context fails
A blob SHALL fail to decrypt under a different `vaultId`, a different VCK, or a header whose file identifier has been altered.

#### Scenario: Other vault
- **WHEN** a blob from vault A is decrypted with the keys of vault B
- **THEN** decryption fails

### Requirement: Reader requirements
Any reader that accepts a blob as a vault file SHALL: take the file tree from the authenticated manifest's `rootCID`; require the blob header's file identifier to equal the manifest entry's `fileId`; require the decrypted size and sha256 to equal the manifest entry's `size` and `sha256`; require the blob name to equal the name recomputed from the path; and treat a manifest history file `manifests/<x>.enc` as valid only if its inner `rootCID` equals `<x>`. This change specifies and tests these requirements at the crypto layer with a reference reader; enforcement in the pull engine arrives with encrypted pull.

#### Scenario: Blob swapped between paths
- **WHEN** the blob of path A is presented for path B
- **THEN** the reference reader rejects it (name, file identifier and hash checks)

#### Scenario: Old blob replayed
- **WHEN** an older genuine blob is presented for a path whose manifest lists a newer file identifier
- **THEN** the reference reader rejects it

#### Scenario: History file renamed
- **WHEN** `manifests/<x>.enc` holds a manifest whose inner `rootCID` is not `<x>`
- **THEN** the reference reader rejects it

### Requirement: Opaque node names
A file's node path SHALL be `current/<p>/<n>` where `n` is the lowercase RFC 4648 base32 encoding, without padding, of the 32-byte HMAC-SHA256 over the UTF-8 vault path keyed by a name key derived with HKDF-SHA256 (32 bytes of output) from the VCK with the raw 16 bytes of the `vaultId` as salt and the label `ipfs-sync/name/v1`, and `p` is the first two characters of `n`. The 52nd character SHALL carry zero in its four unused bits, and a name SHALL be compared by string equality with the recomputed name. The plaintext path SHALL NOT appear in any node path, request URL, request body or stored object; it exists only in the encrypted manifest and in local state. Two different vault paths SHALL map to different names.

#### Scenario: Name shape
- **WHEN** a vault path is mapped
- **THEN** the node path matches `current/[a-z2-7]{2}/[a-z2-7]{52}` and its directory equals the first two characters of the name

#### Scenario: Determinism per vault
- **WHEN** the same vault path is mapped twice with the same keys
- **THEN** the same name results, so a changed file overwrites its own blob

#### Scenario: Different vaults
- **WHEN** the same vault path is mapped in two vaults
- **THEN** the names differ

#### Scenario: Non-canonical name
- **WHEN** a name differs from the recomputed one only in the unused bits of its last character
- **THEN** it is rejected

#### Scenario: No plaintext on the wire
- **WHEN** a publish of a vault with a note titled `Quarterly plan.md` runs against a recording node
- **THEN** no recorded request URL or body contains `Quarterly plan`

### Requirement: Path bytes are used as given
The vault path SHALL be encoded as UTF-8 exactly as the host reports it, without Unicode normalisation, so that the name for a given path is a function of those bytes only.

#### Scenario: Rename
- **WHEN** a file is renamed
- **THEN** its blob is re-encrypted under the new node name, because the name is bound into the associated data, and the old blob is removed

#### Scenario: Different normalisation forms
- **WHEN** a path is given in composed and in decomposed Unicode form
- **THEN** two different names result, and the limitation is documented

### Requirement: Sizes are exact and padding is reserved
Blob length SHALL equal 22 + 28n + plaintext length, exactly, and the specification SHALL state that this exposes each file's exact size. Blob padding is reserved as a possible later format version and is not implemented.

#### Scenario: Documentation
- **WHEN** the threat-model text is read
- **THEN** it states that exact plaintext sizes can be derived from blob sizes
