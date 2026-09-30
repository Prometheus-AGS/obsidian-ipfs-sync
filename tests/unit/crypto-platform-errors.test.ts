// G-07 and G-08: platform failures surface as typed errors, never raw ones; noble's output array is wiped.
import { afterEach, describe, expect, it, vi } from "vitest";

const noble = vi.hoisted(() => ({ impl: undefined as undefined | ((...args: unknown[]) => Promise<Uint8Array>) }));
vi.mock("@noble/hashes/argon2.js", () => ({
  argon2idAsync: (...args: unknown[]) => (noble.impl ?? (() => Promise.reject(new Error("no impl"))))(...args),
}));

import { CryptoError } from "../../src/crypto";
import { aesGcmEncrypt, importAesGcmKey } from "../../src/crypto/aes-gcm";
import { deriveAesGcmKey, deriveHmacKey, hkdfSha256, importHkdfKey } from "../../src/crypto/hkdf";
import { hmacSha256, importHmacKey } from "../../src/crypto/hmac";
import { deriveKek, enforceCostPolicy } from "../../src/crypto/argon2";
import { KdfCostRefusedError } from "../../src/crypto";
import { aesGcmDecrypt } from "../../src/crypto/aes-gcm";
import { secureRandom } from "../../src/crypto/random";
import { repeat } from "../vectors/bytes";

afterEach(() => vi.restoreAllMocks());

async function failureOf(promise: Promise<unknown>): Promise<CryptoError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    return error as CryptoError;
  }
  throw new Error("expected a typed failure");
}

describe("Argon2id platform failures", () => {
  it("an allocation RangeError becomes a typed kdf-unaffordable refusal that names the cost and not the secret", async () => {
    noble.impl = async () => {
      throw new RangeError("Array buffer allocation failed");
    };
    const error = await failureOf(deriveKek(repeat(1, 25), repeat(2, 16), { m: 65_536, t: 3, p: 1 }));
    expect(error.code).toBe("kdf-unaffordable");
    expect(error.message).toContain("64 MiB");
    expect(error.message).not.toContain("allocation failed");
  });

  it("wipes the array noble returned after copying the key out", async () => {
    const original = new Uint8Array(32).fill(7);
    noble.impl = async () => original;
    const kek = await deriveKek(repeat(1, 25), repeat(2, 16), { m: 65_536, t: 3, p: 1 });
    expect([...kek]).toEqual(Array.from({ length: 32 }, () => 7));
    expect(original.every((byte) => byte === 0)).toBe(true);
  });
});

describe("WebCrypto platform failures", () => {
  it("importKey failures are platform-failure for HKDF, AES-GCM and HMAC keys", async () => {
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new TypeError("unsupported algorithm"));
    for (const call of [() => importHkdfKey(repeat(1, 32)), () => importAesGcmKey(repeat(1, 32)), () => importHmacKey(repeat(1, 32))]) {
      expect((await failureOf(call())).code).toBe("platform-failure");
    }
  });

  it("deriveBits, deriveKey, sign and encrypt failures are platform-failure with a fixed message", async () => {
    const base = await importHkdfKey(repeat(1, 32));
    const aes = await importAesGcmKey(repeat(2, 32));
    const mac = await importHmacKey(repeat(3, 32));
    vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("secret detail 0123"));
    vi.spyOn(crypto.subtle, "deriveKey").mockRejectedValue(new Error("secret detail 0123"));
    vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error("secret detail 0123"));
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("secret detail 0123"));
    const errors = await Promise.all([
      failureOf(hkdfSha256(base, repeat(1, 16), repeat(1, 1), 32)),
      failureOf(deriveAesGcmKey(base, repeat(1, 16), repeat(1, 1))),
      failureOf(deriveHmacKey(base, repeat(1, 16), repeat(1, 1))),
      failureOf(hmacSha256(mac, repeat(1, 4))),
      failureOf(aesGcmEncrypt(aes, repeat(1, 12), repeat(1, 4), new Uint8Array(0))),
    ]);
    for (const error of errors) {
      expect(error.code).toBe("platform-failure");
      expect(error.message).not.toContain("secret detail");
    }
  });
});

describe("N2-07: error mapping", () => {
  it("a non-RangeError from Argon2 is platform-failure, only a RangeError is kdf-unaffordable", async () => {
    noble.impl = async () => {
      throw new Error("something else");
    };
    expect((await failureOf(deriveKek(repeat(1, 25), repeat(2, 16), { m: 65_536, t: 3, p: 1 }))).code).toBe("platform-failure");
    noble.impl = async () => {
      throw new RangeError("Array buffer allocation failed");
    };
    expect((await failureOf(deriveKek(repeat(1, 25), repeat(2, 16), { m: 65_536, t: 3, p: 1 }))).code).toBe("kdf-unaffordable");
  });

  it("an error thrown by the progress callback is its own platform-failure, not 'cannot afford'", async () => {
    noble.impl = async (...args: unknown[]) => {
      (args[2] as { onProgress?: (f: number) => void }).onProgress?.(0.5);
      return new Uint8Array(32);
    };
    const error = await failureOf(deriveKek(repeat(1, 25), repeat(2, 16), { m: 65_536, t: 3, p: 1 }, () => {
      throw new RangeError("ui exploded");
    }));
    expect(error.code).toBe("platform-failure");
    expect(error.message).toContain("progress callback");
  });

  it("an approveCost callback that throws or rejects is a refusal with the structured slots", async () => {
    const high = { m: 98_304, t: 3, p: 1 };
    for (const approveCost of [async () => { throw new Error("dialog crashed"); }, () => Promise.reject(new TypeError("x")), () => { throw new Error("sync"); }, async () => "yes" as never]) {
      const error = await failureOf(enforceCostPolicy([high, { m: 65_536, t: 3, p: 1 }, high], { approveCost }));
      expect(error).toBeInstanceOf(KdfCostRefusedError);
      expect((error as KdfCostRefusedError).code).toBe("kdf-cost-refused");
      expect((error as KdfCostRefusedError).slots).toEqual([high, high]);
    }
  });

  it("getRandomValues failing is a typed platform-failure", () => {
    vi.stubGlobal("crypto", { subtle: crypto.subtle, getRandomValues: () => { throw new Error("entropy source gone"); } });
    try {
      secureRandom(16);
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as CryptoError).code).toBe("platform-failure");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only OperationError and DataError from AES-GCM decrypt are authentication failures; anything else is platform-failure", async () => {
    const key = await importAesGcmKey(repeat(4, 32));
    const sealed = repeat(1, 32);
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    decrypt.mockRejectedValueOnce(new DOMException("bad tag", "OperationError"));
    expect((await failureOf(aesGcmDecrypt(key, repeat(1, 12), sealed, new Uint8Array(0)))).code).toBe("authentication-failed");
    decrypt.mockRejectedValueOnce(new DOMException("bad data", "DataError"));
    expect((await failureOf(aesGcmDecrypt(key, repeat(1, 12), sealed, new Uint8Array(0)))).code).toBe("authentication-failed");
    decrypt.mockRejectedValueOnce(new TypeError("not an algorithm"));
    expect((await failureOf(aesGcmDecrypt(key, repeat(1, 12), sealed, new Uint8Array(0)))).code).toBe("platform-failure");
    decrypt.mockRejectedValueOnce(new DOMException("nope", "NotSupportedError"));
    expect((await failureOf(aesGcmDecrypt(key, repeat(1, 12), sealed, new Uint8Array(0)))).code).toBe("platform-failure");
  });
});
