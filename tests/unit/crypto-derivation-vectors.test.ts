import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LABEL_BLOB_AAD, LABEL_FILE_KEY, LABEL_MANIFEST_AAD, LABEL_MANIFEST_KEY, LABEL_NAME_KEY, LABEL_SLOT_AAD, LABEL_SLOT_COMMIT, LABEL_SLOT_WRAP, blobNameFor, parseBlobName, utf8 } from "../../src/crypto";
import { blobSegmentAad } from "../../src/crypto/blob";
import { encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { hmacSha256 } from "../../src/crypto/hmac";
import { u32be, u64be } from "../../src/crypto/bytes";
import { createBlobEncryptionWith } from "../../src/crypto/blob";
import { createVaultKeys } from "../../src/crypto/key-derivation";
import { encryptManifestEnvelopeWith } from "../../src/crypto/manifest-envelope";
import { ascending } from "../vectors/bytes";
import { AAD_INDEX_PINS, BLOB_PINS, MANIFEST_PINS, NAME_PINS, PIN_INPUTS } from "../vectors/derivation-pins";

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/*
 * Label drift: these tests recompute every derivation from the label TEXT written in the design, with node:crypto,
 * and compare with the module's constants and outputs. Changing a label or a salt in the code breaks them.
 */
describe("labels are the ones written in the design", () => {
  it("the constants equal the frozen strings", () => {
    expect(LABEL_SLOT_AAD).toBe("ipfs-sync/slot/v1");
    expect(LABEL_SLOT_WRAP).toBe("ipfs-sync/slot/wrap/v1");
    expect(LABEL_SLOT_COMMIT).toBe("ipfs-sync/slot/commit/v1");
    expect(LABEL_NAME_KEY).toBe("ipfs-sync/name/v1");
    expect(LABEL_MANIFEST_KEY).toBe("ipfs-sync/manifest/v1");
    expect(LABEL_MANIFEST_AAD).toBe("ipfs-sync/manifest/v1");
    expect(LABEL_FILE_KEY).toBe("ipfs-sync/file/v1");
    expect(LABEL_BLOB_AAD).toBe("ipfs-sync/blob/v1");
  });
});

describe("name key: HKDF(VCK, salt = raw vaultId, info = label)", () => {
  it("the module's MAC under the derived name key equals the pinned HMAC and a node:crypto recomputation", async () => {
    const keys = await createVaultKeys(PIN_INPUTS.vaultId, PIN_INPUTS.vck);
    const nameKey = Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, PIN_INPUTS.vaultId, "ipfs-sync/name/v1", 32));
    expect(hexOf(nameKey)).toBe(hexOf(NAME_PINS.nameKey));
    expect(hexOf(await hmacSha256(await keys.nameKey(), utf8(PIN_INPUTS.path)))).toBe(hexOf(NAME_PINS.nameBytes));
    expect(createHmac("sha256", nameKey).update(PIN_INPUTS.path).digest("hex")).toBe(hexOf(NAME_PINS.nameBytes));
    expect(await blobNameFor(keys, PIN_INPUTS.path)).toBe(NAME_PINS.name);
  });

  it("drifts if the label, the salt or the salt encoding changes", async () => {
    const derive = (salt: Uint8Array | string, label: string): string =>
      createHmac("sha256", Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, salt, label, 32))).update(PIN_INPUTS.path).digest("hex");
    expect(derive(PIN_INPUTS.vaultId, "ipfs-sync/name/v1")).toBe(hexOf(NAME_PINS.nameBytes));
    expect(derive(PIN_INPUTS.vaultId, "ipfs-sync/name/v2")).not.toBe(hexOf(NAME_PINS.nameBytes));
    expect(derive(PIN_INPUTS.vaultId, "ipfs-sync/file/v1")).not.toBe(hexOf(NAME_PINS.nameBytes));
    expect(derive(Buffer.from(hexOf(PIN_INPUTS.vaultId)), "ipfs-sync/name/v1")).not.toBe(hexOf(NAME_PINS.nameBytes));
    expect(derive(new Uint8Array(0), "ipfs-sync/name/v1")).not.toBe(hexOf(NAME_PINS.nameBytes));
  });
});

describe("manifest key: HKDF(VCK, salt = raw vaultId, info = label)", () => {
  it("the module's envelope equals the pinned bytes, and the key matches a node:crypto derivation", async () => {
    const keys = await createVaultKeys(PIN_INPUTS.vaultId, PIN_INPUTS.vck);
    const file = await encryptManifestEnvelopeWith(keys, new Uint8Array(MANIFEST_PINS.plaintext), () => new Uint8Array(PIN_INPUTS.manifestNonce));
    expect(hexOf(file)).toBe(hexOf(MANIFEST_PINS.file));
    expect(hexOf(Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, PIN_INPUTS.vaultId, "ipfs-sync/manifest/v1", 32)))).toBe(hexOf(MANIFEST_PINS.manifestKey));
    // Sealing the same bytes under the name-key label gives a different ciphertext: the two labels are separate domains.
    const wrongKey = Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, PIN_INPUTS.vaultId, "ipfs-sync/name/v1", 32));
    expect(hexOf(wrongKey)).not.toBe(hexOf(MANIFEST_PINS.manifestKey));
  });
});

