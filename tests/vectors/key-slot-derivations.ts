import { ascending, expectLength, hex } from "./bytes";

/**
 * Fixed-output vectors for the key-slot derivations (design decision 1 and 2). The construction is this project's
 * own, so there is no external known answer: these are REGRESSION PINS. Each value was computed at authoring time
 * with node:crypto (`hkdfSync`, `createCipheriv("aes-256-gcm")`) from the byte layout in the design, not with
 * the module under test. They fail if a label, a salt, the field order or an integer width drifts.
 *
 * Inputs: KEK = 00..1f, vaultId = 20..2f, slotId = 30..3f, salt = 40..4f, VCK = 50..6f, wrap nonce = 60..6b,
 * Argon2id parameters m = 65,536 KiB, t = 3, p = 1 (version 19, output length 32).
 */
export const SLOT_INPUTS = {
  kek: expectLength("kek", ascending(0x00, 32), 32),
  vaultId: expectLength("vaultId", ascending(0x20, 16), 16),
  slotId: expectLength("slotId", ascending(0x30, 16), 16),
  salt: expectLength("salt", ascending(0x40, 16), 16),
  vck: expectLength("vck", ascending(0x50, 32), 32),
  nonce: expectLength("nonce", ascending(0x60, 12), 12),
  params: { m: 65_536, t: 3, p: 1 },
} as const;

export const SLOT_PINS = {
  /** "ipfs-sync/slot/commit/v1" || slotId || u32(19) || u32(m) || u32(t) || u32(p) || u32(32) || salt, 76 bytes. */
  commitInfo: expectLength(
    "commitInfo",
    hex("697066732d73796e632f736c6f742f636f6d6d69742f7631303132333435363738393a3b3c3d3e3f0000001300010000000000030000000100000020404142434445464748494a4b4c4d4e4f"),
    76,
  ),
  /** HKDF-SHA256(salt = vaultId, IKM = KEK, info = commitInfo, L = 32). */
  commitment: expectLength("commitment", hex("39e5a9ca8d8bf64ab945b58d4198b020eb9a21c827833746f00ea769366de5b2"), 32),
  /** HKDF-SHA256(salt = vaultId, IKM = KEK, info = "ipfs-sync/slot/wrap/v1", L = 32). */
  wrapKey: expectLength("wrapKey", hex("5cd3f85a0e57828fea3f10023dc3f5c800f6e4602a344ec4eb18aa321fdd8582"), 32),
  /** "ipfs-sync/slot/v1" || vaultId || slotId || u32(19) || u32(m) || u32(t) || u32(p) || u32(32) || salt || "argon2id" || 0x00 || "aes-256-gcm", 105 bytes. */
  aad: expectLength(
    "slot aad",
    hex(
      "697066732d73796e632f736c6f742f7631202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" +
        "0000001300010000000000030000000100000020404142434445464748494a4b4c4d4e4f6172676f6e326964006165732d3235362d67636d",
    ),
    105,
  ),
  /** AES-256-GCM(wrapKey, nonce, VCK, aad) = ciphertext (32) || tag (16). */
  wrapped: expectLength(
    "wrapped",
    hex("eaa726728475cd90a2d958faa577e0fd03c2eb6b257b565697002a4499da2edc7f7682583476d9eed42515c90fc14fdc"),
    48,
  ),
} as const;
