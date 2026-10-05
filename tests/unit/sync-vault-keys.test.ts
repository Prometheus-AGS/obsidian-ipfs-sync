import { beforeEach, describe, expect, it, vi } from "vitest";

const kdf = vi.hoisted(() => ({ derivations: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return { ...original, argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => (kdf.derivations++, original.argon2idAsync(...args)) };
});

import { CryptoError, canonicalizePassphraseText, createKeySlots, utf8, type CanonicalPassphrase } from "../../src/crypto";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { createKeySlotsInternal } from "../../src/crypto/key-slots";
import { secureRandom } from "../../src/crypto/random";
import { sha256Hex } from "../../src/sync/hash";
import { DeviceStoreError } from "../../src/sync/device-store";
import { SEQUENCE_FLOOR_FILE, SequenceFloorError, raiseFloor } from "../../src/sync/sequence-floor";
import {
  ABANDON_CONFIRMATION,
  AbandonPartialMoveError,
  VaultKeysError,
  abandonVault,
  describeAbandonFloor,
  partialMoveLine,
  keySlotsCopyPath,
  openVault,
  rootDigest,
  toUnlockedVault,
  type NodeAccess,
  type OpenVaultInput,
} from "../../src/sync/vault-keys";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { countingFakeKdf } from "../vectors/slot-helpers";

const ROOT = "/obsidian-vault-sync/test-root";
const FLOOR = { m: 19_456, t: 2, p: 1 };
const PASS = canonicalizePassphraseText("HEZVI-DN7IB-GLQIX-B5L7V-ARDHC");
const GENERATED = asGenerated("HEZVI-DN7IB-GLQIX-B5L7V-ARDHC");
const OTHER = canonicalizePassphraseText("AAAAAAAAAAAAAAAAAAAAAAAJ6");

interface FakeNode extends NodeAccess {
  slots: Uint8Array | undefined;
  manifest: boolean;
  requests: string[];
}

function nodeWith(slots?: Uint8Array, manifest = false): FakeNode {
  const node: FakeNode = {
    slots,
    manifest,
    requests: [],
    async fetchKeySlots() {
      node.requests.push("keyslots");
      return node.slots;
    },
    async manifestPresent() {
      node.requests.push("manifest");
      return node.manifest;
    },
  };
  return node;
}

let host: MemoryHost;
beforeEach(() => {
  host = createMemoryHost();
  kdf.derivations = 0;
});

const open = (node: NodeAccess, extra: Partial<OpenVaultInput> = {}, passphrase: CanonicalPassphrase = PASS) =>
  openVault({ fs: host.fs, mfsRoot: ROOT, passphrase, local: { hasState: false }, node, ...extra });

async function existingVault(params = FLOOR) {
  return createKeySlots({ passphrase: GENERATED, params });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultKeysError || error instanceof CryptoError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("file names", () => {
  it("names the local copy per MFS root with the first 16 hex of sha256(mfsRoot)", async () => {
    const digest = (await sha256Hex(utf8(ROOT))).slice(0, 16);
    expect(await rootDigest(ROOT)).toBe(digest);
    expect(await keySlotsCopyPath(ROOT)).toBe(`.ipfs-sync/keyslots.${digest}.json`);
    expect(await keySlotsCopyPath("/other")).not.toBe(await keySlotsCopyPath(ROOT));
  });
});

describe("first-time creation", () => {
  it("is refused without an explicit request, with no derivation and no local file", async () => {
    const node = nodeWith();
    expect(await code(open(node))).toBe("creation-not-requested");
    expect(kdf.derivations).toBe(0);
    expect(host.mutations).toEqual([]);
  });

  it("creates on request: the local copy is written, the caller must write the node file first", async () => {
    const node = nodeWith();
    const opened = await open(node, { create: GENERATED, createParams: FLOOR });
    expect(opened.origin).toBe("created");
    expect(opened.writeKeySlotsToNode).toBe(true);
    expect(kdf.derivations).toBe(1);
    expect(host.files.get(await keySlotsCopyPath(ROOT))?.data).toEqual(opened.keySlots);
    expect(opened.keySlotsSha256).toBe(await sha256Hex(opened.keySlots));
  });

  it("an interrupted first publish reruns with the SAME key: the copy exists, the node has no slots and no state", async () => {
    const first = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const again = await open(nodeWith());
    expect(again.origin).toBe("resumed-creation");
    expect(again.writeKeySlotsToNode).toBe(true);
    expect(again.vaultId).toBe(first.vaultId);
    expect(again.keySlots).toEqual(first.keySlots);
  });
});

describe("with a local copy", () => {
  it("unlocks from the copy BEFORE any request: a wrong passphrase sends nothing", async () => {
    const created = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const node = nodeWith(created.keySlots, true);
    expect(await code(open(node, {}, OTHER))).toBe("wrong-passphrase-or-damaged-slot");
    expect(node.requests).toEqual([]);
  });

  it("accepts the node's identical file and compares byte for byte", async () => {
    const created = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const node = nodeWith(created.keySlots, true);
    const opened = await open(node, { local: { hasState: true, vaultId: created.vaultId, keyslotsSha256: created.keySlotsSha256 } });
    expect(opened.origin).toBe("local-copy");
    expect(opened.writeKeySlotsToNode).toBe(false);
    expect(node.requests).toEqual(["keyslots"]);
  });

  it("a node file that differs by one byte stops with no derivation on the node's parameters and no write", async () => {
    const created = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const changed = new Uint8Array(created.keySlots);
    changed[changed.length - 3] = (changed[changed.length - 3] ?? 0) ^ 1;
    const before = kdf.derivations;
    const mutations = host.mutations.length;
    expect(await code(open(nodeWith(changed, true)))).toBe("vault-mismatch");
    expect(kdf.derivations - before).toBe(1);
    expect(host.mutations.length).toBe(mutations);
  });

  it("refuses a copy that disagrees with the recorded vaultId or hash before any derivation", async () => {
    const created = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const before = kdf.derivations;
    expect(await code(open(nodeWith(), { local: { hasState: true, vaultId: "00".repeat(16) } }))).toBe("vault-mismatch");
    expect(await code(open(nodeWith(), { local: { hasState: true, keyslotsSha256: "0".repeat(64) } }))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(before);
    void created;
  });

  it("a node that lost the slots, while the state names the root, stops and generates no key", async () => {
    const created = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const before = host.mutations.length;
    const keysBefore = kdf.derivations;
    expect(await code(open(nodeWith(undefined, true), { local: { hasState: true, vaultId: created.vaultId } }))).toBe("lost-slots");
    expect(await code(open(nodeWith(undefined, true)))).toBe("lost-slots");
    expect(kdf.derivations - keysBefore).toBe(2);
    expect(host.mutations.length).toBe(before);
    expect((await open(nodeWith(), { create: GENERATED })).vaultId).toBe(created.vaultId);
  });

  it("copies are per MFS root: another root does not see this root's copy", async () => {
    await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const other = await openVault({ fs: host.fs, mfsRoot: "/other-root", passphrase: PASS, local: { hasState: false }, node: nodeWith(), create: GENERATED, createParams: FLOOR });
    expect(other.origin).toBe("created");
    expect(host.files.size).toBe(2);
  });
});

describe("without a local copy", () => {
  it("a new device (manifest present, no knowledge) is refused before any derivation, without advising to delete state", async () => {
    const created = await existingVault();
    const before = kdf.derivations;
    const error = await open(nodeWith(created.bytes, true)).catch((e: unknown) => e as VaultKeysError);
    expect((error as VaultKeysError).code).toBe("new-device");
    expect((error as Error).message).not.toMatch(/delete/i);
    expect(kdf.derivations).toBe(before);
    expect(host.mutations).toEqual([]);
  });

  it("slots present, no manifest and no knowledge: refused with no derivation, naming --recover-slots", async () => {
    const created = await existingVault();
    const before = kdf.derivations;
    const error = await open(nodeWith(created.bytes, false)).catch((e: unknown) => e as VaultKeysError);
    expect((error as VaultKeysError).code).toBe("slots-without-manifest");
    expect((error as Error).message).toContain("--recover-slots");
    expect(kdf.derivations).toBe(before);
  });

  it("--recover-slots derives only after the cost was shown and confirmed, then stores the copy", async () => {
    const created = await existingVault();
    const shown: unknown[] = [];
    const before = kdf.derivations;
    expect(await code(open(nodeWith(created.bytes), { recoverSlots: true, confirmRecover: async (costs) => (shown.push(costs), false) }))).toBe("recover-declined");
    expect(kdf.derivations).toBe(before);
    expect(shown).toEqual([[FLOOR]]);
    const opened = await open(nodeWith(created.bytes), { recoverSlots: true, confirmRecover: async () => true });
    expect(opened.origin).toBe("recovered");
    expect(kdf.derivations).toBe(before + 1);
    expect(host.files.get(await keySlotsCopyPath(ROOT))?.data).toEqual(created.bytes);
    host.drop(await keySlotsCopyPath(ROOT));
    expect(await code(open(nodeWith(created.bytes), { recoverSlots: true }))).toBe("slots-without-manifest");
  });

  it("the state's recorded hash is checked before any derivation on node-supplied parameters", async () => {
    const created = await existingVault();
    const before = kdf.derivations;
    expect(await code(open(nodeWith(created.bytes, true), { local: { hasState: true, keyslotsSha256: "0".repeat(64) } }))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(before);
    const opened = await open(nodeWith(created.bytes, true), { local: { hasState: true, keyslotsSha256: await sha256Hex(created.bytes) } });
    expect(opened.origin).toBe("state-hash");
    expect(kdf.derivations).toBe(before + 1);
    expect(host.files.has(await keySlotsCopyPath(ROOT))).toBe(true);
  });

  it("a slot costing 96 MiB is refused when the host cannot ask, and accepted when the host approves", async () => {
    const fake = countingFakeKdf();
    const high = await createKeySlotsInternal({ passphrase: GENERATED, params: { m: 98_304, t: 3, p: 1 } }, secureRandom, { kdf: fake.kdf });
    const state = { hasState: true, keyslotsSha256: await sha256Hex(high.bytes) };
    const before = kdf.derivations;
    expect(await code(open(nodeWith(high.bytes, true), { local: state }))).toBe("kdf-cost-refused");
    expect(kdf.derivations).toBe(before);
  });

  it("a hostile oversize or malformed node file derives nothing", async () => {
    const before = kdf.derivations;
    expect(await code(open(nodeWith(new Uint8Array(20_000)), { recoverSlots: true, confirmRecover: async () => true }))).toBe("oversize-input");
    expect(await code(open(nodeWith(utf8("{}")), { recoverSlots: true, confirmRecover: async () => true }))).toBe("malformed-input");
    expect(kdf.derivations).toBe(before);
  });
});

describe("a held UnlockedVault (R5-06)", () => {
  const CHEAP = { approveCost: async () => true };
  const reopen = (unlocked: Parameters<typeof toUnlockedVault>[0] | ReturnType<typeof toUnlockedVault>, node: NodeAccess) =>
    openVault({ fs: host.fs, mfsRoot: ROOT, local: { hasState: false }, node, unlocked: unlocked as ReturnType<typeof toUnlockedVault>, costPolicy: CHEAP });

  it("uses a minted vault for byte-identical slots with no passphrase and no derivation", async () => {
    const node = nodeWith();
    const opened = await open(node, { create: GENERATED, createParams: FLOOR });
    node.slots = opened.keySlots;
    kdf.derivations = 0;
    const again = await reopen(toUnlockedVault(opened), node);
    expect(again.origin).toBe("local-copy");
    expect(kdf.derivations).toBe(0);
  });

  it("refuses a structurally forged vault (a spread copy is not the minted object) and derives nothing", async () => {
    const node = nodeWith();
    const opened = await open(node, { create: GENERATED, createParams: FLOOR });
    node.slots = opened.keySlots;
    kdf.derivations = 0;
    const forged = { ...toUnlockedVault(opened) };
    expect(await code(reopen(forged, node))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(0);
  });

  it("refuses a minted vault whose keys belong to another vault than the slots being opened", async () => {
    const nodeA = nodeWith();
    const a = await open(nodeA, { create: GENERATED, createParams: FLOOR });
    host = createMemoryHost();
    const nodeB = nodeWith();
    const b = await open(nodeB, { create: GENERATED, createParams: FLOOR });
    expect(a.vaultId).not.toBe(b.vaultId);
    nodeB.slots = b.keySlots;
    const mixed = toUnlockedVault({ ...a, keySlots: b.keySlots, keySlotsSha256: b.keySlotsSha256, vaultId: b.vaultId });
    kdf.derivations = 0;
    expect(await code(reopen(mixed, nodeB))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(0);
  });
});

describe("abandon", () => {
  it("records no latch: it only renames, and does nothing when there is nothing to move", async () => {
    expect((await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 5 })).moved).toEqual([]);
    expect(host.mutations).toEqual([]);
    await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    host.mutations.length = 0;
    await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 6 });
    expect(host.mutations.length).toBeGreaterThan(0);
    expect(host.mutations.every((entry) => /rename/.test(entry))).toBe(true);
    expect(host.files.has(".ipfs-sync/encrypted-seen.json")).toBe(false);
  });

  it("needs only the stat, rename and read capabilities (the latch write is gone)", async () => {
    await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const fs = { stat: (path: string) => host.fs.stat(path), rename: (from: string, to: string) => host.fs.rename(from, to), read: (path: string) => host.fs.read(path) };
    const result = await abandonVault({ fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 7 });
    expect(result.moved.length).toBeGreaterThan(0);
  });

  it("needs the typed confirmation; then moves copy, state and journal to a backup and never touches a node", async () => {
    await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    const digest = await rootDigest(ROOT);
    host.put(`.ipfs-sync/state.${digest}.json`, "{}");
    host.put(`.ipfs-sync/journal.${digest}.json`, "{}");
    host.put(`.ipfs-sync/state.other.json`, "keep");
    const before = host.mutations.length;
    expect(await code(abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: "yes", nowMs: 1 }))).toBe("abandon-not-confirmed");
    expect(host.mutations.length).toBe(before);
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1_700 });
    expect(result.moved).toHaveLength(3);
    expect(result.backupDir).toBe(`.ipfs-sync/abandoned-${digest}-1700`);
    expect([...host.files.keys()].sort()).toEqual(
      [".ipfs-sync/state.other.json", `${result.backupDir}/journal.json`, `${result.backupDir}/keyslots.json`, `${result.backupDir}/state.json`].sort(),
    );
    // No downgrade latch is written: the sequence floor (07a) is the evidence, and abandon keeps it.
    expect(host.files.has(".ipfs-sync/encrypted-seen.json")).toBe(false);
    // A fresh vault can now be created in the same root name with no local knowledge.
    const fresh = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    expect(fresh.origin).toBe("created");
  });
});

