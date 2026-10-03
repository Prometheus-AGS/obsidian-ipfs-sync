import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const kdf = vi.hoisted(() => ({ derivations: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return { ...original, argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => (kdf.derivations++, original.argon2idAsync(...args)) };
});

import { CryptoError, KdfCostRefusedError, type Bytes, canonicalizePassphraseText, createKeySlots, type CanonicalPassphrase, type KdfParams } from "../../src/crypto";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { sha256Hex } from "../../src/sync/hash";
import { PullUnlockError, assertManifestVault, recordLookup, storeKeySlotsCopy, unlockForPull, type PullUnlock, type PullUnlockInput } from "../../src/sync/pull-unlock";
import type { StateRecord } from "../../src/sync/pull-sequence";
import { SequenceFloorError, SEQUENCE_FLOOR_FILE, raiseFloor } from "../../src/sync/sequence-floor";
import { VaultKeysError, keySlotsCopyPath, openVault, toUnlockedVault, type NodeAccess } from "../../src/sync/vault-keys";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { editDocument, firstSlot, flipBase64Bit } from "../vectors/slot-helpers";

const ROOT = "/obsidian-vault-sync/test-root";
const FLOOR = { m: 19_456, t: 2, p: 1 };
/** Above the default cost (t > 3) and cheap enough to derive in a test. */
const ABOVE_DEFAULT: KdfParams = { m: 19_456, t: 4, p: 1 };
const PASS_TEXT = "HEZVI-DN7IB-GLQIX-B5L7V-ARDHC";
const PASS = canonicalizePassphraseText(PASS_TEXT);
const GENERATED = asGenerated(PASS_TEXT);
const OTHER_TEXT = "AAAAAAAAAAAAAAAAAAAAAAAJ6";
const OTHER = canonicalizePassphraseText(OTHER_TEXT);
const HASH_A = "a".repeat(64);

interface FakeNode extends NodeAccess {
  slots: Uint8Array | undefined;
  manifest: boolean;
  requests: string[];
}

function nodeWith(slots?: Uint8Array, manifest = true): FakeNode {
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

const NO_RECORD: PullUnlockInput["recordFor"] = () => undefined;

/** `passphrase: null` means no passphrase at all (a locked vault); the default is the right one. */
function unlock(node: NodeAccess, extra: Partial<PullUnlockInput> = {}, passphrase: CanonicalPassphrase | null = PASS): Promise<PullUnlock> {
  return unlockForPull({ fs: host.fs, mfsRoot: ROOT, passphrase: passphrase ?? undefined, local: { hasState: false }, node, recordFor: NO_RECORD, ...extra });
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

const codeOf = (error: Error): string => (error instanceof PullUnlockError ? error.reason : (error as VaultKeysError | CryptoError).code);

/** A vault as the publishing device created it. Creating it derives once; the counter is reset so tests count the pull only. */
async function publisherVault(params: KdfParams = FLOOR) {
  const created = await createKeySlots({ passphrase: GENERATED, params });
  kdf.derivations = 0;
  return created;
}

/** The three ways a slot file can fail to open, as bytes: one commitment bit, one wrapped-key bit, a wrong passphrase on intact bytes. */
function damagedCommit(bytes: Uint8Array): Bytes {
  return editDocument(bytes, (document) => {
    const slot = firstSlot(document);
    slot["commit"] = flipBase64Bit(slot["commit"] as string, 7);
  });
}
function damagedWrap(bytes: Uint8Array): Bytes {
  return editDocument(bytes, (document) => {
    const wrap = firstSlot(document)["wrap"] as { ct: string };
    wrap.ct = flipBase64Bit(wrap.ct, 100);
  });
}

describe("one outcome, identical work", () => {
  it("wrong passphrase, damaged slot and failed commitment: the same derivations, one error, one message (no copy)", async () => {
    const created = await publisherVault();
    const cases: { name: string; bytes: Bytes; passphrase: CanonicalPassphrase }[] = [
      { name: "wrong passphrase", bytes: created.bytes, passphrase: OTHER },
      { name: "damaged slot", bytes: damagedWrap(created.bytes), passphrase: PASS },
      { name: "failed commitment", bytes: damagedCommit(created.bytes), passphrase: PASS },
    ];
    const seen: { name: string; derivations: number; code: string; message: string; type: string }[] = [];
    for (const { name, bytes, passphrase } of cases) {
      kdf.derivations = 0;
      const error = await failure(unlock(nodeWith(bytes), {}, passphrase));
      seen.push({ name, derivations: kdf.derivations, code: codeOf(error), message: error.message, type: error.constructor.name });
    }
    expect(new Set(seen.map((entry) => entry.derivations))).toEqual(new Set([1]));
    expect(new Set(seen.map((entry) => entry.code))).toEqual(new Set(["wrong-passphrase-or-damaged-slot"]));
    expect(new Set(seen.map((entry) => entry.message)).size).toBe(1);
    expect(new Set(seen.map((entry) => entry.type)).size).toBe(1);
    expect(host.mutations).toEqual([]);
  });

  it("the same holds with a local copy", async () => {
    const created = await publisherVault();
    const seen: { derivations: number; code: string; message: string }[] = [];
    for (const [bytes, passphrase] of [
      [created.bytes, OTHER],
      [damagedWrap(created.bytes), PASS],
      [damagedCommit(created.bytes), PASS],
    ] as const) {
      host = createMemoryHost();
      host.put(await keySlotsCopyPath(ROOT), bytes);
      kdf.derivations = 0;
      const node = nodeWith(created.bytes);
      const error = await failure(unlock(node, {}, passphrase));
      seen.push({ derivations: kdf.derivations, code: codeOf(error), message: error.message });
      expect(node.requests).toEqual([]);
    }
    expect(new Set(seen.map((entry) => entry.derivations))).toEqual(new Set([1]));
    expect(new Set(seen.map((entry) => `${entry.code}|${entry.message}`)).size).toBe(1);
  });

  it("neither the passphrase nor the canonical form appears in any refusal text", async () => {
    const created = await publisherVault();
    const errors = [
      await failure(unlock(nodeWith(created.bytes), {}, OTHER)),
      await failure(unlock(nodeWith(created.bytes), { expectVaultId: "00".repeat(16) })),
      await failure(unlock(nodeWith(created.bytes, false))),
      await failure(unlock(nodeWith(undefined))),
      await failure(unlock(nodeWith(created.bytes), {}, null)),
    ];
    for (const error of errors) {
      const text = `${error.name} ${error.message} ${JSON.stringify(error)}`;
      expect(text).not.toContain(PASS_TEXT);
      expect(text).not.toContain(OTHER_TEXT);
      expect(text).not.toContain(PASS_TEXT.replaceAll("-", ""));
    }
  });
});

describe("expectations and the record are compared on the parsed vaultId before any derivation", () => {
  it("--expect-vault-id that differs refuses with the counter at 0 (new device and local copy)", async () => {
    const created = await publisherVault();
    const wrongId = created.document.vaultId.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const node = nodeWith(created.bytes);
    const error = await failure(unlock(node, { expectVaultId: wrongId }));
    expect(error).toBeInstanceOf(PullUnlockError);
    expect((error as PullUnlockError).reason).toBe("expectation-failed");
    expect(kdf.derivations).toBe(0);
    expect(node.requests).not.toContain("manifest");

    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    const withCopy = await failure(unlock(nodeWith(created.bytes), { expectVaultId: wrongId }));
    expect((withCopy as PullUnlockError).reason).toBe("expectation-failed");
    expect(kdf.derivations).toBe(0);
  });

  it("the right --expect-vault-id proceeds", async () => {
    const created = await publisherVault();
    const opened = await unlock(nodeWith(created.bytes), { expectVaultId: created.document.vaultId });
    expect(opened.vaultId).toBe(created.document.vaultId);
    expect(kdf.derivations).toBe(1);
  });

  it("a directory state or floor of another vault refuses with the counter at 0", async () => {
    const created = await publisherVault();
    const store = createMemoryDeviceStore();
    const otherVault = "ab".repeat(16);
    await raiseFloor(store, otherVault, { sequence: 9, identity: HASH_A, at: 1 });
    const state: StateRecord = { vaultId: otherVault, sequence: 9, identity: HASH_A, pendingPublish: false };
    const error = await failure(unlock(nodeWith(created.bytes), { recordFor: recordLookup({ state, deviceStore: store }) }));
    expect(error).toBeInstanceOf(PullUnlockError);
    expect((error as PullUnlockError).reason).toBe("other-vault");
    expect(kdf.derivations).toBe(0);
  });

  it("the floor is read for the parsed vaultId; a floor of the vault being opened does not refuse by itself", async () => {
    const created = await publisherVault();
    const store = createMemoryDeviceStore();
    await raiseFloor(store, created.document.vaultId, { sequence: 9, identity: HASH_A, at: 1 });
    const seen: string[] = [];
    const lookup = recordLookup({ state: undefined, deviceStore: store });
    const opened = await unlock(nodeWith(created.bytes), {
      recordFor: async (id) => {
        seen.push(id);
        return lookup(id);
      },
    });
    expect(seen).toEqual([created.document.vaultId]);
    expect(opened.vaultId).toBe(created.document.vaultId);
  });

  it("a damaged floor file stops the unlock before any derivation", async () => {
    const created = await publisherVault();
    const store = createMemoryDeviceStore();
    store.entries.set(SEQUENCE_FLOOR_FILE, new TextEncoder().encode("not json"));
    const error = await failure(unlock(nodeWith(created.bytes), { recordFor: recordLookup({ state: undefined, deviceStore: store }) }));
    expect(error).toBeInstanceOf(SequenceFloorError);
    expect(kdf.derivations).toBe(0);
  });

  it("a directory whose state records another vault is refused before the derivation (local record)", async () => {
    const created = await publisherVault();
    const error = await failure(unlock(nodeWith(created.bytes), { local: { hasState: true, vaultId: "cd".repeat(16) } }));
    expect(codeOf(error)).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(0);
  });
});

describe("cost confirmation and the work budget", () => {
  it("a slot file above the default cost is refused non-interactively, with no derivation", async () => {
    const high = await publisherVault(ABOVE_DEFAULT);
    kdf.derivations = 0;
    const error = await failure(unlock(nodeWith(high.bytes)));
    expect(error).toBeInstanceOf(KdfCostRefusedError);
    expect(codeOf(error)).toBe("kdf-cost-refused");
    expect(kdf.derivations).toBe(0);
    expect(host.mutations).toEqual([]);
  });

  it("interactively it asks once with the cost of every tried slot, derives only on yes", async () => {
    const high = await publisherVault(ABOVE_DEFAULT);
    kdf.derivations = 0;
    const shown: (readonly KdfParams[])[] = [];
    const declined = await failure(unlock(nodeWith(high.bytes), { confirmCost: async (costs) => (shown.push(costs), false) }));
    expect(codeOf(declined)).toBe("kdf-cost-refused");
    expect(kdf.derivations).toBe(0);
    expect(shown).toEqual([[ABOVE_DEFAULT]]);

    const thrown = await failure(unlock(nodeWith(high.bytes), { confirmCost: async () => Promise.reject(new Error("dialog closed")) }));
    expect(codeOf(thrown)).toBe("kdf-cost-refused");
    expect(kdf.derivations).toBe(0);

    const accepted = await unlock(nodeWith(high.bytes), { confirmCost: async (costs) => (shown.push(costs), true) });
    expect(accepted.vaultId).toBe(high.document.vaultId);
    expect(kdf.derivations).toBe(1);
    expect(shown).toHaveLength(2);
  });

  it("a slot at or below the default cost never asks", async () => {
    const created = await publisherVault();
    let asked = 0;
    await unlock(nodeWith(created.bytes), { confirmCost: async () => (asked++, true) });
    expect(asked).toBe(0);
  });

  it("a hostile oversize or malformed node file derives nothing", async () => {
    expect(codeOf(await failure(unlock(nodeWith(new Uint8Array(20_000)))))).toBe("oversize-input");
    expect(codeOf(await failure(unlock(nodeWith(new TextEncoder().encode("{}")))))).toBe("malformed-input");
    expect(kdf.derivations).toBe(0);
  });
});

describe("without a local copy (a device that did not create the vault)", () => {
  it("unlocks the node's slot and returns the copy; nothing is written until the caller says so", async () => {
    const created = await publisherVault();
    const opened = await unlock(nodeWith(created.bytes));
    expect(opened.origin).toBe("node-slots");
    expect(opened.vaultId).toBe(created.document.vaultId);
    expect(opened.keySlotsSha256).toBe(await sha256Hex(created.bytes));
    expect(opened.copyToStore).toEqual(created.bytes);
    expect(kdf.derivations).toBe(1);
    expect(host.mutations).toEqual([]);
    expect(host.files.has(await keySlotsCopyPath(ROOT))).toBe(false);
  });

  it("the copy is stored only with both statements, and then the next open takes the copy path", async () => {
    const created = await publisherVault();
    const opened = await unlock(nodeWith(created.bytes));
    const bad = [
      { manifestAuthenticated: false, confirmationGiven: true },
      { manifestAuthenticated: true, confirmationGiven: false },
      {},
    ] as unknown as Parameters<typeof storeKeySlotsCopy>[2][];
    for (const proof of bad) {
      await expect(storeKeySlotsCopy(opened, host.fs, proof)).rejects.toThrow(/stored only after/);
    }
    expect(host.mutations).toEqual([]);
    expect(await storeKeySlotsCopy(opened, host.fs, { manifestAuthenticated: true, confirmationGiven: true })).toBe(true);
    expect(host.files.get(await keySlotsCopyPath(ROOT))?.data).toEqual(created.bytes);

    kdf.derivations = 0;
    const node = nodeWith(created.bytes);
    const again = await unlock(node);
    expect(again.origin).toBe("local-copy");
    expect(again.copyToStore).toBeUndefined();
    expect(await storeKeySlotsCopy(again, host.fs, { manifestAuthenticated: true, confirmationGiven: true })).toBe(false);
    expect(host.mutations).toHaveLength(1);
  });

  it("a returned copy cannot be altered through the caller's view of the node's bytes", async () => {
    const created = await publisherVault();
    const node = nodeWith(new Uint8Array(created.bytes));
    const opened = await unlock(node);
    (node.slots as Uint8Array)[0] = 0;
    expect(opened.copyToStore).toEqual(created.bytes);
  });

  it("the recorded digest is compared before any derivation, and a matching one derives once", async () => {
    const created = await publisherVault();
    const mismatch = await failure(unlock(nodeWith(created.bytes), { local: { hasState: true, keyslotsSha256: "0".repeat(64) } }));
    expect(codeOf(mismatch)).toBe("vault-mismatch");
    expect(mismatch.message).toContain("accept-slots");
    expect(kdf.derivations).toBe(0);
    const opened = await unlock(nodeWith(created.bytes), { local: { hasState: true, keyslotsSha256: await sha256Hex(created.bytes) } });
    expect(opened.origin).toBe("state-hash");
    expect(kdf.derivations).toBe(1);
  });

  it("key slots without a manifest are refused before any derivation, even with the right passphrase", async () => {
    const created = await publisherVault();
    const error = await failure(unlock(nodeWith(created.bytes, false)));
    expect(codeOf(error)).toBe("slots-without-manifest");
    expect(error.message).toMatch(/withheld or not yet published/);
    expect(kdf.derivations).toBe(0);
    expect(host.mutations).toEqual([]);
  });

  it("a root without key slots is a distinct refusal that reveals nothing about any passphrase", async () => {
    const error = await failure(unlock(nodeWith(undefined)));
    expect(codeOf(error)).toBe("no-key-slots");
    expect(kdf.derivations).toBe(0);
  });

  it("a locked vault (no passphrase, no held vault) derives nothing", async () => {
    const created = await publisherVault();
    const error = await failure(unlock(nodeWith(created.bytes), {}, null));
    expect(codeOf(error)).toBe("locked");
    expect(kdf.derivations).toBe(0);
  });

  it("the manifest's vaultId must equal the slot file's", async () => {
    const created = await publisherVault();
    const opened = await unlock(nodeWith(created.bytes));
    expect(() => assertManifestVault(opened, created.document.vaultId)).not.toThrow();
    let raised: unknown;
    try {
      assertManifestVault(opened, "ef".repeat(16));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(VaultKeysError);
    expect((raised as VaultKeysError).code).toBe("vault-mismatch");
    expect(host.mutations).toEqual([]);
  });
});

describe("with a local copy", () => {
  it("unlocks the copy before any request: a wrong passphrase sends nothing", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    const node = nodeWith(created.bytes);
    expect(codeOf(await failure(unlock(node, {}, OTHER)))).toBe("wrong-passphrase-or-damaged-slot");
    expect(node.requests).toEqual([]);
  });

  it("an identical node file is accepted; no copy is returned; the node file is compared byte for byte", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    const node = nodeWith(created.bytes);
    const opened = await unlock(node, { local: { hasState: true, vaultId: created.document.vaultId, keyslotsSha256: await sha256Hex(created.bytes) } });
    expect(opened.origin).toBe("local-copy");
    expect(opened.copyToStore).toBeUndefined();
    expect(node.requests).toEqual(["keyslots", "manifest"]);
    expect(kdf.derivations).toBe(1);
  });

  it("a node file that differs refuses, names the accept action and never derives on the node's parameters", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    // The node's file carries a cost the copy does not: a derivation on it would be visible as a second derivation.
    const rewrapped = await publisherVault(ABOVE_DEFAULT);
    for (const nodeBytes of [rewrapped.bytes, damagedCommit(created.bytes)]) {
      kdf.derivations = 0;
      const error = await failure(unlock(nodeWith(nodeBytes), { confirmCost: async () => true }));
      expect(codeOf(error)).toBe("vault-mismatch");
      expect(error.message).toContain("accept-slots");
      expect(kdf.derivations).toBe(1);
    }
    expect(host.mutations).toEqual([]);
  });

  it("a node that no longer serves the slots, or serves them without a manifest, stops after the local unlock", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    expect(codeOf(await failure(unlock(nodeWith(undefined))))).toBe("no-key-slots");
    expect(codeOf(await failure(unlock(nodeWith(created.bytes, false))))).toBe("slots-without-manifest");
    expect(host.mutations).toEqual([]);
  });

  it("a copy that disagrees with the recorded vault or digest is refused before any derivation", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    expect(codeOf(await failure(unlock(nodeWith(), { local: { hasState: true, vaultId: "00".repeat(16) } })))).toBe("vault-mismatch");
    expect(codeOf(await failure(unlock(nodeWith(), { local: { hasState: true, keyslotsSha256: "0".repeat(64) } })))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(0);
  });
});

