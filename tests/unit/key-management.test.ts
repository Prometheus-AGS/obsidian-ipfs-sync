import { beforeAll, describe, expect, it } from "vitest";
import type { Bytes, HostFs, HostKv } from "../../src/core/host-bridge";
import {
  CryptoError,
  KdfCostDowngradeError,
  parseKeySlots,
  rewrapKeySlots,
  unlockKeySlotsBytes,
  type RewrapInput,
  type RewrappedKeySlots,
  type VaultKeys,
} from "../../src/crypto";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { sha256Hex } from "../../src/sync/hash";
import {
  COST_PRESETS,
  KeyManagementError,
  REAL_KEY_OPERATIONS,
  costFloorOf,
  executeRewrap,
  pendingMaintenance,
  planRewrapCost,
  prepareRewrap,
  resumeRewrap,
  type KeyManagementDeps,
  type KeyManagementInput,
  type KeyOperations,
  type RewrapExecuteInput,
} from "../../src/sync/key-management";
import { REVOCATION_STATEMENT, SAME_PASSPHRASE_STATEMENT, rewrapStatements } from "../../src/sync/key-management-text";
import { buildPruneJournal, readMaintenanceJournal, writeMaintenanceJournal } from "../../src/sync/maintenance-journal";
import { PublishRefusedError, lockLost } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { createSnapshotVerifier } from "../../src/sync/read-back";
import { SEQUENCE_FLOOR_FILE, encodeFloor } from "../../src/sync/sequence-floor";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import { toUnlockedVault, rootDigest, type UnlockedVault } from "../../src/sync/vault-keys";
import { NodeKilled } from "../helpers/fake-kubo";
import {
  KEYSLOTS_PATH,
  MANIFEST_PATH,
  OWNED,
  historyNamesOf,
  journalOf,
  maintenanceNodeOf,
  mutatingCalls,
  oldKeySlotsOf,
  publishedRig,
  publishedRoot,
  winnerRootOf,
} from "../helpers/maintenance-rig";
import { KEY, ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { FLOOR_PARAMS, OTHER_PASSPHRASE, countingFakeKdf, createWithFakeKdf, editDocument, referencePassphrase } from "../vectors/slot-helpers";

/**
 * Task 1.4: `keys change-passphrase` and `keys increase-cost` as the shared orchestration (`key-management.ts`), over the recording fake node.
 * The held vault (`unlocked`) stands for the derivation that opens the local copy; the rewrap and the test unlock are stand-ins that return a
 * real rewrap computed once, so the kill matrix runs in milliseconds. One test at the end runs the real cryptography at the floor cost.
 */

const NOW_ISO = "2026-10-03T10:00:00.000Z";
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);
const publishCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("publish "));

let snapshot: RigSnapshot;
let keys: VaultKeys;
let oldBytes: Bytes;
let rewrapped: RewrappedKeySlots;
let held: UnlockedVault;

beforeAll(async () => {
  const rig = await publishedRig();
  keys = await rig.keys();
  oldBytes = oldKeySlotsOf(rig);
  snapshot = snapshotRig(rig);
  rewrapped = await rewrapKeySlots({
    document: parseKeySlots(oldBytes),
    passphrase: referencePassphrase(),
    next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
    params: FLOOR_PARAMS,
  });
  held = toUnlockedVault({ keys, vaultId: keys.vaultId, keySlots: oldBytes, keySlotsSha256: await sha256Hex(oldBytes) });
});

const fresh = (): Rig => {
  const rig = restoreRig(snapshot);
  rig.node.cidOf(ROOT);
  return rig;
};

interface StubOps {
  readonly ops: KeyOperations;
  readonly rewrapCalls: RewrapInput[];
  readonly unlockCalls: Bytes[];
}

/** The real rewrap computed once; the unlock accepts only that file (anything else is a wrong passphrase). */
function stubOps(): StubOps {
  const rewrapCalls: RewrapInput[] = [];
  const unlockCalls: Bytes[] = [];
  return {
    rewrapCalls,
    unlockCalls,
    ops: {
      rewrap: async (input) => {
        rewrapCalls.push(input);
        return rewrapped;
      },
      unlock: async (bytes) => {
        unlockCalls.push(bytes);
        if (!bytesEqual(bytes, rewrapped.bytes)) throw new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot");
        return { keys, slotId: rewrapped.slotId };
      },
    },
  };
}

