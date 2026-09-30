import { createHmac, hkdfSync, createCipheriv } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CryptoError, constantTimeEqual, wipe } from "../../src/crypto";
import { AES_GCM_TAG_BYTES, aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from "../../src/crypto/aes-gcm";
import { deriveAesGcmKey, deriveHmacKey, hkdfSha256, importHkdfKey } from "../../src/crypto/hkdf";
import { ensureSelfTest } from "../../src/crypto/self-test";
import { hmacSha256, importHmacKey } from "../../src/crypto/hmac";
import { u32be, u64be } from "../../src/crypto/bytes";
import { randomBytes, randomNonce, randomSymbolBytes, secureRandom } from "../../src/crypto/random";
import { PLATFORM_PRIMITIVES, createSelfTestRunner } from "../../src/crypto/self-test";
import { GCM_TAG_FAILURE, GCM_VECTORS } from "../vectors/aes-gcm-vectors";
import { ascii, hex, repeat } from "../vectors/bytes";
import { HKDF_VECTORS } from "../vectors/hkdf-rfc5869";
import { HMAC_VECTORS } from "../vectors/hmac-rfc4231";

afterEach(() => vi.unstubAllGlobals());

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(CryptoError);
  expect((error as CryptoError).code).toBe(code);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("HKDF-SHA256 wrapper (WebCrypto)", () => {
  for (const vector of HKDF_VECTORS) {
    it(`matches ${vector.name} (${vector.source})`, async () => {
      const okm = await hkdfSha256(vector.ikm, vector.salt, vector.info, vector.length);
      expect(Buffer.from(okm).toString("hex")).toBe(Buffer.from(vector.okm).toString("hex"));
    });

    it(`the recorded PRK of ${vector.name} equals HMAC(salt, IKM) computed by node:crypto`, () => {
      const salt = vector.salt.length === 0 ? Buffer.alloc(32) : Buffer.from(vector.salt);
      const prk = createHmac("sha256", salt).update(vector.ikm).digest();
      expect(prk.toString("hex")).toBe(Buffer.from(vector.prk).toString("hex"));
    });
  }

  it("agrees with node:crypto and @noble/hashes for empty info, long info and an empty salt", async () => {
    const ikm = hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    const cases: readonly { salt: Uint8Array<ArrayBuffer>; info: Uint8Array<ArrayBuffer>; length: number }[] = [
      { salt: repeat(7, 16), info: new Uint8Array(0), length: 32 },
      { salt: repeat(7, 16), info: repeat(0x5a, 1024), length: 64 },
      { salt: new Uint8Array(0), info: ascii("ipfs-sync/name/v1"), length: 32 },
      { salt: repeat(1, 16), info: ascii("x"), length: 1 },
    ];
    for (const { salt, info, length } of cases) {
      const ours = Buffer.from(await hkdfSha256(ikm, salt, info, length)).toString("hex");
      expect(ours).toBe(Buffer.from(hkdfSync("sha256", ikm, salt, info, length)).toString("hex"));
      expect(ours).toBe(Buffer.from(hkdf(sha256, ikm, salt, info, length)).toString("hex"));
    }
  });

  it("refuses an output length outside 1..8160", async () => {
    expectCode(await rejectionOf(hkdfSha256(repeat(1, 32), repeat(1, 16), repeat(1, 1), 0)), "invalid-argument");
    expectCode(await rejectionOf(hkdfSha256(repeat(1, 32), repeat(1, 16), repeat(1, 1), 8161)), "invalid-argument");
  });

  it("derives non-extractable AES-GCM and HMAC keys that agree with the raw derivation", async () => {
    const base = await importHkdfKey(repeat(9, 32));
    const salt = repeat(3, 16);
    const info = ascii("test/info");
    const aes = await deriveAesGcmKey(base, salt, info);
    const mac = await deriveHmacKey(base, salt, info);
    expect(aes.extractable).toBe(false);
    expect(mac.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", aes)).rejects.toBeDefined();
    const raw = await hkdfSha256(repeat(9, 32), salt, info, 32);
    const rawMac = createHmac("sha256", raw).update("payload").digest("hex");
    expect(Buffer.from(await hmacSha256(mac, ascii("payload"))).toString("hex")).toBe(rawMac);
    const sealed = await aesGcmEncrypt(aes, repeat(1, 12), ascii("payload"), new Uint8Array(0));
    const cipher = createCipheriv("aes-256-gcm", raw, repeat(1, 12));
    const expected = Buffer.concat([cipher.update("payload"), cipher.final(), cipher.getAuthTag()]);
    expect(Buffer.from(sealed).toString("hex")).toBe(expected.toString("hex"));
  });
});

describe("HMAC-SHA256 wrapper (WebCrypto)", () => {
  for (const vector of HMAC_VECTORS) {
    it(`matches ${vector.name} (${vector.source})`, async () => {
      const mac = await hmacSha256(await importHmacKey(vector.key), vector.data);
      expect(mac).toHaveLength(32);
      const compared = mac.slice(0, vector.truncatedTo ?? 32);
      expect(Buffer.from(compared).toString("hex")).toBe(Buffer.from(vector.mac).toString("hex"));
      expect(Buffer.from(mac).toString("hex")).toBe(createHmac("sha256", vector.key).update(vector.data).digest("hex"));
    });
  }

  it("refuses a key that is not an HMAC-SHA256 key", async () => {
    const aes = await importAesGcmKey(repeat(1, 32));
    expectCode(await rejectionOf(hmacSha256(aes, ascii("x"))), "invalid-argument");
  });
});

describe("AES-256-GCM wrapper (WebCrypto)", () => {
  for (const vector of GCM_VECTORS) {
    it(`encrypts and decrypts ${vector.name} (${vector.source})`, async () => {
      const key = await importAesGcmKey(vector.key);
      const sealed = await aesGcmEncrypt(key, vector.iv, vector.plaintext, vector.aad);
      const expected = new Uint8Array([...vector.ciphertext, ...vector.tag]);
      expect(Buffer.from(sealed).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
      const plain = await aesGcmDecrypt(key, vector.iv, expected, vector.aad);
      expect(Buffer.from(plain).toString("hex")).toBe(Buffer.from(vector.plaintext).toString("hex"));
    });

    it(`the recorded ${vector.name} equals node:crypto's AES-256-GCM`, () => {
      const cipher = createCipheriv("aes-256-gcm", vector.key, vector.iv);
      cipher.setAAD(vector.aad);
      const ciphertext = Buffer.concat([cipher.update(vector.plaintext), cipher.final()]);
      expect(ciphertext.toString("hex")).toBe(Buffer.from(vector.ciphertext).toString("hex"));
      expect(cipher.getAuthTag().toString("hex")).toBe(Buffer.from(vector.tag).toString("hex"));
    });

    it(`rejects ${vector.name} with any single flipped bit (ciphertext, tag or AAD)`, async () => {
      const key = await importAesGcmKey(vector.key);
      const sealed = new Uint8Array([...vector.ciphertext, ...vector.tag]);
      for (let bit = 0; bit < sealed.length * 8; bit++) {
        const flipped = new Uint8Array(sealed);
        flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        expectCode(await rejectionOf(aesGcmDecrypt(key, vector.iv, flipped, vector.aad)), "authentication-failed");
      }
      const aad = new Uint8Array([...vector.aad, 0]);
      expectCode(await rejectionOf(aesGcmDecrypt(key, vector.iv, sealed, aad)), "authentication-failed");
    });
  }

  it(`rejects the derived tag-failure vector (${GCM_TAG_FAILURE.name})`, async () => {
    const base = GCM_VECTORS.find((v) => v.name === "McGrew-Viega test case 16");
    if (base === undefined) throw new Error("vector missing");
    const key = await importAesGcmKey(base.key);
    const bad = new Uint8Array([...base.ciphertext, ...GCM_TAG_FAILURE.badTag]);
    expectCode(await rejectionOf(aesGcmDecrypt(key, base.iv, bad, base.aad)), "authentication-failed");
  });

  it("never accepts a truncated tag: input shorter than 16 bytes is malformed, a cut tag fails authentication", async () => {
    const vector = GCM_VECTORS[3];
    if (vector === undefined) throw new Error("vector missing");
    const key = await importAesGcmKey(vector.key);
    expectCode(await rejectionOf(aesGcmDecrypt(key, vector.iv, repeat(0, AES_GCM_TAG_BYTES - 1), vector.aad)), "malformed-input");
    const sealed = new Uint8Array([...vector.ciphertext, ...vector.tag]);
    expectCode(await rejectionOf(aesGcmDecrypt(key, vector.iv, sealed.slice(0, sealed.length - 4), vector.aad)), "authentication-failed");
  });

  it("enforces a 12-byte nonce and a 256-bit AES key", async () => {
    const key = await importAesGcmKey(repeat(1, 32));
    expectCode(await rejectionOf(aesGcmEncrypt(key, repeat(1, 16), ascii("x"), new Uint8Array(0))), "invalid-argument");
    expectCode(await rejectionOf(aesGcmDecrypt(key, repeat(1, 11), repeat(1, 32), new Uint8Array(0))), "invalid-argument");
    expectCode(await rejectionOf(importAesGcmKey(repeat(1, 16))), "invalid-argument");
    const small = await crypto.subtle.importKey("raw", repeat(1, 16), "AES-GCM", false, ["encrypt"]);
    expectCode(await rejectionOf(aesGcmEncrypt(small, repeat(1, 12), ascii("x"), new Uint8Array(0))), "invalid-argument");
  });

  it("imports keys as non-extractable", async () => {
    const key = await importAesGcmKey(repeat(1, 32));
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
    expect((await importHmacKey(repeat(2, 32))).extractable).toBe(false);
    expect((await importHkdfKey(repeat(3, 32))).extractable).toBe(false);
  });

  it("returns no plaintext when authentication fails", async () => {
    const key = await importAesGcmKey(repeat(4, 32));
    const sealed = await aesGcmEncrypt(key, repeat(5, 12), ascii("SECRET-CONTENT"), new Uint8Array(0));
    sealed[0] = (sealed[0] ?? 0) ^ 1;
    const error = await rejectionOf(aesGcmDecrypt(key, repeat(5, 12), sealed, new Uint8Array(0)));
    expectCode(error, "authentication-failed");
    expect(String((error as Error).message)).not.toContain("SECRET");
  });
});

describe("self-test", () => {
  it("passes on the real platform", async () => {
    await expect(createSelfTestRunner().ensure()).resolves.toBeUndefined();
    await expect(ensureSelfTest()).resolves.toBeUndefined();
  });

  it("fails closed when HKDF returns a wrong value, on every call (failure is never cached)", async () => {
    const runner = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      hkdfSha256: async (ikm, salt, info, length) => {
        const real = await hkdfSha256(ikm, salt, info, length);
        real[0] = (real[0] ?? 0) ^ 0xff;
        return real;
      },
    });
    expectCode(await rejectionOf(runner.ensure()), "self-test-failed");
    expectCode(await rejectionOf(runner.ensure()), "self-test-failed");
  });

  it("fails closed when AES-GCM encrypts wrongly or accepts a bad tag", async () => {
    const wrongEncrypt = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      aesGcmEncrypt: async (key, nonce, plain, aad) => {
        const sealed = await aesGcmEncrypt(key, nonce, plain, aad);
        sealed[3] = (sealed[3] ?? 0) ^ 1;
        return sealed;
      },
    });
    expectCode(await rejectionOf(wrongEncrypt.ensure()), "self-test-failed");
    const laxTag = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      aesGcmDecrypt: async (_key, _nonce, sealed) => sealed.slice(0, sealed.length - AES_GCM_TAG_BYTES),
    });
    expectCode(await rejectionOf(laxTag.ensure()), "self-test-failed");
  });

  it("fails closed when HMAC returns a wrong value", async () => {
    const runner = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      hmacSha256: async (key, data) => {
        const mac = await hmacSha256(key, data);
        mac[31] = (mac[31] ?? 0) ^ 1;
        return mac;
      },
    });
    expectCode(await rejectionOf(runner.ensure()), "self-test-failed");
  });

  it("fails closed when deriveKey (the path that makes every real key) disagrees with raw HKDF output", async () => {
    const wrongAes = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      deriveAesGcmKey: async (_base, _salt, _info) => importAesGcmKey(repeat(9, 32)),
    });
    expectCode(await rejectionOf(wrongAes.ensure()), "self-test-failed");
    const wrongHmac = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      deriveHmacKey: async (_base, _salt, _info) => importHmacKey(repeat(9, 32)),
    });
    expectCode(await rejectionOf(wrongHmac.ensure()), "self-test-failed");
  });

  it("turns a raw platform error into a typed self-test error", async () => {
    const runner = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      hkdfSha256: async () => {
        throw new TypeError("platform exploded");
      },
    });
    expectCode(await rejectionOf(runner.ensure()), "self-test-failed");
  });

  it("runs the check once and remembers only success", async () => {
    let calls = 0;
    const runner = createSelfTestRunner({
      ...PLATFORM_PRIMITIVES,
      hkdfSha256: (ikm, salt, info, length) => {
        calls++;
        return hkdfSha256(ikm, salt, info, length);
      },
    });
    await Promise.all([runner.ensure(), runner.ensure()]);
    await runner.ensure();
    expect(calls).toBe(1);
  });
});

