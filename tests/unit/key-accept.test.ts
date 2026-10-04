import { beforeAll, describe, expect, it } from "vitest";
import type { Bytes, HostFs, HostKv } from "../../src/core/host-bridge";
import { createKeySlotsInternal } from "../../src/crypto/key-slots";
import { fromHex, parseKeySlots, rewrapKeySlots, type RewrappedKeySlots, type VaultKeys } from "../../src/crypto";
import { asGenerated } from "../../src/crypto/testing/generated-passphrase";
import { secureRandom, type RandomSource } from "../../src/crypto/random";
import type { DeviceStore } from "../../src/sync/device-store";
import { sha256Hex } from "../../src/sync/hash";
import { buildJournal, readJournal, writeJournal } from "../../src/sync/journal";
import {
  KeyManagementError,
  commitAcceptance,
  discardMaintenance,
  prepareAcceptance,
  type AcceptDeps,
  type AcceptInput,
} from "../../src/sync/key-management";
import { acceptDowngradeQuestion, acceptStatements, discardStatements, ACCEPT_RESIDUAL_STATEMENT } from "../../src/sync/key-management-text";
import { advance, buildPruneJournal, readMaintenanceJournal, writeMaintenanceJournal } from "../../src/sync/maintenance-journal";
import { PublishRefusedError, lockLost } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState, writeRootState, buildRootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, SequenceFloorError } from "../../src/sync/sequence-floor";
import { SlotAcceptanceError } from "../../src/sync/slot-acceptance";
import { toUnlockedVault, rootDigest } from "../../src/sync/vault-keys";
import { NodeKilled } from "../helpers/fake-kubo";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import {
  KEYSLOTS_PATH,
  MANIFEST_PATH,
  OWNED,
  finishRewrapLocally,
  journalOf,
  maintenanceNodeOf,
  mutatingCalls,
  oldKeySlotsOf,
  publishedRig,
  publishedRoot,
  rewrapOnce,
  startRewrap,
  variantKeySlots,
  winnerRootOf,
} from "../helpers/maintenance-rig";
import { KEY, ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { FLOOR_PARAMS, OTHER_PASSPHRASE, countingFakeKdf, createWithFakeKdf, otherPassphrase, referencePassphrase } from "../vectors/slot-helpers";

/**
 * Task 1.5: `accept-slots` and `discard` as the shared orchestration (`key-management.ts`), over the recording fake node. The real cryptography
 * runs at the floor cost (one derivation per accept), because acceptance is exactly the unlock of an untrusted slot file.
 *
 * Device A rewrapped; device B (the rig these tests build) still holds the old copy while the node serves A's new root.
 */

const NOW_ISO = "2026-10-03T10:00:00.000Z";
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);

let oldSnapshot: RigSnapshot;
let afterNode: RigSnapshot["node"];
let keys: VaultKeys;
let oldBytes: Bytes;
let rewrapped: RewrappedKeySlots;
let rewrappedRoot: string;

beforeAll(async () => {
  const rig = await publishedRig();
  keys = await rig.keys();
  oldBytes = oldKeySlotsOf(rig);
  oldSnapshot = snapshotRig(rig);
  rewrapped = await rewrapKeySlots({
    document: parseKeySlots(oldBytes),
    passphrase: referencePassphrase(),
    next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
    params: FLOOR_PARAMS,
  });
  // Device A's rewrap, on a copy of the same starting point.
  const a = restoreRig(oldSnapshot);
  a.node.cidOf(ROOT);
  await rewrapOnce(a, keys, rewrapped.bytes);
  await finishRewrapLocally(a, rewrapped.bytes);
  afterNode = snapshotRig(a).node;
  rewrappedRoot = publishedRoot(a);
});

/** Device B: the old local copy and record, the node as A left it. */
function deviceB(): Rig {
  const rig = restoreRig({ ...oldSnapshot, node: afterNode });
  rig.node.cidOf(ROOT);
  return rig;
}

/** The old world, with the node still serving the old root. */
function oldWorld(): Rig {
  const rig = restoreRig(oldSnapshot);
  rig.node.cidOf(ROOT);
  return rig;
}

interface DepsOptions {
  readonly kv?: HostKv;
  readonly fs?: Pick<HostFs, "read" | "write" | "stat">;
  readonly assertHeld?: () => void;
  readonly beforeFirstWrite?: () => Promise<void>;
  readonly node?: AcceptDeps["node"];
}