interface DepsOptions {
  readonly kv?: HostKv;
  readonly fs?: Pick<HostFs, "read" | "write" | "stat">;
  readonly assertHeld?: () => void;
  readonly beforeFirstWrite?: () => Promise<void>;
  readonly node?: KeyManagementDeps["node"];
}

function depsFor(rig: Rig, ops: KeyOperations, options: DepsOptions = {}): KeyManagementDeps {
  return {
    node: options.node ?? maintenanceNodeOf(rig),
    fs: options.fs ?? rig.host.fs,
    kv: options.kv ?? rig.host.kv,
    deviceStore: undefined,
    ops,
    now: () => NOW_ISO,
    snapshotVerifier: (keySlots) => createSnapshotVerifier({ client: rig.node.client, keySlots, written: new Map() }),
    assertHeld: options.assertHeld ?? (() => undefined),
    ...(options.beforeFirstWrite === undefined ? {} : { beforeFirstWrite: options.beforeFirstWrite }),
  };
}

const inputFor = (overrides: Partial<KeyManagementInput> = {}): KeyManagementInput => ({
  mfsRoot: ROOT,
  keyName: KEY,
  passphrase: referencePassphrase(),
  unlocked: held,
  key: { absent: false },
  ...overrides,
});

const executeInput = (overrides: Partial<RewrapExecuteInput> = {}): RewrapExecuteInput => ({
  passphrase: referencePassphrase(),
  next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
  params: FLOOR_PARAMS,
  ...overrides,
});

async function rewrapFully(deps: KeyManagementDeps, input: Partial<RewrapExecuteInput> = {}, prepare: Partial<KeyManagementInput> = {}) {
  const prepared = await prepareRewrap(deps, inputFor(prepare));
  return executeRewrap(deps, prepared, executeInput(input));
}

/** The manifest the node serves, decoded with the vault key (the rig's own helper opens the local copy, which a rewrap replaces). */
const manifestOf = async (rig: Rig) => decodeManifestFile(keys, rig.node.files.get(MANIFEST_PATH) as Bytes);
const localCopy = async (rig: Rig): Promise<Bytes> => rig.host.fs.read(`.ipfs-sync/keyslots.${await rootDigest(ROOT)}.json`);
const refusal = async (promise: Promise<unknown>): Promise<PublishRefusedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishRefusedError);
  return error as PublishRefusedError;
};
const failure = async (promise: Promise<unknown>): Promise<KeyManagementError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(KeyManagementError);
  return error as KeyManagementError;
};

