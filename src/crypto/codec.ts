import type { Bytes } from "./bytes";
import { malformed } from "./errors";

/*
 * Canonical encodings (spec: crypto-primitives, encrypted-blobs, key-slots).
 * - hex: lowercase only.
 * - base64: RFC 4648 standard alphabet, padded, and canonical (decode then re-encode reproduces the text).
 * - base32: RFC 4648 alphabet in lowercase, no padding, unused trailing bits zero (52nd character of a 32-byte value).
 * Every decoder rejects anything else instead of normalising it.
 */

const HEX = "0123456789abcdef";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function checkLength(actual: number, expected: number | undefined, what: string): void {
  if (expected !== undefined && actual !== expected) throw malformed(`${what} has the wrong length`);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

export function fromHex(text: string, expectedLength?: number): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) throw malformed("not canonical lowercase hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = HEX.indexOf(text[2 * i] ?? "") * 16 + HEX.indexOf(text[2 * i + 1] ?? "");
  checkLength(out.length, expectedLength, "hex value");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b1 === undefined ? "=" : B64[(n >> 6) & 63];
    out += b2 === undefined ? "=" : B64[n & 63];
  }
  return out;
}

export function fromBase64(text: string, expectedLength?: number): Bytes {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw malformed("not canonical base64");
  const body = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((body.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const char of body) {
    buffer = ((buffer << 6) | B64.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
    }
  }
  if (toBase64(out) !== text) throw malformed("not canonical base64");
  checkLength(out.length, expectedLength, "base64 value");
  return out;
}

export function toBase32Lower(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Decode lowercase base32 without padding. A non-zero unused trailing bit is rejected as non-canonical. */
export function fromBase32Lower(text: string, expectedLength?: number): Bytes {
  if (!/^[a-z2-7]*$/.test(text) || ![0, 2, 4, 5, 7].includes(text.length % 8)) throw malformed("not canonical base32");
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const char of text) {
    buffer = ((buffer << 5) | B32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
    }
  }
  if (toBase32Lower(out) !== text) throw malformed("not canonical base32");
  checkLength(out.length, expectedLength, "base32 value");
  return out;
}