function depsFor(rig: Rig, store: DeviceStore, options: DepsOptions = {}): AcceptDeps {
  return {
    node: options.node ?? maintenanceNodeOf(rig),
    fs: options.fs ?? rig.host.fs,
    kv: options.kv ?? rig.host.kv,
    deviceStore: store,
    assertHeld: options.assertHeld ?? (() => undefined),
    ...(options.beforeFirstWrite === undefined ? {} : { beforeFirstWrite: options.beforeFirstWrite }),
  };
}

const inputFor = (rootCid: string, overrides: Partial<AcceptInput> = {}): AcceptInput => ({ mfsRoot: ROOT, passphrase: otherPassphrase(), target: { kind: "name", rootCid }, ...overrides });

async function accept(deps: AcceptDeps, input: AcceptInput, confirmation: { readonly downgradeConfirmed?: boolean } = {}) {
  return commitAcceptance(deps, await prepareAcceptance(deps, input), confirmation);
}

const copyPath = async (): Promise<string> => `.ipfs-sync/keyslots.${await rootDigest(ROOT)}.json`;
const localCopy = async (rig: Rig): Promise<Bytes> => rig.host.fs.read(await copyPath());
const refusal = async (promise: Promise<unknown>): Promise<PublishRefusedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishRefusedError);
  return error as PublishRefusedError;
};
const failure = async <T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(type);
  return error as T;
};

/** Every local write of a run, to prove that a refusal left the device as it was. */
function recordingKv(rig: Rig): { readonly kv: HostKv; readonly writes: string[] } {
  const writes: string[] = [];
  const kv: HostKv = {
    get: (key) => rig.host.kv.get(key),
    list: (prefix) => rig.host.kv.list(prefix),
    set: async (key, value) => {
      writes.push(`set ${key}`);
      await rig.host.kv.set(key, value);
    },
    delete: async (key) => {
      writes.push(`delete ${key}`);
      await rig.host.kv.delete(key);
    },
  };
  return { kv, writes };
}

describe("accepting the key slots another device wrote", () => {
  it("replaces the copy with the bytes that unlocked, updates the recorded hash, raises no floor, touches no node file, and publishing works afterwards", async () => {
    const rig = deviceB();
    const store = createMemoryDeviceStore();
    // Before: the automatic operations refuse, because the copy differs from the node's file.
    await expect(rig.publish()).rejects.toMatchObject({ code: "vault-mismatch" });
    const stateBefore = await readRootState(rig.host.kv, ROOT);

    const outcome = await accept(depsFor(rig, store), inputFor(rewrappedRoot));

    expect(outcome.kind).toBe("accepted");
    expect(outcome.copyReplaced).toBe(true);
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.keyslotsSha256).toBe(await sha256Hex(rewrapped.bytes));
    expect(state?.sequence).toBe(stateBefore?.sequence);
    expect(state?.highestSequence).toBe(stateBefore?.highestSequence);
    expect(store.writes).toEqual([]);
    expect(mutatingCalls(rig)).toEqual([]);

    // The record names the root the name serves (its manifest is the one recorded), so the next publish sees nothing unpublished and writes nothing.
    expect(state?.rootCid).toBe(rewrappedRoot);
    const idle = await rig.publish({ passphrase: otherPassphrase() });
    expect(idle.published).toBe(false);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("an explicit root never moves the recorded root", async () => {
    const rig = deviceB();
    const before = await readRootState(rig.host.kv, ROOT);
    await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot, { target: { kind: "root-cid", rootCid: rewrappedRoot } }));
    const after = await readRootState(rig.host.kv, ROOT);
    expect(after?.rootCid).toBe(before?.rootCid);
    expect(after?.keyslotsSha256).toBe(await sha256Hex(rewrapped.bytes));
  });

  it("derives the incoming slot once and reads exactly two files, both from the one root it was given, and never resolves the name", async () => {
    const rig = deviceB();
    const inner = maintenanceNodeOf(rig);
    const calls: string[] = [];
    const node: AcceptDeps["node"] = {
      ...inner,
      resolveName: async () => (calls.push("resolveName"), inner.resolveName()),
      readKeySlotsFileAt: async (root) => {
        calls.push(`keyslots ${root}`);
        // The name moves to another root right after the first read.
        rig.node.published.set(OWNED, `/ipfs/${winnerRootOf(rig, new Map())}`);
        return inner.readKeySlotsFileAt(root);
      },
      readManifestFileAt: async (root) => (calls.push(`manifest ${root}`), inner.readManifestFileAt(root)),
    };
    await accept(depsFor(rig, createMemoryDeviceStore(), { node }), inputFor(rewrappedRoot));
    expect(calls).toEqual([`keyslots ${rewrappedRoot}`, `manifest ${rewrappedRoot}`]);
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
  });

  it("names nothing to store when the copy already is the node's file, and writes nothing", async () => {
    const rig = oldWorld();
    const { kv, writes } = recordingKv(rig);
    const prepared = await prepareAcceptance(depsFor(rig, createMemoryDeviceStore(), { kv }), inputFor(publishedRoot(rig), { passphrase: referencePassphrase() }));
    expect(prepared.acceptance.changed).toBe(false);
    expect(prepared.work).toEqual({ copy: false, state: false, publishJournal: false, maintenance: false });
    const outcome = await commitAcceptance(depsFor(rig, createMemoryDeviceStore(), { kv }), prepared, {});
    expect(outcome.kind).toBe("unchanged");
    expect(writes).toEqual([]);
    expect(mutatingCalls(rig)).toEqual([]);
  });
});