describe("the cost plan and the statements", () => {
  it("keeps the current cost for a passphrase change, and the cost floor is the largest tried slot", () => {
    const plan = planRewrapCost(oldBytes, { kind: "change-passphrase", cost: undefined });
    expect(plan.next).toEqual(plan.current);
    expect(plan.current).toEqual(costFloorOf(oldBytes));
    expect(plan.downgrade).toBe(false);
    expect(plan.raises).toBe(false);
  });

  it("marks a lower choice as a downgrade, and a higher one as a raise", () => {
    const high = planRewrapCost(oldBytes, { kind: "change-passphrase", cost: COST_PRESETS.high });
    expect(high.raises).toBe(true);
    expect(high.downgrade).toBe(false);
    const sameCost = planRewrapCost(oldBytes, { kind: "change-passphrase", cost: costFloorOf(oldBytes) });
    expect(sameCost.downgrade).toBe(false);
    expect(sameCost.raises).toBe(false);
  });

  it("a memory or iteration count below the current slot's is a downgrade even when the other is higher", async () => {
    const above = (await createWithFakeKdf(countingFakeKdf(), referencePassphrase(), { m: 32_768, t: 3, p: 1 })).bytes;
    expect(costFloorOf(above)).toEqual({ m: 32_768, t: 3, p: 1 });
    expect(planRewrapCost(above, { kind: "change-passphrase", cost: { m: 19_456, t: 4, p: 1 } }).downgrade).toBe(true);
    expect(planRewrapCost(above, { kind: "change-passphrase", cost: { m: 131_072, t: 2, p: 1 } }).downgrade).toBe(true);
    const raisedOnly = planRewrapCost(above, { kind: "change-passphrase", cost: { m: 32_768, t: 4, p: 1 } });
    expect(raisedOnly.downgrade).toBe(false);
    expect(raisedOnly.raises).toBe(true);
    // increase-cost never takes a lower or a mixed choice.
    expect(() => planRewrapCost(above, { kind: "increase-cost", cost: { m: 131_072, t: 2, p: 1 } })).toThrow(/not higher/);
  });

  it("increase-cost needs a cost and refuses one that is not higher in memory or iterations", () => {
    expect(() => planRewrapCost(oldBytes, { kind: "increase-cost", cost: undefined })).toThrow(KeyManagementError);
    expect(() => planRewrapCost(oldBytes, { kind: "increase-cost", cost: costFloorOf(oldBytes) })).toThrow(/not higher/);
    expect(planRewrapCost(oldBytes, { kind: "increase-cost", cost: COST_PRESETS.standard }).raises).toBe(true);
  });

  it("a cost above the ceilings is refused when it is planned, before any derivation", () => {
    expect(() => planRewrapCost(oldBytes, { kind: "change-passphrase", cost: { m: 262_144, t: 4, p: 1 } })).toThrow(/memory/);
    expect(() => planRewrapCost(oldBytes, { kind: "increase-cost", cost: { m: 131_072, t: 9, p: 1 } })).toThrow(/iterations/);
  });

  it("the presets stay within the ceilings of key-slots", () => {
    expect(COST_PRESETS.standard).toEqual({ m: 65_536, t: 3, p: 1 });
    expect(COST_PRESETS.high).toEqual({ m: 131_072, t: 4, p: 1 });
  });

  it("states, before the confirmation, that old passphrases and old slot copies remain valid and that nothing is revoked", () => {
    const text = rewrapStatements("change-passphrase", planRewrapCost(oldBytes, { kind: "change-passphrase", cost: undefined })).join("\n");
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(REVOCATION_STATEMENT).toMatch(/old passphrase/);
    expect(REVOCATION_STATEMENT).toMatch(/earlier pinned roots/);
    expect(REVOCATION_STATEMENT).toMatch(/does not revoke/i);
    expect(REVOCATION_STATEMENT).toMatch(/re-encrypt/i);
    expect(text).not.toContain(SAME_PASSPHRASE_STATEMENT);
  });

  it("an increase with the same passphrase also states that the old cheaper slot in earlier roots is unaffected, and names the high-cost consequence", () => {
    const plan = planRewrapCost(oldBytes, { kind: "increase-cost", cost: COST_PRESETS.high });
    const text = rewrapStatements("increase-cost", plan).join("\n");
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(text).toContain(SAME_PASSPHRASE_STATEMENT);
    expect(SAME_PASSPHRASE_STATEMENT).toMatch(/old cheaper slot/);
    expect(SAME_PASSPHRASE_STATEMENT).toMatch(/earlier roots/);
    expect(text).toMatch(/phone/i);
    expect(text).toMatch(/128 MiB, 4 iterations/);
    expect(text).toMatch(/above the default/);
    expect(text).toMatch(/terminal/);
    // The plugin does have an approval dialog on its manual paths; only its timer and catch-up pull never ask.
    expect(text).not.toMatch(/no approval dialog/);
    expect(text).toMatch(/timer and catch-up pull/);
    expect(text).toMatch(/manual plugin/i);
    // A raise to the default cost is not above the default: the device-refusal statement is absent.
    const standard = rewrapStatements("increase-cost", planRewrapCost(oldBytes, { kind: "increase-cost", cost: COST_PRESETS.standard })).join("\n");
    expect(standard).not.toMatch(/above the default/);
  });

  it("says how many key derivations the operation runs and at what cost", () => {
    const text = rewrapStatements("change-passphrase", planRewrapCost(oldBytes, { kind: "change-passphrase", cost: undefined })).join("\n");
    expect(text).toMatch(/four key derivations/);
    expect(text).toMatch(/current passphrase twice/);
  });
});

