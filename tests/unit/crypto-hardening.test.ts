// Early-gate (review-2) fixes G-01 to G-04, G-08, G-11, G-12: negative tests for the public surface.
import { describe, expect, it } from "vitest";
import * as publicCrypto from "../../src/crypto";
import { CryptoError, createBlobEncryption, createKeySlots, decryptBlob, decryptBlobBytes, encryptBlobBytes, blobNameFor, parseKeySlots, serializeKeySlots, unlockKeySlots, unlockKeySlotsBytes, utf8, type CanonicalPassphrase,
  type GeneratedPassphrase, type Bytes } from "../../src/crypto";
import { encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { blobLength, decryptBlobBytesUnchecked } from "../../src/crypto/blob";
import { unlockKeySlotsInternal, createKeySlotsInternal } from "../../src/crypto/key-slots";
import { secureRandom } from "../../src/crypto/random";
import { createFilesMap, encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { codeOf, keysFrom } from "../vectors/blob-helpers";
import { manifestFor } from "../vectors/manifest-helpers";
import { FLOOR_PARAMS, countingFakeKdf, createWithFakeKdf, otherPassphrase, referenceGenerated, referencePassphrase, unlockBytesWith } from "../vectors/slot-helpers";

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CryptoError ? error.code : `raw:${String(error)}`;
  }
  return "no-error";
}

const asPassphrase = (bytes: Uint8Array): CanonicalPassphrase => bytes as unknown as CanonicalPassphrase;

describe("G-01: the public surface takes data only", () => {
  it("does not export any injectable variant, KDF, randomness or test hook", () => {
    const names = Object.keys(publicCrypto);
    for (const banned of [
      "unwrapVckInternal", "unlockKeySlotsInternal", "createKeySlotsInternal", "createBlobEncryptionWith", "encryptBlobBytesWith",
      "decryptBlobUnchecked", "decryptBlobBytesUnchecked", "encryptManifestEnvelopeWith", "generatePassphraseWith", "createSelfTestRunner",
      "PLATFORM_PRIMITIVES", "deriveKek", "randomBytes", "randomNonce", "randomSymbolBytes", "secureRandom", "createVaultKeys", "createVaultKeysFromHex",
      "argon2idRaw", "unwrapVckForTest", "markParsed", "assertParsed",
      // N2-04: raw primitives that accept caller nonces or keys, and the raw manifest envelope
      "aesGcmEncrypt", "aesGcmDecrypt", "importAesGcmKey", "importHkdfKey", "hkdfSha256", "deriveAesGcmKey", "deriveHmacKey", "importHmacKey", "hmacSha256",
      "encryptManifestEnvelope", "decryptManifestEnvelope", "manifestAad", "blobSegmentAad", "buildBlobHeader", "blobNameBytes", "blobNameFromKey",
      "parseStrictJson", "serializeCanonical", "ensureSelfTest", "computePassphraseCheck",
    ]) expect(names, banned).not.toContain(banned);
  });

  it("a deps option smuggled into the public unlock is ignored: the real KDF runs and the self-test is not skipped", async () => {
    const created = await createKeySlots({ passphrase: referenceGenerated(), params: FLOOR_PARAMS });
    const fake = countingFakeKdf();
    const smuggled = { document: parseKeySlots(created.bytes), passphrase: referencePassphrase(), deps: { kdf: fake.kdf, selfTest: async () => { throw new Error("skipped"); } } };
    const unlocked = await unlockKeySlots(smuggled);
    expect(unlocked.keys.vaultId).toBe(created.keys.vaultId);
    expect(fake.calls()).toBe(0);
  }, 60_000);

  it("a random option smuggled into the public blob and manifest encryptors is ignored", async () => {
    const keys = await keysFrom(1, 2);
    const name = await blobNameFor(keys, "a.md");
    const zeros = (length: number): Bytes => new Uint8Array(length);
    const params = { keys, nodeName: name, size: 5, random: zeros, exponent: 16 };
    const a = await createBlobEncryption(params);
    const b = await createBlobEncryption(params);
    expect(a.fileId).not.toBe(b.fileId);
    expect(a.fileId).not.toBe("00".repeat(16));
    expect(a.exponent).toBe(23);
    const smuggledEncrypt = encryptBlobBytes as unknown as (k: unknown, n: string, p: Bytes, o: unknown) => Promise<{ fileId: string }>;
    expect((await smuggledEncrypt(keys, name, utf8("x"), { random: zeros })).fileId).not.toBe("00".repeat(16));
    const envelope = encryptManifestEnvelope as unknown as (k: unknown, p: Bytes, r: unknown) => Promise<Bytes>;
    const first = await envelope(keys, utf8("{}"), zeros);
    const second = await envelope(keys, utf8("{}"), zeros);
    expect(Buffer.from(first.slice(5, 17)).toString("hex")).not.toBe(Buffer.from(second.slice(5, 17)).toString("hex"));
  });

  it("types reject the injectable options at compile time", () => {
    // @ts-expect-error deps is not part of the public unlock input
    const a: Parameters<typeof unlockKeySlots>[0] = { document: undefined as never, passphrase: referencePassphrase(), deps: {} };
    // @ts-expect-error random is not part of the public creation input
    const b: Parameters<typeof createKeySlots>[0] = { passphrase: referencePassphrase(), random: secureRandom };
    // @ts-expect-error random is not part of the public blob encryption input
    const c: Parameters<typeof createBlobEncryption>[0] = { keys: undefined as never, nodeName: "", size: 0, random: secureRandom };
    expect([a, b, c]).toHaveLength(3);
  });
});

