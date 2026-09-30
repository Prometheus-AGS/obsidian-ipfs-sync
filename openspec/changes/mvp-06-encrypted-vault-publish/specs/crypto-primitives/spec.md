## Purpose

Defines the cryptographic building blocks, where they come from, how key material is handled, and the tests that must exist before any of them is used, so that no primitive is hand-rolled, no wrapper silently weakens a standard algorithm, and an unavailable platform primitive stops the operation instead of degrading it.

## ADDED Requirements

### Requirement: Approved primitives only
The crypto module SHALL obtain AES-256-GCM, HKDF-SHA256 and HMAC-SHA256 from the platform WebCrypto implementation, and Argon2id and incremental SHA-256 from the pinned `@noble/hashes` 2.4.0 package. It SHALL NOT contain its own implementation of any cipher, hash, key-derivation function or MAC (a constant-time comparison of two fixed-length byte strings is not a primitive and is allowed). Randomness SHALL come from the platform cryptographically secure generator.

#### Scenario: No hand-rolled primitive
- **WHEN** the crypto source is reviewed
- **THEN** every primitive call resolves to WebCrypto or `@noble/hashes`, and no file implements a block cipher, hash round function or KDF loop

#### Scenario: Pinned dependency
- **WHEN** the dependency manifest is read
- **THEN** `@noble/hashes` is pinned to the exact version 2.4.0 and no other cryptography package is present

### Requirement: Fail closed when WebCrypto is missing
If `crypto.subtle` (or the secure random generator) is unavailable, every operation that needs it SHALL fail with a typed crypto-unavailable error. There SHALL be no fallback implementation, no downgrade to a weaker mode, and no plaintext path.

#### Scenario: Missing subtle crypto
- **WHEN** `crypto.subtle` is undefined
- **THEN** unlock, setup and publish fail with the crypto-unavailable error and send no request

### Requirement: First-use self-test
On the first unlock in each host process, the module SHALL run a small known-answer self-test of HKDF-SHA256 and AES-256-GCM through the same wrappers, and SHALL fail closed with a typed error if either result differs from the expected value.

#### Scenario: Self-test passes
- **WHEN** a vault is unlocked for the first time in a session
- **THEN** the self-test runs once before the passphrase-derived key is used, and passes

#### Scenario: Self-test fails
- **WHEN** a platform returns a wrong HKDF output
- **THEN** unlock fails with a self-test error and no key is used

### Requirement: Runtime neutrality
The crypto module SHALL run unchanged in Node 24 and the Obsidian WebView. It SHALL NOT import Node built-in modules, Obsidian APIs or native modules, and SHALL pass the project's WebView-safety checks. Test-only helpers (the raw-VCK hook, the unexported Argon2id entry that bypasses the parameter floors) SHALL live outside the module's public index, SHALL each carry a unique sentinel string, and SHALL NOT be reachable from the plugin or CLI bundles. The bundles SHALL be checked for the sentinels, the build's dependency metadata SHALL be checked for any input from the test-only folder, and a lint rule SHALL forbid importing that folder from non-test code. Randomness SHALL be injected by parameter and never through a global setter.

#### Scenario: Static check
- **WHEN** the WebView-safety grep and the import probe run over `src/`
- **THEN** they find no Node built-in import in `src/crypto`

#### Scenario: Test hooks not bundled
- **WHEN** the plugin and CLI bundles are searched for the sentinel strings and their dependency metadata is inspected
- **THEN** no sentinel and no test-only input is present

### Requirement: Known-answer tests
Each primitive wrapper SHALL be tested against published vectors, each citing its source in the test file: RFC 5869 appendix A test cases 1 to 3 for HKDF-SHA256, plus the wrapper with empty and with long `info`; RFC 4231 test cases for HMAC-SHA256; the McGrew and Viega AES-GCM test cases 13 to 16 (256-bit keys with 96-bit IVs; cases 17 and 18 use other IV lengths and are excluded) and the NIST `gcmEncryptExtIV256` vectors, including a tag-failure vector; RFC 4648 test vectors for base32 and base64; the RFC 9106 section 5.3 Argon2id vector run through an unexported entry that bypasses the wrapper's parameter floors; and a floor-parameter Argon2id output cross-checked against an independent implementation (the Node platform's own Argon2 if Node 24.15 provides one, otherwise a second published vector set).