describe("a rewrap through the orchestration", () => {
  it("replaces the slot file, republishes the same sequence, then updates the local copy and the state, and removes the journal", async () => {
    const rig = fresh();
    const stub = stubOps();
    const manifestBefore = rig.node.files.get(MANIFEST_PATH);
    const historyBefore = historyNamesOf(rig);
    const stateBefore = await readRootState(rig.host.kv, ROOT);

    const outcome = await rewrapFully(depsFor(rig, stub.ops));

    expect(outcome.kind).toBe("rewrapped");
    expect(outcome.testUnlock).toBe("verified");
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), rewrapped.bytes)).toBe(true);
    expect(parseKeySlots(rig.node.files.get(KEYSLOTS_PATH) as Bytes).slots).toHaveLength(1);
    expect(bytesEqual(rig.node.files.get(MANIFEST_PATH), manifestBefore)).toBe(true);
    expect((await manifestOf(rig)).sequence).toBe(2);
    expect(historyNamesOf(rig)).toEqual(historyBefore);
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.keyslotsSha256).toBe(await sha256Hex(rewrapped.bytes));
    expect(state?.rootCid).toBe(publishedRoot(rig));
    expect(state?.sequence).toBe(stateBefore?.sequence);
    expect(state?.highestSequence).toBe(stateBefore?.highestSequence);
    expect(await journalOf(rig)).toBeUndefined();
    expect(publishCalls(rig)).toHaveLength(1);
    expect(stub.rewrapCalls).toHaveLength(1);
    expect(stub.unlockCalls).toHaveLength(1);
    expect(bytesEqual(stub.unlockCalls[0], rewrapped.bytes)).toBe(true);
  });

  it("passes the current passphrase, the new secret, the chosen cost, the cost policy and the downgrade flag to the rewrap", async () => {
    const rig = fresh();
    const stub = stubOps();
    const costPolicy = { approveCost: async () => true };
    await rewrapFully(depsFor(rig, stub.ops), { allowDowngrade: true, costPolicy });
    const call = stub.rewrapCalls[0] as RewrapInput;
    expect(call.allowDowngrade).toBe(true);
    expect(call.costPolicy).toBe(costPolicy);
    expect(call.params).toEqual(FLOOR_PARAMS);
    expect(call.next.kind).toBe("generated");
    expect(bytesEqual(call.passphrase, referencePassphrase())).toBe(true);
    expect(call.document.vaultId).toBe(keys.vaultId);
    expect(call.document.slots).toHaveLength(1);
  });

  it("increase-cost reuses the unlocking passphrase and tests the new slot with it", async () => {
    const rig = fresh();
    const stub = stubOps();
    await rewrapFully(depsFor(rig, stub.ops), { next: { kind: "reuse" } });
    expect((stub.rewrapCalls[0] as RewrapInput).next.kind).toBe("reuse");
    expect(stub.unlockCalls).toHaveLength(1);
  });

  it("stores no passphrase in the journal, the state or the key-value store", async () => {
    const rig = fresh();
    const stub = stubOps();
    const seen: string[] = [];
    const kv: HostKv = {
      ...rig.host.kv,
      set: async (key, value) => {
        seen.push(new TextDecoder().decode(value));
        await rig.host.kv.set(key, value);
      },
    };
    await rewrapFully(depsFor(rig, stub.ops, { kv }));
    const everything = seen.join("\n");
    expect(everything).not.toContain(OTHER_PASSPHRASE);
    expect(everything).not.toContain(OTHER_PASSPHRASE.toLowerCase());
    expect(everything.length).toBeGreaterThan(0);
  });

  it("writes the journal before the first node change and asks for the first-write check before the journal", async () => {
    const rig = fresh();
    const stub = stubOps();
    const order: string[] = [];
    const kv: HostKv = {
      ...rig.host.kv,
      set: async (key, value) => {
        order.push(`kv ${key}`);
        await rig.host.kv.set(key, value);
      },
    };
    const deps = depsFor(rig, stub.ops, { kv, beforeFirstWrite: async () => void order.push("first-write") });
    await rewrapFully(deps);
    expect(order[0]).toBe("first-write");
    expect(order[1]).toBe(`kv ${rootFileNames(ROOT).maintenance}`);
  });

  it("a first-write check that fails stops the run with nothing written", async () => {
    const rig = fresh();
    const stub = stubOps();
    const deps = depsFor(rig, stub.ops, { beforeFirstWrite: async () => Promise.reject(lockLost()) });
    await refusal(rewrapFully(deps));
    expect(mutatingCalls(rig)).toEqual([]);
    expect(await journalOf(rig)).toBeUndefined();
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a lapsed lock stops every write, the local ones included", async () => {
    const rig = fresh();
    const stub = stubOps();
    const deps = depsFor(rig, stub.ops, {
      assertHeld: () => {
        throw lockLost();
      },
    });
    await refusal(rewrapFully(deps));
    expect(mutatingCalls(rig)).toEqual([]);
    expect(await journalOf(rig)).toBeUndefined();
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256).toBe(await sha256Hex(oldBytes));
  });

  it("a downgrade the rewrap refuses leaves nothing written", async () => {
    const rig = fresh();
    const stub = stubOps();
    const ops: KeyOperations = {
      ...stub.ops,
      rewrap: async () => {
        throw new KdfCostDowngradeError({ m: 131_072, t: 4, p: 1 }, FLOOR_PARAMS, "the new cost is lower");
      },
    };
    const error = await rewrapFully(depsFor(rig, ops)).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(KdfCostDowngradeError);
    expect(mutatingCalls(rig)).toEqual([]);
    expect(await journalOf(rig)).toBeUndefined();
  });
});