describe("what acceptance refuses", () => {
  it("a slot file of another vault is refused before any derivation and nothing is written", async () => {
    const rig = deviceB();
    const attacker = await createKeySlotsInternal({ passphrase: asGenerated(OTHER_PASSPHRASE), params: FLOOR_PARAMS }, secureRandom, {});
    const root = winnerRootOf(rig, new Map([["keyslots.json", attacker.bytes]]));
    const { kv, writes } = recordingKv(rig);
    const error = await failure(accept(depsFor(rig, createMemoryDeviceStore(), { kv }), inputFor(root)), SlotAcceptanceError);
    expect(error.code).toBe("other-vault");
    expect(writes).toEqual([]);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a slot file that carries this vault's id and unlocks with the typed passphrase, but wraps another key, does not authenticate manifest.enc and is not accepted", async () => {
    const rig = deviceB();
    let call = 0;
    const draws: RandomSource = (length) => {
      call += 1;
      if (call === 1) return fromHex(keys.vaultId);
      if (call === 2) return Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
      return secureRandom(length);
    };
    const attacker = await createKeySlotsInternal({ passphrase: asGenerated(OTHER_PASSPHRASE), params: FLOOR_PARAMS }, draws, {});
    const root = winnerRootOf(rig, new Map([["keyslots.json", attacker.bytes]]));
    const { kv, writes } = recordingKv(rig);
    const error = await failure(accept(depsFor(rig, createMemoryDeviceStore(), { kv }), inputFor(root)), SlotAcceptanceError);
    expect(error.code).toBe("manifest-not-authentic");
    expect(writes).toEqual([]);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a session that holds the vault's keys refuses slots that wrap a different key", async () => {
    const rig = deviceB();
    const other = await createWithFakeKdf(countingFakeKdf());
    const held = toUnlockedVault({ keys: other.keys, vaultId: other.keys.vaultId, keySlots: oldBytes, keySlotsSha256: await sha256Hex(oldBytes) });
    const error = await failure(accept(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot, { heldVault: held })), SlotAcceptanceError);
    expect(error.code).toBe("key-changed");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a wrong passphrase is the one unlock failure and nothing is written", async () => {
    const rig = deviceB();
    const { kv, writes } = recordingKv(rig);
    await expect(accept(depsFor(rig, createMemoryDeviceStore(), { kv }), inputFor(rewrappedRoot, { passphrase: referencePassphrase() }))).rejects.toMatchObject({ code: "wrong-passphrase-or-damaged-slot" });
    expect(writes).toEqual([]);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a slot above the default cost is refused before any derivation unless the host confirms, and the confirmation sees the costs", async () => {
    const rig = deviceB();
    const dear = await rewrapKeySlots({
      document: parseKeySlots(oldBytes),
      passphrase: referencePassphrase(),
      next: { kind: "generated", passphrase: asGenerated(OTHER_PASSPHRASE) },
      params: { m: 19_456, t: 4, p: 1 },
    });
    const root = winnerRootOf(rig, new Map([["keyslots.json", dear.bytes]]));
    const deps = depsFor(rig, createMemoryDeviceStore());
    await expect(prepareAcceptance(deps, inputFor(root))).rejects.toMatchObject({ code: "kdf-cost-refused" });
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    const seen: unknown[] = [];
    const prepared = await prepareAcceptance(deps, inputFor(root, { confirmCost: async (costs) => (seen.push(...costs), true) }));
    expect(seen).toEqual([{ m: 19_456, t: 4, p: 1 }]);
    expect(prepared.acceptance.changed).toBe(true);
  });

  it("a damaged sequence floor is a refusal before any derivation", async () => {
    const rig = deviceB();
    const store = createMemoryDeviceStore();
    store.entries.set(SEQUENCE_FLOOR_FILE, new TextEncoder().encode("not json"));
    let derived = false;
    await failure(accept(depsFor(rig, store), inputFor(rewrappedRoot, { onProgress: () => void (derived = true) })), SequenceFloorError);
    expect(derived).toBe(false);
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a root without a manifest, or without slots, is not a root to accept", async () => {
    const rig = deviceB();
    const manifest = rig.node.files.get(MANIFEST_PATH) as Bytes;
    rig.node.files.delete(MANIFEST_PATH);
    const noManifest = winnerRootOf(rig, new Map());
    rig.node.files.set(MANIFEST_PATH, manifest);
    const keySlots = rig.node.files.get(KEYSLOTS_PATH) as Bytes;
    rig.node.files.delete(KEYSLOTS_PATH);
    const noSlots = winnerRootOf(rig, new Map());
    rig.node.files.set(KEYSLOTS_PATH, keySlots);
    for (const root of [noManifest, noSlots]) {
      const error = await failure(accept(depsFor(rig, createMemoryDeviceStore()), inputFor(root)), KeyManagementError);
      expect(error.code).toBe("root-incomplete");
    }
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
  });

  it("a name value that is not a CID never becomes a path", async () => {
    const rig = deviceB();
    const error = await failure(accept(depsFor(rig, createMemoryDeviceStore()), inputFor("../../etc")), KeyManagementError);
    expect(error.code).toBe("root-incomplete");
  });

  it("a held lock stops every write: the copy, the record and the journal stay as they were", async () => {
    const rig = deviceB();
    const prepared = await prepareAcceptance(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot));
    const lapsed = depsFor(rig, createMemoryDeviceStore(), {
      assertHeld: () => {
        throw lockLost();
      },
    });
    expect((await refusal(commitAcceptance(lapsed, prepared, {}))).code).toBe("lock-lost");
    const checked = depsFor(rig, createMemoryDeviceStore(), { beforeFirstWrite: async () => Promise.reject(lockLost()) });
    expect((await refusal(commitAcceptance(checked, prepared, {}))).code).toBe("lock-lost");
    expect(bytesEqual(await localCopy(rig), oldBytes)).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256).toBe(await sha256Hex(oldBytes));
  });
});

