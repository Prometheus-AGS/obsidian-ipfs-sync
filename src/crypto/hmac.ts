import type { Bytes } from "./bytes";
import { invalidArgument } from "./errors";
import { guard, requireSubtle } from "./webcrypto";

/** Import raw bytes as a non-extractable HMAC-SHA256 key. The caller should overwrite `raw` afterwards. */
export async function importHmacKey(raw: Bytes): Promise<CryptoKey> {
  const subtle = requireSubtle();
  return guard(() => subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
}

/** HMAC-SHA256 (RFC 2104) from WebCrypto; always 32 bytes. */
export async function hmacSha256(key: CryptoKey, data: Bytes): Promise<Bytes> {
  const algorithm = key.algorithm as { name?: string; hash?: { name?: string } };
  if (algorithm.name !== "HMAC" || algorithm.hash?.name !== "SHA-256") throw invalidArgument("key is not an HMAC-SHA256 key");
  const subtle = requireSubtle();
  return new Uint8Array(await guard(() => subtle.sign("HMAC", key, data)));
}
