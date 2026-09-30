import { createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BLOB_HEADER_BYTES, BLOB_MIN_BYTES, BLOB_NAME_PATTERN, CryptoError, blobLength, blobMfsPath, blobNameFor, blobTreePath, concatBytes, createBlobEncryption, decryptBlob, decryptBlobBytes, encryptBlobBytes, isBlobName, parseBlobHeader, parseBlobName, toHex, utf8, type Bytes } from "../../src/crypto";
import { blobSegmentAad } from "../../src/crypto/blob";
import { secureRandom, type RandomSource } from "../../src/crypto/random";
import { encryptBlobBytesWith, decryptBlobBytesUnchecked, decryptBlobUnchecked } from "../../src/crypto/blob";
import { ascending, hex } from "../vectors/bytes";
import { BLOB_PINS, NAME_PINS, PIN_INPUTS } from "../vectors/derivation-pins";

import { failure, hexOf, keysFrom, recordingRandom } from "../vectors/blob-helpers";

describe("opaque node names", () => {
  it("match the pinned vector and an independent computation with node:crypto", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const name = await blobNameFor(keys, PIN_INPUTS.path);
    expect(name).toBe(NAME_PINS.name);
    expect(hexOf(parseBlobName(name))).toBe(hexOf(NAME_PINS.nameBytes));
    const nameKey = Buffer.from(hkdfSync("sha256", ascending(0x50, 32), ascending(0x20, 16), "ipfs-sync/name/v1", 32));
    expect(nameKey.toString("hex")).toBe(hexOf(NAME_PINS.nameKey));
  });

  it("has the shape current/<2>/<52>, is deterministic, and differs per path and per vault", async () => {
    const a = await keysFrom(0x20, 0x50);
    const b = await keysFrom(0x21, 0x50);
    const c = await keysFrom(0x20, 0x51);
    const name = await blobNameFor(a, "notes/a.md");
    expect(name).toMatch(BLOB_NAME_PATTERN);
    expect(name).toHaveLength(52);
    expect(await blobNameFor(a, "notes/a.md")).toBe(name);
    expect(blobTreePath(name)).toBe(`${name.slice(0, 2)}/${name}`);
    expect(blobMfsPath(name)).toMatch(/^current\/[a-z2-7]{2}\/[a-z2-7]{52}$/);
    expect(blobMfsPath(name).split("/")[1]).toBe(name.slice(0, 2));
    const others = [await blobNameFor(a, "notes/b.md"), await blobNameFor(b, "notes/a.md"), await blobNameFor(c, "notes/a.md")];
    expect(new Set([name, ...others]).size).toBe(4);
  });

  it("uses path bytes as given: composed and decomposed forms give different names, and a lone surrogate is refused", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const composed = await blobNameFor(keys, "café.md");
    const decomposed = await blobNameFor(keys, "café.md");
    expect(composed).not.toBe(decomposed);
    await expect(blobNameFor(keys, "a\ud800b.md")).rejects.toMatchObject({ code: "malformed-input" });
    await expect(blobNameFor(keys, "")).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects a name whose unused trailing bits are not zero, and any other non-canonical form", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const name = await blobNameFor(keys, "notes/a.md");
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const bumped = `${name.slice(0, 51)}${alphabet[alphabet.indexOf(name[51] ?? "") | 1]}`;
    expect(bumped).not.toBe(name);
    expect(isBlobName(name)).toBe(true);
    expect(isBlobName(bumped)).toBe(false);
    for (const bad of [name.toUpperCase(), name.slice(0, 51), `${name}a`, `${name.slice(0, 51)}1`, "", `${name.slice(0, 2)}/${name}`]) expect(isBlobName(bad)).toBe(false);
    expect(() => blobTreePath(bumped)).toThrowError(CryptoError);
  });
});

