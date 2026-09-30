import { describe, expect, it } from "vitest";
import {
  CryptoError,
  KEY_SLOTS_MAX_BYTES,
  OversizeInputError,
  createKeySlots,
  parseKeySlots,
  serializeKeySlots,
  toBase64,
  unlockKeySlotsBytes,
  utf8,
} from "../../src/crypto";
import { unwrapVckForTest } from "../../src/crypto/testing/unwrap-vck";
import { FLOOR_PARAMS, countingFakeKdf, createWithFakeKdf, editDocument, firstSlot, otherPassphrase, referenceGenerated, referencePassphrase, unlockBytesWith } from "../vectors/slot-helpers";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  return "no-error";
}

function codeOfSync(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  return "no-error";
}

async function fixture() {
  const fake = countingFakeKdf();
  const created = await createWithFakeKdf(fake);
  return { fake, created, text: decode(created.bytes) };
}

async function unlockCode(bytes: Uint8Array, fake: ReturnType<typeof countingFakeKdf>): Promise<string> {
  return codeOf(unlockBytesWith(bytes, referencePassphrase(), fake));
}

describe("key-slot document: canonical form (checked before the schema)", () => {
  it("refuses reordered keys, CRLF, a missing or doubled trailing newline, a compact layout and different indentation, with no derivation", async () => {
    const { fake, created, text } = await fixture();
    const before = fake.calls();
    const variants: readonly Uint8Array[] = [
      utf8(text.replace(/\n/g, "\r\n")),
      utf8(text.slice(0, -1)),
      utf8(`${text}\n`),
      utf8(JSON.stringify(JSON.parse(text))),
      utf8(JSON.stringify(JSON.parse(text), null, 4) + "\n"),
      utf8(` ${text}`),
      // vaultId placed before slots (sorted order is slots, vaultId, version).
      utf8(JSON.stringify({ vaultId: JSON.parse(text).vaultId, slots: JSON.parse(text).slots, version: 1 }, null, 2) + "\n"),
    ];
    for (const variant of variants) expect(await unlockCode(variant, fake)).toBe("malformed-input");
    expect(fake.calls()).toBe(before);
    expect(await unlockCode(created.bytes, fake)).toBe("no-error");
  });

  it("refuses duplicate keys at any level", async () => {
    const { fake, text } = await fixture();
    const topLevel = text.replace('"version": 1', '"version": 1,\n  "version": 1');
    const insideSlot = text.replace('"type": "passphrase"', '"type": "passphrase",\n      "type": "passphrase"');
    for (const variant of [topLevel, insideSlot]) expect(await unlockCode(utf8(variant), fake)).toBe("malformed-input");
  });

  it("refuses non-integer numbers, exponent notation and negative zero, also inside unknown slots", async () => {
    const { fake, created, text } = await fixture();
    expect(await unlockCode(utf8(text.replace('"m": 19456', '"m": 19456.0')), fake)).toBe("malformed-input");
    expect(await unlockCode(utf8(text.replace('"m": 19456', '"m": 1.9456e4')), fake)).toBe("malformed-input");
    const withFloat = editDocument(created.bytes, (d) => { (d["slots"] as unknown[]).push({ type: "future", weight: 1.5 }); });
    expect(await unlockCode(withFloat, fake)).toBe("malformed-input");
    const withNegZero = utf8(decode(editDocument(created.bytes, (d) => { (d["slots"] as unknown[]).push({ type: "future", weight: 0 }); })).replace('"weight": 0', '"weight": -0'));
    expect(await unlockCode(withNegZero, fake)).toBe("malformed-input");
  });

  it("refuses non-canonical base64 in any binary field before deriving", async () => {
    const { fake, created } = await fixture();
    const before = fake.calls();
    const fields: readonly ((slot: Record<string, unknown>) => void)[] = [
      (s) => { const k = s["kdf"] as { salt: string }; k.salt = k.salt.replace(/=+$/, ""); },
      (s) => {
        // Unused trailing bits set: the last character of a 16-byte value's base64 carries four zero bits.
        const k = s["kdf"] as { salt: string };
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const last = k.salt.slice(21, 22);
        k.salt = `${k.salt.slice(0, 21)}${alphabet[alphabet.indexOf(last) | 1]}==`;
      },
      (s) => { const w = s["wrap"] as { ct: string }; w.ct = `${w.ct.slice(0, -1)}!`; },
      (s) => { s["commit"] = `${s["commit"] as string}\n`; },
    ];
    for (const edit of fields) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>));
      expect(await unlockCode(bad, fake)).toBe("malformed-input");
    }
    expect(fake.calls()).toBe(before);
  });

  it("refuses wrong-length binary fields and a vault or slot identifier that is not 32 lowercase hex", async () => {
    const { fake, created } = await fixture();
    const edits: readonly ((slot: Record<string, unknown>, doc: Record<string, unknown>) => void)[] = [
      (s) => { (s["wrap"] as { nonce: string }).nonce = toBase64(new Uint8Array(11)); },
      (s) => { (s["wrap"] as { ct: string }).ct = toBase64(new Uint8Array(47)); },
      (s) => { s["commit"] = toBase64(new Uint8Array(31)); },
      (s) => { s["id"] = "AB".repeat(16); },
      (s) => { s["id"] = "ab".repeat(15); },
      (_s, d) => { d["vaultId"] = "cd".repeat(17); },
      (_s, d) => { d["vaultId"] = "CD".repeat(16); },
    ];
    for (const edit of edits) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>, d as Record<string, unknown>));
      expect(await unlockCode(bad, fake)).toBe("malformed-input");
    }
  });
});

