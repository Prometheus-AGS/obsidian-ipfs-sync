import { createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MANIFEST_HEADER_BYTES, MANIFEST_MAX_FILE_BYTES, OversizeInputError, blobNameFor, concatBytes, utf8 } from "../../src/crypto";
import { decryptManifestEnvelope, encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { type RandomSource } from "../../src/crypto/random";
import { ManifestFormatError, assertRootCidV1, createFilesMap, decodeManifestFile, encodeManifestFile, parseManifestV2, serializeManifestV2, type EncryptedManifestFile } from "../../src/sync/encrypted-manifest";
import { encryptManifestEnvelopeWith } from "../../src/crypto/manifest-envelope";
import { ascending } from "../vectors/bytes";
import { MANIFEST_PINS, PIN_INPUTS } from "../vectors/derivation-pins";

import { ROOT_CID, V0_CID, keysFrom, entryFor, manifestFor, seal, refusal, hexOf } from "../vectors/manifest-helpers";

describe("manifest.enc envelope", () => {
  it("produces the pinned file with injected randomness, and node:crypto decrypts it (regression, labelled)", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const random: RandomSource = (length) => {
      expect(length).toBe(12);
      return new Uint8Array(PIN_INPUTS.manifestNonce);
    };
    const file = await encryptManifestEnvelopeWith(keys, new Uint8Array(MANIFEST_PINS.plaintext), random);
    expect(hexOf(file)).toBe(hexOf(MANIFEST_PINS.file));
    expect(hexOf(file.slice(0, MANIFEST_HEADER_BYTES))).toBe(hexOf(MANIFEST_PINS.header));

    const key = Buffer.from(hkdfSync("sha256", ascending(0x50, 32), ascending(0x20, 16), "ipfs-sync/manifest/v1", 32));
    expect(key.toString("hex")).toBe(hexOf(MANIFEST_PINS.manifestKey));
    const decipher = createDecipheriv("aes-256-gcm", key, MANIFEST_PINS.file.subarray(5, 17));
    decipher.setAAD(MANIFEST_PINS.aad);
    decipher.setAuthTag(Buffer.from(MANIFEST_PINS.file.subarray(MANIFEST_PINS.file.length - 16)));
    const plain = Buffer.concat([decipher.update(MANIFEST_PINS.file.subarray(17, MANIFEST_PINS.file.length - 16)), decipher.final()]);
    expect(hexOf(plain)).toBe(hexOf(MANIFEST_PINS.plaintext));
    expect(hexOf(await decryptManifestEnvelope(keys, MANIFEST_PINS.file))).toBe(hexOf(MANIFEST_PINS.plaintext));
  });

  it("fails on any single flipped bit of the file (header, nonce, ciphertext or tag), exhaustively", async () => {
    const keys = await keysFrom(1, 2);
    const file = await encryptManifestEnvelope(keys, utf8('{"sample":"manifest plaintext for the bit-flip sweep"}'));
    for (let bit = 0; bit < file.length * 8; bit++) {
      const flipped = new Uint8Array(file);
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      const error = await refusal(decryptManifestEnvelope(keys, flipped));
      expect(["authentication-failed", "malformed-input", "unsupported-format"]).toContain(error.code);
    }
  });

  it("fails for another vault's keys, a truncated or extended file, and a bad magic or version", async () => {
    const keys = await keysFrom(1, 2);
    const file = await encryptManifestEnvelope(keys, utf8("{}"));
    expect((await refusal(decryptManifestEnvelope(await keysFrom(2, 2), file))).code).toBe("authentication-failed");
    expect((await refusal(decryptManifestEnvelope(await keysFrom(1, 3), file))).code).toBe("authentication-failed");
    for (let cut = 0; cut < file.length; cut++) await refusal(decryptManifestEnvelope(keys, file.slice(0, cut)));
    await refusal(decryptManifestEnvelope(keys, concatBytes(file, new Uint8Array(1))));
    const badMagic = new Uint8Array(file);
    badMagic[0] = 0;
    expect((await refusal(decryptManifestEnvelope(keys, badMagic))).code).toBe("malformed-input");
    const badVersion = new Uint8Array(file);
    badVersion[4] = 3;
    expect((await refusal(decryptManifestEnvelope(keys, badVersion))).code).toBe("unsupported-format");
    expect((await refusal(decryptManifestEnvelope(keys, new Uint8Array(32)))).code).toBe("malformed-input");
  });

  it("refuses a file above 64 MiB without decrypting, and a plaintext that would make one", async () => {
    const keys = await keysFrom(1, 2);
    const tooBig = new Uint8Array(MANIFEST_MAX_FILE_BYTES + 1);
    const error = await refusal(decryptManifestEnvelope(keys, tooBig));
    expect(error).toBeInstanceOf(OversizeInputError);
    expect((error as OversizeInputError).cap).toBe("manifest-file-size");
    const plaintextTooBig = await refusal(encryptManifestEnvelope(keys, new Uint8Array(MANIFEST_MAX_FILE_BYTES)));
    expect((plaintextTooBig as OversizeInputError).cap).toBe("manifest-file-size");
    const atLimit = await encryptManifestEnvelope(keys, new Uint8Array(MANIFEST_MAX_FILE_BYTES - 33));
    expect(atLimit).toHaveLength(MANIFEST_MAX_FILE_BYTES);
    expect((await decryptManifestEnvelope(keys, atLimit)).length).toBe(MANIFEST_MAX_FILE_BYTES - 33);
  }, 60_000);

  it("draws a fresh nonce for every manifest file", async () => {
    const keys = await keysFrom(1, 2);
    const nonces = new Set<string>();
    for (let i = 0; i < 300; i++) nonces.add(hexOf((await encryptManifestEnvelope(keys, utf8("{}"))).slice(5, 17)));
    expect(nonces.size).toBe(300);
  });
});