describe("abandon: the sequence floor it keeps", () => {
  const floorEntry = (sequence: number) => ({ sequence, identity: "1".repeat(64), at: 1000 });

  async function createdVault() {
    const opened = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    return opened.vaultId;
  }

  it("returns the floor found for the vault named by the key-slot copy, and leaves the floor file byte-identical", async () => {
    const vaultId = await createdVault();
    const store = createMemoryDeviceStore();
    await raiseFloor(store, vaultId, floorEntry(5));
    await raiseFloor(store, "c".repeat(32), floorEntry(9));
    const before = new Uint8Array(store.entries.get(SEQUENCE_FLOOR_FILE) ?? new Uint8Array());
    store.writes.length = 0;
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store });
    expect(result.floor).toEqual({ status: "kept", vaultId, sequence: 5 });
    expect(describeAbandonFloor(result.floor)).toBe("sequence floor kept: 5");
    expect(store.entries.get(SEQUENCE_FLOOR_FILE)).toEqual(before);
    expect(store.writes).toEqual([]);
    expect(await keySlotsCopyPath(ROOT).then((path) => host.files.has(path))).toBe(false);
  });

  it("reads the vault id from the state when the key-slot copy does not parse", async () => {
    const store = createMemoryDeviceStore();
    const vaultId = "d".repeat(32);
    await raiseFloor(store, vaultId, floorEntry(3));
    const digest = await rootDigest(ROOT);
    host.put(`.ipfs-sync/keyslots.${digest}.json`, "not key slots");
    host.put(`.ipfs-sync/state.${digest}.json`, JSON.stringify({ vaultId }));
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store });
    expect(result.floor).toEqual({ status: "kept", vaultId, sequence: 3 });
  });

  it.each([
    ["no device store is given", undefined],
    ["the store holds no floor file", createMemoryDeviceStore()],
  ])("says none when %s", async (_name, store) => {
    await createdVault();
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, ...(store === undefined ? {} : { deviceStore: store }) });
    expect(result.floor).toEqual({ status: "none" });
    expect(describeAbandonFloor(result.floor)).toContain("sequence floor kept: none");
    expect(store?.writes ?? []).toEqual([]);
  });

  it("says none for a vault that has no entry in the floor file, and for files that name no vault", async () => {
    const store = createMemoryDeviceStore();
    await raiseFloor(store, "c".repeat(32), floorEntry(9));
    await createdVault();
    expect((await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store })).floor).toEqual({ status: "none" });
    const digest = await rootDigest("/obsidian-vault-sync/junk");
    host.put(`.ipfs-sync/keyslots.${digest}.json`, "{}");
    // R6-L1: files that name no vault are not "no floor": the floor was not looked up at all.
    expect((await abandonVault({ fs: host.fs, mfsRoot: "/obsidian-vault-sync/junk", confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store })).floor).toEqual({ status: "not-looked-up" });
  });

  it("R6-L1: when the vault id cannot be determined, it says 'not looked up', not 'none (this device has no floor)'", async () => {
    const store = createMemoryDeviceStore();
    const digest = await rootDigest(ROOT);
    host.put(`.ipfs-sync/state.${digest}.json`, "not json");
    host.put(`.ipfs-sync/journal.${digest}.json`, "{}");
    const { floor } = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store });
    expect(floor).toEqual({ status: "not-looked-up" });
    expect(describeAbandonFloor(floor)).toBe("sequence floor kept: not looked up (the vault id is no longer on this device)");
    expect(describeAbandonFloor(floor)).not.toContain("none");
    // The other statuses keep their wording.
    expect(describeAbandonFloor({ status: "none" })).toBe("sequence floor kept: none (this device has no floor for the vault)");
  });

  it("reports a damaged floor file as unreadable, still moves the files and does not touch the floor", async () => {
    await createdVault();
    const store = createMemoryDeviceStore();
    const damaged = new TextEncoder().encode("{not json");
    store.entries.set(SEQUENCE_FLOOR_FILE, damaged);
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store });
    expect(result.floor.status).toBe("unreadable");
    expect(describeAbandonFloor(result.floor)).toContain("unreadable");
    expect(result.moved.length).toBeGreaterThan(0);
    expect(store.entries.get(SEQUENCE_FLOOR_FILE)).toBe(damaged);
    expect(store.writes).toEqual([]);
  });

  it("reads nothing from the store when there is nothing to move", async () => {
    const store = { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) };
    const result = await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 1, deviceStore: store });
    expect(result).toMatchObject({ moved: [], floor: { status: "none" } });
    expect(store.get).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });
});