describe("file key: HKDF(VCK, salt = raw fileId, info = label)", () => {
  it("the module's blob equals the pinned bytes, and the key matches a node:crypto derivation", async () => {
    const keys = await createVaultKeys(PIN_INPUTS.vaultId, PIN_INPUTS.vck);
    const draws = [PIN_INPUTS.fileId, PIN_INPUTS.blobNonce];
    const encryption = await createBlobEncryptionWith(
      { keys, nodeName: NAME_PINS.name, size: PIN_INPUTS.plaintext.length },
      { random: () => new Uint8Array(draws.shift() as Uint8Array) },
    );
    const segment = await encryption.encryptSegment(0, utf8(PIN_INPUTS.plaintext));
    expect(hexOf(new Uint8Array([...encryption.header, ...segment]))).toBe(hexOf(BLOB_PINS.blob));
    expect(hexOf(Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, PIN_INPUTS.fileId, "ipfs-sync/file/v1", 32)))).toBe(hexOf(BLOB_PINS.fileKey));
    // A salt made of the 32 hex characters instead of the 16 raw bytes gives a different key.
    const asciiSalt = Buffer.from(hkdfSync("sha256", PIN_INPUTS.vck, Buffer.from(hexOf(PIN_INPUTS.fileId)), "ipfs-sync/file/v1", 32));
    expect(hexOf(asciiSalt)).not.toBe(hexOf(BLOB_PINS.fileKey));
    expect(hexOf(BLOB_PINS.header)).toBe("4953424c0117" + hexOf(PIN_INPUTS.fileId));
  });
});

describe("integer encodings in associated data", () => {
  it("u32 and u64 are big-endian and fixed width", () => {
    expect(hexOf(u32be(19))).toBe("00000013");
    expect(hexOf(u32be(65_536))).toBe("00010000");
    expect(hexOf(u32be(0xffffffff))).toBe("ffffffff");
    expect(hexOf(u64be(1))).toBe("0000000000000001");
    expect(hexOf(u64be(2 ** 32))).toBe("0000000100000000");
    expect(hexOf(u64be(2 ** 32 - 1))).toBe("00000000ffffffff");
  });

  for (const pin of AAD_INDEX_PINS) {
    it(`blob associated data for index ${pin.index}, final=${String(pin.final)} matches the pin and a BigInt recomputation`, () => {
      expect(hexOf(u64be(pin.index))).toBe(pin.u64);
      const header = BLOB_PINS.header;
      const aad = blobSegmentAad(PIN_INPUTS.vaultId, header, NAME_PINS.nameBytes, pin.index, pin.final);
      expect(hexOf(aad)).toBe(pin.aad);
      const big = Buffer.alloc(8);
      big.writeBigUInt64BE(BigInt(pin.index));
      const independent = Buffer.concat([Buffer.from("ipfs-sync/blob/v1"), PIN_INPUTS.vaultId, header, NAME_PINS.nameBytes, big, Buffer.from([pin.final ? 1 : 0])]);
      expect(independent.toString("hex")).toBe(pin.aad);
    });
  }

  it("an index above 2^32 does not collide with its low 32 bits, and index 0 differs from index 2^32", () => {
    const a = blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 5, false);
    const b = blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 2 ** 32 + 5, false);
    const c = blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 2 ** 32, false);
    const d = blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 0, false);
    expect(new Set([hexOf(a), hexOf(b), hexOf(c), hexOf(d)]).size).toBe(4);
  });

  it("every component of the blob associated data changes the output (label, vault, header, name, index, final flag)", () => {
    const base = hexOf(blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 0, true));
    const flippedHeader = new Uint8Array(BLOB_PINS.header);
    flippedHeader[21] = (flippedHeader[21] ?? 0) ^ 1;
    const flippedName = new Uint8Array(NAME_PINS.nameBytes);
    flippedName[31] = (flippedName[31] ?? 0) ^ 1;
    const variants = [
      hexOf(blobSegmentAad(ascending(0x21, 16), BLOB_PINS.header, NAME_PINS.nameBytes, 0, true)),
      hexOf(blobSegmentAad(PIN_INPUTS.vaultId, flippedHeader, NAME_PINS.nameBytes, 0, true)),
      hexOf(blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, flippedName, 0, true)),
      hexOf(blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 1, true)),
      hexOf(blobSegmentAad(PIN_INPUTS.vaultId, BLOB_PINS.header, NAME_PINS.nameBytes, 0, false)),
    ];
    expect(new Set([base, ...variants]).size).toBe(6);
    expect(hexOf(parseBlobName(NAME_PINS.name))).toBe(hexOf(NAME_PINS.nameBytes));
  });
});
