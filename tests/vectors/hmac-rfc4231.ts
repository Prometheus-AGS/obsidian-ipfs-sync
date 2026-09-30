import { ascending, ascii, expectLength, hex, repeat } from "./bytes";

/**
 * RFC 4231, section 4, HMAC-SHA-256 test cases 1 to 7 (case 5 is the truncated-output case: only the
 * first 128 bits are specified by the RFC). Source: https://www.rfc-editor.org/rfc/rfc4231#section-4 (IETF, December 2005).
 * Transcribed from memory of the RFC text (no network access in this task) and confirmed at authoring time
 * against Node's `crypto.createHmac("sha256", ...)`. Lengths are asserted when the module loads.
 */
export interface HmacVector {
  readonly name: string;
  readonly source: string;
  readonly key: Uint8Array<ArrayBuffer>;
  readonly data: Uint8Array<ArrayBuffer>;
  /** Expected output. When `truncatedTo` is set only that many leading bytes are specified. */
  readonly mac: Uint8Array<ArrayBuffer>;
  readonly truncatedTo?: number;
}

export const HMAC_VECTORS: readonly HmacVector[] = [
  {
    name: "RFC 4231 case 1",
    source: "RFC 4231 section 4.2",
    key: expectLength("case 1 key", repeat(0x0b, 20), 20),
    data: ascii("Hi There"),
    mac: expectLength("case 1 mac", hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"), 32),
  },
  {
    name: "RFC 4231 case 2",
    source: "RFC 4231 section 4.3",
    key: ascii("Jefe"),
    data: ascii("what do ya want for nothing?"),
    mac: expectLength("case 2 mac", hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"), 32),
  },
  {
    name: "RFC 4231 case 3",
    source: "RFC 4231 section 4.4",
    key: expectLength("case 3 key", repeat(0xaa, 20), 20),
    data: expectLength("case 3 data", repeat(0xdd, 50), 50),
    mac: expectLength("case 3 mac", hex("773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"), 32),
  },
  {
    name: "RFC 4231 case 4",
    source: "RFC 4231 section 4.5",
    key: expectLength("case 4 key", ascending(0x01, 25), 25),
    data: expectLength("case 4 data", repeat(0xcd, 50), 50),
    mac: expectLength("case 4 mac", hex("82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"), 32),
  },
  {
    name: "RFC 4231 case 5 (truncated to 128 bits)",
    source: "RFC 4231 section 4.6",
    key: expectLength("case 5 key", repeat(0x0c, 20), 20),
    data: ascii("Test With Truncation"),
    mac: expectLength("case 5 mac", hex("a3b6167473100ee06e0c796c2955552b"), 16),
    truncatedTo: 16,
  },
  {
    name: "RFC 4231 case 6 (key longer than the block size)",
    source: "RFC 4231 section 4.7",
    key: expectLength("case 6 key", repeat(0xaa, 131), 131),
    data: ascii("Test Using Larger Than Block-Size Key - Hash Key First"),
    mac: expectLength("case 6 mac", hex("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"), 32),
  },
  {
    name: "RFC 4231 case 7 (long key and long data)",
    source: "RFC 4231 section 4.8",
    key: expectLength("case 7 key", repeat(0xaa, 131), 131),
    data: ascii(
      "This is a test using a larger than block-size key and a larger than block-size data. " +
        "The key needs to be hashed before being used by the HMAC algorithm.",
    ),
    mac: expectLength("case 7 mac", hex("9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"), 32),
  },
];