describe("crypto.subtle missing (no fallback)", () => {
  it("raises crypto-unavailable from every wrapper and from the self-test", async () => {
    const key = await importAesGcmKey(repeat(1, 32));
    const hmacKey = await importHmacKey(repeat(1, 32));
    const hkdfKey = await importHkdfKey(repeat(1, 32));
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto), subtle: undefined });
    expectCode(await rejectionOf(importAesGcmKey(repeat(1, 32))), "crypto-unavailable");
    expectCode(await rejectionOf(importHmacKey(repeat(1, 32))), "crypto-unavailable");
    expectCode(await rejectionOf(importHkdfKey(repeat(1, 32))), "crypto-unavailable");
    expectCode(await rejectionOf(hkdfSha256(repeat(1, 32), repeat(1, 16), repeat(1, 1), 32)), "crypto-unavailable");
    expectCode(await rejectionOf(hkdfSha256(hkdfKey, repeat(1, 16), repeat(1, 1), 32)), "crypto-unavailable");
    expectCode(await rejectionOf(aesGcmEncrypt(key, repeat(1, 12), ascii("x"), new Uint8Array(0))), "crypto-unavailable");
    expectCode(await rejectionOf(aesGcmDecrypt(key, repeat(1, 12), repeat(1, 32), new Uint8Array(0))), "crypto-unavailable");
    expectCode(await rejectionOf(hmacSha256(hmacKey, ascii("x"))), "crypto-unavailable");
    expectCode(await rejectionOf(createSelfTestRunner().ensure()), "crypto-unavailable");
  });

  it("raises crypto-unavailable from the secure generator when getRandomValues is missing", () => {
    vi.stubGlobal("crypto", { subtle: crypto.subtle });
    expect(() => secureRandom(16)).toThrowError(CryptoError);
    try {
      secureRandom(16);
    } catch (error) {
      expectCode(error, "crypto-unavailable");
    }
  });
});