describe("a cheaper slot is a downgrade and needs a confirmation that shows both costs", () => {
  async function deviceWithDearCopy(): Promise<Rig> {
    const rig = deviceB();
    const dear = await rewrapKeySlots({ document: parseKeySlots(oldBytes), passphrase: referencePassphrase(), next: { kind: "reuse" }, params: { m: 32_768, t: 3, p: 1 } });
    await rig.host.fs.write(await copyPath(), dear.bytes);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("no state");
    await writeRootState(rig.host.kv, buildRootState({ ...state, keyslotsSha256: await sha256Hex(dear.bytes) }));
    return rig;
  }

  it("prepare reports both costs; commit without the confirmation stores nothing; with it, stores", async () => {
    const rig = await deviceWithDearCopy();
    const dearBytes = await localCopy(rig);
    const { kv, writes } = recordingKv(rig);
    const deps = depsFor(rig, createMemoryDeviceStore(), { kv });
    const prepared = await prepareAcceptance(deps, inputFor(rewrappedRoot));
    expect(prepared.acceptance.downgrade).toEqual({ current: { m: 32_768, t: 3, p: 1 }, incoming: FLOOR_PARAMS });
    const question = acceptDowngradeQuestion(prepared.acceptance.downgrade as NonNullable<typeof prepared.acceptance.downgrade>);
    expect(question).toContain("32 MiB, 3 iterations");
    expect(question).toContain("19 MiB, 2 iterations");

    const unconfirmed = await failure(commitAcceptance(deps, prepared, {}), SlotAcceptanceError);
    expect(unconfirmed.code).toBe("downgrade-unconfirmed");
    expect(writes).toEqual([]);
    expect(bytesEqual(await localCopy(rig), dearBytes)).toBe(true);

    await commitAcceptance(deps, prepared, { downgradeConfirmed: true });
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
  });
});

