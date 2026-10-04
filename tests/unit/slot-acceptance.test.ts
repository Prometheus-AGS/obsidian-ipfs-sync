import { beforeEach, describe, expect, it, vi } from "vitest";

const kdf = vi.hoisted(() => ({ derivations: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return { ...original, argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => (kdf.derivations++, original.argon2idAsync(...args)) };
});

import { CryptoError, canonicalizePassphraseText, fromHex, type Bytes, type CanonicalPassphrase, type KdfParams, type VaultKeys } from "../../src/crypto";
import { createKeySlotsInternal } from "../../src/crypto/key-slots";
import { secureRandom, type RandomSource } from "../../src/crypto/random";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { PullUnlockError } from "../../src/sync/pull-unlock";
import type { StateRecord } from "../../src/sync/pull-sequence";
import { SEQUENCE_FLOOR_FILE, SequenceFloorError, raiseFloor } from "../../src/sync/sequence-floor";
import { SlotAcceptanceError, acceptedSlotBytes, evaluateSlotAcceptance, type SlotAcceptanceInput } from "../../src/sync/slot-acceptance";
import { toUnlockedVault } from "../../src/sync/vault-keys";
import { sha256Hex } from "../../src/sync/hash";
import { buildManifest } from "../helpers/commit-scenario";
import { createMemoryDeviceStore, type MemoryDeviceStore } from "../helpers/memory-device-store";
import { ROOT_CID } from "../vectors/manifest-helpers";

const ROOT = "/obsidian-vault-sync/test-root";
const CHEAP: KdfParams = { m: 19_456, t: 2, p: 1 };
/** Above the default cost (t > 3) and cheap enough to derive in a test. */
const ABOVE_DEFAULT: KdfParams = { m: 19_456, t: 4, p: 1 };
const OLD_TEXT = "HEZVI-DN7IB-GLQIX-B5L7V-ARDHC";
const NEW_TEXT = "AAAAAAAAAAAAAAAAAAAAAAAJ6";
const OLD = canonicalizePassphraseText(OLD_TEXT);
const NEW = canonicalizePassphraseText(NEW_TEXT);

/** A source whose first two draws (vaultId, vault key) are fixed and whose other draws (slot id, salt, nonce) are fresh. */
function fixedIdentity(vaultId: Bytes, vck: Bytes): RandomSource {
  let call = 0;
  return (length) => {
    call += 1;
    if (call === 1) return new Uint8Array(vaultId);
    if (call === 2) return new Uint8Array(vck);
    return secureRandom(length);
  };
}

const VAULT_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const VAULT_KEY = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const ATTACKER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

interface Slots {
  readonly bytes: Bytes;
  readonly keys: VaultKeys;
}

/** A slot file for the vault (`vaultId`, `vck`) under a passphrase and cost: what a creator or a rewrap leaves on the node. */
async function slotsFor(passphrase: string, params: KdfParams, vaultId = VAULT_ID, vck = VAULT_KEY): Promise<Slots> {
  const created = await createKeySlotsInternal({ passphrase: asGenerated(passphrase), params }, fixedIdentity(vaultId, vck), {});
  return { bytes: created.bytes, keys: created.keys };
}

async function manifestBytes(keys: VaultKeys, sequence: number): Promise<{ file: Bytes; identity: string }> {
  const manifest = await buildManifest(keys, sequence, [], ROOT_CID);
  return { file: (await encodeManifestFile(keys, manifest)).file, identity: manifestIdentity(manifest) };
}

const VAULT_HEX = Array.from(VAULT_ID, (b) => b.toString(16).padStart(2, "0")).join("");

function stateAt(sequence: number, identity: string): StateRecord {
  return { vaultId: VAULT_HEX, sequence, identity, pendingPublish: false };
}

let store: MemoryDeviceStore;
beforeEach(() => {
  store = createMemoryDeviceStore();
  kdf.derivations = 0;
});

async function accept(input: Partial<SlotAcceptanceInput> & Pick<SlotAcceptanceInput, "keySlots" | "manifestFile">, passphrase: CanonicalPassphrase = NEW) {
  return evaluateSlotAcceptance({ mfsRoot: ROOT, passphrase, currentCopy: undefined, state: undefined, deviceStore: store, target: "name", ...input });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("accepting a rewrapped slot file", () => {
  it("returns the exact bytes that unlocked, with one derivation, no downgrade and a same-manifest verdict", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 4);
    kdf.derivations = 0;
    const input = new Uint8Array(after.bytes);
    const accepted = await accept({ keySlots: input, manifestFile: manifest.file, currentCopy: before.bytes, state: stateAt(4, manifest.identity) });
    expect(kdf.derivations).toBe(1);
    expect(accepted.keySlots).toEqual(after.bytes);
    expect(accepted.keySlots).not.toBe(input);
    expect(accepted.keySlotsSha256).toBe(await sha256Hex(after.bytes));
    expect(accepted.vaultId).toBe(VAULT_HEX);
    expect(accepted.changed).toBe(true);
    expect(accepted.downgrade).toBeUndefined();
    expect(accepted.verdict.kind).toBe("same");
    expect(accepted.manifest).toEqual({ sequence: 4, identity: manifest.identity });
    input.fill(0);
    expect(accepted.keySlots).toEqual(after.bytes);
    expect(store.writes).toEqual([]);
  });

  it("reports unchanged slots as unchanged", async () => {
    const same = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(same.keys, 2);
    const accepted = await accept({ keySlots: same.bytes, manifestFile: manifest.file, currentCopy: same.bytes, state: stateAt(2, manifest.identity) });
    expect(accepted.changed).toBe(false);
  });

  it("a wrong passphrase is one derivation and the usual single outcome", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 1);
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes }, OLD));
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("wrong-passphrase-or-damaged-slot");
    expect(kdf.derivations).toBe(1);
  });
});

