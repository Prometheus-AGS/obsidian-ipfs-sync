import { createDecipheriv } from "node:crypto";
import { argon2Sync, hkdfSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CryptoError, KdfParamsError, createKeySlots, fromBase64, fromHex, toBase64, toHex, unlockKeySlotsBytes, utf8 } from "../../src/crypto";
import { ensureSelfTest } from "../../src/crypto/self-test";
import { hkdfSha256, importHkdfKey } from "../../src/crypto/hkdf";
import { createKeySlotsInternal, unlockKeySlotsInternal } from "../../src/crypto/key-slots";
import { randomBytes, secureRandom, type RandomSource } from "../../src/crypto/random";
import { parseKeySlots, serializeKeySlots, slotAad, slotCommitInfo } from "../../src/crypto/key-slot-format";
import { unwrapVckForTest } from "../../src/crypto/testing/unwrap-vck";
import { ascending } from "../vectors/bytes";
import { SLOT_INPUTS, SLOT_PINS } from "../vectors/key-slot-derivations";
import { FLOOR_PARAMS, countingFakeKdf, createWithFakeKdf, editDocument, firstSlot, flipBase64Bit, otherPassphrase, referenceGenerated, referencePassphrase, unlockBytesWith } from "../vectors/slot-helpers";

afterEach(() => vi.restoreAllMocks());

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("key-slot derivations are pinned (regression vectors computed with node:crypto)", () => {
  const { kek, vaultId, slotId, salt, vck, nonce, params } = SLOT_INPUTS;

  it("commitment information bytes and the commitment", async () => {
    const info = slotCommitInfo(slotId, params, salt);
    expect(hexOf(info)).toBe(hexOf(SLOT_PINS.commitInfo));
    const commitment = await hkdfSha256(await importHkdfKey(new Uint8Array(kek)), vaultId, info, 32);
    expect(hexOf(commitment)).toBe(hexOf(SLOT_PINS.commitment));
  });

  it("wrap key, slot associated data and the wrapped VCK", async () => {
    const wrapKey = await hkdfSha256(new Uint8Array(kek), vaultId, utf8("ipfs-sync/slot/wrap/v1"), 32);
    expect(hexOf(wrapKey)).toBe(hexOf(SLOT_PINS.wrapKey));
    const aad = slotAad(vaultId, slotId, params, salt);
    expect(hexOf(aad)).toBe(hexOf(SLOT_PINS.aad));
    const { createCipheriv } = await import("node:crypto");
    const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
    cipher.setAAD(aad);
    const wrapped = Buffer.concat([cipher.update(vck), cipher.final(), cipher.getAuthTag()]);
    expect(hexOf(wrapped)).toBe(hexOf(SLOT_PINS.wrapped));
  });

  it("the module's commitment changes with every input (label drift, salt, slot, parameter, KEK)", async () => {
    const base = await importHkdfKey(new Uint8Array(kek));
    const reference = hexOf(await hkdfSha256(base, vaultId, slotCommitInfo(slotId, params, salt), 32));
    const variants = [
      hexOf(await hkdfSha256(base, ascending(0x21, 16), slotCommitInfo(slotId, params, salt), 32)),
      hexOf(await hkdfSha256(base, vaultId, slotCommitInfo(ascending(0x31, 16), params, salt), 32)),
      hexOf(await hkdfSha256(base, vaultId, slotCommitInfo(slotId, { ...params, m: 65_537 }, salt), 32)),
      hexOf(await hkdfSha256(base, vaultId, slotCommitInfo(slotId, { ...params, t: 4 }, salt), 32)),
      hexOf(await hkdfSha256(base, vaultId, slotCommitInfo(slotId, params, ascending(0x41, 16)), 32)),
      hexOf(await hkdfSha256(await importHkdfKey(ascending(1, 32)), vaultId, slotCommitInfo(slotId, params, salt), 32)),
    ];
    expect(new Set([reference, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("key slots: creation, unlock, cross-check against node:crypto (real Argon2id at the floor parameters)", () => {
  it("round-trips, produces the documented fields, and is readable by an independent unwrap built from the spec text", async () => {
    const created = await createKeySlots({ passphrase: referenceGenerated(), params: FLOOR_PARAMS });
    const document = parseKeySlots(created.bytes);
    expect(document.slots).toHaveLength(1);
    expect(created.keys.vaultId).toBe(document.vaultId);
    const unlocked = await unlockKeySlotsBytes(created.bytes, referencePassphrase());
    expect(unlocked.keys.vaultId).toBe(created.keys.vaultId);
    expect((await unlocked.keys.nameKey()).extractable).toBe(false);
    expect((await unlocked.keys.manifestKey()).extractable).toBe(false);
    // Same VCK: both key sets derive the same name key.
    const a = await created.keys.nameKey();
    const b = await unlocked.keys.nameKey();
    const mac = async (key: CryptoKey): Promise<string> => hexOf(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8("probe"))));
    expect(await mac(a)).toBe(await mac(b));

    // Independent unwrap with node:crypto only, following the design text.
    const raw = await unwrapVckForTest(created.bytes, referencePassphrase());
    const slot = document.slots[0] as { id: string; kdf: { m: number; t: number; p: number; salt: string }; wrap: { ct: string; nonce: string }; commit: string };
    const salt = fromBase64(slot.kdf.salt);
    const kek = argon2Sync("argon2id", { message: referencePassphrase(), nonce: salt, parallelism: 1, tagLength: 32, memory: slot.kdf.m, passes: slot.kdf.t });
    const vaultId = fromHex(document.vaultId);
    const slotId = fromHex(slot.id);
    const info = Buffer.concat([Buffer.from("ipfs-sync/slot/commit/v1"), slotId, be32(19), be32(slot.kdf.m), be32(slot.kdf.t), be32(slot.kdf.p), be32(32), salt]);
    expect(Buffer.from(hkdfSync("sha256", kek, vaultId, info, 32)).toString("base64")).toBe(slot.commit);
    const wrapKey = Buffer.from(hkdfSync("sha256", kek, vaultId, "ipfs-sync/slot/wrap/v1", 32));
    const wrapped = fromBase64(slot.wrap.ct);
    expect(wrapped).toHaveLength(48);
    const aad = Buffer.concat([Buffer.from("ipfs-sync/slot/v1"), vaultId, slotId, be32(19), be32(slot.kdf.m), be32(slot.kdf.t), be32(slot.kdf.p), be32(32), salt, Buffer.from("argon2id"), Buffer.from([0]), Buffer.from("aes-256-gcm")]);
    const decipher = createDecipheriv("aes-256-gcm", wrapKey, fromBase64(slot.wrap.nonce));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(wrapped.subarray(32)));
    const vck = Buffer.concat([decipher.update(wrapped.subarray(0, 32)), decipher.final()]);
    expect(vck.toString("hex")).toBe(hexOf(raw.vck));

    // The serialised document contains the VCK in no encoding.
    const text = Buffer.from(created.bytes);
    expect(text.includes(Buffer.from(raw.vck))).toBe(false);
    expect(text.toString("utf8")).not.toContain(toHex(raw.vck));
    expect(text.toString("utf8")).not.toContain(toBase64(raw.vck));
  }, 60_000);

  it("serialises canonically: keys slots, vaultId, version; two-space indent; one trailing newline; stable re-serialisation", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const text = new TextDecoder().decode(created.bytes);
    expect(text.startsWith('{\n  "slots": [\n    {\n      "commit"')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(hexOf(serializeKeySlots(parseKeySlots(created.bytes)))).toBe(hexOf(created.bytes));
    const json = JSON.parse(text) as { version: number; slots: { kdf: Record<string, unknown>; wrap: Record<string, unknown>; type: string }[] };
    expect(Object.keys(json)).toEqual(["slots", "vaultId", "version"]);
    expect(json.version).toBe(1);
    expect(Object.keys(json.slots[0]?.kdf ?? {})).toEqual(["alg", "dkLen", "m", "p", "salt", "t", "v"]);
    expect(Object.keys(json.slots[0]?.wrap ?? {})).toEqual(["alg", "ct", "nonce"]);
    expect(json.slots[0]?.kdf).toMatchObject({ alg: "argon2id", v: 19, dkLen: 32, m: 19456, t: 2, p: 1 });
    expect(json.slots[0]?.wrap["alg"]).toBe("aes-256-gcm");
  });

  it("draws randomness in the documented order: vaultId 16, VCK 32, slotId 16, salt 16, nonce 12", async () => {
    const lengths: number[] = [];
    let counter = 0;
    const random: RandomSource = (length) => {
      lengths.push(length);
      return Uint8Array.from({ length }, () => counter++ & 0xff);
    };
    const fake = countingFakeKdf();
    await createKeySlotsInternal({ passphrase: referenceGenerated(), params: FLOOR_PARAMS }, random, { kdf: fake.kdf });
    expect(lengths).toEqual([16, 32, 16, 16, 12]);
    expect(randomBytes(random, 3)).toHaveLength(3);
  });

  it("two creations share nothing (vault identifier, slot identifier, salt, nonce, wrapped key all differ)", async () => {
    const fake = countingFakeKdf();
    const a = parseKeySlots((await createWithFakeKdf(fake)).bytes);
    const b = parseKeySlots((await createWithFakeKdf(fake)).bytes);
    expect(a.vaultId).not.toBe(b.vaultId);
    const sa = a.slots[0] as { id: string; kdf: { salt: string }; wrap: { ct: string; nonce: string } };
    const sb = b.slots[0] as { id: string; kdf: { salt: string }; wrap: { ct: string; nonce: string } };
    expect(new Set([sa.id, sb.id, sa.kdf.salt, sb.kdf.salt, sa.wrap.nonce, sb.wrap.nonce, sa.wrap.ct, sb.wrap.ct]).size).toBe(8);
  });

  it("refuses to create a slot with parameters outside the floors and ceilings, before deriving", async () => {
    const fake = countingFakeKdf();
    for (const params of [{ m: 1024, t: 3, p: 1 }, { m: 65_536, t: 5, p: 1 }, { m: 65_536, t: 3, p: 2 }, { m: 4 * 1024 * 1024, t: 3, p: 1 }]) {
      await expect(createKeySlotsInternal({ passphrase: referenceGenerated(), params }, secureRandom, { kdf: fake.kdf })).rejects.toBeInstanceOf(KdfParamsError);
    }
    expect(fake.calls()).toBe(0);
  });
});

function be32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

describe("key slots: unlock behaviour (fast stand-in KDF, logic only)", () => {
  it("wrong passphrase raises the single error, derives once, and leaves the document untouched", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = hexOf(created.bytes);
    const other = otherPassphrase();
    expect(await codeOf(unlockBytesWith(created.bytes, other, fake))).toBe("wrong-passphrase-or-damaged-slot");
    expect(hexOf(created.bytes)).toBe(before);
    expect(fake.calls()).toBe(2);
    const error = await unlockBytesWith(created.bytes, other, fake).then(
      () => new Error("unexpectedly unlocked"),
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(CryptoError);
    expect(error.message).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAJ6");
  });

  it("a corrupted commitment fails before any decryption or wrap-key derivation, in unlock and in the test hook", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const damaged = editDocument(created.bytes, (d) => {
      const slot = firstSlot(d);
      slot["commit"] = flipBase64Bit(slot["commit"] as string, 7);
    });
    await ensureSelfTest();
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const deriveKey = vi.spyOn(crypto.subtle, "deriveKey");
    expect(await codeOf(unlockBytesWith(damaged, referencePassphrase(), fake))).toBe("wrong-passphrase-or-damaged-slot");
    expect(await codeOf(unwrapVckForTest(damaged, referencePassphrase(), { kdf: fake.kdf }))).toBe("wrong-passphrase-or-damaged-slot");
    expect(decrypt).not.toHaveBeenCalled();
    expect(deriveKey).not.toHaveBeenCalled();
    // Control: the undamaged document does reach the wrap key and the decryption.
    await unlockBytesWith(created.bytes, referencePassphrase(), fake);
    expect(deriveKey).toHaveBeenCalled();
    expect(decrypt).toHaveBeenCalled();
  });

  const damageCases: readonly { name: string; edit: (slot: Record<string, unknown>, doc: Record<string, unknown>) => void }[] = [
    { name: "memory changed by one KiB", edit: (s) => { (s["kdf"] as { m: number }).m += 1; } },
    { name: "iterations changed by one", edit: (s) => { (s["kdf"] as { t: number }).t += 1; } },
    { name: "one bit of the salt", edit: (s) => { const k = s["kdf"] as { salt: string }; k.salt = flipBase64Bit(k.salt, 3); } },
    { name: "one bit of the slot identifier", edit: (s) => { s["id"] = `${(s["id"] as string).slice(0, 31)}${(s["id"] as string).endsWith("0") ? "1" : "0"}`; } },
    { name: "one bit of the vault identifier", edit: (_s, d) => { d["vaultId"] = `${(d["vaultId"] as string).slice(0, 31)}${(d["vaultId"] as string).endsWith("0") ? "1" : "0"}`; } },
    { name: "one bit of the wrapped key", edit: (s) => { const w = s["wrap"] as { ct: string }; w.ct = flipBase64Bit(w.ct, 100); } },
    { name: "one bit of the wrap tag", edit: (s) => { const w = s["wrap"] as { ct: string }; w.ct = flipBase64Bit(w.ct, 47 * 8); } },
    { name: "one bit of the wrap nonce", edit: (s) => { const w = s["wrap"] as { nonce: string }; w.nonce = flipBase64Bit(w.nonce, 0); } },
  ];
  for (const { name, edit } of damageCases) {
    it(`fails as wrong-passphrase-or-damaged-slot when ${name} changes`, async () => {
      const fake = countingFakeKdf();
      const created = await createWithFakeKdf(fake);
      const damaged = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>, d as Record<string, unknown>));
      expect(await codeOf(unlockBytesWith(damaged, referencePassphrase(), fake))).toBe("wrong-passphrase-or-damaged-slot");
    });
  }

  it("refuses fixed-field violations with unsupported-format and no derivation", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = fake.calls();
    const edits: readonly ((slot: Record<string, unknown>) => void)[] = [
      (s) => { (s["kdf"] as { v: number }).v = 20; },
      (s) => { (s["kdf"] as { dkLen: number }).dkLen = 31; },
      (s) => { (s["kdf"] as { alg: string }).alg = "argon2i"; },
      (s) => { (s["wrap"] as { alg: string }).alg = "aes-128-gcm"; },
    ];
    for (const edit of edits) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>));
      expect(await codeOf(unlockBytesWith(bad, referencePassphrase(), fake))).toBe("unsupported-format");
    }
    expect(fake.calls()).toBe(before);
  });

  it("refuses KDF parameters outside the bounds naming the parameter, with no derivation", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = fake.calls();
    const cases: readonly { edit: (slot: Record<string, unknown>) => void; parameter: string }[] = [
      { edit: (s) => { (s["kdf"] as { m: number }).m = 1024; }, parameter: "memory" },
      { edit: (s) => { (s["kdf"] as { m: number }).m = 19_455; }, parameter: "memory" },
      { edit: (s) => { (s["kdf"] as { m: number }).m = 131_073; }, parameter: "memory" },
      { edit: (s) => { (s["kdf"] as { m: number }).m = 4 * 1024 * 1024; }, parameter: "memory" },
      { edit: (s) => { (s["kdf"] as { t: number }).t = 1; }, parameter: "iterations" },
      { edit: (s) => { (s["kdf"] as { t: number }).t = 5; }, parameter: "iterations" },
      { edit: (s) => { (s["kdf"] as { p: number }).p = 2; }, parameter: "parallelism" },
      { edit: (s) => { const k = s["kdf"] as { salt: string }; k.salt = toBase64(new Uint8Array(15)); }, parameter: "salt" },
      { edit: (s) => { const k = s["kdf"] as { salt: string }; k.salt = toBase64(new Uint8Array(17)); }, parameter: "salt" },
    ];
    for (const { edit, parameter } of cases) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>));
      const error = await unlockBytesWith(bad, referencePassphrase(), fake).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KdfParamsError);
      expect((error as KdfParamsError).parameter).toBe(parameter);
    }
    expect(fake.calls()).toBe(before);
  });

  it("accepts the floors and the defaults with no policy, and the ceilings only with approval", async () => {
    const fake = countingFakeKdf();
    for (const params of [{ m: 19_456, t: 2, p: 1 }, { m: 65_536, t: 3, p: 1 }]) {
      const created = await createKeySlotsInternal({ passphrase: referenceGenerated(), params }, secureRandom, { kdf: fake.kdf });
      await unlockBytesWith(created.bytes, referencePassphrase(), fake);
    }
    const ceiling = await createKeySlotsInternal({ passphrase: referenceGenerated(), params: { m: 131_072, t: 4, p: 1 } }, secureRandom, { kdf: fake.kdf });
    expect(await codeOf(unlockBytesWith(ceiling.bytes, referencePassphrase(), fake))).toBe("kdf-cost-refused");
    await unlockBytesWith(ceiling.bytes, referencePassphrase(), fake, { costPolicy: { approveCost: async () => true } });
  });

  it("refuses an unsupported document version before any derivation, even when the document is also non-canonical", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = fake.calls();
    const v2 = editDocument(created.bytes, (d) => { d["version"] = 2; });
    expect(await codeOf(unlockBytesWith(v2, referencePassphrase(), fake))).toBe("unsupported-format");
    const v2crlf = utf8(new TextDecoder().decode(v2).replace(/\n/g, "\r\n"));
    expect(await codeOf(unlockBytesWith(v2crlf, referencePassphrase(), fake))).toBe("unsupported-format");
    expect(fake.calls()).toBe(before);
  });

  it("tries at most two passphrase slots, in list order", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const doc = parseKeySlots(created.bytes);
    const slots = [doc.slots[0], doc.slots[0], doc.slots[0]];
    const three = serializeKeySlots({ ...doc, slots: slots as typeof doc.slots });
    const wrong = fake.calls();
    expect(await codeOf(unlockBytesWith(three, otherPassphrase(), fake))).toBe("wrong-passphrase-or-damaged-slot");
    expect(fake.calls() - wrong).toBe(2);
  });

  it("validates only the slots it will try: a bad first slot refuses the whole unlock, a bad third slot is ignored", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const good = parseKeySlots(created.bytes);
    const goodSlot = good.slots[0] as unknown as { kdf: { m: number } } & Record<string, unknown>;
    const badSlot = { ...goodSlot, kdf: { ...goodSlot.kdf, m: 1 } };
    const before = fake.calls();
    const badFirst = serializeKeySlots({ ...good, slots: [badSlot, goodSlot] as unknown as typeof good.slots });
    expect(await codeOf(unlockBytesWith(badFirst, referencePassphrase(), fake))).toBe("kdf-params-out-of-bounds");
    expect(fake.calls()).toBe(before);
    const badThird = serializeKeySlots({ ...good, slots: [goodSlot, goodSlot, badSlot] as unknown as typeof good.slots });
    const unlocked = await unlockBytesWith(badThird, referencePassphrase(), fake);
    expect(unlocked.keys.vaultId).toBe(good.vaultId);
  });

  it("opens the second slot when the first does not open", async () => {
    const fake = countingFakeKdf();
    const first = await createWithFakeKdf(fake, otherPassphrase());
    const second = await createWithFakeKdf(fake);
    const a = parseKeySlots(first.bytes);
    const b = parseKeySlots(second.bytes);
    // Different vaults: the second slot's commitment binds its own vault identifier, so it opens only in its own document.
    const merged = serializeKeySlots({ ...b, slots: [a.slots[0], b.slots[0]] as unknown as typeof b.slots });
    const unlocked = await unlockBytesWith(merged, referencePassphrase(), fake);
    expect(unlocked.keys.vaultId).toBe(b.vaultId);
  });

  it("runs the platform self-test before deriving, and raises crypto-unavailable without deriving when crypto.subtle is missing", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = fake.calls();
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto), subtle: undefined });
    expect(await codeOf(unlockBytesWith(created.bytes, referencePassphrase(), fake))).toBe("crypto-unavailable");
    expect(await codeOf(createKeySlotsInternal({ passphrase: referenceGenerated(), params: FLOOR_PARAMS }, secureRandom, { kdf: fake.kdf }))).toBe("crypto-unavailable");
    vi.unstubAllGlobals();
    expect(fake.calls()).toBe(before);
  });

  it("fails closed when the injected self-test fails", async () => {
    const fake = countingFakeKdf();
    const created = await createWithFakeKdf(fake);
    const before = fake.calls();
    const failing = { kdf: fake.kdf, selfTest: async () => { throw new CryptoError("self-test-failed", "stub"); } };
    expect(await codeOf(unlockKeySlotsInternal({ document: parseKeySlots(created.bytes), passphrase: referencePassphrase() }, failing))).toBe("self-test-failed");
    expect(fake.calls()).toBe(before);
  });
});