describe("what a rewrap refuses before it changes anything", () => {
  it("refuses a node that is ahead of this device, naming the pull", async () => {
    const rig = fresh();
    const stateName = rootFileNames(ROOT).state;
    const stateAt2 = (await rig.host.kv.get(stateName)) as Bytes;
    rig.host.put("notes/third.md", "third", 4000);
    await rig.publish();
    await rig.host.kv.set(stateName, stateAt2);
    rig.node.calls.length = 0;
    const stub = stubOps();
    const error = await refusal(prepareRewrap(depsFor(rig, stub.ops), inputFor()));
    expect(error.message).toMatch(/pull/i);
    expect(mutatingCalls(rig)).toEqual([]);
    expect(stub.rewrapCalls).toHaveLength(0);
  });

  it("refuses a rolled-back node whose sequence equals the record but lies below the floor", async () => {
    const rig = fresh();
    const stub = stubOps();
    const deviceStore = createMemoryDeviceStore();
    await deviceStore.set(SEQUENCE_FLOOR_FILE, encodeFloor({ version: 1, floors: { [keys.vaultId]: { sequence: 9, identity: "a".repeat(64), at: 1 } } }));
    const deps: KeyManagementDeps = { ...depsFor(rig, stub.ops), deviceStore };
    const error = await refusal(prepareRewrap(deps, inputFor()));
    expect(error.code).toBe("sequence-below-floor");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("refuses when this device holds no key-slot copy", async () => {
    const rig = fresh();
    await rig.host.fs.remove(`.ipfs-sync/keyslots.${await rootDigest(ROOT)}.json`);
    const error = await failure(prepareRewrap(depsFor(rig, stubOps().ops), inputFor()));
    expect(error.code).toBe("no-key-slot-copy");
  });

  it("refuses when this device holds no record of the root", async () => {
    const rig = fresh();
    await rig.host.kv.delete(rootFileNames(ROOT).state);
    const error = await failure(prepareRewrap(depsFor(rig, stubOps().ops), inputFor()));
    expect(error.code).toBe("no-record");
  });

  it("refuses a file with a slot of a type this version does not know before any derivation", async () => {
    const rig = fresh();
    const bytes = editDocument(oldBytes, (document) => {
      (document["slots"] as unknown[]).push({ type: "hardware-key", blob: "AAAA" });
    });
    await rig.host.fs.write(`.ipfs-sync/keyslots.${await rootDigest(ROOT)}.json`, bytes);
    const stub = stubOps();
    let progressed = 0;
    const error = await failure(prepareRewrap(depsFor(rig, stub.ops), inputFor({ unlocked: undefined, onProgress: () => void (progressed += 1) })));
    expect(error.code).toBe("unknown-slot-type");
    expect(progressed).toBe(0);
    expect(stub.rewrapCalls).toHaveLength(0);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("refuses when the publication key does not exist, and creates nothing", async () => {
    const rig = fresh();
    const error = await refusal(prepareRewrap(depsFor(rig, stubOps().ops), inputFor({ key: { absent: true } })));
    expect(error.code).toBe("publication-key-missing");
    expect(rig.node.calls.filter((call) => call.startsWith("keyGen"))).toEqual([]);
  });

  it("refuses while an unfinished publish is pending, without reading it as damaged", async () => {
    const rig = fresh();
    await rig.host.kv.set(rootFileNames(ROOT).journal, new TextEncoder().encode("not a journal at all"));
    const error = await refusal(prepareRewrap(depsFor(rig, stubOps().ops), inputFor()));
    expect(error.code).toBe("publish-journal-pending");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("refuses while any maintenance journal is pending, naming both ways out", async () => {
    const rig = fresh();
    const stub = stubOps();
    await writeMaintenanceJournal(rig.host.kv, buildPruneJournal(await factsOf(rig), []));
    const error = await refusal(prepareRewrap(depsFor(rig, stub.ops), inputFor()));
    expect(error.code).toBe("maintenance-pending");
    expect(error.message).toContain("keys discard");
    expect(error.message).toContain("keys accept-slots");
    await rig.host.kv.set(rootFileNames(ROOT).maintenance, new TextEncoder().encode("{ torn"));
    expect((await refusal(prepareRewrap(depsFor(rig, stub.ops), inputFor()))).code).toBe("maintenance-pending");
  });
});

async function factsOf(rig: Rig) {
  const state = (await readRootState(rig.host.kv, ROOT)) as NonNullable<Awaited<ReturnType<typeof readRootState>>>;
  return {
    mfsRoot: ROOT,
    key: KEY,
    vaultId: state.vaultId,
    keyslotsSha256: state.keyslotsSha256,
    startRoot: publishedRoot(rig),
    nodeSequence: state.sequence,
    manifestSha256: await sha256Hex(rig.node.files.get(MANIFEST_PATH) as Bytes),
    startedAt: NOW_ISO,
  };
}

describe("a pending journal is reported before any passphrase is needed", () => {
  it("pendingMaintenance returns the rewrap journal, nothing when there is none, and refuses a damaged file", async () => {
    const rig = fresh();
    expect(await pendingMaintenance(depsFor(rig, stubOps().ops), ROOT)).toBeUndefined();
    rig.node.killAfterMutation = 1;
    await expect(rewrapFully(depsFor(rig, stubOps().ops, { kv: rig.killableHost.kv }))).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    const pending = await pendingMaintenance(depsFor(rig, stubOps().ops), ROOT);
    expect(pending?.type).toBe("rewrap");
    expect(pending?.phase).toBe("journaled");
    await rig.host.kv.set(rootFileNames(ROOT).maintenance, new TextEncoder().encode("{ torn"));
    expect((await refusal(pendingMaintenance(depsFor(rig, stubOps().ops), ROOT))).code).toBe("maintenance-pending");
  });
});

describe("kill after each step: a rerun finishes the one rewrap and never makes a second slot", () => {
  /** The fs seam counts as a node mutation step, so a kill can land between the copy and the state. */
  function killableFs(rig: Rig): Pick<HostFs, "read" | "write" | "stat"> {
    return {
      read: (path) => rig.host.fs.read(path),
      stat: (path) => rig.host.fs.stat(path),
      write: async (path, data) => {
        await rig.host.fs.write(path, data);
        rig.node.mutations += 1;
        if (rig.node.killAfterMutation !== undefined && rig.node.mutations >= rig.node.killAfterMutation) throw new NodeKilled(rig.node.mutations);
      },
    };
  }

  async function expectFinished(rig: Rig, where: string): Promise<void> {
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), rewrapped.bytes), where).toBe(true);
    expect(parseKeySlots(rig.node.files.get(KEYSLOTS_PATH) as Bytes).slots, where).toHaveLength(1);
    expect(bytesBytes(await localCopy(rig)), where).toBe(bytesBytes(rewrapped.bytes));
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.keyslotsSha256, where).toBe(await sha256Hex(rewrapped.bytes));
    expect(state?.rootCid, where).toBe(publishedRoot(rig));
    expect(rig.node.cidOf(ROOT), where).toBe(publishedRoot(rig));
    expect(await journalOf(rig), where).toBeUndefined();
    expect(publishCalls(rig).length, where).toBeLessThanOrEqual(1);
    expect((await manifestOf(rig)).sequence, where).toBe(2);
  }
  const bytesBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

  it("every kill from the first journal write to the journal removal resumes to one publication", async () => {
    let completedAt: number | undefined;
    for (let k = 1; completedAt === undefined; k += 1) {
      const rig = fresh();
      const stub = stubOps();
      const where = `kill after mutation ${k}`;
      rig.node.killAfterMutation = k;
      let killed = false;
      try {
        await rewrapFully(depsFor(rig, stub.ops, { kv: rig.killableHost.kv, fs: killableFs(rig) }));
      } catch (error) {
        if (!(error instanceof NodeKilled)) throw error;
        killed = true;
      }
      expect(stub.rewrapCalls.length, where).toBe(1);
      if (!killed) {
        completedAt = k;
        await expectFinished(rig, where);
        break;
      }
      rig.node.killAfterMutation = undefined;
      const read = await readMaintenanceJournal(rig.host.kv, ROOT);
      if (read.kind === "ok") {
        const resumeStub = stubOps();
        const outcome = await resumeRewrap(depsFor(rig, resumeStub.ops), read.journal, inputFor());
        expect(outcome.kind, where).toBe("finished");
        expect(resumeStub.rewrapCalls, where).toHaveLength(0);
      } else {
        expect(read.kind, where).toBe("none");
      }
      await expectFinished(rig, where);
    }
    // journal, file, journal, journal, pin, publish, state, journal, copy, state, journal, delete: twelve steps, then the run completes.
    expect(completedAt).toBe(13);
  });

  it("a kill after the name was published: the rerun needs no passphrase, publishes nothing more and updates the local copy", async () => {
    const rig = fresh();
    rig.node.killAfterMutation = 8; // ... state (7), journal at `published` (8)
    await expect(rewrapFully(depsFor(rig, stubOps().ops, { kv: rig.killableHost.kv, fs: killableFs(rig) }))).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    expect((await journalOf(rig))?.phase).toBe("published");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    const calls = publishCalls(rig).length;
    const stub = stubOps();
    const outcome = await resumeRewrap(depsFor(rig, stub.ops), (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>, inputFor({ passphrase: undefined, unlocked: undefined }));
    expect(outcome.kind).toBe("finished");
    expect(outcome.testUnlock).toBe("not-run");
    expect(publishCalls(rig)).toHaveLength(calls);
    expect(stub.unlockCalls).toHaveLength(0);
    await expectFinished(rig, "after the published phase");
  });

  it("a rerun before the name was published needs the current passphrase and refuses without one", async () => {
    const rig = fresh();
    rig.node.killAfterMutation = 3;
    await expect(rewrapFully(depsFor(rig, stubOps().ops, { kv: rig.killableHost.kv }))).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    const journal = (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>;
    const error = await refusal(resumeRewrap(depsFor(rig, stubOps().ops), journal, inputFor({ passphrase: undefined, unlocked: undefined })));
    expect(error.code).toBe("passphrase-required");
    expect(publishCalls(rig)).toHaveLength(0);
  });

  it("a node file that matches neither the journal nor the old bytes is refused naming the two commands, and nothing is changed", async () => {
    const rig = fresh();
    rig.node.killAfterMutation = 3;
    await expect(rewrapFully(depsFor(rig, stubOps().ops, { kv: rig.killableHost.kv }))).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    const other = new Uint8Array(rewrapped.bytes);
    other[other.length - 3] = (other[other.length - 3] ?? 0) ^ 1;
    rig.node.files.set(KEYSLOTS_PATH, other);
    const journal = (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>;
    const error = await refusal(resumeRewrap(depsFor(rig, stubOps().ops), journal, inputFor()));
    expect(error.code).toBe("maintenance-lost-race");
    expect(error.message).toContain("keys discard");
    expect(error.message).toContain("keys accept-slots");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect(publishCalls(rig)).toHaveLength(0);
  });

  it("a name that now serves another device's key-slot file after our publication: the rerun refuses, the local copy stays", async () => {
    const rig = fresh();
    rig.node.killAfterMutation = 8;
    await expect(rewrapFully(depsFor(rig, stubOps().ops, { kv: rig.killableHost.kv, fs: killableFs(rig) }))).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    const rival = new Uint8Array(oldBytes);
    rival[rival.length - 3] = (rival[rival.length - 3] ?? 0) ^ 1;
    const winner = winnerRootOf(rig, new Map([["keyslots.json", rival]]));
    rig.node.published.set(OWNED, `/ipfs/${winner}`);
    const journal = (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>;
    const error = await refusal(resumeRewrap(depsFor(rig, stubOps().ops), journal, inputFor({ passphrase: undefined, unlocked: undefined })));
    expect(error.code).toBe("maintenance-lost-race");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256).toBe(await sha256Hex(oldBytes));
  });

  it("a prune journal is not finished by the rewrap commands", async () => {
    const rig = fresh();
    await writeMaintenanceJournal(rig.host.kv, buildPruneJournal(await factsOf(rig), []));
    const journal = (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>;
    expect((await refusal(resumeRewrap(depsFor(rig, stubOps().ops), journal, inputFor()))).code).toBe("maintenance-pending");
  });
});

describe("the test unlock after publishing", () => {
  it("reports a lost race when another device's rewrap won after ours, and leaves the local copy and the state alone", async () => {
    const rig = fresh();
    const stub = stubOps();
    const inner = maintenanceNodeOf(rig);
    const rival = new Uint8Array(oldBytes);
    rival[rival.length - 3] = (rival[rival.length - 3] ?? 0) ^ 1;
    const node: KeyManagementDeps["node"] = {
      ...inner,
      // Right after our name/publish, another device publishes its own root.
      publishRoot: async (root, start) => {
        await inner.publishRoot(root, start);
        rig.node.published.set(OWNED, `/ipfs/${winnerRootOf(rig, new Map([["keyslots.json", rival]]))}`);
      },
    };
    const error = await failure(rewrapFully(depsFor(rig, stub.ops, { node })));
    expect(error.code).toBe("test-unlock-failed");
    expect(error.message).toMatch(/another device/);
    expect(error.message).toMatch(/may not open/);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256).toBe(await sha256Hex(oldBytes));
    expect((await journalOf(rig))?.phase).toBe("published");
    // The rerun does not complete it either: the node's file is not ours.
    const journal = (await journalOf(rig)) as NonNullable<Awaited<ReturnType<typeof journalOf>>>;
    const again = await refusal(resumeRewrap(depsFor(rig, stubOps().ops, { node }), journal, inputFor({ passphrase: undefined, unlocked: undefined })));
    expect(again.code).toBe("maintenance-lost-race");
  });

  it("reports a new passphrase that does not open the published file", async () => {
    const rig = fresh();
    const stub = stubOps();
    const ops: KeyOperations = {
      ...stub.ops,
      unlock: async () => {
        throw new CryptoError("wrong-passphrase-or-damaged-slot", "wrong passphrase or damaged key slot");
      },
    };
    const error = await failure(rewrapFully(depsFor(rig, ops)));
    expect(error.code).toBe("test-unlock-failed");
    expect(error.message).toMatch(/may not open/);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("authenticates manifest.enc of the published root under the new unlock, so a file of another vault key is caught", async () => {
    const rig = fresh();
    const stub = stubOps();
    const otherVault = await createWithFakeKdf(countingFakeKdf());
    const ops: KeyOperations = {
      ...stub.ops,
      // Unlocks, but to a different vault key than the one the manifest was written under.
      unlock: async () => ({ keys: otherVault.keys, slotId: otherVault.slotId }),
    };
    const error = await failure(rewrapFully(depsFor(rig, ops)));
    expect(error.code).toBe("test-unlock-failed");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });
});

describe("with the real cryptography at the floor cost", () => {
  it("the new passphrase opens the node's file, the old one fails there and still opens the previous root's copy; publishing continues", async () => {
    const rig = fresh();
    const previousRoot = rig.node.cidOf(ROOT) as string;
    const next = asGenerated(OTHER_PASSPHRASE);
    const prepared = await prepareRewrap(depsFor(rig, REAL_KEY_OPERATIONS), inputFor());
    const outcome = await executeRewrap(depsFor(rig, REAL_KEY_OPERATIONS), prepared, executeInput({ next: { kind: "generated", passphrase: next } }));
    expect(outcome.testUnlock).toBe("verified");
    const onNode = rig.node.files.get(KEYSLOTS_PATH) as Bytes;
    expect(parseKeySlots(onNode).slots).toHaveLength(1);
    expect((await unlockKeySlotsBytes(onNode, next)).keys.vaultId).toBe(keys.vaultId);
    await expect(unlockKeySlotsBytes(onNode, referencePassphrase())).rejects.toMatchObject({ code: "wrong-passphrase-or-damaged-slot" });
    const previous = await maintenanceNodeOf(rig).readKeySlotsFileAt(previousRoot);
    expect((await unlockKeySlotsBytes(previous as Bytes, referencePassphrase())).keys.vaultId).toBe(keys.vaultId);
    expect(bytesEqual(await localCopy(rig), onNode)).toBe(true);

    rig.node.calls.length = 0;
    const idle = await rig.publish({ passphrase: next });
    expect(idle.published).toBe(false);
    expect(mutatingCalls(rig)).toEqual([]);

    rig.host.put("notes/third.md", "third", 5000);
    const changed = await rig.publish({ passphrase: next });
    expect(changed.sequence).toBe(3);
    expect(mutatingCalls(rig).some((call) => call.startsWith("publish "))).toBe(true);
  });
});
