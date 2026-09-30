import { CryptoError } from "./errors";

/**
 * Run a platform cryptography call and turn any failure that is not already typed into `platform-failure`
 * (spec: "never a raw platform error"). The platform message is dropped: it could echo inputs.
 */
export async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError("platform-failure", "a platform cryptography operation failed");
  }
}

/**
 * The platform SubtleCrypto. There is no fallback implementation: if it is missing every operation that needs
 * it fails with `crypto-unavailable`, and no weaker mode or plaintext path exists.
 */
export function requireSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined || subtle === null) {
    throw new CryptoError("crypto-unavailable", "WebCrypto (crypto.subtle) is not available; encryption cannot run");
  }
  return subtle;
}

/** The platform CSPRNG entry point, or `crypto-unavailable`. */
export function requireGetRandomValues(): (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> {
  const platform = (globalThis as { crypto?: Crypto }).crypto;
  if (platform === undefined || platform === null || typeof platform.getRandomValues !== "function") {
    throw new CryptoError("crypto-unavailable", "the secure random generator (crypto.getRandomValues) is not available");
  }
  return (array) => platform.getRandomValues(array);
}
