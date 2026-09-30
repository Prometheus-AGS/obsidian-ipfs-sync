import type { Bytes } from "./bytes";
import { CryptoError, invalidArgument, malformed } from "./errors";
import { guard, requireSubtle } from "./webcrypto";

/** AES-256-GCM parameters are fixed: a 96-bit nonce and a 128-bit tag, nothing shorter. */
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;
export const AES_GCM_KEY_BYTES = 32;

/** Import a raw 32-byte key as a non-extractable AES-256-GCM key. The caller should overwrite `raw` afterwards. */
export async function importAesGcmKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== AES_GCM_KEY_BYTES) throw invalidArgument("AES-256-GCM key must be 32 bytes");
  const subtle = requireSubtle();
  return guard(() => subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
}

function assertAesKey(key: CryptoKey): void {
  const algorithm = key.algorithm as { name?: string; length?: number };
  if (algorithm.name !== "AES-GCM" || algorithm.length !== 256) throw invalidArgument("key is not an AES-256-GCM key");
}

function assertNonce(nonce: Bytes): void {
  if (nonce.length !== AES_GCM_NONCE_BYTES) throw invalidArgument("AES-GCM nonce must be 12 bytes");
}

/** Encrypt and return `ciphertext || tag` (tag 16 bytes). */
export async function aesGcmEncrypt(key: CryptoKey, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> {
  assertAesKey(key);
  assertNonce(nonce);
  const subtle = requireSubtle();
  const sealed = await guard(() =>
    subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: AES_GCM_TAG_BYTES * 8 }, key, plaintext),
  );
  return new Uint8Array(sealed);
}

/**
 * Decrypt `ciphertext || tag`. A failed authentication raises the typed `authentication-failed` error and
 * never returns unauthenticated plaintext. Anything shorter than a tag is malformed, so a truncated tag
 * cannot be accepted.
 */
export async function aesGcmDecrypt(key: CryptoKey, nonce: Bytes, sealed: Bytes, aad: Bytes): Promise<Bytes> {
  assertAesKey(key);
  assertNonce(nonce);
  if (sealed.length < AES_GCM_TAG_BYTES) throw malformed("ciphertext is shorter than an authentication tag");
  const subtle = requireSubtle();
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: AES_GCM_TAG_BYTES * 8 },
      key,
      sealed,
    );
    return new Uint8Array(plain);
  } catch (error) {
    // Only the outcomes WebCrypto uses for a failed authentication are authentication failures; anything else is the platform.
    const name = (error as { name?: string } | null)?.name;
    if (name === "OperationError" || name === "DataError") throw new CryptoError("authentication-failed", "authentication failed");
    throw new CryptoError("platform-failure", "a platform cryptography operation failed");
  }
}