describe("key-slot document: schema", () => {
  it("refuses extra or missing fields at the document, slot, kdf and wrap levels as malformed", async () => {
    const { fake, created } = await fixture();
    const before = fake.calls();
    const edits: readonly ((slot: Record<string, unknown>, doc: Record<string, unknown>) => void)[] = [
      (_s, d) => { d["extra"] = 1; },
      (s) => { s["extra"] = "x"; },
      (s) => { (s["kdf"] as Record<string, unknown>)["extra"] = 1; },
      (s) => { (s["wrap"] as Record<string, unknown>)["extra"] = 1; },
      (s) => { delete s["commit"]; },
      (s) => { delete (s["kdf"] as Record<string, unknown>)["salt"]; },
      (s) => { delete (s["wrap"] as Record<string, unknown>)["nonce"]; },
      (_s, d) => { delete d["vaultId"]; },
    ];
    for (const edit of edits) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>, d as Record<string, unknown>));
      expect(await unlockCode(bad, fake)).toBe("malformed-input");
    }
    expect(fake.calls()).toBe(before);
  });

  it("refuses wrong types (string where an integer is expected and the reverse)", async () => {
    const { fake, created } = await fixture();
    const edits: readonly ((slot: Record<string, unknown>) => void)[] = [
      (s) => { (s["kdf"] as Record<string, unknown>)["m"] = "19456"; },
      (s) => { (s["kdf"] as Record<string, unknown>)["salt"] = 5; },
      (s) => { s["type"] = 5; },
      (s) => { s["kdf"] = "argon2id"; },
    ];
    for (const edit of edits) {
      const bad = editDocument(created.bytes, (d) => edit(firstSlot(d) as Record<string, unknown>));
      expect(await unlockCode(bad, fake)).toBe("malformed-input");
    }
    expect(await unlockCode(utf8('{\n  "slots": [],\n  "vaultId": 5,\n  "version": 1\n}\n'), fake)).toBe("malformed-input");
    expect(await unlockCode(utf8("[]\n"), fake)).toBe("malformed-input");
    expect(await unlockCode(utf8("not json"), fake)).toBe("malformed-input");
    expect(await unlockCode(utf8('{\n  "slots": [],\n  "vaultId": "' + "00".repeat(16) + '"\n}\n'), fake)).toBe("malformed-input");
  });

  it("skips slots of an unknown type with arbitrary content, and refuses with no-usable-slot when only unknown slots remain", async () => {
    const { fake, created } = await fixture();
    const unknownFirst = editDocument(created.bytes, (d) => {
      (d["slots"] as unknown[]).unshift({ type: "security-key", anything: { nested: [1, 2, 3] }, extra: "fields are allowed here" });
    });
    const unlocked = await unlockBytesWith(unknownFirst, referencePassphrase(), fake);
    expect(unlocked.keys.vaultId).toBe(parseKeySlots(created.bytes).vaultId);
    // The unknown slot is preserved verbatim by a re-serialisation.
    expect(decode(serializeKeySlots(parseKeySlots(unknownFirst)))).toBe(decode(unknownFirst));

    const before = fake.calls();
    const onlyUnknown = editDocument(created.bytes, (d) => { d["slots"] = [{ type: "future" }, { type: "recovery-phrase", blob: "x" }]; });
    expect(await unlockCode(onlyUnknown, fake)).toBe("no-usable-slot");
    const empty = editDocument(created.bytes, (d) => { d["slots"] = []; });
    expect(await unlockCode(empty, fake)).toBe("no-usable-slot");
    expect(fake.calls()).toBe(before);
  });

  it("refuses a slot without a string type or that is not an object", async () => {
    const { fake, created } = await fixture();
    for (const slot of [{}, { type: 3 }, "passphrase", null, [1]]) {
      const bad = editDocument(created.bytes, (d) => { (d["slots"] as unknown[]).push(slot); });
      expect(await unlockCode(bad, fake)).toBe("malformed-input");
    }
  });
});

