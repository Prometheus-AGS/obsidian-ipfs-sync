import { ascending, expectLength, hex } from "./bytes";

/**
 * Fixed-output vectors for the vault-key derivations (name key, manifest key, file key), the blob and manifest
 * associated data, and one complete blob and one complete manifest file. The construction is this project's own,
 * so these are REGRESSION PINS, not external known answers. Every value was computed at authoring time with
 * node:crypto (`hkdfSync`, `createHmac`, `createCipheriv("aes-256-gcm")`) from the byte layout in the design and
 * a hand-written base32 encoder, not with the module under test. They fail if a label, a salt (vaultId for the
 * name and manifest keys, the raw fileId for the file key), a field order, or an integer width drifts.
 *
 * Inputs: vaultId = 20..2f, VCK = 50..6f, blob fileId = 70..7f, blob nonce = 80..8b, manifest nonce = 90..9b;
 * path "notes/a.md"; plaintext "hello world\n"; segment exponent 23.
 */
export const PIN_INPUTS = {
  vaultId: expectLength("vaultId", ascending(0x20, 16), 16),
  vck: expectLength("vck", ascending(0x50, 32), 32),
  fileId: expectLength("fileId", ascending(0x70, 16), 16),
  blobNonce: expectLength("blobNonce", ascending(0x80, 12), 12),
  manifestNonce: expectLength("manifestNonce", ascending(0x90, 12), 12),
  path: "notes/a.md",
  plaintext: "hello world\n",
} as const;

export const NAME_PINS = {
  /** HKDF-SHA256(salt = vaultId, IKM = VCK, info = "ipfs-sync/name/v1", L = 32). Not extractable in the module: pinned through the MAC. */
  nameKey: expectLength("nameKey", hex("134adf471ec1835f492d39f71c69ddc7d41ff128c0bf95335dd62998b4f40d48"), 32),
  /** HMAC-SHA256(nameKey, "notes/a.md"). */
  nameBytes: expectLength("nameBytes", hex("a3013aba2ea015b4b981354f89068df4c3e593d1a80f75d17bbad22fc5ac902c"), 32),
  /** Lowercase base32, no padding, of nameBytes: 52 characters. */
  name: "umatvorouak3jombgvhysbun6tb6le6rvahxlul3xljc7rnmsawa",
} as const;

export const BLOB_PINS = {
  /** HKDF-SHA256(salt = raw fileId, IKM = VCK, info = "ipfs-sync/file/v1", L = 32). Pinned through the blob ciphertext. */
  fileKey: expectLength("fileKey", hex("53802db82d29f421eab10a1f482142fa38475cb3137ec056263add36f51a49ea"), 32),
  /** "ISBL" | 0x01 | 0x17 | fileId, 22 bytes. */
  header: expectLength("blob header", hex("4953424c0117707172737475767778797a7b7c7d7e7f"), 22),
  /** "ipfs-sync/blob/v1" | vaultId | header | nameBytes | u64(0) | 0x01 (single final segment). */
  aad: expectLength(
    "blob aad",
    hex(
      "697066732d73796e632f626c6f622f7631202122232425262728292a2b2c2d2e2f" +
        "4953424c0117707172737475767778797a7b7c7d7e7f" +
        "a3013aba2ea015b4b981354f89068df4c3e593d1a80f75d17bbad22fc5ac902c000000000000000001",
    ),
    17 + 16 + 22 + 32 + 8 + 1,
  ),
  /** header | nonce | ciphertext | tag, 62 bytes = 22 + 28 + 12. */
  blob: expectLength(
    "blob",
    hex(
      "4953424c0117707172737475767778797a7b7c7d7e7f" +
        "808182838485868788898a8b" +
        "1c0d99cd2fecbe206b24ae750c753559f64bdc1086798a72ca7a8e45",
    ),
    62,
  ),
} as const;

export const MANIFEST_PINS = {
  /** HKDF-SHA256(salt = vaultId, IKM = VCK, info = "ipfs-sync/manifest/v1", L = 32). Pinned through the envelope ciphertext. */
  manifestKey: expectLength("manifestKey", hex("afebbad6a89ab365fb46429531eb6fc8868d17e010445a125d22cfbd83d87c4c"), 32),
  /** "ISMF" | 0x02 | nonce, 17 bytes. */
  header: expectLength("manifest header", hex("49534d4602909192939495969798999a9b"), 17),
  /** "ipfs-sync/manifest/v1" | vaultId | header, 21 + 16 + 17 = 54 bytes. */
  aad: expectLength(
    "manifest aad",
    hex("697066732d73796e632f6d616e69666573742f7631202122232425262728292a2b2c2d2e2f49534d4602909192939495969798999a9b"),
    54,
  ),
  /** Plaintext bytes sealed below: {"files":{},"version":2} */
  plaintext: expectLength("manifest plaintext", hex("7b2266696c6573223a7b7d2c2276657273696f6e223a327d"), 24),
  /** header | ciphertext | tag. */
  file: expectLength(
    "manifest file",
    hex("49534d4602909192939495969798999a9bb21611ef37595427b43c941ca0b3f279743d2ff5ebb5fdfaa7ddb10ba36a89342939ef7710fb313a"),
    57,
  ),
} as const;

/**
 * Blob associated data with a segment index above 2^32, computed with node:crypto's `writeBigUInt64BE` (not the
 * module): "ipfs-sync/blob/v1" | vaultId | header | nameBytes | u64(index) | final flag, for the inputs above.
 */
export const AAD_INDEX_PINS = [
  {
    index: 4_294_967_301,
    final: false,
    u64: "0000000100000005",
    aad: "697066732d73796e632f626c6f622f7631202122232425262728292a2b2c2d2e2f4953424c0117707172737475767778797a7b7c7d7e7fa3013aba2ea015b4b981354f89068df4c3e593d1a80f75d17bbad22fc5ac902c000000010000000500",
  },
  {
    index: 4_294_967_301,
    final: true,
    u64: "0000000100000005",
    aad: "697066732d73796e632f626c6f622f7631202122232425262728292a2b2c2d2e2f4953424c0117707172737475767778797a7b7c7d7e7fa3013aba2ea015b4b981354f89068df4c3e593d1a80f75d17bbad22fc5ac902c000000010000000501",
  },
  {
    index: 9_007_199_254_740_991,
    final: false,
    u64: "001fffffffffffff",
    aad: "697066732d73796e632f626c6f622f7631202122232425262728292a2b2c2d2e2f4953424c0117707172737475767778797a7b7c7d7e7fa3013aba2ea015b4b981354f89068df4c3e593d1a80f75d17bbad22fc5ac902c001fffffffffffff00",
  },
] as const;