describe("randomness", () => {
  it("draws 100,000 distinct segment nonces from the secure generator", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(Buffer.from(randomNonce(secureRandom)).toString("hex"));
    expect(seen.size).toBe(100_000);
  }, 60_000);

  it("returns the requested length, also above the 65,536-byte getRandomValues limit", () => {
    expect(secureRandom(0)).toHaveLength(0);
    expect(secureRandom(200_000)).toHaveLength(200_000);
    expectCode((() => { try { secureRandom(-1); } catch (error) { return error; } return undefined; })(), "invalid-argument");
  });

  it("refuses an injected source that returns the wrong number of bytes", () => {
    expect(() => randomBytes(() => new Uint8Array(5), 12)).toThrowError(CryptoError);
  });

  it("maps every byte value to a symbol without modulo bias (each of 32 symbols has exactly 8 preimages)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const mapped = randomSymbolBytes(() => new Uint8Array(all), 256, alphabet);
    const counts = new Map<number, number>();
    for (const symbol of mapped) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
    expect(String.fromCharCode(...randomSymbolBytes(() => new Uint8Array([0, 25, 26, 31, 32, 255]), 6, alphabet))).toBe("AZ27A7");
  });

  it("refuses an alphabet whose length is not a power of two", () => {
    expect(() => randomSymbolBytes(secureRandom, 4, "ABC")).toThrowError(CryptoError);
    expect(() => randomSymbolBytes(secureRandom, 4, "A")).toThrowError(CryptoError);
  });
});