describe("a session-held UnlockedVault", () => {
  it("bypasses the derivation (and the cost question) for byte-identical slots, with no passphrase", async () => {
    const created = await publisherVault(ABOVE_DEFAULT);
    const first = await unlock(nodeWith(created.bytes), { confirmCost: async () => true });
    kdf.derivations = 0;
    let asked = 0;
    const second = await unlock(nodeWith(created.bytes), { passphrase: undefined, unlocked: first.vault, confirmCost: async () => (asked++, true) });
    expect(kdf.derivations).toBe(0);
    expect(asked).toBe(0);
    expect(second.keys).toBe(first.keys);
    expect(second.copyToStore).toEqual(created.bytes);
  });

  it("works against the local copy as well, and refuses a forged or foreign held vault without deriving", async () => {
    const created = await publisherVault();
    host.put(await keySlotsCopyPath(ROOT), created.bytes);
    const first = await unlock(nodeWith(created.bytes));
    kdf.derivations = 0;
    const held = await unlock(nodeWith(created.bytes), { passphrase: undefined, unlocked: first.vault });
    expect(held.origin).toBe("local-copy");
    expect(kdf.derivations).toBe(0);

    const forged = { ...first.vault };
    expect(codeOf(await failure(unlock(nodeWith(created.bytes), { passphrase: undefined, unlocked: forged })))).toBe("vault-mismatch");

    const other = await publisherVault();
    const foreign = toUnlockedVault({ keys: first.keys, vaultId: other.document.vaultId, keySlots: other.bytes, keySlotsSha256: await sha256Hex(other.bytes) });
    host = createMemoryHost();
    expect(codeOf(await failure(unlock(nodeWith(other.bytes), { passphrase: undefined, unlocked: foreign })))).toBe("vault-mismatch");
    expect(kdf.derivations).toBe(0);
  });
});

