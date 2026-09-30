/**
 * Strict helpers for the vector files. `Buffer.from(text, "hex")` silently truncates at the first bad
 * character, which would turn a transcription slip into a shorter (and possibly still "passing") vector,
 * so every conversion here throws on odd length or a non-hex character.
 */
export function hex(text: string): Uint8Array<ArrayBuffer> {
  const compact = text.replace(/\s+/g, "");
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) {
    throw new Error(`vector transcription error: not an even-length hex string: "${text.slice(0, 40)}"`);
  }
  return new Uint8Array(Buffer.from(compact, "hex"));
}

/** `count` copies of one byte value (RFC vectors are full of 0x0b * 22 and similar). */
export function repeat(value: number, count: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(count).fill(value);
}

/** Ascending byte run `first, first + 1, ...` of `count` bytes (RFC 5869 test case 2 and RFC 4231 case 4). */
export function ascending(first: number, count: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: count }, (_, index) => (first + index) & 0xff);
}

/** Fail loudly when a decoded field does not have the byte length the vector file declares for it. */
export function expectLength(label: string, bytes: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
  if (bytes.length !== length) throw new Error(`vector transcription error: ${label} is ${bytes.length} bytes, declared ${length}`);
  return new Uint8Array(bytes);
}

export function ascii(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, "latin1"));
}
