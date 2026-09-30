import { argon2Sync } from "node:crypto";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError, DEFAULT_KDF_PARAMS, KDF_ITERATIONS_CEILING, KDF_MEMORY_CEILING_KIB, KDF_MEMORY_FLOOR_KIB, KDF_SALT_BYTES, KdfParamsError, PASSPHRASE_ALPHABET, PASSPHRASE_LENGTH, PassphraseFormatError, assertKdfParams, canonicalizePassphrase, canonicalizePassphraseText, describeKdfCost, exceedsDefaultCost, formatPassphrase, generatePassphrase, utf8 } from "../../src/crypto";
import { computePassphraseCheck } from "../../src/crypto/passphrase";
import { secureRandom } from "../../src/crypto/random";
import { deriveKek } from "../../src/crypto/argon2";
import { generatePassphraseWith } from "../../src/crypto/passphrase";
import { argon2idRaw } from "../../src/crypto/testing/argon2id-raw";
import { RFC9106_ARGON2ID } from "../vectors/argon2-rfc9106";
import { repeat } from "../vectors/bytes";
import { CHECK_VECTORS, REJECTED_PHRASES, VALID_PASSPHRASE } from "../vectors/passphrase";

const text = (bytes: Uint8Array): string => String.fromCharCode(...bytes);
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function code(action: () => unknown): PassphraseFormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PassphraseFormatError);
    expect((error as CryptoError).code).toBe("passphrase-format");
    return error as PassphraseFormatError;
  }
  throw new Error("expected passphrase-format");
}

describe("Argon2id (@noble/hashes) against independent implementations", () => {
  it("matches the RFC 9106 section 5.3 vector through the test-only raw entry", async () => {
    const v = RFC9106_ARGON2ID;
    const tag = await argon2idRaw({ password: v.password, salt: v.salt, m: v.m, t: v.t, p: v.p, dkLen: v.dkLen, secret: v.secret, associatedData: v.associatedData });
    expect(hexOf(tag)).toBe(hexOf(v.tag));
  });

  it("the recorded RFC 9106 tag equals Node's crypto.argon2Sync (independent implementation)", () => {
    const v = RFC9106_ARGON2ID;
    const tag = argon2Sync("argon2id", { message: v.password, nonce: v.salt, parallelism: v.p, tagLength: v.dkLen, memory: v.m, passes: v.t, secret: v.secret, associatedData: v.associatedData });
    expect(hexOf(new Uint8Array(tag))).toBe(hexOf(v.tag));
  });

  it("the public wrapper refuses the RFC 9106 parameters as below the floors", async () => {
    const v = RFC9106_ARGON2ID;
    const error = await deriveKek(v.password, v.salt, { m: v.m, t: v.t, p: v.p }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KdfParamsError);
    expect((error as KdfParamsError).parameter).toBe("memory");
  });

  it("matches Node's crypto.argon2Sync at the floor parameters (19,456 KiB, t=2, p=1)", async () => {
    const password = utf8(VALID_PASSPHRASE.canonical);
    const salt = repeat(0x5c, 16);
    const ours = await deriveKek(password, salt, { m: KDF_MEMORY_FLOOR_KIB, t: 2, p: 1 });
    const theirs = argon2Sync("argon2id", { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: KDF_MEMORY_FLOOR_KIB, passes: 2 });
    expect(hexOf(ours)).toBe(hexOf(new Uint8Array(theirs)));
  }, 60_000);

  it("matches Node's crypto.argon2Sync at the default parameters (64 MiB, t=3, p=1) and reports progress", async () => {
    const password = utf8(VALID_PASSPHRASE.canonical);
    const salt = repeat(0xa7, 16);
    const progress: number[] = [];
    const ours = await deriveKek(password, salt, DEFAULT_KDF_PARAMS, (fraction: number) => progress.push(fraction));
    const theirs = argon2Sync("argon2id", { message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3 });
    expect(hexOf(ours)).toBe(hexOf(new Uint8Array(theirs)));
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.every((f) => f >= 0 && f <= 1)).toBe(true);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  }, 120_000);
});

