import { describe, expect, it } from "vitest";
import { CryptoError, blobNameFor, concatBytes, createBlobEncryption, decryptBlob, decryptBlobBytes, encryptBlobBytes, parseBlobHeader, parseBlobName, utf8, type Bytes, type VaultKeys } from "../../src/crypto";
import { aesGcmEncrypt } from "../../src/crypto/aes-gcm";
import { blobSegmentAad } from "../../src/crypto/blob";
import { secureRandom } from "../../src/crypto/random";
import { encryptBlobBytesWith, decryptBlobBytesUnchecked, decryptBlobUnchecked } from "../../src/crypto/blob";
import { ascending, hex } from "../vectors/bytes";

import { codeOf, failure, keysFrom } from "../vectors/blob-helpers";

describe("tampering: every bit flip fails, with no plaintext returned", () => {
  it("flipping any single bit of a 100-byte blob (header, nonce, ciphertext or tag) fails with a typed error", async () => {
    const keys = await keysFrom(7, 8);
    const name = await blobNameFor(keys, "small.md");
    const { blob } = await encryptBlobBytes(keys, name, secureRandom(100));
    expect(blob).toHaveLength(150);
    let checked = 0;
    for (let bit = 0; bit < blob.length * 8; bit++) {
      const flipped = new Uint8Array(blob);
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      const result = await failure(keys, name, flipped);
      expect(["authentication-failed", "malformed-input", "unsupported-format"]).toContain(result.code);
      expect(result.yielded).toBe(0);
      checked++;
    }
    expect(checked).toBe(1200);
  }, 60_000);

  it("flipping sampled bits of a three-segment blob (exponent 16) fails; earlier segments may yield, the file as a whole fails", async () => {
    const keys = await keysFrom(7, 8);
    const name = await blobNameFor(keys, "three.bin");
    const { blob } = await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 1000), { exponent: 16 });
    const wire = 65_536 + 28;
    expect(blob).toHaveLength(22 + 2 * wire + 1000 + 28);
    const bits = new Set<number>();
    for (let byte = 0; byte < 22; byte++) for (let bit = 0; bit < 8; bit++) bits.add(byte * 8 + bit);
    for (let seg = 0; seg < 3; seg++) {
      const start = 22 + seg * wire;
      const end = seg < 2 ? start + wire : blob.length;
      for (let byte = start; byte < start + 12; byte++) for (let bit = 0; bit < 8; bit++) bits.add(byte * 8 + bit);
      for (let byte = end - 16; byte < end; byte++) for (let bit = 0; bit < 8; bit++) bits.add(byte * 8 + bit);
    }
    for (let byte = 22; byte < blob.length; byte += 4096) bits.add(byte * 8 + (byte % 8));
    for (const bit of bits) {
      const flipped = new Uint8Array(blob);
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      const result = await failure(keys, name, flipped);
      expect(["authentication-failed", "malformed-input", "unsupported-format"]).toContain(result.code);
    }
    expect(bits.size).toBeGreaterThan(600);
  }, 120_000);

  it("a failure in the third segment is raised after the authenticated first two were yielded", async () => {
    const keys = await keysFrom(7, 8);
    const name = await blobNameFor(keys, "three.bin");
    const { blob } = await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 1000), { exponent: 16 });
    const damaged = new Uint8Array(blob);
    damaged[damaged.length - 20] = (damaged[damaged.length - 20] ?? 0) ^ 1;
    const result = await failure(keys, name, damaged);
    expect(result).toEqual({ code: "authentication-failed", yielded: 2 });
  });

  it("truncation at every byte boundary fails (exhaustive for a 100-byte blob; header, edges and a stride for a multi-segment blob)", async () => {
    const keys = await keysFrom(7, 8);
    const name = await blobNameFor(keys, "cut.md");
    const small = (await encryptBlobBytes(keys, name, secureRandom(100))).blob;
    for (let cut = 0; cut < small.length; cut++) {
      expect((await failure(keys, name, small.slice(0, cut))).code).not.toBe("no-error");
    }
    const big = (await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 500), { exponent: 16 })).blob;
    const wire = 65_536 + 28;
    const cuts = new Set<number>();
    for (let cut = 0; cut <= 60; cut++) cuts.add(cut);
    for (const boundary of [22 + wire, 22 + 2 * wire, big.length]) {
      for (let delta = -60; delta <= 60; delta++) if (boundary + delta < big.length) cuts.add(boundary + delta);
    }
    for (let cut = 61; cut < big.length; cut += 1499) cuts.add(cut);
    for (const cut of cuts) expect((await failure(keys, name, big.slice(0, cut))).code).not.toBe("no-error");
    expect(cuts.size).toBeGreaterThan(300);
    expect((await failure(keys, name, big)).code).toBe("no-error");
  }, 120_000);
});