describe("G-02: branded passphrase and parsed document", () => {
  const bad: readonly [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["24 valid symbols", utf8("HEZVIDN7IBGLQIXB5L7VARDH")],
    ["26 symbols", utf8("HEZVIDN7IBGLQIXB5L7VARDHCA")],
    ["hyphenated display form", utf8("HEZVI-DN7IB-GLQIX-B5L7V-ARDHC")],
    ["lower case", utf8("hezvidn7ibglqixb5l7vardhc")],
    ["a chosen phrase", utf8("Correct Horse Battery Staple")],
    ["25 zero bytes", new Uint8Array(25)],
    ["25 valid-alphabet symbols with a bad check", utf8("HEZVIDN7IBGLQIXB5L7VARDHD")],
  ];

  for (const [label, bytes] of bad) {
    it(`create and unlock refuse ${label} with passphrase-format before any derivation`, async () => {
      const fake = countingFakeKdf();
      const created = await createWithFakeKdf(fake);
      const before = fake.calls();
      expect(await code(createKeySlotsInternal({ passphrase: asPassphrase(bytes) as unknown as GeneratedPassphrase, params: FLOOR_PARAMS }, secureRandom, { kdf: fake.kdf }))).toBe("passphrase-format");
      expect(await code(unlockBytesWith(created.bytes, asPassphrase(bytes), fake))).toBe("passphrase-format");
      expect(await code(createKeySlots({ passphrase: asPassphrase(bytes) as unknown as GeneratedPassphrase }))).toBe("passphrase-format");
      expect(await code(unlockKeySlotsBytes(created.bytes, asPassphrase(bytes)))).toBe("passphrase-format");
      expect(fake.calls()).toBe(before);
    });
  }

  it("unlock refuses a document that did not come from parseKeySlots (JSON.parse, hand-built), without deriving", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const viaJson = JSON.parse(new TextDecoder().decode(created.bytes));
    const before = fake.calls();
    for (const document of [viaJson, { ...created.document }, { version: 1, vaultId: "00".repeat(16), slots: [{ type: "future" }] }]) {
      expect(await code(unlockKeySlotsInternal({ document, passphrase: referencePassphrase() }, { kdf: fake.kdf }))).toBe("invalid-argument");
    }
    expect(fake.calls()).toBe(before);
    // The parsed and the created documents are accepted and frozen.
    expect(Object.isFrozen(created.document)).toBe(true);
    await unlockKeySlotsInternal({ document: created.document, passphrase: referencePassphrase() }, { kdf: fake.kdf });
    await unlockKeySlotsInternal({ document: parseKeySlots(created.bytes), passphrase: referencePassphrase() }, { kdf: fake.kdf });
  });

  it("slots are discriminated by their type field: an unknown-type slot is skipped, never mistaken for a passphrase slot", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const doc = parseKeySlots(created.bytes);
    const withUnknown = serializeKeySlots({ ...doc, slots: [{ type: "future", raw: { type: "future", secret: "x" } }, ...doc.slots] });
    const parsed = parseKeySlots(withUnknown);
    expect(parsed.slots[0]?.type).toBe("future");
    const unlocked = await unlockBytesWith(withUnknown, referencePassphrase(), fake);
    expect(unlocked.keys.vaultId).toBe(doc.vaultId);
  });
});

