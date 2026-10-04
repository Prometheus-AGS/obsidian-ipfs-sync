/**
 * Public surface of the crypto module (mvp-06). Pure and WebView-safe: no Node built-ins, no Obsidian APIs.
 *
 * Primitives: AES-256-GCM, HKDF-SHA256 and HMAC-SHA256 from WebCrypto; Argon2id and SHA-256 from
 * `@noble/hashes` 2.4.0. There is no fallback when `crypto.subtle` is missing (typed `crypto-unavailable`).
 *
 * Stated limits (a reader of this module must not assume more):
 * - Zeroization is best effort. The runtime may have copied the bytes (garbage collector, JIT, the platform
 *   crypto layer), so `wipe` narrows the exposure window and does not guarantee erasure.
 * - A non-extractable CryptoKey stops a caller from reading the key bytes. It does not stop other code running
 *   in the same JavaScript context (another plugin) from using the key object to encrypt or decrypt. Code that
 *   holds a `VaultKeys` can call `fileKey`, `nameKey` and `manifestKey` with the public labels, so it can
 *   derive keys and use them (a derivation oracle); it cannot read the vault content key itself. Keep the object
 *   out of reach of other plugins.
 * - The passphrase dialog holds the passphrase in an interface string, which cannot be zeroed.
 * - An environment variable that carries a passphrase stays readable by the same user's other processes.
 *
 * The test-only helpers in `./testing/` and the injectable ("Internal", "With", "Unchecked") variants of the
 * entry points are deliberately NOT exported here; tools/hook-isolation.mjs enforces where their names may appear.
 */
export {
  DEFAULT_KDF_PARAMS,
  KDF_ALGORITHM,
  KDF_ITERATIONS_CEILING,
  KDF_ITERATIONS_DEFAULT,
  KDF_ITERATIONS_FLOOR,
  KDF_MEMORY_CEILING_KIB,
  KDF_MEMORY_DEFAULT_KIB,
  KDF_MEMORY_FLOOR_KIB,
  KDF_OUTPUT_BYTES,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KDF_VERSION,
  assertKdfParams,
  describeKdfCost,
  exceedsDefaultCost,
  type CostPolicy,
  type KdfParams,
  type KdfProgress,
} from "./argon2";
export {
  BLOB_NAME_BYTES,
  BLOB_NAME_LENGTH,
  BLOB_NAME_PATTERN,
  BLOB_PREFIX_LENGTH,
  BLOB_TREE_ROOT,
  blobMfsPath,
  blobNameFor,
  blobTreePath,
  isBlobName,
  parseBlobName,
} from "./blob-names";
export {
  BLOB_HEADER_BYTES,
  BLOB_MAGIC,
  BLOB_MIN_BYTES,
  BLOB_READER_MAX_EXPONENT,
  BLOB_READER_MIN_EXPONENT,
  BLOB_SEGMENT_OVERHEAD,
  BLOB_VERSION,
  BLOB_WRITER_EXPONENT,
  blobLength,
  createBlobEncryption,
  decryptBlob,
  decryptBlobBytes,
  encryptBlobBytes,
  parseBlobHeader,
  segmentCountFor,
  type BlobDecryptionInput,
  type BlobEncryption,
  type BlobEncryptionParams,
  type BlobHeader,
} from "./blob";
export {
  MANIFEST_ENVELOPE_VERSION,
  MANIFEST_HEADER_BYTES,
  MANIFEST_MAGIC,
  MANIFEST_MAX_FILE_BYTES,
  MANIFEST_MIN_BYTES,
  manifestFileSize,
} from "./manifest-envelope";
export { concatBytes, constantTimeEqual, copyBytes, hasLoneSurrogate, utf8, wipe, type Bytes } from "./bytes";
export { fromBase32Lower, fromBase64, fromHex, toBase32Lower, toBase64, toHex } from "./codec";
export {
  CryptoError,
  KdfCostDowngradeError,
  KdfCostRefusedError,
  KdfParamsError,
  OversizeInputError,
  type CryptoErrorCode,
  type KdfParameterName,
} from "./errors";
export {
  FILE_ID_BYTES,
  LABEL_BLOB_AAD,
  LABEL_FILE_KEY,
  LABEL_MANIFEST_AAD,
  LABEL_MANIFEST_KEY,
  LABEL_NAME_KEY,
  LABEL_SLOT_AAD,
  LABEL_SLOT_COMMIT,
  LABEL_SLOT_WRAP,
  SLOT_ID_BYTES,
  VAULT_ID_BYTES,
  VCK_BYTES,
  type VaultKeys,
} from "./key-derivation";
export {
  KEY_SLOTS_MAX_BYTES,
  KEY_SLOTS_MAX_SLOTS,
  KEY_SLOTS_MAX_TRIED,
  KEY_SLOTS_VERSION,
  isPassphraseSlot,
  parseKeySlots,
  prepareTriedSlots,
  serializeKeySlots,
  type KeySlotsDocument,
  type ParsedKeySlots,
  type PassphraseSlotRecord,
  type PreparedSlot,
  type SlotRecord,
  type UnknownSlotRecord,
} from "./key-slot-format";
export {
  createKeySlots,
  rewrapKeySlots,
  unlockKeySlots,
  unlockKeySlotsBytes,
  type CreateKeySlotsInput,
  type CreatedKeySlots,
  type RewrapInput,
  type RewrapSecret,
  type RewrappedKeySlots,
  type UnlockInput,
  type UnlockedVault,
} from "./key-slots";
export {
  PASSPHRASE_ALPHABET,
  PASSPHRASE_BODY_SYMBOLS,
  PASSPHRASE_CHECK_LABEL,
  PASSPHRASE_CHECK_SYMBOLS,
  PASSPHRASE_GROUP_SIZE,
  PASSPHRASE_INPUT_MAX_BYTES,
  PASSPHRASE_LENGTH,
  PassphraseFormatError,
  assertCanonicalPassphrase,
  canonicalizePassphrase,
  canonicalizePassphraseText,
  formatPassphrase,
  generatePassphrase,
  type CanonicalPassphrase,
  type GeneratedPassphrase,
  type PassphraseFailure,
} from "./passphrase";