#### Scenario: HKDF vectors
- **WHEN** the wrapper derives with the RFC 5869 test case 1 inputs
- **THEN** the output equals the published OKM

#### Scenario: AES-GCM vectors
- **WHEN** a 256-bit-key vector is encrypted with its published nonce and associated data
- **THEN** the ciphertext and tag equal the published values, and decryption with one flipped tag bit fails

#### Scenario: Argon2id vector
- **WHEN** the RFC 9106 Argon2id vector is run through the unexported entry
- **THEN** the tag equals the published one

#### Scenario: Wrapper and floors
- **WHEN** the public wrapper is called with the RFC 9106 parameters
- **THEN** it refuses them as below the floors, proving the vector is not reachable through the public path

### Requirement: Pinned labels and encodings
Fixed-output vectors SHALL pin the name key, manifest key and file key derivations (the labels and salts of the design), the slot commitment derivation with its exact information bytes, the unsigned 32-bit and 64-bit big-endian AAD encodings including a segment index above 2^32, and the canonical passphrase function (separators removed and case folded only for exactly 25 symbols, everything else rejected).

#### Scenario: Test hook honours the commitment
- **WHEN** the test-only key hook is given a slot with a corrupted commitment
- **THEN** it fails, because it calls the same internal function as production unlock

#### Scenario: Label drift
- **WHEN** any derivation label or salt is changed in the code
- **THEN** a fixed-output test fails

### Requirement: Independent reference decryptor
A test-only reference decryptor, written from the specification text using Node's own cryptography module and importing nothing from `src/crypto`, SHALL decrypt blobs, key slots and manifests produced by the module, and SHALL reject the same malformed inputs.

#### Scenario: Cross-implementation
- **WHEN** a blob, a slot and a manifest produced by the module are given to the reference decryptor
- **THEN** it recovers the plaintext and key without importing the module

#### Scenario: AAD component mutation
- **WHEN** each component of the associated data (label, vault identifier, header, node name, segment index, final flag) is mutated in turn on the reference side
- **THEN** decryption fails for every mutation

### Requirement: Non-extractable derived keys
Keys derived from the VCK (file, name and manifest keys) SHALL be created as non-extractable platform keys wherever the platform allows it, and the VCK SHALL be imported as a non-extractable derivation key after unlock. Raw key bytes that must exist briefly (the generated VCK at setup, the KEK during wrapping, the passphrase bytes and their normalised intermediate) SHALL be overwritten as soon as they are no longer needed. The zeroization is best effort; the language runtime may have copied the bytes and the specification SHALL NOT claim otherwise. A non-extractable key does not prevent other code in the same JavaScript context from using the key object, and the specification SHALL say so. In particular, code that holds the session's key set can derive and export the raw file, name and manifest key bytes by running the public derivation with the public labels; non-extractability protects only against exporting the base key object itself, and the base key SHALL NOT be exported from the module's public surface unless a test needs it.

#### Scenario: Session key not extractable
- **WHEN** a vault is unlocked and its session key is inspected
- **THEN** the key object reports that it is not extractable and exports nothing

#### Scenario: Limits documented
- **WHEN** the crypto module's documentation is read
- **THEN** it states that zeroization is best effort, that another plugin in the same context could use the key object, and that the passphrase dialog holds the passphrase as a string that cannot be zeroed