describe("KDF parameter bounds", () => {
  it("accepts the floors, the defaults and the ceilings", () => {
    expect(() => assertKdfParams({ m: 19_456, t: 2, p: 1 })).not.toThrow();
    expect(() => assertKdfParams(DEFAULT_KDF_PARAMS)).not.toThrow();
    expect(() => assertKdfParams({ m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: 1 })).not.toThrow();
    expect(DEFAULT_KDF_PARAMS).toEqual({ m: 65_536, t: 3, p: 1 });
  });

  const salt = repeat(1, KDF_SALT_BYTES);
  const refused: readonly { name: string; params: { m: number; t: number; p: number }; parameter: string }[] = [
    { name: "1,024 KiB", params: { m: 1_024, t: 3, p: 1 }, parameter: "memory" },
    { name: "one KiB below the floor", params: { m: 19_455, t: 3, p: 1 }, parameter: "memory" },
    { name: "one KiB above the ceiling", params: { m: 131_073, t: 3, p: 1 }, parameter: "memory" },
    { name: "4 GiB", params: { m: 4 * 1024 * 1024, t: 3, p: 1 }, parameter: "memory" },
    { name: "fractional memory", params: { m: 65_536.5, t: 3, p: 1 }, parameter: "memory" },
    { name: "1 iteration", params: { m: 65_536, t: 1, p: 1 }, parameter: "iterations" },
    { name: "5 iterations", params: { m: 65_536, t: 5, p: 1 }, parameter: "iterations" },
    { name: "parallelism 2", params: { m: 65_536, t: 3, p: 2 }, parameter: "parallelism" },
    { name: "parallelism 0", params: { m: 65_536, t: 3, p: 0 }, parameter: "parallelism" },
  ];
  for (const { name, params, parameter } of refused) {
    it(`refuses ${name} naming the ${parameter} parameter, before allocating`, async () => {
      const before = process.memoryUsage().arrayBuffers;
      const started = performance.now();
      const error = await deriveKek(repeat(2, 25), salt, params).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KdfParamsError);
      expect((error as KdfParamsError).parameter).toBe(parameter);
      expect((error as KdfParamsError).code).toBe("kdf-params-out-of-bounds");
      expect(performance.now() - started).toBeLessThan(500);
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
    });
  }

  it("refuses a salt that is not 16 bytes", async () => {
    const error = await deriveKek(repeat(2, 25), repeat(1, 15), DEFAULT_KDF_PARAMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KdfParamsError);
    expect((error as KdfParamsError).parameter).toBe("salt");
  });

  it("flags costs above the defaults and describes them", () => {
    expect(exceedsDefaultCost(DEFAULT_KDF_PARAMS)).toBe(false);
    expect(exceedsDefaultCost({ m: 98_304, t: 3, p: 1 })).toBe(true);
    expect(exceedsDefaultCost({ m: 65_536, t: 4, p: 1 })).toBe(true);
    expect(describeKdfCost(DEFAULT_KDF_PARAMS)).toBe("64 MiB, 3 iterations");
  });
});