describe("tampering: splice, reorder, extend, other vault, other name, other identifier", () => {
  async function threeSegments() {
    const keys = await keysFrom(9, 10);
    const name = await blobNameFor(keys, "seg.bin");
    const { blob, fileId } = await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 1000), { exponent: 16 });
    const wire = 65_536 + 28;
    const segment = (i: number): Uint8Array => blob.slice(22 + i * wire, i === 2 ? blob.length : 22 + (i + 1) * wire);
    return { keys, name, blob, fileId, header: blob.slice(0, 22), segment };
  }

  it("fails when two segments are swapped, or one is repeated in place of another", async () => {
    const { keys, name, header, segment } = await threeSegments();
    expect((await failure(keys, name, concatBytes(header, segment(1), segment(0), segment(2)))).code).toBe("authentication-failed");
    expect((await failure(keys, name, concatBytes(header, segment(0), segment(0), segment(2)))).code).toBe("authentication-failed");
    expect((await failure(keys, name, concatBytes(header, segment(0), segment(1), segment(1).slice(0, 1028)))).code).not.toBe("no-error");
  });

  it("fails when the last segment is removed (truncation at a segment boundary) or a valid segment from another position is appended", async () => {
    const { keys, name, blob, header, segment } = await threeSegments();
    const withoutLast = concatBytes(header, segment(0), segment(1));
    expect((await failure(keys, name, withoutLast)).code).toBe("authentication-failed");
    expect((await failure(keys, name, concatBytes(blob, segment(0)))).code).not.toBe("no-error");
    expect((await failure(keys, name, concatBytes(blob, new Uint8Array(40)))).code).not.toBe("no-error");
    expect((await failure(keys, name, concatBytes(blob, new Uint8Array(3)))).code).not.toBe("no-error");
  });

  it("fails when a segment of the same size comes from another file or another vault", async () => {
    const { keys, name, header, segment, blob } = await threeSegments();
    const otherFile = await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 1000), { exponent: 16 });
    const wire = 65_536 + 28;
    const foreign = otherFile.blob.slice(22 + wire, 22 + 2 * wire);
    expect((await failure(keys, name, concatBytes(header, segment(0), foreign, segment(2)))).code).toBe("authentication-failed");
    const otherKeys = await keysFrom(9, 11);
    const otherName = await blobNameFor(otherKeys, "seg.bin");
    const otherVault = await encryptBlobBytesWith(otherKeys, otherName, secureRandom(2 * 65_536 + 1000), { exponent: 16 });
    const spliced = otherVault.blob.slice(22 + wire, 22 + 2 * wire);
    expect((await failure(keys, name, concatBytes(header, segment(0), spliced, segment(2)))).code).toBe("authentication-failed");
    expect((await failure(keys, name, blob)).code).toBe("no-error");
  });

  it("fails under another vault identifier, another VCK, another node name and an altered file identifier", async () => {
    const { keys, name, blob, fileId } = await threeSegments();
    expect((await failure(await keysFrom(9, 11), name, blob)).code).toBe("authentication-failed");
    expect((await failure(await keysFrom(10, 10), name, blob)).code).toBe("authentication-failed");
    expect((await failure(keys, await blobNameFor(keys, "other.bin"), blob)).code).toBe("authentication-failed");
    const altered = new Uint8Array(blob);
    altered[6] = (altered[6] ?? 0) ^ 1;
    expect((await failure(keys, name, altered)).code).toBe("authentication-failed");
    expect((await failure(keys, name, blob, blob.length, "00".repeat(16))).code).toBe("vault-mismatch");
    expect((await failure(keys, name, blob, blob.length, fileId)).code).toBe("no-error");
  });

  it("an old genuine blob decrypts under the same name (replay is caught by the manifest comparison, not here)", async () => {
    const keys = await keysFrom(9, 10);
    const name = await blobNameFor(keys, "versions.md");
    const first = await encryptBlobBytes(keys, name, utf8("version one"));
    const second = await encryptBlobBytes(keys, name, utf8("version two"));
    expect(await decryptBlobBytesUnchecked(keys, name, first.blob)).toEqual(utf8("version one"));
    expect(await decryptBlobBytesUnchecked(keys, name, second.blob)).toEqual(utf8("version two"));
    expect(first.fileId).not.toBe(second.fileId);
    expect((await failure(keys, name, first.blob, first.blob.length, second.fileId)).code).toBe("vault-mismatch");
  });
});