describe("restoring across a rewrap by root CID", () => {
  /** Sequences 2 and 3 with the old slots, then device A's rewrap: the current root holds the new slots, the older root the old. */
  async function worldWithRewrap(): Promise<{ readonly rig: Rig; readonly olderRoot: string; readonly before: Bytes; readonly after: Bytes }> {
    const rig = await publishedRig();
    const olderRoot = publishedRoot(rig);
    rig.host.put("notes/third.md", "third", 4000);
    await rig.publish();
    const before = oldKeySlotsOf(rig);
    // This world is its own vault: its rewrap is computed from its own key-slot file.
    const next = await rewrapKeySlots({ document: parseKeySlots(before), passphrase: referencePassphrase(), next: { kind: "reuse" }, params: { m: 19_456, t: 3, p: 1 } });
    await rewrapOnce(rig, await rig.keys(), next.bytes);
    await finishRewrapLocally(rig, next.bytes);
    return { rig, olderRoot, before, after: next.bytes };
  }

  it("is a rollback refusal without the flag, and a restore with --allow-rollback that brings the older slots back, the record's sequence untouched", async () => {
    const { rig, olderRoot, before: olderSlots, after: currentSlots } = await worldWithRewrap();
    const before = await readRootState(rig.host.kv, ROOT);
    expect(before?.highestSequence).toBe(3);
    const deps = depsFor(rig, createMemoryDeviceStore());

    const refused = await failure(accept(deps, { mfsRoot: ROOT, passphrase: referencePassphrase(), target: { kind: "root-cid", rootCid: olderRoot } }), SlotAcceptanceError);
    expect(refused.code).toBe("verdict-refused");
    expect(bytesEqual(await localCopy(rig), currentSlots)).toBe(true);

    const restored = await prepareAcceptance(deps, { mfsRoot: ROOT, passphrase: referencePassphrase(), target: { kind: "root-cid", rootCid: olderRoot }, flags: { allowRollback: true } });
    expect(restored.acceptance.verdict.kind).toBe("restore");
    // The older slot is the cheaper one (the rewrap raised the cost): restoring across it is a downgrade like any other.
    expect(restored.acceptance.downgrade).toBeDefined();
    await failure(commitAcceptance(deps, restored, {}), SlotAcceptanceError);
    expect(bytesEqual(await localCopy(rig), currentSlots)).toBe(true);
    await commitAcceptance(deps, restored, { downgradeConfirmed: true });
    expect(bytesEqual(await localCopy(rig), olderSlots)).toBe(true);
    const after = await readRootState(rig.host.kv, ROOT);
    expect(after?.keyslotsSha256).toBe(await sha256Hex(olderSlots));
    expect(after?.highestSequence).toBe(3);
    expect(after?.sequence).toBe(before?.sequence);
    // An explicit root never moves the recorded root.
    expect(after?.rootCid).toBe(before?.rootCid);
  });

  it("a name-resolved root never takes the rollback flag", async () => {
    const { rig, olderRoot } = await worldWithRewrap();
    const error = await failure(
      prepareAcceptance(depsFor(rig, createMemoryDeviceStore()), { mfsRoot: ROOT, passphrase: referencePassphrase(), target: { kind: "name", rootCid: olderRoot }, flags: { allowRollback: true } }),
      SlotAcceptanceError,
    );
    expect(error.code).toBe("verdict-refused");
  });
});

describe("a pending publish journal follows the copy", () => {
  async function withPublishJournal(rig: Rig): Promise<void> {
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("no state");
    await writeJournal(
      rig.host.kv,
      buildJournal({
        mfsRoot: ROOT,
        key: KEY,
        vaultId: state.vaultId,
        keyslotsSha256: state.keyslotsSha256,
        sequence: state.sequence + 1,
        manifestSha256: "a".repeat(64),
        pending: { manifest: { ...state.manifest, sequence: state.sequence + 1 }, mtimes: state.mtimes },
        startedAt: NOW_ISO,
        startRoot: state.rootCid,
      }),
    );
  }

  it("updates keyslotsSha256 in the journal and in the state, and nothing else in the journal", async () => {
    const rig = deviceB();
    await withPublishJournal(rig);
    const before = await readJournal(rig.host.kv, ROOT);
    if (before.kind !== "ok") throw new Error("no journal");
    const outcome = await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot));
    expect(outcome.publishJournalUpdated).toBe(true);
    const after = await readJournal(rig.host.kv, ROOT);
    if (after.kind !== "ok") throw new Error("no journal");
    const sha = await sha256Hex(rewrapped.bytes);
    expect(after.journal.keyslotsSha256).toBe(sha);
    expect({ ...after.journal, keyslotsSha256: before.journal.keyslotsSha256 }).toEqual(before.journal);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256).toBe(sha);
  });

  it("a journal of another vault is left alone", async () => {
    const rig = deviceB();
    await withPublishJournal(rig);
    const read = await readJournal(rig.host.kv, ROOT);
    if (read.kind !== "ok") throw new Error("no journal");
    const foreign = buildJournal({ ...read.journal, vaultId: "f".repeat(32), pending: { ...read.journal.pending, manifest: { ...read.journal.pending.manifest, vaultId: "f".repeat(32) } } });
    await writeJournal(rig.host.kv, foreign);
    const outcome = await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot));
    expect(outcome.publishJournalUpdated).toBe(false);
    expect((await readJournal(rig.host.kv, ROOT)).kind === "ok" && ((await readJournal(rig.host.kv, ROOT)) as { journal: { keyslotsSha256: string } }).journal.keyslotsSha256).toBe(foreign.keyslotsSha256);
  });

  it("an unreadable publish journal is left alone, not read as a maintenance journal and not removed", async () => {
    const rig = deviceB();
    await rig.host.kv.set(rootFileNames(ROOT).journal, new TextEncoder().encode("torn"));
    await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot));
    expect(new TextDecoder().decode(await rig.host.kv.get(rootFileNames(ROOT).journal))).toBe("torn");
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
  });
});

