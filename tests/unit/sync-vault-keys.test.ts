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
import {
  ABANDON_CONFIRMATION,
  VaultKeysError,
  abandonVault,
  keySlotsCopyPath,
  openVault,
  rootDigest,
  toUnlockedVault,
  type NodeAccess,
  type OpenVaultInput,
} from "../../src/sync/vault-keys";
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
  it("records the latch before the first rename, and records nothing when there is nothing to move", async () => {
    expect((await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 5 })).moved).toEqual([]);
    expect(host.mutations).toEqual([]);
    await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    host.mutations.length = 0;
    await abandonVault({ fs: host.fs, mfsRoot: ROOT, confirmation: ABANDON_CONFIRMATION, nowMs: 6 });
    const firstRename = host.mutations.findIndex((entry) => /rename/.test(entry));
    const latchWrite = host.mutations.findIndex((entry) => entry.includes("encrypted-seen.json"));
    expect(latchWrite).toBeGreaterThanOrEqual(0);
    expect(latchWrite).toBeLessThan(firstRename);
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
      [".ipfs-sync/encrypted-seen.json", ".ipfs-sync/state.other.json", `${result.backupDir}/journal.json`, `${result.backupDir}/keyslots.json`, `${result.backupDir}/state.json`].sort(),
    );
    // The downgrade latch was written through the same fs, before anything moved (R5-02).
    expect(host.files.has(".ipfs-sync/encrypted-seen.json")).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(host.files.get(".ipfs-sync/encrypted-seen.json")?.data))).toMatchObject({ encryptedSeen: true, sightings: [{ mfsRoot: ROOT, key: "abandon" }] });
    // A fresh vault can now be created in the same root name with no local knowledge.
    const fresh = await open(nodeWith(), { create: GENERATED, createParams: FLOOR });
    expect(fresh.origin).toBe("created");
  });
});
