import type { Bytes } from "./bytes";
import { hasLoneSurrogate, utf8 } from "./bytes";
import { fromBase32Lower, toBase32Lower } from "./codec";
import { invalidArgument, malformed } from "./errors";
import type { VaultKeys } from "./key-derivation";
import { hmacSha256 } from "./hmac";

/*
 * Opaque node names (spec: encrypted-blobs, "Opaque node names"). A file's node path is
 * `current/<p>/<n>`: `n` is the lowercase RFC 4648 base32 (no padding, 52 characters) of
 * HMAC-SHA256(nameKey, UTF-8(path)) and `p` is its first two characters. The 52nd character carries four
 * unused bits that must be zero; a name is compared by string equality with the recomputed name.
 * The path is encoded exactly as the host reports it, with no Unicode normalisation.
 */
export const BLOB_NAME_BYTES = 32;
export const BLOB_NAME_LENGTH = 52;
export const BLOB_PREFIX_LENGTH = 2;
export const BLOB_NAME_PATTERN = /^[a-z2-7]{52}$/;
export const BLOB_TREE_ROOT = "current";

/**
 * HMAC value for a vault path. A path with a lone surrogate is refused: UTF-8 encoding would silently replace it
 * with U+FFFD, and two different paths would then share one name.
 */
export async function blobNameBytes(nameKey: CryptoKey, path: string): Promise<Bytes> {
  if (path === "") throw invalidArgument("path must not be empty");
  if (hasLoneSurrogate(path)) throw malformed("path is not valid Unicode text");
  return hmacSha256(nameKey, utf8(path));
}

/** The 52-character node name for a path, from an already derived name key (use for batches). */
export async function blobNameFromKey(nameKey: CryptoKey, path: string): Promise<string> {
  return toBase32Lower(await blobNameBytes(nameKey, path));
}

/** The 52-character node name for a path in this vault. */
export async function blobNameFor(keys: VaultKeys, path: string): Promise<string> {
  return blobNameFromKey(await keys.nameKey(), path);
}

/**
 * Decode a node name back to its 32 raw HMAC bytes (the value bound into the blob's associated data).
 * Anything that is not the canonical 52-character encoding, including a non-zero unused bit in the last
 * character, is rejected as malformed.
 */
export function parseBlobName(name: string): Bytes {
  if (!BLOB_NAME_PATTERN.test(name)) throw malformed("not a canonical blob name");
  return fromBase32Lower(name, BLOB_NAME_BYTES);
}

export function isBlobName(name: string): boolean {
  try {
    parseBlobName(name);
    return true;
  } catch {
    return false;
  }
}

/** Path of a blob below the tree root: `<first two characters>/<name>`. */
export function blobTreePath(name: string): string {
  parseBlobName(name);
  return `${name.slice(0, BLOB_PREFIX_LENGTH)}/${name}`;
}

/** Path below the MFS root: `current/<first two characters>/<name>`. */
export function blobMfsPath(name: string): string {
  return `${BLOB_TREE_ROOT}/${blobTreePath(name)}`;
}
