import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { serializeManifestV2, type EncryptedManifest } from "./encrypted-manifest";

/**
 * The identity of an authenticated manifest: lowercase hex sha256 of its canonical plaintext serialisation
 * (`serializeManifestV2`). It is never a hash of `manifest.enc` bytes, because the envelope uses a random nonce:
 * re-encrypting one plaintext manifest gives different ciphertext and the same identity. The identity covers
 * `publishedAt` and `device`, so two publishers at one sequence have two identities.
 */
export function manifestIdentity(manifest: EncryptedManifest): string {
  return bytesToHex(sha256(serializeManifestV2(manifest)));
}