describe("a lost-race maintenance journal", () => {
  /** Device L lost a rewrap race: its journal says `file-written`, and its key-slot file sits in the shared tree. The name serves the old root. */
  async function loserRig(): Promise<{ readonly rig: Rig; readonly variant: Bytes }> {
    const rig = oldWorld();
    const variant = variantKeySlots(oldBytes, "c");
    const { deps } = await startRewrap(rig, keys, variant);
    await deps.node.writeKeySlotsFile(variant);
    const read = await readMaintenanceJournal(rig.host.kv, ROOT);
    if (read.kind !== "ok") throw new Error("no journal");
    await writeMaintenanceJournal(rig.host.kv, advance(read.journal, "file-written"));
    rig.node.calls.length = 0;
    rig.node.mutations = 0;
    return { rig, variant };
  }

  /**
   * The same loser after the winner's rewrap published its root: the shared tree is the one tree of the node, so the loser's late write replaced the
   * winner's file in it (the write race the doc of `republish-root.ts` says is not detected), while the name serves the winner's root.
   */
  async function loserBehindWinner(): Promise<{ readonly rig: Rig; readonly winner: string }> {
    const rig = deviceB();
    const variant = variantKeySlots(rewrapped.bytes, "c");
    const { deps, journal } = await startRewrap(rig, keys, variant);
    await deps.node.writeKeySlotsFile(variant);
    await writeMaintenanceJournal(rig.host.kv, advance(journal, "file-written"));
    rig.node.calls.length = 0;
    rig.node.mutations = 0;
    return { rig, winner: rewrappedRoot };
  }

  it("accept takes the loser's file back out of the shared tree, replaces the copy, clears the journal, and publish then works", async () => {
    const { rig, winner } = await loserBehindWinner();
    const outcome = await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(winner));
    expect(outcome.withdrawn).toBe(true);
    expect(outcome.maintenanceCleared).toBe("removed");
    expect(await journalOf(rig)).toBeUndefined();
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), rewrapped.bytes)).toBe(true);
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes)).toBe(true);
    const published = await rig.publish({ passphrase: otherPassphrase() });
    expect(published.published).toBe(false);
  });

  it("accept also clears a damaged maintenance journal", async () => {
    const rig = deviceB();
    await rig.host.kv.set(rootFileNames(ROOT).maintenance, new TextEncoder().encode("{ torn"));
    const prepared = await prepareAcceptance(depsFor(rig, createMemoryDeviceStore()), inputFor(rewrappedRoot));
    expect(prepared.maintenance.kind).toBe("damaged");
    const outcome = await commitAcceptance(depsFor(rig, createMemoryDeviceStore()), prepared, {});
    expect(outcome.maintenanceCleared).toBe("removed");
    expect(outcome.withdrawn).toBe(false);
    expect((await readMaintenanceJournal(rig.host.kv, ROOT)).kind).toBe("none");
  });

  it("discard withdraws the loser's file, removes the journal, and publish works afterwards", async () => {
    const { rig } = await loserRig();
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), oldBytes)).toBe(false);
    const outcome = await discardMaintenance(depsFor(rig, createMemoryDeviceStore()), ROOT);
    expect(outcome).toMatchObject({ kind: "discarded", type: "rewrap", withdrawn: true });
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), oldBytes)).toBe(true);
    expect(await journalOf(rig)).toBeUndefined();
    const published = await rig.publish();
    expect(published.published).toBe(false);
  });

  it("discard touches nothing on the node when the shared tree no longer holds the journal's file", async () => {
    const { rig } = await loserRig();
    rig.node.files.set(KEYSLOTS_PATH, oldBytes);
    rig.node.calls.length = 0;
    const outcome = await discardMaintenance(depsFor(rig, createMemoryDeviceStore()), ROOT);
    expect(outcome).toMatchObject({ kind: "discarded", withdrawn: false });
    expect(mutatingCalls(rig)).toEqual([]);
    expect(await journalOf(rig)).toBeUndefined();
  });

  it("discard has nothing to do without a journal, and writes nothing", async () => {
    const rig = oldWorld();
    const { kv, writes } = recordingKv(rig);
    const outcome = await discardMaintenance(depsFor(rig, createMemoryDeviceStore(), { kv }), ROOT);
    expect(outcome.kind).toBe("none");
    expect(writes).toEqual([]);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("discard removes a damaged journal and a prune journal without touching the node", async () => {
    const damaged = oldWorld();
    await damaged.host.kv.set(rootFileNames(ROOT).maintenance, new TextEncoder().encode("{ torn"));
    expect(await discardMaintenance(depsFor(damaged, createMemoryDeviceStore()), ROOT)).toMatchObject({ kind: "discarded", type: "damaged", withdrawn: false });
    expect(mutatingCalls(damaged)).toEqual([]);

    const pruned = oldWorld();
    const state = await readRootState(pruned.host.kv, ROOT);
    if (state === undefined) throw new Error("no state");
    await writeMaintenanceJournal(
      pruned.host.kv,
      buildPruneJournal({ mfsRoot: ROOT, key: KEY, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256, startRoot: publishedRoot(pruned), nodeSequence: state.sequence, manifestSha256: "b".repeat(64), startedAt: NOW_ISO }, []),
    );
    expect(await discardMaintenance(depsFor(pruned, createMemoryDeviceStore()), ROOT)).toMatchObject({ kind: "discarded", type: "prune", withdrawn: false });
    expect(mutatingCalls(pruned)).toEqual([]);
  });

  it("discard leaves the file alone for a rewrap that reached the published phase, and says which phase it dropped", async () => {
    const { rig } = await loserRig();
    const read = await readMaintenanceJournal(rig.host.kv, ROOT);
    if (read.kind !== "ok") throw new Error("no journal");
    await writeMaintenanceJournal(rig.host.kv, { ...advance(read.journal, "snapshotted", publishedRoot(rig)), phase: "published" } as typeof read.journal);
    rig.node.calls.length = 0;
    const outcome = await discardMaintenance(depsFor(rig, createMemoryDeviceStore()), ROOT);
    expect(outcome).toMatchObject({ kind: "discarded", type: "rewrap", phase: "published", withdrawn: false });
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a failing withdrawal keeps the journal, and a lapsed lock stops the removal", async () => {
    const { rig } = await loserRig();
    const inner = maintenanceNodeOf(rig);
    const failing: AcceptDeps["node"] = {
      ...inner,
      writeKeySlotsFile: async () => {
        throw new Error("the node went away");
      },
    };
    await expect(discardMaintenance(depsFor(rig, createMemoryDeviceStore(), { node: failing }), ROOT)).rejects.toThrow(/went away/);
    expect((await journalOf(rig))?.type).toBe("rewrap");
    const lapsed = depsFor(rig, createMemoryDeviceStore(), {
      assertHeld: () => {
        throw lockLost();
      },
    });
    expect((await refusal(discardMaintenance(lapsed, ROOT))).code).toBe("lock-lost");
    expect((await journalOf(rig))?.type).toBe("rewrap");
  });
});

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

