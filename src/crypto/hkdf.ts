import type { Bytes } from "./bytes";
import { invalidArgument } from "./errors";
import { guard, requireSubtle } from "./webcrypto";

/** HKDF-SHA256 from WebCrypto (RFC 5869). The largest output is 255 blocks of 32 bytes. */
export const HKDF_MAX_OUTPUT_BYTES = 255 * 32;

/** Import raw key material as a non-extractable HKDF base key. The caller should overwrite `raw` afterwards. */
export async function importHkdfKey(raw: Bytes): Promise<CryptoKey> {
  const subtle = requireSubtle();
  return guard(() => subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]));
}

/** HKDF-SHA256 bytes. `ikm` is raw bytes (imported non-extractable for the call) or an existing HKDF key. */
export async function hkdfSha256(ikm: Bytes | CryptoKey, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  if (!Number.isInteger(length) || length < 1 || length > HKDF_MAX_OUTPUT_BYTES) throw invalidArgument("HKDF length out of range");
  const subtle = requireSubtle();
  const base = ikm instanceof Uint8Array ? await importHkdfKey(ikm) : ikm;
  const bits = await guard(() => subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, length * 8));
  return new Uint8Array(bits);
}

/** A non-extractable AES-256-GCM key derived with HKDF-SHA256 (encrypt and decrypt only). */
export async function deriveAesGcmKey(base: CryptoKey, salt: Bytes, info: Bytes): Promise<CryptoKey> {
  const subtle = requireSubtle();
  return guard(() =>
    subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
  );
}

/** A non-extractable HMAC-SHA256 key derived with HKDF-SHA256 (sign and verify only). */
export async function deriveHmacKey(base: CryptoKey, salt: Bytes, info: Bytes): Promise<CryptoKey> {
  const subtle = requireSubtle();
  return guard(() =>
    subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  );
}