describe("key-slot regression vector (injected randomness, real Argon2id at the floor parameters)", () => {
  it("reproduces the recorded document byte for byte, and node:crypto reproduces its commitment and wrapped key", async () => {
    const { REGRESSION_KEYSLOTS } = await import("../vectors/key-slots-regression");
    let draw = 0;
    const random: RandomSource = (length) => {
      const start = 0x10 * (draw++ + 1);
      return Uint8Array.from({ length }, (_, j) => (start + j) & 0xff);
    };
    const created = await createKeySlotsInternal({ passphrase: referenceGenerated(), params: FLOOR_PARAMS }, random, {});
    expect(new TextDecoder().decode(created.bytes)).toBe(REGRESSION_KEYSLOTS);

    const vaultId = ascending(0x10, 16);
    const vck = ascending(0x20, 32);
    const slotId = ascending(0x30, 16);
    const salt = ascending(0x40, 16);
    const nonce = ascending(0x50, 12);
    const kek = argon2Sync("argon2id", { message: utf8("HEZVIDN7IBGLQIXB5L7VARDHC"), nonce: salt, parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 });
    const commit = Buffer.from(hkdfSync("sha256", kek, vaultId, slotCommitInfo(slotId, FLOOR_PARAMS, salt), 32));
    expect(commit.toString("base64")).toBe("qrsYdZ5YN/ITK9nUBBp3o1HS7oNjy4XN+RzqaD0AFmw=");
    const wrapKey = Buffer.from(hkdfSync("sha256", kek, vaultId, "ipfs-sync/slot/wrap/v1", 32));
    const { createCipheriv } = await import("node:crypto");
    const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
    cipher.setAAD(slotAad(vaultId, slotId, FLOOR_PARAMS, salt));
    const wrapped = Buffer.concat([cipher.update(vck), cipher.final(), cipher.getAuthTag()]);
    expect(wrapped.toString("base64")).toBe("Q3NJGsP2VPTGMfWSa0lygdBxePDbkIXXftMA1Kx2u4HOOgAs89oa9B2Ibxbfi+X4");
  }, 60_000);
});