describe("kill after each step: a rerun reaches the same end state", () => {
  async function loser(): Promise<{ readonly rig: Rig; readonly winner: string }> {
    const rig = deviceB();
    const variant = variantKeySlots(rewrapped.bytes, "c");
    const { deps, journal } = await startRewrap(rig, keys, variant);
    await deps.node.writeKeySlotsFile(variant);
    await writeMaintenanceJournal(rig.host.kv, advance(journal, "file-written"));
    rig.node.mutations = 0;
    return { rig, winner: rewrappedRoot };
  }

  async function expectAccepted(rig: Rig, where: string): Promise<void> {
    expect(bytesEqual(await localCopy(rig), rewrapped.bytes), where).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.keyslotsSha256, where).toBe(await sha256Hex(rewrapped.bytes));
    expect(await journalOf(rig), where).toBeUndefined();
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), rewrapped.bytes), where).toBe(true);
  }

  it("accept over a lost rewrap race and a pending publish journal: every kill is finished by running accept again", async () => {
    let completedAt: number | undefined;
    for (let k = 1; completedAt === undefined; k += 1) {
      const { rig, winner } = await loser();
      const state = await readRootState(rig.host.kv, ROOT);
      if (state === undefined) throw new Error("no state");
      await writeJournal(
        rig.host.kv,
        buildJournal({
          mfsRoot: ROOT,
          key: KEY,
          vaultId: state.vaultId,
          keyslotsSha256: state.keyslotsSha256,
          sequence: state.sequence + 1,
          manifestSha256: "a".repeat(64),
          pending: { manifest: { ...state.manifest, sequence: state.sequence + 1 }, mtimes: state.mtimes },
          startedAt: NOW_ISO,
          startRoot: state.rootCid,
        }),
      );
      rig.node.mutations = 0;
      const where = `kill after mutation ${k}`;
      rig.node.killAfterMutation = k;
      let killed = false;
      try {
        await accept(depsFor(rig, createMemoryDeviceStore(), { kv: rig.killableHost.kv, fs: killableFs(rig) }), inputFor(winner));
      } catch (error) {
        if (!(error instanceof NodeKilled)) throw error;
        killed = true;
      }
      rig.node.killAfterMutation = undefined;
      if (!killed) {
        completedAt = k;
        await expectAccepted(rig, where);
        break;
      }
      await accept(depsFor(rig, createMemoryDeviceStore()), inputFor(winner));
      await expectAccepted(rig, where);
      const journal = await readJournal(rig.host.kv, ROOT);
      expect(journal.kind === "ok" && journal.journal.keyslotsSha256, where).toBe(await sha256Hex(rewrapped.bytes));
    }
    // withdrawal, copy, state, publish journal, maintenance journal removal: five steps, then the run completes.
    expect(completedAt).toBe(6);
  });

  it("discard: every kill is finished by running discard again", async () => {
    let completedAt: number | undefined;
    for (let k = 1; completedAt === undefined; k += 1) {
      const rig = oldWorld();
      const variant = variantKeySlots(oldBytes, "c");
      const { deps } = await startRewrap(rig, keys, variant);
      await deps.node.writeKeySlotsFile(variant);
      rig.node.mutations = 0;
      const where = `kill after mutation ${k}`;
      rig.node.killAfterMutation = k;
      let killed = false;
      try {
        await discardMaintenance(depsFor(rig, createMemoryDeviceStore(), { kv: rig.killableHost.kv }), ROOT);
      } catch (error) {
        if (!(error instanceof NodeKilled)) throw error;
        killed = true;
      }
      rig.node.killAfterMutation = undefined;
      if (!killed) completedAt = k;
      else await discardMaintenance(depsFor(rig, createMemoryDeviceStore()), ROOT);
      expect(await journalOf(rig), where).toBeUndefined();
      expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), oldBytes), where).toBe(true);
    }
    // withdrawal, journal removal: two steps, then the run completes.
    expect(completedAt).toBe(3);
  });
});

