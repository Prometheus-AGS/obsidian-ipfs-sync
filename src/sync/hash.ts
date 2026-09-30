import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Bytes, HostFs } from "../core/host-bridge";

/** Files up to this size are read whole and hashed with WebCrypto. */
export const SINGLE_READ_LIMIT_BYTES = 32 * 1024 * 1024;

/** Larger files are read in ranges of this size and hashed incrementally. */
export const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

/** Lowercase hex sha256 of the bytes, using WebCrypto (available in Node 24 and the Obsidian WebView). */
export async function sha256Hex(bytes: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Lowercase hex sha256 of a file. WebCrypto has no incremental digest, so a file
 * above 32 MB is read in 8 MB ranges and fed to an incremental sha256; the whole
 * file is never in memory. The result equals the one-pass digest of the same bytes.
 */
export async function hashFile(fs: Pick<HostFs, "read" | "readRange">, path: string, size: number): Promise<string> {
  if (size <= SINGLE_READ_LIMIT_BYTES) return sha256Hex(await fs.read(path));
  const hasher = sha256.create();
  for (let offset = 0; offset < size; offset += HASH_CHUNK_BYTES) {
    hasher.update(await fs.readRange(path, offset, Math.min(HASH_CHUNK_BYTES, size - offset)));
  }
  return bytesToHex(hasher.digest());
}