describe("G-03: decryptBlob is bound to the manifest entry", () => {
  async function fixtureBlob(size = 300) {
    const keys = await keysFrom(3, 4);
    const name = await blobNameFor(keys, "bound.md");
    const plain = secureRandom(size);
    const { blob, fileId } = await encryptBlobBytes(keys, name, plain);
    return { keys, name, plain, blob, fileId, size };
  }

  it("requires expectedFileId and expectedSize", async () => {
    const { keys, name, blob } = await fixtureBlob();
    const call = decryptBlob as unknown as (input: unknown) => AsyncGenerator<Bytes>;
    expect(() => call({ keys, nodeName: name, totalLength: blob.length, source: blob })).toThrowError(CryptoError);
    expect(() => call({ keys, nodeName: name, totalLength: blob.length, source: blob, expectedFileId: "00" })).toThrowError(CryptoError);
    const bytesCall = decryptBlobBytes as unknown as (k: unknown, n: string, b: Uint8Array) => Promise<Bytes>;
    expect(await code(bytesCall(keys, name, blob))).toBe("invalid-argument");
  });

  it("accepts the authentic blob with the right identifier and size", async () => {
    const { keys, name, blob, fileId, size, plain } = await fixtureBlob();
    expect(Buffer.compare(await decryptBlobBytes(keys, name, blob, fileId, size), plain)).toBe(0);
  });

  it("refuses a wrong size before any segment is decrypted (an old large genuine blob is not streamed)", async () => {
    const { keys, name, blob, fileId, size } = await fixtureBlob();
    for (const wrong of [size - 1, size + 1, 0, 2 ** 24]) {
      let yielded = 0;
      const error = await (async () => {
        try {
          for await (const part of decryptBlob({ keys, nodeName: name, totalLength: blob.length, source: blob, expectedFileId: fileId, expectedSize: wrong })) yielded += part.length + 1;
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(codeOf(error)).toBe("vault-mismatch");
      expect(yielded).toBe(0);
    }
  });

  it("refuses an authentic OLD blob of the same name whose file identifier the manifest no longer lists (replay)", async () => {
    const { keys, name, fileId, size } = await fixtureBlob();
    const older = await encryptBlobBytes(keys, name, secureRandom(size));
    expect(older.fileId).not.toBe(fileId);
    expect(await code(decryptBlobBytes(keys, name, older.blob, fileId, size))).toBe("vault-mismatch");
    expect(blobLength(size)).toBe(older.blob.length);
    // The test-only unchecked variant still decrypts it: the binding is what stops the replay.
    expect((await decryptBlobBytesUnchecked(keys, name, older.blob)).length).toBe(size);
  });

  it("requires totalLength to equal blobLength(expectedSize, exponent) for multi-segment blobs too", async () => {
    const keys = await keysFrom(3, 4);
    const name = await blobNameFor(keys, "multi.bin");
    const { encryptBlobBytesWith } = await import("../../src/crypto/blob");
    const plain = secureRandom(2 * 65_536 + 7);
    const { blob, fileId } = await encryptBlobBytesWith(keys, name, plain, { exponent: 16 });
    expect(Buffer.compare(await decryptBlobBytes(keys, name, blob, fileId, plain.length), plain)).toBe(0);
    expect(await code(decryptBlobBytes(keys, name, blob, fileId, 2 * 65_536))).toBe("vault-mismatch");
    expect(blob.length).toBe(blobLength(plain.length, 16));
  });
});

describe("G-04: the cost policy", () => {
  const HIGH = { m: 98_304, t: 3, p: 1 };

  async function twoHighSlots(fake: ReturnType<typeof countingFakeKdf>) {
    const created = await createWithFakeKdf(fake, referencePassphrase(), HIGH);
    const doc = parseKeySlots(created.bytes);
    return serializeKeySlots({ ...doc, slots: [doc.slots[0], doc.slots[0]] as unknown as typeof doc.slots });
  }

  it("refuses an above-default slot with no policy and no callback, naming the cost, and derives nothing", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake, referencePassphrase(), HIGH);
    const before = fake.calls();
    const error = await unlockBytesWith(created.bytes, referencePassphrase(), fake).catch((e: unknown) => e as CryptoError);
    expect((error as CryptoError).code).toBe("kdf-cost-refused");
    expect((error as CryptoError).message).toContain("96 MiB");
    expect(fake.calls()).toBe(before);
  });

  it("accepts it when the host callback approves, and refuses when it declines", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake, referencePassphrase(), HIGH);
    const seen: unknown[] = [];
    await unlockBytesWith(created.bytes, referencePassphrase(), fake, { costPolicy: { approveCost: async (params) => (seen.push(params), true) } });
    expect(seen).toEqual([HIGH]);
    const before = fake.calls();
    expect(await code(unlockBytesWith(created.bytes, referencePassphrase(), fake, { costPolicy: { approveCost: async () => false } }))).toBe("kdf-cost-refused");
    expect(fake.calls()).toBe(before);
  });

  it("calls the callback once per tried slot above the limit, all before the first derivation", async () => {
    const fake = countingFakeKdf();
    const bytes = await twoHighSlots(fake);
    const log: string[] = [];
    const before = fake.calls();
    const spyKdf = { kdf: async (...args: Parameters<typeof fake.kdf>) => (log.push("kdf"), fake.kdf(...args)), calls: fake.calls };
    await unlockBytesWith(bytes, otherPassphrase(), spyKdf, { costPolicy: { approveCost: async () => (log.push("approve"), true) } }).catch(() => undefined);
    expect(log).toEqual(["approve", "approve", "kdf", "kdf"]);
    expect(fake.calls() - before).toBe(2);
  });

  it("does not ask for a slot within the default cost, and a custom maxCost raises the bar", async () => {
    const fake = countingFakeKdf();
    const cheap = await createWithFakeKdf(fake);
    let asked = 0;
    await unlockBytesWith(cheap.bytes, referencePassphrase(), fake, { costPolicy: { approveCost: async () => (asked++, true) } });
    expect(asked).toBe(0);
    const high = await createWithFakeKdf(fake, referencePassphrase(), HIGH);
    await unlockBytesWith(high.bytes, referencePassphrase(), fake, { costPolicy: { maxCost: HIGH } });
    expect(await code(unlockBytesWith(high.bytes, referencePassphrase(), fake, { costPolicy: { maxCost: { m: 65_536, t: 3, p: 1 } } }))).toBe("kdf-cost-refused");
  });
});