const VAULT_ID = "e".repeat(32);
const FOUR = ["keyslots", "state", "journal", "maintenance"] as const;

async function seedFour(): Promise<string> {
  const digest = await rootDigest(ROOT);
  host.put(`.ipfs-sync/keyslots.${digest}.json`, "not key slots");
  host.put(`.ipfs-sync/state.${digest}.json`, JSON.stringify({ vaultId: VAULT_ID }));
  host.put(`.ipfs-sync/journal.${digest}.json`, "journal-body");
  host.put(`.ipfs-sync/maintenance.${digest}.json`, "maintenance-body");
  return digest;
}

const INPUT = (extra: Partial<Parameters<typeof abandonVault>[0]> = {}): Parameters<typeof abandonVault>[0] => ({
  fs: host.fs,
  mfsRoot: ROOT,
  confirmation: ABANDON_CONFIRMATION,
  nowMs: 9,
  ...extra,
});

describe("R6-M3: a failing device store never blocks the move", () => {
  const SECRET = "/Users/someone/secret-store-path";
  it.each([
    ["a DeviceStoreError", new DeviceStoreError(`cannot locate ${SECRET}`)],
    ["a generic Error", new Error(`EACCES ${SECRET}`)],
    ["a SequenceFloorError raised by the store itself", new SequenceFloorError(`floor ${SECRET}`)],
    ["a thrown string", SECRET],
  ])("%s: all four files still move and the report says the floor could not be read, without the message", async (_label, failure) => {
    const digest = await seedFour();
    const store = {
      get: vi.fn(async () => {
        throw failure;
      }),
      set: vi.fn(async () => undefined),
    };
    const result = await abandonVault(INPUT({ deviceStore: store }));
    expect(store.get).toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
    expect(result.moved).toHaveLength(4);
    for (const kind of FOUR) {
      expect(host.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
      expect(host.files.has(`${result.backupDir}/${kind}.json`)).toBe(true);
    }
    const text = describeAbandonFloor(result.floor);
    expect(text).toContain("could not be read");
    expect(JSON.stringify(result.floor)).not.toContain("secret");
    expect(text).not.toContain("secret");
  });
});

describe("R6-M4: a rename that fails after the first one is a partial move", () => {
  const OS_TEXT = "EIO: i/o error, rename '/Users/someone/secret/state.json'";

  it.each([
    [2, ["keyslots"], "1 of 4"],
    [3, ["keyslots", "state"], "2 of 4"],
    [4, ["keyslots", "state", "journal"], "3 of 4"],
  ])("failing rename number %i throws a typed error with only counts and the kinds moved", async (failing, kinds, counts) => {
    const digest = await seedFour();
    let renames = 0;
    const fs = {
      stat: host.fs.stat,
      read: host.fs.read,
      rename: async (from: string, to: string) => {
        renames += 1;
        if (renames === failing) throw new Error(OS_TEXT);
        await host.fs.rename(from, to);
      },
    };
    const error = await abandonVault(INPUT({ fs })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AbandonPartialMoveError);
    const partial = error as AbandonPartialMoveError;
    expect(partial.moved).toBe(kinds.length);
    expect(partial.total).toBe(4);
    expect(partial.kinds).toEqual(kinds);
    expect(partial.message).toBe(`${counts} files were moved. Run abandon again to move the rest.`);
    expect(partial.message).toBe(partialMoveLine(kinds.length, 4));
    expect(partial.message).not.toContain("EIO");
    expect(partial.message).not.toContain("secret");
    expect(JSON.stringify(partial)).not.toContain("secret");
    expect(partial.cause).toBeUndefined();
    // The files already moved are in the backup; the rest are still in place.
    for (const kind of FOUR) {
      const moved = (kinds as readonly string[]).includes(kind);
      expect(host.files.has(`.ipfs-sync/${kind}.${digest}.json`), kind).toBe(!moved);
      expect(host.files.has(`.ipfs-sync/abandoned-${digest}-9/${kind}.json`), kind).toBe(moved);
    }
  });

  it("a failure of the FIRST rename is not a partial move: nothing moved, the original error surfaces", async () => {
    await seedFour();
    const fs = {
      stat: host.fs.stat,
      read: host.fs.read,
      rename: async () => {
        throw new Error(OS_TEXT);
      },
    };
    const error = await abandonVault(INPUT({ fs })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeInstanceOf(AbandonPartialMoveError);
    expect((error as Error).message).toBe(OS_TEXT);
  });

  it("running abandon again finishes the rest, and counts only what that run moved", async () => {
    const digest = await seedFour();
    let renames = 0;
    const failing = {
      stat: host.fs.stat,
      read: host.fs.read,
      rename: async (from: string, to: string) => {
        renames += 1;
        if (renames === 3) throw new Error(OS_TEXT);
        await host.fs.rename(from, to);
      },
    };
    await expect(abandonVault(INPUT({ fs: failing }))).rejects.toBeInstanceOf(AbandonPartialMoveError);
    const second = await abandonVault(INPUT());
    expect(second.moved).toEqual([`.ipfs-sync/journal.${digest}.json`, `.ipfs-sync/maintenance.${digest}.json`]);
    for (const kind of FOUR) expect(host.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
    for (const kind of FOUR) expect(host.files.has(`.ipfs-sync/abandoned-${digest}-9/${kind}.json`)).toBe(true);
  });

  it("a one-file move that fails is not a partial move", async () => {
    const digest = await rootDigest(ROOT);
    host.put(`.ipfs-sync/journal.${digest}.json`, "j");
    const fs = {
      stat: host.fs.stat,
      read: host.fs.read,
      rename: async () => {
        throw new Error(OS_TEXT);
      },
    };
    await expect(abandonVault(INPUT({ fs }))).rejects.toThrow(OS_TEXT);
  });
});
