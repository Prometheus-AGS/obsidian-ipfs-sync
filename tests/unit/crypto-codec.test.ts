import { describe, expect, it } from "vitest";
import { CryptoError, fromBase32Lower, fromBase64, fromHex, toBase32Lower, toBase64, toHex } from "../../src/crypto";
import { secureRandom } from "../../src/crypto/random";
import { RFC4648_VECTORS } from "../vectors/rfc4648";

function rejects(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("malformed-input");
    return;
  }
  throw new Error("expected the decoder to reject");
}

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));

describe("RFC 4648 section 10 vectors", () => {
  for (const vector of RFC4648_VECTORS) {
    it(`base64 of "${vector.input}"`, () => {
      expect(toBase64(ascii(vector.input))).toBe(vector.base64);
      expect(Buffer.from(fromBase64(vector.base64)).toString("latin1")).toBe(vector.input);
    });

    it(`base32 of "${vector.input}" (lower case, unpadded form of the RFC text)`, () => {
      const lower = vector.base32.replace(/=+$/, "").toLowerCase();
      expect(toBase32Lower(ascii(vector.input))).toBe(lower);
      expect(Buffer.from(fromBase32Lower(lower)).toString("latin1")).toBe(vector.input);
    });
  }
});

describe("canonical decoding", () => {
  it("round-trips random values and agrees with Node's hex and base64", () => {
    for (let length = 0; length <= 70; length++) {
      const bytes = secureRandom(length);
      expect(toHex(bytes)).toBe(Buffer.from(bytes).toString("hex"));
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
      expect([...fromBase32Lower(toBase32Lower(bytes))]).toEqual([...bytes]);
    }
  });

  it("rejects non-canonical hex (upper case, odd length, non-hex characters)", () => {
    rejects(() => fromHex("AB"));
    rejects(() => fromHex("abc"));
    rejects(() => fromHex("zz"));
    rejects(() => fromHex("0a 0b"));
  });

  it("rejects non-canonical base64 (missing padding, non-zero trailing bits, url alphabet, whitespace, wrong padding)", () => {
    rejects(() => fromBase64("Zg"));
    rejects(() => fromBase64("Zh=="));
    rejects(() => fromBase64("Zm9="));
    rejects(() => fromBase64("Zm9v\n"));
    rejects(() => fromBase64("Zm-_"));
    rejects(() => fromBase64("Z==="));
    rejects(() => fromBase64("=Zg="));
    rejects(() => fromBase64("Zg=="+"Zg=="));
  });

  it("rejects non-canonical base32 (upper case, padding, bad length, non-zero trailing bits)", () => {
    rejects(() => fromBase32Lower("MY"));
    rejects(() => fromBase32Lower("my======"));
    rejects(() => fromBase32Lower("mz"));
    rejects(() => fromBase32Lower("m"));
    rejects(() => fromBase32Lower("mzx"));
    rejects(() => fromBase32Lower("m1"));
  });

  it("a 32-byte value encodes to 52 characters whose last character carries four zero bits", () => {
    const encoded = toBase32Lower(secureRandom(32));
    expect(encoded).toMatch(/^[a-z2-7]{52}$/);
    expect(fromBase32Lower(encoded, 32)).toHaveLength(32);
    const last = "abcdefghijklmnopqrstuvwxyz234567".indexOf(encoded[51] ?? "");
    expect(last & 0x0f).toBe(0);
    const bumped = `${encoded.slice(0, 51)}${"abcdefghijklmnopqrstuvwxyz234567"[last | 1]}`;
    rejects(() => fromBase32Lower(bumped, 32));
  });

  it("enforces an expected decoded length", () => {
    rejects(() => fromHex("abcd", 3));
    rejects(() => fromBase64("Zm9v", 4));
    rejects(() => fromBase32Lower("mzxw6", 4));
  });
});