describe("platform and secrecy", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const NODE_USE = /from\s+["']node:|require\(\s*["']node:|\bprocess\.|\bBuffer\b|from\s+["'](?:fs|path|os|crypto|child_process)["']/;

  it("the unlock modules import nothing from Node and use no Buffer or process", () => {
    for (const file of ["src/sync/pull-unlock.ts", "src/sync/vault-keys.ts"]) expect(read(file), file).not.toMatch(NODE_USE);
  });

  it("the unlock modules emit no event, log line or console output", () => {
    for (const file of ["src/sync/pull-unlock.ts", "src/sync/vault-keys.ts"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/console\./);
      expect(text, file).not.toMatch(/\bemit\(|\.publish\(|events\//);
    }
  });

  it("opening never reaches a write capability", async () => {
    const created = await publisherVault();
    const readOnly = { read: host.fs.read, stat: host.fs.stat };
    const opened = await unlockForPull({ fs: readOnly, mfsRoot: ROOT, passphrase: PASS, local: { hasState: false }, node: nodeWith(created.bytes), recordFor: NO_RECORD });
    expect(opened.copyToStore).toBeDefined();
    expect(host.mutations).toEqual([]);
  });
});

describe("the publisher-side refusal for a new device", () => {
  it("names the pull command and no longer says pulling arrives in the next change", async () => {
    const created = await publisherVault();
    const error = await failure(openVault({ fs: host.fs, mfsRoot: ROOT, passphrase: PASS, local: { hasState: false }, node: nodeWith(created.bytes, true) }));
    expect(codeOf(error)).toBe("new-device");
    expect(error.message).toContain("ipfs-sync pull");
    expect(error.message).not.toMatch(/next change/);
    expect(kdf.derivations).toBe(0);
  });
});
