import { describe, expect, it } from "vitest";
import {
  CryptoError,
  KdfCostRefusedError,
  KdfParamsError,
  PassphraseFormatError,
  createKeySlots,
  fromBase64,
  parseKeySlots,
  type CanonicalPassphrase,
  type KdfParams,
} from "../../src/crypto";
import { KdfCostDowngradeError } from "../../src/crypto/errors";
import { rewrapKeySlotsInternal, type RewrapInput } from "../../src/crypto/key-slots";
import { randomBytes, type RandomSource } from "../../src/crypto/random";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { unwrapVckForTest } from "../../src/crypto/testing/unwrap-vck";
import * as R from "../support/reference-decryptor";
import { FLOOR_PARAMS, OTHER_PASSPHRASE, countingFakeKdf, createWithFakeKdf, editDocument, otherPassphrase, referencePassphrase, unlockBytesWith, type CountingKdf } from "../vectors/slot-helpers";
import { VALID_PASSPHRASE } from "../vectors/passphrase";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CryptoError) return error.code;
    throw error;
  }
  return "no-error";
}

/** Rewrap to a new generated passphrase with the counting stand-in KDF. */
function rewrapWith(counter: CountingKdf, bytes: Uint8Array, overrides: Partial<RewrapInput> = {}, random?: RandomSource) {
  const input: RewrapInput = {
    document: parseKeySlots(bytes),
    passphrase: referencePassphrase(),
    next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
    params: FLOOR_PARAMS,
    ...overrides,
  };
  return rewrapKeySlotsInternal(input, random ?? ((length) => crypto.getRandomValues(new Uint8Array(length))), { kdf: counter.kdf });
}

async function vckOf(bytes: Uint8Array, passphrase: CanonicalPassphrase, counter: CountingKdf): Promise<string> {
  const raw = await unwrapVckForTest(bytes, passphrase, { kdf: counter.kdf });
  return hex(raw.vck);
}

describe("rewrapKeySlots: change passphrase", () => {
  it("wraps the same vault key under the new passphrase, in a file that holds only the new slot", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const before = counter.calls();
    const rewrapped = await rewrapWith(counter, created.bytes);
    expect(counter.calls() - before).toBe(2); // the second derivation of the current passphrase, and the new slot's
    const document = parseKeySlots(rewrapped.bytes);
    expect(document.slots).toHaveLength(1);
    expect(document.vaultId).toBe(parseKeySlots(created.bytes).vaultId);
    expect(rewrapped.slotId).not.toBe(created.slotId);
    expect(await vckOf(rewrapped.bytes, otherPassphrase(), counter)).toBe(await vckOf(created.bytes, referencePassphrase(), counter));
    const unlocked = await unlockBytesWith(rewrapped.bytes, otherPassphrase(), counter);
    expect(unlocked.keys.vaultId).toBe(created.keys.vaultId);
  });

  it("the old passphrase fails on the new file and still opens the old file", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const rewrapped = await rewrapWith(counter, created.bytes);
    expect(await codeOf(unlockBytesWith(rewrapped.bytes, referencePassphrase(), counter))).toBe("wrong-passphrase-or-damaged-slot");
    expect((await unlockBytesWith(created.bytes, referencePassphrase(), counter)).keys.vaultId).toBe(created.keys.vaultId);
  });

  it("two rewraps differ in slot identifier, salt, nonce, commitment and wrapped key, and recover the same key", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const a = await rewrapWith(counter, created.bytes);
    const b = await rewrapWith(counter, created.bytes);
    const slotA = parseKeySlots(a.bytes).slots[0] as { id: string; kdf: { salt: string }; wrap: { nonce: string; ct: string }; commit: string };
    const slotB = parseKeySlots(b.bytes).slots[0] as typeof slotA;
    const old = parseKeySlots(created.bytes).slots[0] as typeof slotA;
    for (const field of [(s: typeof slotA) => s.id, (s: typeof slotA) => s.kdf.salt, (s: typeof slotA) => s.wrap.nonce, (s: typeof slotA) => s.commit, (s: typeof slotA) => s.wrap.ct]) {
      expect(new Set([field(old), field(slotA), field(slotB)]).size).toBe(3);
    }
    expect(await vckOf(a.bytes, otherPassphrase(), counter)).toBe(await vckOf(b.bytes, otherPassphrase(), counter));
  });

  it("draws randomness in the documented order: slot identifier 16, salt 16, nonce 12", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const lengths: number[] = [];
    const random: RandomSource = (length) => {
      lengths.push(length);
      return Uint8Array.from({ length }, (_, index) => (index + lengths.length) & 0xff);
    };
    await rewrapWith(counter, created.bytes, {}, random);
    expect(lengths).toEqual([16, 16, 12]);
    expect(randomBytes(random, 1)).toHaveLength(1);
  });

  it("refuses a new passphrase that was not generated here, before any derivation", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const before = counter.calls();
    const failure = rewrapWith(counter, created.bytes, { next: { kind: "generated", passphrase: otherPassphrase() as never } });
    await expect(failure).rejects.toBeInstanceOf(PassphraseFormatError);
    expect(counter.calls()).toBe(before);
  });

  it("a wrong current passphrase writes nothing and derives no new slot", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const before = counter.calls();
    expect(await codeOf(rewrapWith(counter, created.bytes, { passphrase: otherPassphrase() }))).toBe("wrong-passphrase-or-damaged-slot");
    expect(counter.calls() - before).toBe(1); // the unlock attempt only
  });
});

