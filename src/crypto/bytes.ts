import { invalidArgument } from "./errors";

/** The byte-array type WebCrypto accepts. Matches `Bytes` in the host bridge. */
export type Bytes = Uint8Array<ArrayBuffer>;

const TEXT_ENCODER = new TextEncoder();

export function utf8(text: string): Bytes {
  return TEXT_ENCODER.encode(text);
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function copyBytes(bytes: Uint8Array): Bytes {
  return new Uint8Array(bytes);
}

/** Unsigned 32-bit big-endian. */
export function u32be(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw invalidArgument("u32 out of range");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** Unsigned 64-bit big-endian from a non-negative safe integer (segment indexes never exceed 2^53). */
export function u64be(value: number): Bytes {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidArgument("u64 out of range");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000), false);
  view.setUint32(4, value >>> 0, false);
  return out;
}

/**
 * Constant-time equality for two byte strings. The lengths are public, so a length difference returns false
 * immediately; for equal lengths every byte is visited and combined without a data-dependent branch.
 * This is a comparison, not a primitive.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

/**
 * Best-effort overwrite. The JavaScript runtime may have copied the bytes (garbage collection, JIT, the
 * platform crypto layer), so this narrows the exposure window and does not guarantee erasure.
 */
export function wipe(...arrays: readonly (Uint8Array | undefined)[]): void {
  for (const array of arrays) array?.fill(0);
}

/**
 * True when the text contains an unpaired UTF-16 surrogate. UTF-8 encoding would silently replace it with
 * U+FFFD, so two different strings could share one encoding. Written as a loop, not a regular expression with
 * look-behind, because older iOS WebViews reject look-behind at parse time.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