describe("blob format and the pinned regression vector", () => {
  it("produces the pinned 62-byte blob with injected randomness, and node:crypto decrypts it (regression, labelled)", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const draws = [PIN_INPUTS.fileId, PIN_INPUTS.blobNonce];
    let next = 0;
    const random: RandomSource = (length) => {
      const value = draws[next++];
      if (value === undefined || value.length !== length) throw new Error("unexpected randomness request");
      return new Uint8Array(value);
    };
    const { blob, fileId } = await encryptBlobBytesWith(keys, NAME_PINS.name, utf8(PIN_INPUTS.plaintext), { random });
    expect(hexOf(blob)).toBe(hexOf(BLOB_PINS.blob));
    expect(fileId).toBe(toHex(PIN_INPUTS.fileId));
    expect(blob).toHaveLength(blobLength(PIN_INPUTS.plaintext.length));
    expect(hexOf(blobSegmentAad(ascending(0x20, 16), blob.slice(0, 22), NAME_PINS.nameBytes, 0, true))).toBe(hexOf(BLOB_PINS.aad));

    // Independent decryption of the pinned bytes with node:crypto only.
    const fileKey = Buffer.from(hkdfSync("sha256", ascending(0x50, 32), PIN_INPUTS.fileId, "ipfs-sync/file/v1", 32));
    expect(fileKey.toString("hex")).toBe(hexOf(BLOB_PINS.fileKey));
    const decipher = createDecipheriv("aes-256-gcm", fileKey, BLOB_PINS.blob.subarray(22, 34));
    decipher.setAAD(BLOB_PINS.aad);
    decipher.setAuthTag(Buffer.from(BLOB_PINS.blob.subarray(BLOB_PINS.blob.length - 16)));
    const plain = Buffer.concat([decipher.update(BLOB_PINS.blob.subarray(34, BLOB_PINS.blob.length - 16)), decipher.final()]);
    expect(plain.toString()).toBe(PIN_INPUTS.plaintext);
    expect(await decryptBlobBytesUnchecked(keys, NAME_PINS.name, BLOB_PINS.blob, toHex(PIN_INPUTS.fileId))).toEqual(utf8(PIN_INPUTS.plaintext));
  });

  it("has a 22-byte header: magic ISBL, version 1, exponent 23, file identifier", async () => {
    const keys = await keysFrom(1, 2);
    const name = await blobNameFor(keys, "a.md");
    const { blob, fileId } = await encryptBlobBytes(keys, name, utf8("x"));
    expect(hexOf(blob.slice(0, 6))).toBe("4953424c0117");
    expect(parseBlobHeader(blob.slice(0, 22))).toEqual({ exponent: 23, fileId });
    expect(BLOB_HEADER_BYTES).toBe(22);
  });

  it("an empty file is one 50-byte segment that decrypts to an empty file", async () => {
    const keys = await keysFrom(1, 2);
    const name = await blobNameFor(keys, "empty.md");
    const { blob } = await encryptBlobBytes(keys, name, new Uint8Array(0));
    expect(blob).toHaveLength(50);
    expect(blob).toHaveLength(BLOB_MIN_BYTES);
    const parts: Bytes[] = [];
    for await (const part of decryptBlobUnchecked({ keys, nodeName: name, totalLength: 50, source: blob })) parts.push(part);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(0);
  });

  it("blob length arithmetic: 20 MiB is 3 segments of 8, 8 and 4 MiB (round trip at exponent 23)", async () => {
    const size = 20 * 1024 * 1024;
    expect(blobLength(size)).toBe(22 + 3 * 28 + size);
    expect(blobLength(0)).toBe(50);
    expect(blobLength(8 * 1024 * 1024)).toBe(22 + 28 + 8 * 1024 * 1024);
    expect(blobLength(8 * 1024 * 1024 + 1)).toBe(22 + 56 + 8 * 1024 * 1024 + 1);
    const keys = await keysFrom(3, 4);
    const name = await blobNameFor(keys, "big.bin");
    const plaintext = secureRandom(size);
    const encryption = await createBlobEncryption({ keys, nodeName: name, size });
    const sizes: number[] = [];
    const parts: Bytes[] = [];
    for await (const chunk of encryption.chunks(async (offset, length) => plaintext.slice(offset, offset + length))) {
      sizes.push(chunk.length);
      parts.push(chunk);
    }
    expect(sizes).toEqual([22, 8 * 1024 * 1024 + 28, 8 * 1024 * 1024 + 28, 4 * 1024 * 1024 + 28]);
    expect(encryption.blobLength).toBe(blobLength(size));
    const blob = concatBytes(...parts);
    expect(blob).toHaveLength(encryption.blobLength);
    const decrypted: Bytes[] = [];
    for await (const part of decryptBlobUnchecked({ keys, nodeName: name, totalLength: blob.length, source: (async function* () { for (let i = 0; i < blob.length; i += 1_000_003) yield blob.slice(i, i + 1_000_003); })() })) decrypted.push(part);
    expect(decrypted.map((p) => p.length)).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(Buffer.compare(concatBytes(...decrypted), plaintext)).toBe(0);
  }, 60_000);

  it("a plaintext that is an exact multiple of the segment size ends with a full final segment", async () => {
    const keys = await keysFrom(3, 4);
    const name = await blobNameFor(keys, "exact.bin");
    const plaintext = secureRandom(2 * 65_536);
    const { blob } = await encryptBlobBytesWith(keys, name, plaintext, { exponent: 16 });
    expect(blob).toHaveLength(22 + 2 * 28 + 2 * 65_536);
    expect(Buffer.compare(await decryptBlobBytesUnchecked(keys, name, blob), plaintext)).toBe(0);
  });
});

