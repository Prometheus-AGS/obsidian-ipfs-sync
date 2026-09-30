import { aesGcmDecrypt, aesGcmEncrypt, AES_GCM_NONCE_BYTES, AES_GCM_TAG_BYTES } from "./aes-gcm";
import { concatBytes, utf8, type Bytes } from "./bytes";
import { CryptoError, OversizeInputError, malformed } from "./errors";
import { LABEL_MANIFEST_AAD, VAULT_ID_BYTES, type VaultKeys } from "./key-derivation";
import { randomNonce, secureRandom, type RandomSource } from "./random";

/*
 * manifest.enc envelope (spec: manifest-v2, "Encrypted at rest"):
 *   header (17 bytes) = "ISMF" (4) | version 0x02 (1) | nonce (12), then ciphertext | tag (16).
 * Key: HKDF-SHA256(VCK, salt = vaultId, info = "ipfs-sync/manifest/v1"). Associated data:
 * "ipfs-sync/manifest/v1" | vaultId (16) | header (17). This module handles bytes only; the manifest JSON
 * lives in src/sync/encrypted-manifest.ts.
 */
export const MANIFEST_MAGIC = "ISMF";
export const MANIFEST_ENVELOPE_VERSION = 2;
export const MANIFEST_HEADER_BYTES = 4 + 1 + AES_GCM_NONCE_BYTES;
export const MANIFEST_MIN_BYTES = MANIFEST_HEADER_BYTES + AES_GCM_TAG_BYTES;
/** A `manifest.enc` above this size is refused (64 MiB). */
export const MANIFEST_MAX_FILE_BYTES = 64 * 1024 * 1024;

const MAGIC_BYTES = utf8(MANIFEST_MAGIC);

export function manifestAad(vaultIdBytes: Bytes, header: Bytes): Bytes {
  return concatBytes(utf8(LABEL_MANIFEST_AAD), vaultIdBytes, header);
}

function fileSizeError(): OversizeInputError {
  return new OversizeInputError("manifest-file-size", "manifest.enc would exceed the 64 MiB limit");
}

/** Size of `manifest.enc` for a plaintext of this length. */
export function manifestFileSize(plaintextLength: number): number {
  return MANIFEST_HEADER_BYTES + plaintextLength + AES_GCM_TAG_BYTES;
}

/** Encrypt manifest plaintext into `manifest.enc` bytes, refusing a result above the 64 MiB cap. */
export function encryptManifestEnvelope(keys: VaultKeys, plaintext: Bytes): Promise<Bytes> {
  return encryptManifestEnvelopeWith(keys, plaintext, secureRandom);
}

/** @internal test use only: the nonce source may be substituted. */
export async function encryptManifestEnvelopeWith(keys: VaultKeys, plaintext: Bytes, random: RandomSource): Promise<Bytes> {
  if (manifestFileSize(plaintext.length) > MANIFEST_MAX_FILE_BYTES) throw fileSizeError();
  const header = concatBytes(MAGIC_BYTES, new Uint8Array([MANIFEST_ENVELOPE_VERSION]), randomNonce(random));
  const nonce = header.slice(5);
  const sealed = await aesGcmEncrypt(await keys.manifestKey(), nonce, plaintext, manifestAad(keys.vaultIdBytes, header));
  return concatBytes(header, sealed);
}

/**
 * Decrypt `manifest.enc`. A file above 64 MiB is refused before any work; a bad magic or a length under 33 bytes
 * is malformed; version other than 2 is unsupported-format; any authentication failure (a flipped bit, another
 * vault, another key) raises `authentication-failed` and returns no plaintext.
 */
export async function decryptManifestEnvelope(keys: VaultKeys, file: Uint8Array): Promise<Bytes> {
  if (file.length > MANIFEST_MAX_FILE_BYTES) throw fileSizeError();
  if (file.length < MANIFEST_MIN_BYTES) throw malformed("manifest.enc is too short");
  if (!MAGIC_BYTES.every((byte, index) => file[index] === byte)) throw malformed("not an encrypted manifest (bad magic)");
  if (file[4] !== MANIFEST_ENVELOPE_VERSION) throw new CryptoError("unsupported-format", "unsupported manifest version");
  const header = file.slice(0, MANIFEST_HEADER_BYTES);
  if (keys.vaultIdBytes.length !== VAULT_ID_BYTES) throw malformed("vault identifier has the wrong length");
  const nonce = file.slice(5, MANIFEST_HEADER_BYTES);
  return aesGcmDecrypt(await keys.manifestKey(), nonce, file.slice(MANIFEST_HEADER_BYTES), manifestAad(keys.vaultIdBytes, header));
}