describe("a slot file that is not this vault's", () => {
  it("another vault's slots that unlock with the typed passphrase: refused before any derivation when the device records a vault", async () => {
    const mine = await slotsFor(OLD_TEXT, CHEAP);
    const mineManifest = await manifestBytes(mine.keys, 3);
    const otherVault = await slotsFor(NEW_TEXT, CHEAP, Uint8Array.from({ length: 16 }, () => 9), ATTACKER_KEY);
    kdf.derivations = 0;
    const withState = await failure(accept({ keySlots: otherVault.bytes, manifestFile: mineManifest.file, state: stateAt(3, mineManifest.identity) }));
    expect(withState).toBeInstanceOf(PullUnlockError);
    expect((withState as PullUnlockError).reason).toBe("other-vault");
    const copyOnly = await failure(accept({ keySlots: otherVault.bytes, manifestFile: mineManifest.file, currentCopy: mine.bytes }));
    expect(copyOnly).toBeInstanceOf(SlotAcceptanceError);
    expect((copyOnly as SlotAcceptanceError).code).toBe("other-vault");
    expect(kdf.derivations).toBe(0);
  });

  it("slots that claim this vault's id with another vault key unlock but the node's manifest does not authenticate: not accepted", async () => {
    const mine = await slotsFor(OLD_TEXT, CHEAP);
    const genuine = await manifestBytes(mine.keys, 3);
    const forged = await slotsFor(NEW_TEXT, CHEAP, VAULT_ID, ATTACKER_KEY);
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: forged.bytes, manifestFile: genuine.file, currentCopy: mine.bytes, state: stateAt(3, genuine.identity) }));
    expect(error).toBeInstanceOf(SlotAcceptanceError);
    expect((error as SlotAcceptanceError).code).toBe("manifest-not-authentic");
    expect(kdf.derivations).toBe(1);
  });

  it("a forged manifest under the forged key also passes the checks unless the device holds the vault key; a held key refuses it", async () => {
    const mine = await slotsFor(OLD_TEXT, CHEAP);
    const forged = await slotsFor(NEW_TEXT, CHEAP, VAULT_ID, ATTACKER_KEY);
    const forgedManifest = await manifestBytes(forged.keys, 9);
    const held = toUnlockedVault({ keys: mine.keys, vaultId: VAULT_HEX, keySlots: mine.bytes, keySlotsSha256: await sha256Hex(mine.bytes) });
    const error = await failure(accept({ keySlots: forged.bytes, manifestFile: forgedManifest.file, currentCopy: mine.bytes, state: stateAt(3, "a".repeat(64)), heldVault: held }));
    expect(error).toBeInstanceOf(SlotAcceptanceError);
    expect((error as SlotAcceptanceError).code).toBe("key-changed");
  });

  it("a device that records nothing about a vault has nothing to accept: refused before any derivation", async () => {
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 1);
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file }));
    expect((error as SlotAcceptanceError).code).toBe("nothing-to-accept");
    expect(kdf.derivations).toBe(0);
  });

  it("--expect-vault-id that differs is refused before any derivation", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 1);
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes, flags: { expectVaultId: "f".repeat(32) } }));
    expect((error as PullUnlockError).reason).toBe("expectation-failed");
    expect(kdf.derivations).toBe(0);
  });
});