describe("randomness: a new file identifier and fresh nonces on every encryption", () => {
  it("draws the file identifier first (16 bytes) and then one 12-byte nonce per segment", async () => {
    const keys = await keysFrom(5, 6);
    const name = await blobNameFor(keys, "n.md");
    const { random, lengths } = recordingRandom();
    await encryptBlobBytesWith(keys, name, secureRandom(2 * 65_536 + 10), { exponent: 16, random });
    expect(lengths).toEqual([16, 12, 12, 12]);
  });

  it("every encryption draws a new file identifier, including a rewrite of the same content", async () => {
    const keys = await keysFrom(5, 6);
    const name = await blobNameFor(keys, "n.md");
    const { random, lengths } = recordingRandom();
    const identifiers = new Set<string>();
    for (let i = 0; i < 200; i++) identifiers.add((await encryptBlobBytesWith(keys, name, utf8("same content"), { random })).fileId);
    expect(identifiers.size).toBe(200);
    expect(lengths.filter((length) => length === 16)).toHaveLength(200);
    // With the secure generator too.
    const secure = new Set<string>();
    for (let i = 0; i < 300; i++) secure.add((await encryptBlobBytes(keys, name, utf8("same content"))).fileId);
    expect(secure.size).toBe(300);
  });

  it("two encryptions of the same file differ in file identifier, every nonce and every ciphertext", async () => {
    const keys = await keysFrom(5, 6);
    const name = await blobNameFor(keys, "n.md");
    const plaintext = secureRandom(65_536 + 100);
    const a = await encryptBlobBytesWith(keys, name, plaintext, { exponent: 16 });
    const b = await encryptBlobBytesWith(keys, name, plaintext, { exponent: 16 });
    expect(a.fileId).not.toBe(b.fileId);
    const wire = 65_536 + 28;
    for (const [start, end] of [[22, 34], [34, 22 + wire - 16], [22 + wire, 22 + wire + 12]] as const) {
      expect(hexOf(a.blob.slice(start, end))).not.toBe(hexOf(b.blob.slice(start, end)));
    }
    expect(hexOf(a.blob.slice(-16))).not.toBe(hexOf(b.blob.slice(-16)));
  });

  it("a rename produces a different blob and the old blob does not decrypt under the new name", async () => {
    const keys = await keysFrom(5, 6);
    const oldName = await blobNameFor(keys, "old.md");
    const newName = await blobNameFor(keys, "new.md");
    const plaintext = utf8("content that moves");
    const a = await encryptBlobBytes(keys, oldName, plaintext);
    const b = await encryptBlobBytes(keys, newName, plaintext);
    expect(hexOf(a.blob)).not.toBe(hexOf(b.blob));
    expect((await failure(keys, newName, a.blob)).code).toBe("authentication-failed");
    expect((await failure(keys, oldName, b.blob)).code).toBe("authentication-failed");
    expect((await failure(keys, newName, a.blob)).yielded).toBe(0);
  });
});