describe("byte helpers", () => {
  it("constantTimeEqual compares equal-length values and rejects different lengths", () => {
    expect(constantTimeEqual(hex("0102"), hex("0102"))).toBe(true);
    expect(constantTimeEqual(hex("0102"), hex("0103"))).toBe(false);
    expect(constantTimeEqual(hex("01"), hex("0102"))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("encodes unsigned 32-bit and 64-bit big-endian, including an index above 2^32", () => {
    expect(Buffer.from(u32be(0x01020304)).toString("hex")).toBe("01020304");
    expect(Buffer.from(u32be(0xffffffff)).toString("hex")).toBe("ffffffff");
    expect(Buffer.from(u64be(0)).toString("hex")).toBe("0000000000000000");
    expect(Buffer.from(u64be(2 ** 32 + 5)).toString("hex")).toBe("0000000100000005");
    expect(Buffer.from(u64be(Number.MAX_SAFE_INTEGER)).toString("hex")).toBe("001fffffffffffff");
    expect(() => u32be(2 ** 32)).toThrowError(CryptoError);
    expect(() => u32be(-1)).toThrowError(CryptoError);
    expect(() => u64be(2 ** 53)).toThrowError(CryptoError);
    expect(() => u64be(1.5)).toThrowError(CryptoError);
  });

  it("wipe overwrites in place and tolerates undefined", () => {
    const secret = hex("aabbcc");
    wipe(secret, undefined);
    expect([...secret]).toEqual([0, 0, 0]);
  });
});

describe("lone surrogates", () => {
  it("detects unpaired surrogates without a look-behind regular expression", async () => {
    const { hasLoneSurrogate } = await import("../../src/crypto");
    expect(hasLoneSurrogate("plain ascii")).toBe(false);
    expect(hasLoneSurrogate("emoji 😀 paired")).toBe(false);
    expect(hasLoneSurrogate("\ud83d")).toBe(true);
    expect(hasLoneSurrogate("\ude00")).toBe(true);
    expect(hasLoneSurrogate("\ude00\ud83d")).toBe(true);
    expect(hasLoneSurrogate("a\ud800b")).toBe(true);
    expect(hasLoneSurrogate("\ud83d😀")).toBe(true);
    expect(hasLoneSurrogate("")).toBe(false);
  });
});