describe("the sequence verdict", () => {
  it("a lower-sequence root needs an explicit target and the rollback flag", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const older = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(older.keys, 2);
    const base = { keySlots: older.bytes, manifestFile: manifest.file, currentCopy: before.bytes, state: stateAt(5, "c".repeat(64)) };

    const byName = await failure(accept({ ...base, target: "name" }));
    expect((byName as SlotAcceptanceError).code).toBe("verdict-refused");
    expect((byName as SlotAcceptanceError).refusal?.reason).toBe("older");
    const nameWithFlag = await failure(accept({ ...base, target: "name", flags: { allowRollback: true } }));
    expect((nameWithFlag as SlotAcceptanceError).refusal?.reason).toBe("flag-combination");
    const explicitNoFlag = await failure(accept({ ...base, target: "root-cid" }));
    expect((explicitNoFlag as SlotAcceptanceError).refusal?.reason).toBe("older");

    const restored = await accept({ ...base, target: "root-cid", flags: { allowRollback: true } });
    expect(restored.verdict).toEqual({ kind: "restore", recordedSequence: 5, candidateSequence: 2 });
  });

  it("an equal sequence with a different identity is a fork and is not accepted", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 4);
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes, state: stateAt(4, "d".repeat(64)) }));
    expect((error as SlotAcceptanceError).refusal?.reason).toBe("fork");
  });

  it("a damaged sequence floor is surfaced before any derivation, never read as no record", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 4);
    store.entries.set(SEQUENCE_FLOOR_FILE, new TextEncoder().encode("{not json"));
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes }));
    expect(error).toBeInstanceOf(SequenceFloorError);
    expect(kdf.derivations).toBe(0);
  });

  it("the floor alone is a record: a manifest below it is refused", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 2);
    await raiseFloor(store, VAULT_HEX, { sequence: 6, identity: "e".repeat(64), at: 1 });
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes }));
    expect((error as SlotAcceptanceError).refusal?.reason).toBe("older");
  });
});

describe("cost", () => {
  it("a cheaper slot sets the downgrade indicator, and the bytes are released only on confirmation", async () => {
    const before = await slotsFor(OLD_TEXT, ABOVE_DEFAULT);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 4);
    const accepted = await accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes, state: stateAt(4, manifest.identity) });
    expect(accepted.downgrade).toEqual({ current: ABOVE_DEFAULT, incoming: CHEAP });
    expect(() => acceptedSlotBytes(accepted, {})).toThrow(SlotAcceptanceError);
    expect(() => acceptedSlotBytes(accepted, { downgradeConfirmed: false })).toThrow(SlotAcceptanceError);
    expect(acceptedSlotBytes(accepted, { downgradeConfirmed: true })).toEqual(after.bytes);
  });

  it("an equal or dearer slot needs no downgrade confirmation", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const manifest = await manifestBytes(after.keys, 1);
    const equal = await accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes });
    expect(equal.downgrade).toBeUndefined();
    expect(acceptedSlotBytes(equal, {})).toEqual(after.bytes);
  });

  it("an incoming slot above the default cost is refused without a confirmCost callback, before any derivation", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, ABOVE_DEFAULT);
    const manifest = await manifestBytes(after.keys, 1);
    kdf.derivations = 0;
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: manifest.file, currentCopy: before.bytes }));
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("kdf-cost-refused");
    expect(kdf.derivations).toBe(0);
    const seen: KdfParams[][] = [];
    const accepted = await accept({
      keySlots: after.bytes,
      manifestFile: manifest.file,
      currentCopy: before.bytes,
      confirmCost: async (costs) => (seen.push([...costs]), true),
    });
    expect(seen).toEqual([[ABOVE_DEFAULT]]);
    expect(accepted.downgrade).toBeUndefined();
  });
});

describe("the damaged manifest", () => {
  it("garbage manifest bytes after a good unlock are a non-authentic manifest", async () => {
    const before = await slotsFor(OLD_TEXT, CHEAP);
    const after = await slotsFor(NEW_TEXT, CHEAP);
    const error = await failure(accept({ keySlots: after.bytes, manifestFile: fromHex("00".repeat(80)), currentCopy: before.bytes }));
    expect((error as SlotAcceptanceError).code).toBe("manifest-not-authentic");
  });
});