describe("G-08: zeroization is real for what the core owns", () => {
  const recording = () => {
    const returned: Uint8Array[] = [];
    const counter = countingFakeKdf();
    return {
      returned,
      counter: {
        calls: counter.calls,
        kdf: async (...args: Parameters<typeof counter.kdf>) => {
          const kek = await counter.kdf(...args);
          returned.push(kek);
          return kek;
        },
      },
    };
  };
  const zeroed = (arrays: readonly Uint8Array[]): boolean => arrays.length > 0 && arrays.every((a) => a.every((byte) => byte === 0));

  it("wipes the KEK the KDF returned after create, after a successful unlock, a wrong passphrase and a commitment mismatch", async () => {
    const setup = recording();
    const created = await createWithFakeKdf(setup.counter);
    expect(zeroed(setup.returned)).toBe(true);

    for (const [label, passphrase, doc] of [
      ["success", referencePassphrase(), created.bytes],
      ["wrong passphrase", otherPassphrase(), created.bytes],
    ] as const) {
      const run = recording();
      await unlockBytesWith(doc, passphrase, run.counter).catch(() => undefined);
      expect(zeroed(run.returned), label).toBe(true);
    }
    const damaged = new TextDecoder().decode(created.bytes).replace(/("commit": ")./, (_m, p: string) => `${p}${"A"}`);
    const run = recording();
    await unlockBytesWith(utf8(damaged), referencePassphrase(), run.counter).catch(() => undefined);
    expect(zeroed(run.returned)).toBe(true);
  });

  it("wipes the KEK also when the derivation after the KDF fails (platform error path)", async () => {
    const run = recording();
    const created = await createWithFakeKdf(countingFakeKdf());
    const { vi } = await import("vitest");
    const spy = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new TypeError("boom"));
    try {
      expect(await code(unlockBytesWith(created.bytes, referencePassphrase(), run.counter))).toBe("platform-failure");
    } finally {
      spy.mockRestore();
    }
    expect(zeroed(run.returned)).toBe(true);
  });
});

describe("G-11: a plain-object files map is refused, not silently truncated", () => {
  it("encodeManifestFile refuses a files map that is not prototype-free", async () => {
    const keys = await keysFrom(1, 2);
    const good = await manifestFor(keys, ["a.md"]);
    const plain: EncryptedManifest = { ...good, files: { ...good.files } };
    const error = await encodeManifestFile(keys, plain).catch((e: unknown) => e as CryptoError);
    expect((error as CryptoError).code).toBe("malformed-input");
    const withProto = {} as Record<string, unknown>;
    withProto["__proto__"] = good.files["a.md"];
    expect(Object.keys(withProto)).toHaveLength(0);
    expect(await code(encodeManifestFile(keys, { ...good, files: withProto as never }))).toBe("malformed-input");
    expect((await encodeManifestFile(keys, { ...good, files: createFilesMap(Object.entries(good.files)) })).sizes.entries).toBe(1);
  });
});

describe("G-12 and N2-01: the reader is linear in tiny chunks and releases what it has consumed", () => {
  it("consumed chunks are released at once, never retained until compaction", async () => {
    const { ByteReader } = await import("../../src/crypto/blob");
    const chunk = (): Uint8Array => new Uint8Array(10).fill(1);
    const source = (async function* () {
      for (let i = 0; i < 5000; i++) yield chunk();
    })();
    const reader = new ByteReader(source, 50_000);
    for (let round = 0; round < 40; round++) {
      await reader.take(1000);
      expect(reader.retainedConsumed()).toBe(0);
    }
    // a partly consumed chunk stays until its last byte is taken
    await reader.take(5);
    await reader.take(5);
    expect(reader.retainedConsumed()).toBe(0);
  });

  it("decrypts a 300 KB blob delivered one byte at a time in reasonable time", async () => {
    const keys = await keysFrom(5, 6);
    const name = await blobNameFor(keys, "trickle.bin");
    const plain = secureRandom(300_000);
    const { blob, fileId } = await encryptBlobBytes(keys, name, plain);
    const source = (async function* () {
      for (let i = 0; i < blob.length; i++) yield blob.subarray(i, i + 1);
    })();
    const started = performance.now();
    const parts: Bytes[] = [];
    for await (const part of decryptBlob({ keys, nodeName: name, totalLength: blob.length, source, expectedFileId: fileId, expectedSize: plain.length })) parts.push(part);
    expect(Buffer.compare(Buffer.concat(parts), plain)).toBe(0);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