describe("the words", () => {
  it("states the residual weakness of a cold command-line accept", () => {
    expect(ACCEPT_RESIDUAL_STATEMENT).toMatch(/node that also knows the passphrase/);
    expect(ACCEPT_RESIDUAL_STATEMENT).toMatch(/own key/);
    expect(ACCEPT_RESIDUAL_STATEMENT).toMatch(/does not prove/);
    const text = acceptStatements("name").join("\n");
    expect(text).toContain(ACCEPT_RESIDUAL_STATEMENT);
    expect(text).toMatch(/does not raise the sequence floor/);
    expect(text).toMatch(/one root/);
  });

  it("a restore across a rewrap says that publish stays refused until the current slots are accepted again", () => {
    expect(acceptStatements("root-cid").join("\n")).toMatch(/accept the current key slots again/);
    expect(acceptStatements("name").join("\n")).not.toMatch(/accept the current key slots again/);
  });

  it("names what each pending operation costs to drop", () => {
    expect(discardStatements({ kind: "none" }).join("\n")).toMatch(/nothing to discard/);
    expect(discardStatements({ kind: "damaged" }).join("\n")).toMatch(/cannot be read/);
    const base = { version: 1, mfsRoot: ROOT, key: KEY, vaultId: "a".repeat(32), keyslotsSha256: "b".repeat(64), startRoot: null, nodeSequence: 1, manifestSha256: "c".repeat(64), startedAt: NOW_ISO, snapshotRoot: null } as const;
    const early = discardStatements({ kind: "ok", journal: { ...base, type: "rewrap", phase: "file-written", oldKeySlotsHex: "00", newKeySlotsHex: "01" } }).join("\n");
    expect(early).toMatch(/never took effect/);
    const late = discardStatements({ kind: "ok", journal: { ...base, snapshotRoot: "bafy0000000000", type: "rewrap", phase: "published", oldKeySlotsHex: "00", newKeySlotsHex: "01" } }).join("\n");
    expect(late).toMatch(/old passphrase no longer opens/);
    expect(late).toMatch(/keys accept-slots/);
    const prune = discardStatements({ kind: "ok", journal: { ...base, type: "prune", phase: "removing", removals: [] } }).join("\n");
    expect(prune).toMatch(/stay removed/);
  });
});
