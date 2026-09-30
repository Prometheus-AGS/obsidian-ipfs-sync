import { CryptoError, type VaultKeys } from "../../src/crypto";
import { decryptBlobUnchecked } from "../../src/crypto/blob";
import { createVaultKeys } from "../../src/crypto/key-derivation";
import { secureRandom, type RandomSource } from "../../src/crypto/random";
import { ascending } from "./bytes";

export async function keysFrom(vaultStart: number, vckStart: number): Promise<VaultKeys> {
  return createVaultKeys(ascending(vaultStart, 16), ascending(vckStart, 32));
}

export const codeOf = (error: unknown): string => (error instanceof CryptoError ? error.code : `not-a-CryptoError:${String(error)}`);

export async function failure(keys: VaultKeys, name: string, blob: Uint8Array, totalLength = blob.length, expectedFileId?: string): Promise<{ code: string; yielded: number }> {
  let yielded = 0;
  try {
    for await (const part of decryptBlobUnchecked({ keys, nodeName: name, totalLength, source: blob, expectedFileId })) {
      yielded += part.length > 0 ? 1 : 0;
    }
  } catch (error) {
    return { code: codeOf(error), yielded };
  }
  return { code: "no-error", yielded };
}

/** A random source that wraps the secure generator and records each requested length. */
export function recordingRandom(): { random: RandomSource; lengths: number[] } {
  const lengths: number[] = [];
  const random: RandomSource = (length) => {
    lengths.push(length);
    return secureRandom(length);
  };
  return { random, lengths };
}

export const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