describe("rewrapKeySlots: cost", () => {
  const BASE: KdfParams = { m: 20_480, t: 3, p: 1 };

  it("a cost above the ceilings is refused before any derivation", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter, referencePassphrase(), BASE);
    const before = counter.calls();
    for (const params of [{ m: 131_073, t: 3, p: 1 }, { m: 65_536, t: 5, p: 1 }, { m: 65_536, t: 3, p: 2 }]) {
      await expect(rewrapWith(counter, created.bytes, { params })).rejects.toBeInstanceOf(KdfParamsError);
    }
    expect(counter.calls()).toBe(before);
  });

  it("a lower memory or lower iterations is refused without the downgrade flag, before any derivation", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter, referencePassphrase(), BASE);
    const before = counter.calls();
    for (const params of [{ m: 19_456, t: 3, p: 1 }, { m: 20_480, t: 2, p: 1 }]) {
      const failure = await rewrapWith(counter, created.bytes, { params }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(KdfCostDowngradeError);
      expect((failure as KdfCostDowngradeError).current).toEqual(BASE);
      expect((failure as KdfCostDowngradeError).requested).toEqual(params);
      expect((failure as KdfCostDowngradeError).code).toBe("kdf-downgrade-refused");
    }
    expect(counter.calls()).toBe(before);
  });

  it("a lower cost goes through with the downgrade flag, and an equal or higher cost needs none", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter, referencePassphrase(), BASE);
    const lower = await rewrapWith(counter, created.bytes, { params: { m: 19_456, t: 2, p: 1 }, allowDowngrade: true });
    expect(lower.params).toEqual({ m: 19_456, t: 2, p: 1 });
    expect(parseKeySlots(lower.bytes).slots).toHaveLength(1);
    expect((await rewrapWith(counter, created.bytes, { params: BASE })).params).toEqual(BASE);
    expect((await rewrapWith(counter, created.bytes, { params: { m: 65_536, t: 4, p: 1 } })).params).toEqual({ m: 65_536, t: 4, p: 1 });
  });

  it("unlocking a current slot above the default cost needs the cost policy, as an ordinary unlock does", async () => {
    const counter = countingFakeKdf();
    const high: KdfParams = { m: 131_072, t: 4, p: 1 };
    const created = await createWithFakeKdf(counter, referencePassphrase(), high);
    const before = counter.calls();
    await expect(rewrapWith(counter, created.bytes, { params: high })).rejects.toBeInstanceOf(KdfCostRefusedError);
    expect(counter.calls()).toBe(before);
    const seen: KdfParams[] = [];
    const approved = await rewrapWith(counter, created.bytes, {
      params: high,
      costPolicy: { approveCost: async (params) => { seen.push(params); return true; } },
    });
    expect(seen).toEqual([high]);
    expect(approved.params).toEqual(high);
  });
});

