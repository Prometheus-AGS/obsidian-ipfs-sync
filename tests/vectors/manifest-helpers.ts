import { expect } from "vitest";
import { CryptoError, blobNameFor, toHex, utf8, type Bytes, type VaultKeys } from "../../src/crypto";
import { encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { createVaultKeys } from "../../src/crypto/key-derivation";
import { secureRandom } from "../../src/crypto/random";
import { createFilesMap, type EncryptedManifest, type EncryptedManifestFile } from "../../src/sync/encrypted-manifest";
import { ascending } from "./bytes";

export const ROOT_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
export const V0_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
export const SHA = "a".repeat(64);

export const keysFrom = (vault: number, vck: number): Promise<VaultKeys> => createVaultKeys(ascending(vault, 16), ascending(vck, 32));

export async function entryFor(keys: VaultKeys, path: string, cid = ROOT_CID): Promise<EncryptedManifestFile> {
  return { sha256: SHA, size: path.length, blob: await blobNameFor(keys, path), fileId: toHex(secureRandom(16)), cid };
}

export async function manifestFor(keys: VaultKeys, paths: readonly string[], overrides: Partial<EncryptedManifest> = {}): Promise<EncryptedManifest> {
  const files = createFilesMap();
  for (const path of paths) files[path] = await entryFor(keys, path);
  return {
    version: 2,
    vaultId: keys.vaultId,
    sequence: 1,
    rootCID: ROOT_CID,
    publishedAt: "2026-09-30T12:00:00.000Z",
    device: "test-device",
    excludesHash: "b".repeat(64),
    files,
    ...overrides,
  };
}

/** Encrypt arbitrary (possibly illegal) plaintext as an authenticated manifest.enc. */
export const seal = (keys: VaultKeys, json: string): Promise<Bytes> => encryptManifestEnvelope(keys, utf8(json));

export async function refusal(promise: Promise<unknown>): Promise<CryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    return error as CryptoError;
  }
  throw new Error("expected a refusal");
}

export const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
