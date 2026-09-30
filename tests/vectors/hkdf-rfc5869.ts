import { ascending, expectLength, hex, repeat } from "./bytes";

/**
 * RFC 5869, Appendix A, "Test Vectors with SHA-256", test cases 1 to 3.
 * Source: https://www.rfc-editor.org/rfc/rfc5869#appendix-A (IETF, May 2010).
 * Transcribed from memory of the RFC text (no network access in this task), then confirmed value by value against
 * two independent implementations at authoring time: Node's `crypto.hkdfSync` and HMAC-SHA256 (for the PRK). Each
 * length below is asserted when the module loads, so a slip in a hex string fails loudly.
 */
export interface HkdfVector {
  readonly name: string;
  readonly source: string;
  readonly ikm: Uint8Array<ArrayBuffer>;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly info: Uint8Array<ArrayBuffer>;
  readonly length: number;
  readonly prk: Uint8Array<ArrayBuffer>;
  readonly okm: Uint8Array<ArrayBuffer>;
}

export const HKDF_VECTORS: readonly HkdfVector[] = [
  {
    name: "RFC 5869 A.1 basic",
    source: "RFC 5869 Appendix A.1",
    ikm: expectLength("A.1 IKM", repeat(0x0b, 22), 22),
    salt: expectLength("A.1 salt", hex("000102030405060708090a0b0c"), 13),
    info: expectLength("A.1 info", hex("f0f1f2f3f4f5f6f7f8f9"), 10),
    length: 42,
    prk: expectLength("A.1 PRK", hex("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"), 32),
    okm: expectLength(
      "A.1 OKM",
      hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
      42,
    ),
  },
  {
    name: "RFC 5869 A.2 longer inputs",
    source: "RFC 5869 Appendix A.2",
    ikm: expectLength("A.2 IKM", ascending(0x00, 80), 80),
    salt: expectLength("A.2 salt", ascending(0x60, 80), 80),
    info: expectLength("A.2 info", ascending(0xb0, 80), 80),
    length: 82,
    prk: expectLength("A.2 PRK", hex("06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244"), 32),
    okm: expectLength(
      "A.2 OKM",
      hex(
        "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c" +
          "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71" +
          "cc30c58179ec3e87c14c01d5c1f3434f1d87",
      ),
      82,
    ),
  },
  {
    name: "RFC 5869 A.3 zero-length salt and info",
    source: "RFC 5869 Appendix A.3",
    ikm: expectLength("A.3 IKM", repeat(0x0b, 22), 22),
    salt: new Uint8Array(0),
    info: new Uint8Array(0),
    length: 42,
    prk: expectLength("A.3 PRK", hex("19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04"), 32),
    okm: expectLength(
      "A.3 OKM",
      hex("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"),
      42,
    ),
  },
];