describe("key-slot document: caps and hostile input", () => {
  it("accepts 8 slots and refuses 9 as oversize (slot count)", async () => {
    const { fake, created } = await fixture();
    const doc = parseKeySlots(created.bytes);
    const eight = serializeKeySlots({ ...doc, slots: Array.from({ length: 8 }, () => ({ type: "future", raw: { type: "future" } })).concat([]) as unknown as typeof doc.slots });
    expect(await unlockCode(eight, fake)).toBe("no-usable-slot");
    const nine = editDocument(created.bytes, (d) => { d["slots"] = Array.from({ length: 9 }, () => ({ type: "future" })); });
    const error = await unlockBytesWith(nine, referencePassphrase(), fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OversizeInputError);
    expect((error as OversizeInputError).cap).toBe("keyslots-slot-count");
  });

  it("refuses a document above 16 KiB as oversize without parsing it", async () => {
    const { fake, text } = await fixture();
    const padded = utf8(text.replace('"version": 1', `"version": 1,\n  "pad": "${"x".repeat(KEY_SLOTS_MAX_BYTES)}"`));
    expect(padded.length).toBeGreaterThan(KEY_SLOTS_MAX_BYTES);
    const error = await unlockBytesWith(padded, referencePassphrase(), fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OversizeInputError);
    expect((error as OversizeInputError).cap).toBe("keyslots-size");
    expect(codeOfSync(() => parseKeySlots(new Uint8Array(1024 * 1024)))).toBe("oversize-input");
  });

  it("refuses deeply nested and huge inputs without crashing", async () => {
    const { fake } = await fixture();
    const deep = utf8(`{"version":1,"slots":${"[".repeat(8000)}${"]".repeat(8000)},"vaultId":"${"00".repeat(16)}"}`);
    expect(deep.length).toBeLessThan(KEY_SLOTS_MAX_BYTES);
    expect(await unlockCode(deep, fake)).toBe("malformed-input");
    expect(await unlockCode(utf8("{".repeat(9000)), fake)).toBe("malformed-input");
    expect(await unlockCode(new Uint8Array([0xff, 0xfe, 0xfd]), fake)).toBe("malformed-input");
    expect(await unlockCode(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), fake)).toBe("malformed-input");
  });

  it("treats a __proto__ member as data or refuses it, and never alters an object prototype", async () => {
    const { fake, created, text } = await fixture();
    const top = utf8(text.replace('{\n  "slots"', '{\n  "__proto__": {\n    "polluted": true\n  },\n  "slots"'));
    expect(await unlockCode(top, fake)).toBe("malformed-input");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    // Inside an unknown-type slot it is preserved as plain data and the passphrase slot still opens.
    const inSlot = utf8(decode(created.bytes).replace('"slots": [', '"slots": [\n    {\n      "__proto__": {\n        "polluted": true\n      },\n      "type": "future"\n    },'));
    expect(await unlockCode(inSlot, fake)).toBe("no-error");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(parseKeySlots(inSlot))).toBe(Object.prototype);
  });

  it("parses into objects without a prototype where the document is attacker-controlled (unknown slot content)", async () => {
    const { created } = await fixture();
    const doc = editDocument(created.bytes, (d) => { (d["slots"] as unknown[]).push({ type: "future", data: { a: 1 } }); });
    const parsed = parseKeySlots(doc);
    const unknown = parsed.slots[1] as { raw: object };
    expect(Object.getPrototypeOf(unknown.raw)).toBeNull();
  });
});

describe("key-slot hook and real-Argon2 wiring", () => {
  it("the test-only hook returns the raw VCK and vault identifier from the same routine as unlock (real Argon2id, floor parameters)", async () => {
    const created = await createKeySlots({ passphrase: referenceGenerated(), params: FLOOR_PARAMS });
    const raw = await unwrapVckForTest(created.bytes, referencePassphrase());
    expect(raw.vck).toHaveLength(32);
    expect(raw.vaultId).toHaveLength(16);
    expect(raw.slotId).toBe(created.slotId);
    expect(Buffer.from(raw.vaultId).toString("hex")).toBe(created.keys.vaultId);
    const wrong = await codeOf(unwrapVckForTest(created.bytes, otherPassphrase()));
    expect(wrong).toBe("wrong-passphrase-or-damaged-slot");
  }, 60_000);
});