describe("rewrapKeySlots: same passphrase (increase cost)", () => {
  it("reuses the unlocking passphrase, which need not be a generated one, and the old file keeps its own cost", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const typed = referencePassphrase(); // canonical but never marked as generated, like a passphrase the user typed
    const raised: KdfParams = { m: 65_536, t: 3, p: 1 };
    const rewrapped = await rewrapWith(counter, created.bytes, { passphrase: typed, next: { kind: "reuse" }, params: raised });
    expect(rewrapped.params).toEqual(raised);
    expect(await vckOf(rewrapped.bytes, referencePassphrase(), counter)).toBe(await vckOf(created.bytes, referencePassphrase(), counter));
    expect(rewrapped.slotId).not.toBe(created.slotId);
    const slot = parseKeySlots(rewrapped.bytes).slots[0] as { kdf: { m: number; t: number } };
    expect(slot.kdf).toMatchObject({ m: 65_536, t: 3 });
    expect(parseKeySlots(created.bytes).slots).toHaveLength(1);
  });

  it("reuse mode still refuses a wrong passphrase: the unlock proves the secret before it is reused", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    expect(await codeOf(rewrapWith(counter, created.bytes, { passphrase: otherPassphrase(), next: { kind: "reuse" } }))).toBe("wrong-passphrase-or-damaged-slot");
  });
});

describe("rewrapKeySlots: the current file", () => {
  it("a slot of a type this build does not know refuses the rewrap before any derivation, wherever it sits in the file", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const before = counter.calls();
    // Positions: after the passphrase slot (outside the two tried) and before it; both must refuse.
    const after = editDocument(created.bytes, (document) => {
      (document["slots"] as unknown[]).push({ type: "hardware-key", blob: "AAAA" });
    });
    const first = editDocument(created.bytes, (document) => {
      (document["slots"] as unknown[]).unshift({ type: "hardware-key", blob: "AAAA" });
    });
    for (const bytes of [after, first]) {
      const failure = await rewrapWith(counter, bytes).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CryptoError);
      expect((failure as CryptoError).code).toBe("unsupported-format");
      expect((failure as CryptoError).message).toContain("slot types this version does not know");
    }
    expect(counter.calls()).toBe(before);
  });

  it("a file with no usable passphrase slot is refused before any derivation", async () => {
    const counter = countingFakeKdf();
    const created = await createWithFakeKdf(counter);
    const bytes = editDocument(created.bytes, (document) => {
      document["slots"] = [];
    });
    const before = counter.calls();
    expect(await codeOf(rewrapWith(counter, bytes))).toBe("no-usable-slot");
    expect(counter.calls()).toBe(before);
  });
});

describe("rewrapKeySlots: independent reader (real Argon2id at the floor parameters)", () => {
  it("the reference decryptor opens the rewrapped file with the new passphrase to the same vault key", async () => {
    const created = await createKeySlots({ passphrase: asGenerated(VALID_PASSPHRASE.canonical), params: FLOOR_PARAMS });
    const rewrapped = await rewrapKeySlotsInternal(
      {
        document: parseKeySlots(created.bytes),
        passphrase: referencePassphrase(),
        next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
        params: FLOOR_PARAMS,
      },
      (length) => crypto.getRandomValues(new Uint8Array(length)),
      {},
    );
    const oldVault = R.unlockKeyslots(created.bytes, VALID_PASSPHRASE.canonical);
    const newVault = R.unlockKeyslots(rewrapped.bytes, OTHER_PASSPHRASE);
    expect(newVault.vck.toString("hex")).toBe(oldVault.vck.toString("hex"));
    expect(newVault.vaultId.toString("hex")).toBe(oldVault.vaultId.toString("hex"));
    expect(() => R.unlockKeyslots(rewrapped.bytes, VALID_PASSPHRASE.canonical)).toThrow();
    expect(fromBase64((parseKeySlots(rewrapped.bytes).slots[0] as { kdf: { salt: string } }).kdf.salt)).toHaveLength(16);
  }, 60_000);
});
