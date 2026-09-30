/**
 * The per-file read cap. Obsidian's adapter has no partial read, so reading a file loads all of it; the cap keeps
 * that bounded. The default is a proposal chosen so a phone-class device survives it, not a measurement.
 */

export const DEFAULT_MAX_READ_MB = 64;
export const MIN_MAX_READ_MB = 8;
export const MAX_MAX_READ_MB = 1024;

const BYTES_PER_MB = 1024 * 1024;

export function readCapBytes(megabytes: number): number {
  return megabytes * BYTES_PER_MB;
}

export function isValidReadCapMb(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_MAX_READ_MB && value <= MAX_MAX_READ_MB;
}

export const READ_CAP_RANGE_MESSAGE = `the read cap must be a whole number of megabytes from ${MIN_MAX_READ_MB} to ${MAX_MAX_READ_MB}`;

export type ReadCapParse = { readonly ok: true; readonly megabytes: number } | { readonly ok: false; readonly message: string };

/** Text from the settings tab to a cap in megabytes, or the message to show beside the field. */
export function parseReadCapMb(text: string): ReadCapParse {
  const trimmed = text.trim();
  const value = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return isValidReadCapMb(value) ? { ok: true, megabytes: value } : { ok: false, message: READ_CAP_RANGE_MESSAGE };
}
