/**
 * Resource ceilings of the decrypting pull (design decision 14, spec encrypted-pull "Resource bounds"). Every number here
 * is a proposal, not a measurement; the 07b operator run is where they meet a real gateway.
 *
 * Pure: no I/O. The ranged plugin source (`blob-source.ts`) and the pull orchestration (`encrypted-pull.ts`) read them.
 */

const MIB = 1024 * 1024;

/** In-flight ciphertext plus plaintext segment memory across the whole fetch pool. */
export const SEGMENT_MEMORY_BUDGET = 128 * MIB;

/**
 * Largest blob the plugin accepts as one whole body when the gateway answers 200 to a Range request: two of the largest
 * segments (2 x 2^24 bytes). Above it the response is discarded, not decrypted, and the file is `unfetched`.
 */
export const WHOLE_BODY_LIMIT = 32 * MIB;

/** Total plaintext bytes above which the pull asks for confirmation (plugin setting `pullConfirmAboveMb`, CLI `--max-bytes`). */
export const PULL_CONFIRM_ABOVE_DEFAULT = 512 * MIB;

/** Smallest segment exponent the plugin fetches by ranges: exponent 16 would mean 16,384 requests per GiB. The CLI streams and has no such floor. */
export const PLUGIN_MIN_EXPONENT = 20;

/** Slack on the 22-byte header probe: an answer longer than `22 + this` shows that the gateway ignored the Range header. */
export const RANGE_PROBE_MARGIN_BYTES = 64;

/** Upper bound on files in flight, whatever the exponent. */
export const PULL_MAX_CONCURRENCY = 6;

/**
 * Files in flight for a segment exponent `e`: `min(6, floor(128 MiB / (2 * 2^e)))`, so 6 at exponent 23 and 4 at 24.
 * Each file holds one ciphertext and one plaintext segment, counted as two whole segments. The 28 framing bytes per segment
 * are left out on purpose: with them exponent 24 would give 3, and the design, the spec and task 4.4 all state 4.
 */
export function pullConcurrency(exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 30) throw new RangeError("segment exponent out of range");
  return Math.max(1, Math.min(PULL_MAX_CONCURRENCY, Math.floor(SEGMENT_MEMORY_BUDGET / (2 * 2 ** exponent))));
}

/** The sum of the plaintext sizes of the files a pull must fetch, exact. Raises on a size that is not a non-negative safe integer. */
export function totalBytesToFetch(entries: Iterable<{ readonly size: number }>): number {
  let total = 0;
  for (const { size } of entries) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("a file size is not a non-negative safe integer");
    total += size;
    if (!Number.isSafeInteger(total)) throw new RangeError("the total size is not a safe integer");
  }
  return total;
}

/** True when the pull must ask before fetching (`total` strictly above the ceiling). */
export function exceedsPullCeiling(totalBytes: number, ceilingBytes: number = PULL_CONFIRM_ABOVE_DEFAULT): boolean {
  return totalBytes > ceilingBytes;
}

/** The blob to send the range probe for: the one with the smallest length (the first in order on a tie), or undefined for none. */
export function smallestBlob<T extends { readonly totalLength: number }>(blobs: readonly T[]): T | undefined {
  let smallest: T | undefined;
  for (const blob of blobs) {
    if (smallest === undefined || blob.totalLength < smallest.totalLength) smallest = blob;
  }
  return smallest;
}