### Requirement: Public entry points take data only
Every public entry point of the crypto module (create key slots, unlock key slots, blob encryption, manifest envelope encryption, cap checks) SHALL accept only data inputs and, where useful, a progress callback. Injectable randomness, injectable key-derivation and self-test functions, exponent overrides, size limits and functions that return raw key bytes SHALL exist only as internal entries that are not exported from the module index, are imported only by tests and the test-only folder, and are restricted by the isolation lint (which SHALL also forbid, outside those files, the identifiers of the internal variants). Passphrases SHALL be accepted only as a branded canonical-passphrase value produced by the canonicalisation or generation functions, and parsed key-slot documents only as a branded value produced by the strict parser or by slot creation; plain byte arrays and structurally typed objects SHALL be refused by the type system and, where reachable at run time, before any derivation.

#### Scenario: No injection through spread options
- **WHEN** a caller passes an options object containing a key-derivation or self-test function to a public entry
- **THEN** the option is not part of the type and is not honoured

#### Scenario: Unbranded input
- **WHEN** an empty byte array, a 24-symbol array or a hyphenated 29-byte display string is passed as the passphrase to slot creation or unlock
- **THEN** it is refused with the `passphrase-format` error before any derivation

#### Scenario: Unparsed document
- **WHEN** a document produced by `JSON.parse` is passed to unlock
- **THEN** it is refused, because only the strict parser can produce the accepted value

### Requirement: Typed fail-closed errors
Every cryptographic failure SHALL raise a typed error from a fixed set — `crypto-unavailable`, `wrong-passphrase-or-damaged-slot`, `kdf-params`, `unsupported-format`, `no-usable-slot`, `passphrase-format`, `malformed`, `authentication`, `oversize-input`, `vault-mismatch`, `platform-failure` — never a raw platform error, and SHALL NOT return unauthenticated plaintext. Only a genuine AES-GCM authentication failure (the platform's operation-error or data-error) SHALL be reported as `authentication`; any other platform failure SHALL be reported as `platform-failure`, so callers can retry instead of quarantining data. `malformed` SHALL be raised only for structurally invalid input (bad magic, unsupported version or exponent, a blob under 50 bytes, a final piece under 28 bytes); every other decryption failure, including damage that cannot be told from tampering, SHALL be `authentication`. Error messages SHALL NOT contain key material, passphrases or plaintext.

#### Scenario: Authentication failure
- **WHEN** a ciphertext with one flipped bit is decrypted
- **THEN** a typed authentication error is raised and no unauthenticated plaintext is returned

#### Scenario: Platform failure
- **WHEN** the platform fails for a reason other than authentication (for example, a resource error)
- **THEN** the error is `platform-failure`, not `authentication`

#### Scenario: Message content
- **WHEN** any typed error is formatted
- **THEN** its text contains no passphrase, key bytes or decrypted content

### Requirement: Randomness quality
Nonces, salts, file identifiers, the VCK, the vault identifier and generated passphrases SHALL each be freshly drawn from the secure generator on every use. No nonce SHALL be derived from a counter or a clock. Generated passphrase characters SHALL be mapped without modulo bias.

#### Scenario: Nonce uniqueness
- **WHEN** 100,000 nonces are drawn by the same function used for segments
- **THEN** all are distinct

#### Scenario: No file-key reuse
- **WHEN** many file encryptions are run and the derived file-key inputs (file identifiers) are collected
- **THEN** no identifier repeats, and a structural test shows every encryption draws a new one

#### Scenario: Same plaintext, different ciphertext
- **WHEN** the same file content is encrypted twice
- **THEN** the two outputs differ in file identifier, every nonce, and every ciphertext segment

### Requirement: Injectable randomness for tests only
Randomness sources SHALL be injectable so tests can produce reproducible outputs. Production entry points SHALL NOT accept an injected source from user or network input, and the default SHALL be the secure generator.

#### Scenario: Reproducible test vector
- **WHEN** a test injects fixed randomness and encrypts a small file
- **THEN** the output equals a recorded regression vector, recorded as a regression check and not as an independent known answer

### Requirement: Test-only raw-key hook
A test-only entry that returns the raw VCK from a passphrase and a slot (needed by the automated feature operation to prove the key is absent from stored bytes) SHALL exist outside the module's public index.

#### Scenario: Hook location
- **WHEN** `src/crypto/index.ts` is read
- **THEN** it does not export the hook
