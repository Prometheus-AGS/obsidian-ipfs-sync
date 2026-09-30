import type { Bytes } from "./bytes";
import { utf8 } from "./bytes";
import { toHex } from "./codec";
import { invalidArgument } from "./errors";
import { deriveAesGcmKey, deriveHmacKey, importHkdfKey } from "./hkdf";

/*
 * Labels, salts and derived keys of the key hierarchy (design decision 1). Identifiers used as HKDF salts or in
 * associated data are the RAW 16 bytes (hex-decoded) of vaultId, slotId and fileId, never their 32 hex characters.
 * The labels are part of the frozen format: a fixed-output test pins each derivation.
 */
export const LABEL_SLOT_AAD = "ipfs-sync/slot/v1";
export const LABEL_SLOT_WRAP = "ipfs-sync/slot/wrap/v1";
export const LABEL_SLOT_COMMIT = "ipfs-sync/slot/commit/v1";
export const LABEL_NAME_KEY = "ipfs-sync/name/v1";
export const LABEL_MANIFEST_KEY = "ipfs-sync/manifest/v1";
export const LABEL_FILE_KEY = "ipfs-sync/file/v1";
export const LABEL_BLOB_AAD = "ipfs-sync/blob/v1";
/** The manifest associated data uses the same text as the manifest key label. */
export const LABEL_MANIFEST_AAD = LABEL_MANIFEST_KEY;

export const VAULT_ID_BYTES = 16;
export const FILE_ID_BYTES = 16;
export const SLOT_ID_BYTES = 16;
export const VCK_BYTES = 32;

/**
 * The unlocked vault. The vault content key is held only as a non-extractable HKDF base key; every other key
 * is derived from it on demand and is also non-extractable. The VCK key is NOT part of this interface. Non-extractable
 * is nominal against code that holds a `VaultKeys`: it can call these methods, and `fileKey` with a chosen
 * identifier is a derivation oracle over the public labels. Keep the object out of reach of other plugins.
 */
export interface VaultKeys {
  /** Public vault identifier, 32 lowercase hex characters. */
  readonly vaultId: string;
  /** The raw 16 identifier bytes (a copy). */
  readonly vaultIdBytes: Bytes;
  /** HMAC-SHA256 key for opaque node names (salt: vaultId; info: `ipfs-sync/name/v1`). Memoised. */
  nameKey(): Promise<CryptoKey>;
  /** AES-256-GCM key for `manifest.enc` (salt: vaultId; info: `ipfs-sync/manifest/v1`). Memoised. */
  manifestKey(): Promise<CryptoKey>;
  /** AES-256-GCM key for one blob version (salt: the file's 16 identifier bytes; info: `ipfs-sync/file/v1`). */
  fileKey(fileId: Bytes): Promise<CryptoKey>;
}

/**
 * Wrap a recovered or freshly generated VCK. The bytes are imported and then NOT retained; the caller overwrites
 * `vck` afterwards.
 */
export async function createVaultKeys(vaultIdBytes: Bytes, vck: Bytes): Promise<VaultKeys> {
  if (vaultIdBytes.length !== VAULT_ID_BYTES) throw invalidArgument("vault identifier must be 16 bytes");
  if (vck.length !== VCK_BYTES) throw invalidArgument("vault content key must be 32 bytes");
  const id = new Uint8Array(vaultIdBytes);
  const base = await importHkdfKey(vck);
  let name: Promise<CryptoKey> | undefined;
  let manifest: Promise<CryptoKey> | undefined;
  return {
    vaultId: toHex(id),
    get vaultIdBytes(): Bytes {
      return new Uint8Array(id);
    },
    nameKey: () => (name ??= deriveHmacKey(base, id, utf8(LABEL_NAME_KEY))),
    manifestKey: () => (manifest ??= deriveAesGcmKey(base, id, utf8(LABEL_MANIFEST_KEY))),
    fileKey: (fileId) => {
      if (fileId.length !== FILE_ID_BYTES) throw invalidArgument("file identifier must be 16 bytes");
      return deriveAesGcmKey(base, new Uint8Array(fileId), utf8(LABEL_FILE_KEY));
    },
  };
}