describe("generated passphrase check", () => {
  for (const { body, check } of CHECK_VECTORS) {
    it(`check of ${body} is ${check} (fixed-output regression pin, also computed with node:crypto)`, () => {
      expect(text(computePassphraseCheck(utf8(body)))).toBe(check);
      const digest = createHash("sha256").update(`ipfs-sync/passphrase/check/v1${body}`).digest();
      const independent = PASSPHRASE_ALPHABET[(digest[0] ?? 0) >> 3] + (PASSPHRASE_ALPHABET[(((digest[0] ?? 0) & 7) << 2) | ((digest[1] ?? 0) >> 6)] ?? "");
      expect(independent).toBe(check);
    });
  }

  it("validates the pinned reference passphrase in display, lower-case and separator-free forms", () => {
    for (const form of [VALID_PASSPHRASE.display, VALID_PASSPHRASE.display.toLowerCase(), VALID_PASSPHRASE.canonical, VALID_PASSPHRASE.canonical.toLowerCase(), "HEZVI DN7IB GLQIX B5L7V ARDHC", " hezvi-dn7ib glqix-b5l7v ardhc "]) {
      expect(text(canonicalizePassphraseText(form))).toBe(VALID_PASSPHRASE.canonical);
      expect(text(canonicalizePassphrase(utf8(form)))).toBe(VALID_PASSPHRASE.canonical);
    }
  });

  it("rejects the pinned phrases with the check reason, expected check YK and presented LE", () => {
    for (const { text: phrase, expectedCheck, presentedCheck } of REJECTED_PHRASES) {
      const error = code(() => canonicalizePassphraseText(phrase));
      expect(error.reason).toBe("check");
      const letters = phrase.replace(/ /g, "").toUpperCase();
      expect(letters).toHaveLength(25);
      expect(text(computePassphraseCheck(utf8(letters.slice(0, 23))))).toBe(expectedCheck);
      expect(letters.slice(23)).toBe(presentedCheck);
      expect(error.message).not.toContain(phrase);
    }
  });

  it("rejects 24 and 26 valid symbols, empty input, other alphabets and oversize input", () => {
    const valid = VALID_PASSPHRASE.canonical;
    expect(code(() => canonicalizePassphraseText(valid.slice(0, 24))).reason).toBe("length");
    expect(code(() => canonicalizePassphraseText(`${valid}A`)).reason).toBe("length");
    expect(code(() => canonicalizePassphraseText("")).reason).toBe("length");
    expect(code(() => canonicalizePassphraseText("-- --")).reason).toBe("length");
    expect(code(() => canonicalizePassphraseText(`${valid.slice(0, 24)}1`)).reason).toBe("alphabet");
    expect(code(() => canonicalizePassphraseText(`${valid.slice(0, 24)}8`)).reason).toBe("alphabet");
    expect(code(() => canonicalizePassphraseText(`${valid.slice(0, 24)}É`)).reason).toBe("alphabet");
    expect(code(() => canonicalizePassphraseText(`${valid.slice(0, 24)}_`)).reason).toBe("alphabet");
    expect(code(() => canonicalizePassphraseText(`${valid.slice(0, 12)}‐${valid.slice(12)}`)).reason).toBe("alphabet");
    expect(code(() => canonicalizePassphraseText("A".repeat(257))).reason).toBe("length");
    expect(code(() => canonicalizePassphrase(new Uint8Array(300))).reason).toBe("length");
  });

  it("rejects a changed check symbol at either check position, for every other symbol", () => {
    const valid = VALID_PASSPHRASE.canonical;
    for (const position of [23, 24]) {
      for (const symbol of PASSPHRASE_ALPHABET) {
        if (symbol === valid[position]) continue;
        const mutated = `${valid.slice(0, position)}${symbol}${valid.slice(position + 1)}`;
        expect(code(() => canonicalizePassphraseText(mutated)).reason).toBe("check");
      }
    }
  });

  it("generates 25 symbols (23 random plus 2 valid check symbols) that always validate", () => {
    const generated = generatePassphrase();
    expect(generated).toHaveLength(PASSPHRASE_LENGTH);
    expect(text(generated)).toMatch(/^[A-Z2-7]{25}$/);
    expect(formatPassphrase(generated)).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}$/);
    expect(text(canonicalizePassphrase(generated))).toBe(text(generated));
  });

  it("generates deterministically from an injected source (test-only) using byte & 31 on 23 bytes", () => {
    const source = Uint8Array.from({ length: 23 }, (_, i) => i * 11);
    const generated = generatePassphraseWith(() => new Uint8Array(source));
    const expectedBody = [...source].map((b) => PASSPHRASE_ALPHABET[b & 31]).join("");
    expect(text(generated).slice(0, 23)).toBe(expectedBody);
    expect(text(generated).slice(23)).toBe(text(computePassphraseCheck(utf8(expectedBody))));
  });

  it("validates 10,000 random generated passphrases, and single-symbol changes are rejected at least 99.8% of the time", () => {
    let mutations = 0;
    let rejected = 0;
    let checkPositionMutations = 0;
    let checkPositionRejected = 0;
    const randomIndex = new Uint32Array(1);
    for (let n = 0; n < 10_000; n++) {
      const generated = text(generatePassphrase());
      expect(text(canonicalizePassphraseText(generated))).toBe(generated);
      for (let position = 0; position < PASSPHRASE_LENGTH; position++) {
        crypto.getRandomValues(randomIndex);
        const original = PASSPHRASE_ALPHABET.indexOf(generated[position] ?? "");
        const symbol = PASSPHRASE_ALPHABET[(original + 1 + ((randomIndex[0] ?? 0) % 31)) % 32];
        const mutated = `${generated.slice(0, position)}${symbol}${generated.slice(position + 1)}`;
        let accepted = true;
        try {
          canonicalizePassphraseText(mutated);
        } catch {
          accepted = false;
        }
        mutations++;
        if (!accepted) rejected++;
        if (position >= 23) {
          checkPositionMutations++;
          if (!accepted) checkPositionRejected++;
        }
      }
    }
    // A mistyped body symbol is caught with probability about 99.9% (1 - 1/1024); a mistyped check symbol always.
    expect(checkPositionRejected).toBe(checkPositionMutations);
    expect(rejected / mutations).toBeGreaterThanOrEqual(0.998);
  }, 120_000);

  it("draws symbol frequencies consistent with uniformity for the random part (chi-square, df 31)", () => {
    const counts = new Array<number>(32).fill(0);
    const total = 32_000;
    for (let n = 0; n < total / 23; n++) {
      for (const symbol of generatePassphrase().subarray(0, 23)) counts[PASSPHRASE_ALPHABET.indexOf(String.fromCharCode(symbol))]!++;
    }
    const drawn = counts.reduce((a, b) => a + b, 0);
    const expected = drawn / 32;
    const chi = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // p = 1e-7 critical value for 31 degrees of freedom is about 90; a fair generator stays far below it.
    expect(chi).toBeLessThan(90);
  });

  it("a generated passphrase typed in lower case with or without separators derives the same key", async () => {
    const generated = generatePassphrase();
    const salt = repeat(0x33, 16);
    const params = { m: KDF_MEMORY_FLOOR_KIB, t: 2, p: 1 };
    const forms = [formatPassphrase(generated), text(generated).toLowerCase()];
    const keys = await Promise.all(forms.map((form) => deriveKek(canonicalizePassphraseText(form), salt, params)));
    expect(hexOf(keys[0]!)).toBe(hexOf(keys[1]!));
  }, 60_000);

  it("refuses to format anything but 25 symbols", () => {
    expect(() => formatPassphrase(new Uint8Array(24))).toThrowError(PassphraseFormatError);
  });
});
