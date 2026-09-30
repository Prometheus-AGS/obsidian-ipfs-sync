import type { Bytes } from "./bytes";
import { CryptoError, invalidArgument } from "./errors";
import { requireGetRandomValues } from "./webcrypto";

/**
 * A source of random bytes. Randomness is injected by parameter only: there is no global setter and the
 * default is the platform CSPRNG. Only tests pass another source; a source never comes from user or network input.
 */
export type RandomSource = (length: number) => Bytes;

/** `getRandomValues` accepts at most 65,536 bytes per call. */
const GET_RANDOM_VALUES_MAX = 65536;

/** The platform cryptographically secure generator. Throws `crypto-unavailable` when it is missing. */
export const secureRandom: RandomSource = (length) => {
  if (!Number.isSafeInteger(length) || length < 0) throw invalidArgument("random length out of range");
  const fill = requireGetRandomValues();
  const out = new Uint8Array(length);
  try {
    for (let offset = 0; offset < length; offset += GET_RANDOM_VALUES_MAX) {
      fill(out.subarray(offset, Math.min(length, offset + GET_RANDOM_VALUES_MAX)));
    }
  } catch {
    throw new CryptoError("platform-failure", "the secure random generator failed");
  }
  return out;
};

/** Draw exactly `length` bytes, refusing a source that returns a different amount. */
export function randomBytes(random: RandomSource, length: number): Bytes {
  const bytes = random(length);
  if (bytes.length !== length) throw invalidArgument("random source returned the wrong number of bytes");
  return bytes;
}

/** A fresh 96-bit AES-GCM nonce. Never derived from a counter or a clock. */
export function randomNonce(random: RandomSource): Bytes {
  return randomBytes(random, 12);
}

/**
 * `count` symbols from `alphabet`, as ASCII bytes, chosen as `byte & (alphabet.length - 1)`.
 * The alphabet length must be a power of two no larger than 256, so every symbol has exactly
 * 256 / length preimages and the mapping has no modulo bias.
 */
export function randomSymbolBytes(random: RandomSource, count: number, alphabet: string): Bytes {
  const size = alphabet.length;
  if (size < 2 || size > 256 || (size & (size - 1)) !== 0) throw invalidArgument("alphabet length must be a power of two");
  const source = randomBytes(random, count);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = alphabet.charCodeAt((source[i] ?? 0) & (size - 1));
  source.fill(0);
  return out;
}