describe("structure checks", () => {
  it("refuses a bad magic, version 2, exponents 15 and 25, and a header of the wrong length before deriving any key", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const { blob } = await encryptBlobBytes(keys, name, utf8("content"));
    const patch = (index: number, value: number): Uint8Array => {
      const copy = new Uint8Array(blob);
      copy[index] = value;
      return copy;
    };
    expect((await failure(keys, name, patch(0, 0x58))).code).toBe("malformed-input");
    expect((await failure(keys, name, patch(4, 2))).code).toBe("unsupported-format");
    expect((await failure(keys, name, patch(4, 0))).code).toBe("unsupported-format");
    expect((await failure(keys, name, patch(5, 15))).code).toBe("unsupported-format");
    expect((await failure(keys, name, patch(5, 25))).code).toBe("unsupported-format");
    expect((await failure(keys, name, patch(5, 0))).code).toBe("unsupported-format");
    expect(() => parseBlobHeader(blob.slice(0, 21))).toThrowError(CryptoError);
    const derived: number[] = [];
    const spyKeys: VaultKeys = { ...keys, fileKey: (fileId) => { derived.push(1); return keys.fileKey(fileId); } };
    await failure(spyKeys, name, patch(4, 2));
    await failure(spyKeys, name, patch(5, 15));
    await failure(spyKeys, name, patch(0, 0));
    expect(derived).toHaveLength(0);
  });

  it("accepts every reader exponent from 16 to 24 in the header of a blob encrypted with it", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "e.md");
    for (const exponent of [16, 17, 20, 23, 24]) {
      const { blob } = await encryptBlobBytesWith(keys, name, utf8("tiny"), { exponent });
      expect(parseBlobHeader(blob.slice(0, 22)).exponent).toBe(exponent);
      expect(await decryptBlobBytesUnchecked(keys, name, blob)).toEqual(utf8("tiny"));
    }
    await expect(encryptBlobBytesWith(keys, name, utf8("x"), { exponent: 15 })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(encryptBlobBytesWith(keys, name, utf8("x"), { exponent: 25 })).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("classifies structurally invalid input as malformed: under 50 bytes, a final piece under 28 bytes, an empty segment after others", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const empty = (await encryptBlobBytes(keys, name, new Uint8Array(0))).blob;
    expect((await failure(keys, name, empty.slice(0, 49))).code).toBe("malformed-input");
    expect((await failure(keys, name, new Uint8Array(0))).code).toBe("malformed-input");
    expect((await failure(keys, name, new Uint8Array(22))).code).toBe("malformed-input");
    const big = (await encryptBlobBytesWith(keys, name, secureRandom(65_536 + 100), { exponent: 16 })).blob;
    const wire = 65_536 + 28;
    expect((await failure(keys, name, big.slice(0, 22 + wire + 27))).code).toBe("malformed-input");
    expect((await failure(keys, name, big.slice(0, 22 + wire + 1))).code).toBe("malformed-input");
    expect((await failure(keys, name, big.slice(0, 22 + wire + 28))).code).toBe("malformed-input");
  });

  it("refuses a stated length that disagrees with the delivered bytes, and never returns plaintext for it", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const { blob } = await encryptBlobBytes(keys, name, utf8("length matters"));
    expect((await failure(keys, name, blob, blob.length + 5)).code).toBe("malformed-input");
    expect((await failure(keys, name, blob, blob.length - 5)).code).not.toBe("no-error");
    expect((await failure(keys, name, blob, Number.NaN)).code).toBe("malformed-input");
  });

  it("fails closed, without asserting a class, for structurally indistinguishable damage: trailing bytes, short or empty non-final segments", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const { blob } = await encryptBlobBytes(keys, name, utf8("some content here"));
    expect((await failure(keys, name, concatBytes(blob, new Uint8Array(40)))).code).not.toBe("no-error");
    expect((await failure(keys, name, concatBytes(blob, new Uint8Array(1)))).code).not.toBe("no-error");

    // Authentic segments in an illegal arrangement, built with the module's own AAD function and WebCrypto.
    const nameBytes = parseBlobName(name);
    const fileId = ascending(0xa0, 16);
    const header = concatBytes(utf8("ISBL"), new Uint8Array([1, 16]), fileId);
    const key = await keys.fileKey(fileId);
    const seal = async (index: number, plain: Uint8Array, final: boolean): Promise<Uint8Array> => {
      const nonce = ascending(index * 16 + (final ? 1 : 0), 12);
      return concatBytes(nonce, await aesGcmEncrypt(key, nonce, new Uint8Array(plain), blobSegmentAad(keys.vaultIdBytes, header, nameBytes, index, final)));
    };
    const shortFirst = concatBytes(header, await seal(0, secureRandom(10), false), await seal(1, secureRandom(50), true));
    expect((await failure(keys, name, shortFirst)).code).not.toBe("no-error");
    const zeroFirst = concatBytes(header, await seal(0, new Uint8Array(0), false), await seal(1, secureRandom(50), true));
    expect((await failure(keys, name, zeroFirst)).code).not.toBe("no-error");
    const fullThenEmptyFinal = concatBytes(header, await seal(0, secureRandom(65_536), false), await seal(1, new Uint8Array(0), true));
    expect((await failure(keys, name, fullThenEmptyFinal)).code).toBe("malformed-input");
    const control = concatBytes(header, await seal(0, secureRandom(65_536), false), await seal(1, secureRandom(5), true));
    expect((await failure(keys, name, control)).code).toBe("no-error");
  });

  it("never accepts a shortened authentication tag: a segment sealed with a 96-bit tag fails", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const nameBytes = parseBlobName(name);
    const fileId = ascending(0xb0, 16);
    const header = concatBytes(utf8("ISBL"), new Uint8Array([1, 23]), fileId);
    const key = await keys.fileKey(fileId);
    const nonce = ascending(0xc0, 12);
    const aad = blobSegmentAad(keys.vaultIdBytes, header, nameBytes, 0, true);
    const short = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 96 }, key, utf8("a payload of some length")));
    expect(short.length).toBe("a payload of some length".length + 12);
    const blob = concatBytes(header, nonce, short);
    expect((await failure(keys, name, blob)).code).toBe("authentication-failed");
    // Padding the short tag out to 16 bytes with zeros does not help either.
    expect((await failure(keys, name, concatBytes(blob, new Uint8Array(4)))).code).toBe("authentication-failed");
  });

  it("refuses to encrypt a segment with the wrong plaintext length, and reports a file that changed while being read", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const encryption = await createBlobEncryption({ keys, nodeName: name, size: 100 });
    await expect(encryption.encryptSegment(0, new Uint8Array(99))).rejects.toMatchObject({ code: "malformed-input" });
    await expect(encryption.encryptSegment(1, new Uint8Array(0))).rejects.toMatchObject({ code: "invalid-argument" });
    const drained: Bytes[] = [];
    await expect(
      (async () => {
        for await (const chunk of encryption.chunks(async () => new Uint8Array(50))) drained.push(chunk);
      })(),
    ).rejects.toMatchObject({ code: "malformed-input" });
    await expect(createBlobEncryption({ keys, nodeName: "not-a-name", size: 1 })).rejects.toMatchObject({ code: "malformed-input" });
  });

  it("decrypts from a source delivered in arbitrary chunk sizes, including one byte at a time", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "chunks.md");
    const plaintext = secureRandom(300);
    const { blob } = await encryptBlobBytes(keys, name, plaintext);
    for (const size of [1, 7, 22, 23, 100, 10_000]) {
      const source = (async function* () {
        for (let i = 0; i < blob.length; i += size) yield blob.slice(i, i + size);
      })();
      const out: Bytes[] = [];
      for await (const part of decryptBlobUnchecked({ keys, nodeName: name, totalLength: blob.length, source })) out.push(part);
      expect(Buffer.compare(concatBytes(...out), plaintext)).toBe(0);
    }
  });

  it("refuses a source that stalls by yielding endless empty chunks", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "stall.md");
    const { blob } = await encryptBlobBytes(keys, name, utf8("stalled"));
    const source = (async function* () {
      yield blob;
      for (;;) yield new Uint8Array(0);
    })();
    const error = await (async () => {
      try {
        for await (const part of decryptBlobUnchecked({ keys, nodeName: name, totalLength: blob.length, source })) void part;
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(codeOf(error)).toBe("malformed-input");
  });

  it("its typed errors carry no plaintext and no key material", async () => {
    const keys = await keysFrom(11, 12);
    const name = await blobNameFor(keys, "s.md");
    const secret = "TOP-SECRET-PLAINTEXT";
    const { blob } = await encryptBlobBytes(keys, name, utf8(secret));
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    const error = await decryptBlobBytesUnchecked(keys, name, blob).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CryptoError);
    expect(String((error as Error).message)).not.toContain(secret);
    expect(String((error as Error).message)).not.toContain(name);
  });
});