describe("manifest v2 codec", () => {
  it("round-trips a manifest through manifest.enc", async () => {
    const keys = await keysFrom(1, 2);
    const manifest = await manifestFor(keys, ["notes/a.md", "notes/daily/2026-01-01.md", "assets/img.png", "\u00e9t\u00e9/caf\u00e9.md"], { sequence: 7 });
    const { file, sizes } = await encodeManifestFile(keys, manifest);
    expect(sizes.entries).toBe(4);
    expect(file).toHaveLength(sizes.fileBytes);
    const decoded = await decodeManifestFile(keys, file);
    expect(decoded.sequence).toBe(7);
    expect(Object.keys(decoded.files).sort()).toEqual(Object.keys(manifest.files).sort());
    expect(decoded.files["notes/a.md"]).toEqual(manifest.files["notes/a.md"]);
    expect(Object.getPrototypeOf(decoded.files)).toBeNull();
  });

  it("serialises with sorted keys (UTF-16 code-unit order, also for integer-like paths) and no whitespace", async () => {
    const keys = await keysFrom(1, 2);
    const manifest = await manifestFor(keys, ["2", "10", "b", "a"]);
    const text = new TextDecoder().decode(serializeManifestV2(manifest));
    expect(text).not.toMatch(/\s(?=[^"]*(?:"[^"]*"[^"]*)*$)/);
    expect(text.startsWith('{"device":"test-device","excludesHash":"' + "b".repeat(64) + '","files":{"10":{"blob":')).toBe(true);
    expect(text.indexOf('"10":')).toBeLessThan(text.indexOf('"2":'));
    expect(text.indexOf('"2":')).toBeLessThan(text.indexOf('"a":'));
    expect(text.indexOf('"a":')).toBeLessThan(text.indexOf('"b":'));
    expect(text.endsWith('"vaultId":"' + keys.vaultId + '","version":2}')).toBe(true);
    expect(text.indexOf('"publishedAt"')).toBeLessThan(text.indexOf('"rootCID"'));
    expect(text.indexOf('"rootCID"')).toBeLessThan(text.indexOf('"sequence"'));
  });

  it("fails on any single bit flip of manifest.enc, and for another vault's keys", async () => {
    const keys = await keysFrom(1, 2);
    const { file } = await encodeManifestFile(keys, await manifestFor(keys, ["a.md", "b/c.md"]));
    for (let bit = 0; bit < file.length * 8; bit += 1) {
      const flipped = new Uint8Array(file);
      flipped[bit >> 3] = (flipped[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      await refusal(decodeManifestFile(keys, flipped));
    }
    expect((await refusal(decodeManifestFile(await keysFrom(2, 2), file))).code).toBe("authentication-failed");
    // A manifest authenticated under the right keys but naming another vault is refused as a mismatch.
    const foreign = await manifestFor(keys, ["a.md"], { vaultId: "ab".repeat(16) });
    expect((await refusal(parseManifestV2(keys, serializeManifestV2(foreign)))).code).toBe("vault-mismatch");
  });

  it("rejects an entry whose blob name does not match its path, before and after authentication", async () => {
    const keys = await keysFrom(1, 2);
    const manifest = await manifestFor(keys, ["a.md", "b.md"]);
    const swapped = createFilesMap([
      ["a.md", { ...(manifest.files["a.md"] as EncryptedManifestFile), blob: (manifest.files["b.md"] as EncryptedManifestFile).blob }],
      ["b.md", manifest.files["b.md"] as EncryptedManifestFile],
    ]);
    const error = await refusal(encodeManifestFile(keys, { ...manifest, files: swapped }));
    expect(error).toBeInstanceOf(ManifestFormatError);
    expect((error as ManifestFormatError).field).toBe("blob");
    await refusal(decodeManifestFile(keys, await seal(keys, new TextDecoder().decode(serializeManifestV2({ ...manifest, files: swapped })))));
    // A name in another vault's namespace is also inconsistent.
    const other = await keysFrom(1, 3);
    const foreignName = createFilesMap([["a.md", { ...(manifest.files["a.md"] as EncryptedManifestFile), blob: await blobNameFor(other, "a.md") }]]);
    await refusal(encodeManifestFile(keys, { ...manifest, files: foreignName }));
  });

  it("rejects the unsafe path forms of the untrusted-path rules and accepts a normal path", async () => {
    const keys = await keysFrom(1, 2);
    const unsafe = ["/a", "C:/a", "c:x", "a\\b", "a/../b", "a//b", "./a", "a/./b", "a/", "\u0007bell", "tab\there", "x\u007f", ".IPFS-SYNC/x", ".ipfs-sync/state.json", "a\ud800b"];
    for (const path of unsafe) {
      const manifest = await manifestFor(keys, [], {});
      const files = createFilesMap([[path, await entryFor(keys, "safe.md")]]);
      const error = await refusal(parseManifestV2(keys, serializeManifestV2({ ...manifest, files })));
      expect((error as ManifestFormatError).field).toBe("path");
      expect(error.message).not.toContain(path);
    }
    // The empty path (JSON key "") is refused too.
    const emptyPath = createFilesMap([["", await entryFor(keys, "safe.md")]]);
    const emptyError = await refusal(parseManifestV2(keys, serializeManifestV2({ ...(await manifestFor(keys, [])), files: emptyPath })));
    expect((emptyError as ManifestFormatError).field).toBe("path");
    const ok = await manifestFor(keys, ["notes/daily/2026-01-01.md"]);
    expect(Object.keys((await parseManifestV2(keys, serializeManifestV2(ok))).files)).toEqual(["notes/daily/2026-01-01.md"]);
  });

  it("treats a __proto__ path as plain data and alters no prototype", async () => {
    const keys = await keysFrom(1, 2);
    const manifest = await manifestFor(keys, ["__proto__", "constructor", "toString", "a.md"]);
    const { file } = await encodeManifestFile(keys, manifest);
    const decoded = await decodeManifestFile(keys, file);
    expect(Object.keys(decoded.files).sort()).toEqual(["__proto__", "a.md", "constructor", "toString"]);
    expect(Object.getOwnPropertyDescriptor(decoded.files, "__proto__")?.value).toEqual(manifest.files["__proto__"]);
    expect(({} as Record<string, unknown>)["sha256"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "blob")).toBe(false);
    // Raw authenticated JSON with a __proto__ member behaves the same.
    const raw = new TextDecoder().decode(serializeManifestV2(manifest));
    expect(raw).toContain('"__proto__":{');
    expect(Object.keys((await parseManifestV2(keys, utf8(raw))).files)).toContain("__proto__");
  });

  it("rejects sequence 0, negative, fractional, 2^53, and accepts 1 and 2^53 - 1", async () => {
    const keys = await keysFrom(1, 2);
    const base = await manifestFor(keys, ["a.md"]);
    for (const sequence of [0, -1, 1.5, 2 ** 53, Number.NaN]) {
      const text = new TextDecoder().decode(serializeManifestV2({ ...base, sequence: 1 })).replace('"sequence":1', `"sequence":${Number.isNaN(sequence) ? '"x"' : String(sequence)}`);
      await refusal(parseManifestV2(keys, utf8(text)));
    }
    for (const sequence of [1, 2 ** 53 - 1]) expect((await parseManifestV2(keys, serializeManifestV2({ ...base, sequence }))).sequence).toBe(sequence);
  });

  it("rejects duplicate keys at the root and inside a file entry", async () => {
    const keys = await keysFrom(1, 2);
    const base = new TextDecoder().decode(serializeManifestV2(await manifestFor(keys, ["a.md"])));
    const duplicateRoot = base.replace('"version":2}', '"version":2,"version":2}');
    const duplicateEntry = base.replace('"size":4', '"size":4,"size":4');
    expect(duplicateEntry).not.toBe(base);
    for (const text of [duplicateRoot, duplicateEntry]) await refusal(decodeManifestFile(keys, await seal(keys, text)));
    const duplicatePath = base.replace('"files":{"a.md":', '"files":{"a.md":{"blob":"x"},"a.md":');
    await refusal(decodeManifestFile(keys, await seal(keys, duplicatePath)));
  });

  it("rejects unknown fields, missing fields and wrong types at every level", async () => {
    const keys = await keysFrom(1, 2);
    const base = JSON.parse(new TextDecoder().decode(serializeManifestV2(await manifestFor(keys, ["a.md"])))) as Record<string, unknown>;
    const edits: readonly ((m: Record<string, unknown>) => void)[] = [
      (m) => { m["extra"] = 1; },
      (m) => { delete m["device"]; },
      (m) => { m["version"] = "2"; },
      (m) => { m["version"] = 1; },
      (m) => { m["files"] = []; },
      (m) => { m["files"] = null; },
      (m) => { ((m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>)["extra"] = 1; },
      (m) => { delete ((m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>)["cid"]; },
      (m) => { ((m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>)["size"] = "4"; },
      (m) => { ((m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>)["size"] = -1; },
      (m) => { ((m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>)["size"] = 1.5; },
      (m) => { m["files"] = { "a.md": "not an object" }; },
    ];
    for (const edit of edits) {
      const copy = structuredClone(base);
      edit(copy);
      await refusal(parseManifestV2(keys, utf8(JSON.stringify(copy))));
    }
    await refusal(parseManifestV2(keys, utf8("[]")));
    await refusal(parseManifestV2(keys, utf8("not json")));
    await refusal(parseManifestV2(keys, new Uint8Array([0xff, 0xfe])));
  });

  it("enforces the field formats: hex case, CID forms, timestamps, device length", async () => {
    const keys = await keysFrom(1, 2);
    const base = JSON.parse(new TextDecoder().decode(serializeManifestV2(await manifestFor(keys, ["a.md"])))) as Record<string, unknown>;
    const entry = (m: Record<string, unknown>): Record<string, unknown> => (m["files"] as Record<string, Record<string, unknown>>)["a.md"] as Record<string, unknown>;
    const refused: readonly ((m: Record<string, unknown>) => void)[] = [
      (m) => { m["vaultId"] = "AB".repeat(16); },
      (m) => { m["excludesHash"] = "B".repeat(64); },
      (m) => { m["excludesHash"] = "b".repeat(63); },
      (m) => { m["rootCID"] = V0_CID },
      (m) => { m["rootCID"] = "bafy"; },
      (m) => { m["rootCID"] = ROOT_CID.toUpperCase(); },
      (m) => { m["publishedAt"] = "2026-09-30 12:00:00"; },
      (m) => { m["publishedAt"] = "2026-09-30T12:00:00+02:00"; },
      (m) => { m["publishedAt"] = "2026-13-45T25:61:61Z"; },
      (m) => { m["publishedAt"] = "2026-09-30T12:00:00.1234Z"; },
      (m) => { m["publishedAt"] = "2026-02-30T00:00:00Z"; },
      (m) => { m["publishedAt"] = "2026-09-30T24:00:00Z"; },
      (m) => { m["device"] = ""; },
      (m) => { m["device"] = "d".repeat(65); },
      (m) => { m["device"] = 5; },
      (m) => { entry(m)["sha256"] = "A".repeat(64); },
      (m) => { entry(m)["fileId"] = "ab".repeat(15); },
      (m) => { entry(m)["blob"] = "abc"; },
      (m) => { entry(m)["cid"] = "notacid"; },
      (m) => { entry(m)["cid"] = ROOT_CID.toUpperCase(); },
      (m) => { entry(m)["cid"] = `${V0_CID}x`; },
    ];
    for (const edit of refused) {
      const copy = structuredClone(base);
      edit(copy);
      await refusal(parseManifestV2(keys, utf8(JSON.stringify(copy))));
    }
    const accepted: readonly ((m: Record<string, unknown>) => void)[] = [
      (m) => { entry(m)["cid"] = V0_CID; },
      (m) => { m["device"] = "d".repeat(64); },
      (m) => { m["device"] = "\u{1F600}".repeat(64); },
      (m) => { m["publishedAt"] = "2026-09-30T12:00:00Z"; },
      (m) => { m["publishedAt"] = "2026-09-30T12:00:00.123Z"; },
    ];
    for (const edit of accepted) {
      const copy = structuredClone(base);
      edit(copy);
      await parseManifestV2(keys, utf8(JSON.stringify(copy)));
    }
  });

  it("names the CIDv0 root refusal with a typed refusal", () => {
    expect(() => assertRootCidV1(V0_CID)).toThrowError(ManifestFormatError);
    expect(() => assertRootCidV1(ROOT_CID)).not.toThrow();
  });

  it("accepts whitespace and key-order variants of an authenticated manifest", async () => {
    const keys = await keysFrom(1, 2);
    const manifest = await manifestFor(keys, ["a.md", "b.md"], { sequence: 3 });
    const canonical = JSON.parse(new TextDecoder().decode(serializeManifestV2(manifest))) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(canonical).reverse());
    const variants = [JSON.stringify(canonical, null, 2), JSON.stringify(reversed), `\n\t ${JSON.stringify(reversed, null, 4)}\r\n`];
    for (const variant of variants) {
      const decoded = await decodeManifestFile(keys, await seal(keys, variant));
      expect(decoded.sequence).toBe(3);
      expect(Object.keys(decoded.files).sort()).toEqual(["a.md", "b.md"]);
    }
  });
});
