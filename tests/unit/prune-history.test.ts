import { beforeAll, describe, expect, it } from "vitest";
import type { Bytes } from "../../src/core/host-bridge";
import type { VaultKeys } from "../../src/crypto";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { resolveForkBase } from "../../src/sync/fork-resolution";
import { sha256Hex } from "../../src/sync/hash";
import { HISTORY_REFUSE_AT, HISTORY_WARN_AT, assessHistoryCount, listHistory } from "../../src/sync/history-check";
import { historyFileName, isHistoryName } from "../../src/sync/history-names";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { buildPruneJournal, readMaintenanceJournal, writeMaintenanceJournal } from "../../src/sync/maintenance-journal";
import {
  HISTORY_KEEP_FLOOR,
  PruneHistoryError,
  executePrune,
  preparePrune,
  resumePrune,
  type PruneDeps,
  type PruneInput,
} from "../../src/sync/prune-history";
import { PublishRefusedError, lockLost } from "../../src/sync/publish-refusals";
import { createSnapshotVerifier } from "../../src/sync/read-back";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { toUnlockedVault, type UnlockedVault } from "../../src/sync/vault-keys";
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
  startRewrap,
  variantKeySlots,
  winnerRootOf,
} from "../helpers/maintenance-rig";
import { junkHistoryName, seedHistory, type SeededHistory } from "../helpers/prune-rig";
import { KEY, ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";
import { referencePassphrase } from "../vectors/slot-helpers";

/**
 * Task 1.6: `prune-history` as the shared engine (`prune-history.ts`), over the recording fake node. The node holds a long history without having
 * published that many times (`seedHistory`): the newest 20 history files are genuine, the older ones are bytes that authenticate as nothing, as
 * a node holding old history would list them. The engine must therefore decide from names for the old ones and from authentication for the newest.
 */

const NOW_ISO = "2026-10-03T10:00:00.000Z";
const BIG = 1_600;
const SMALL = 40;
const SMALL_FORKS = [35, 40] as const;

let base: RigSnapshot;
let big: RigSnapshot;
let small: RigSnapshot;
let keys: VaultKeys;
let held: UnlockedVault;
let bigSeed: SeededHistory;
let smallSeed: SeededHistory;

beforeAll(async () => {
  const rig = await publishedRig();
  keys = await rig.keys();
  const slots = oldKeySlotsOf(rig);
  held = toUnlockedVault({ keys, vaultId: keys.vaultId, keySlots: slots, keySlotsSha256: await sha256Hex(slots) });
  base = snapshotRig(rig);
  const bigRig = restoreRig(base);
  bigRig.node.cidOf(ROOT);
  bigSeed = await seedHistory({ node: bigRig.node, kv: bigRig.host.kv, mfsRoot: ROOT, keys, total: BIG });
  big = snapshotRig(bigRig);
  const smallRig = restoreRig(base);
  smallRig.node.cidOf(ROOT);
  smallSeed = await seedHistory({ node: smallRig.node, kv: smallRig.host.kv, mfsRoot: ROOT, keys, total: SMALL, forks: SMALL_FORKS });
  small = snapshotRig(smallRig);
}, 60_000);

const fresh = (snapshot: RigSnapshot): Rig => {
  const rig = restoreRig(snapshot);
  rig.node.cidOf(ROOT);
  return rig;
};

interface DepsOptions {
  readonly kv?: Rig["host"]["kv"];
  readonly assertHeld?: () => void;
  readonly beforeFirstWrite?: () => Promise<void>;
  readonly node?: PruneDeps["node"];
}

function depsFor(rig: Rig, options: DepsOptions = {}): PruneDeps {
  return {
    node: options.node ?? maintenanceNodeOf(rig),
    fs: rig.host.fs,
    kv: options.kv ?? rig.host.kv,
    deviceStore: undefined,
    now: () => NOW_ISO,
    snapshotVerifier: (keySlots) => createSnapshotVerifier({ client: rig.node.client, keySlots, written: new Map() }),
    assertHeld: options.assertHeld ?? (() => undefined),
    ...(options.beforeFirstWrite === undefined ? {} : { beforeFirstWrite: options.beforeFirstWrite }),
  };
}

const inputFor = (keep: number, overrides: Partial<PruneInput> = {}): PruneInput => ({
  mfsRoot: ROOT,
  keyName: KEY,
  passphrase: referencePassphrase(),
  unlocked: held,
  key: { absent: false },
  keep,
  ...overrides,
});

/** What a rerun from `published` on is given: no passphrase and no held vault. */
const bareInput = (keep: number): PruneInput => ({ mfsRoot: ROOT, keyName: KEY, passphrase: undefined, key: { absent: false }, keep });

async function pruneFully(rig: Rig, keep: number, options: DepsOptions = {}, overrides: Partial<PruneInput> = {}) {
  const deps = depsFor(rig, options);
  const prepared = await preparePrune(deps, inputFor(keep, overrides));
  return { prepared, outcome: await executePrune(deps, prepared) };
}

const rmCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("rm "));
const publishCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("publish "));
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);
const currentEntry = (seed: SeededHistory): string => historyFileName(seed.manifest.sequence, seed.manifest.rootCID);
const entryPath = (name: string): string => `${ROOT}/manifests/${name}`;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error, "the call should have been refused").toBeDefined();
  return error;
}

/** A refusal before any change: a typed error, and the node was not touched in any way that changes it. */
async function refused(rig: Rig, run: () => Promise<unknown>, code: string): Promise<Error> {
  const error = await failure(run());
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toBe(code);
  expect(mutatingCalls(rig)).toEqual([]);
  expect(await journalOf(rig)).toBeUndefined();
  return error as Error;
}

describe("a prune of a long history", () => {
  it("with 1,600 prefixed entries and --keep 100 removes the oldest 1,500 and nothing else", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    const rootBefore = rig.node.cidOf(ROOT) as string;
    const currentBefore = rig.node.cidOf(`${ROOT}/current`);
    const manifestBefore = new Uint8Array(rig.node.files.get(MANIFEST_PATH) as Bytes);
    const slotsBefore = new Uint8Array(rig.node.files.get(KEYSLOTS_PATH) as Bytes);

    const { prepared, outcome } = await pruneFully(rig, 100);

    expect(prepared.plan.removals).toHaveLength(1_500);
    expect(outcome.removed).toBe(1_500);
    expect(historyNamesOf(rig)).toEqual(bigSeed.names.slice(1_500));
    // Each request removed one history name under manifests/, and nothing else changed the tree but the pin and the publication.
    const removed = rmCalls(rig);
    expect(removed).toHaveLength(1_500);
    for (const call of removed) {
      const path = call.slice("rm ".length);
      expect(path.startsWith(`${ROOT}/manifests/`)).toBe(true);
      expect(isHistoryName(path.slice(`${ROOT}/manifests/`.length))).toBe(true);
    }
    expect(mutatingCalls(rig).filter((call) => !call.startsWith("rm ")).map((call) => call.split(" ")[0])).toEqual(["pin", "publish"]);
    // current/, manifest.enc and keyslots.json are unchanged; the sequence is not touched.
    expect(rig.node.cidOf(`${ROOT}/current`)).toBe(currentBefore);
    expect(bytesEqual(rig.node.files.get(MANIFEST_PATH), manifestBefore)).toBe(true);
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), slotsBefore)).toBe(true);
    // One publication of the snapshot that was read back, recorded as this device's root.
    expect(publishedRoot(rig)).toBe(outcome.snapshotRoot);
    expect(rig.node.cidOf(ROOT)).toBe(outcome.snapshotRoot);
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.rootCid).toBe(outcome.snapshotRoot);
    expect(state?.sequence).toBe(BIG);
    expect(await journalOf(rig)).toBeUndefined();
    // The earlier root is still fetchable, with its history as it was.
    expect(await rig.node.client.ipfsLs(`/ipfs/${rootBefore}/manifests`)).toHaveLength(BIG);
  });

  it("--keep 5 keeps 20", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    const { prepared, outcome } = await pruneFully(rig, 5);
    expect(prepared.plan.keepEffective).toBe(HISTORY_KEEP_FLOOR);
    expect(prepared.plan.floorApplied).toBe(true);
    expect(outcome.removed).toBe(BIG - HISTORY_KEEP_FLOOR);
    expect(historyNamesOf(rig)).toEqual(bigSeed.names.slice(-HISTORY_KEEP_FLOOR));
  });

  it("the history the warning and the refusal count is brought back under both by a prune (task 1.8, option b)", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    const client = rig.node.client;
    const before = await listHistory(client, ROOT);
    expect(before.entries.length).toBeGreaterThanOrEqual(HISTORY_WARN_AT);
    expect(assessHistoryCount(before)).toMatch(/prune-history/);
    expect(assessHistoryCount(before)).not.toMatch(/not available/);
    await pruneFully(rig, 100);
    expect(assessHistoryCount(await listHistory(client, ROOT))).toBeUndefined();
  });

  it("a folder at the refusal level (2,000 files) can be pruned, and publishing is possible again", { timeout: 60_000 }, async () => {
    const rig = fresh(base);
    await seedHistory({ node: rig.node, kv: rig.host.kv, mfsRoot: ROOT, keys, total: 2_000 });
    const full = await listHistory(rig.node.client, ROOT);
    expect(full.entries.length).toBeGreaterThanOrEqual(HISTORY_REFUSE_AT);
    let message = "";
    try {
      assessHistoryCount(full);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ipfs-sync prune-history/);
    expect(message).not.toMatch(/not available/);
    await pruneFully(rig, 100);
    expect(assessHistoryCount(await listHistory(rig.node.client, ROOT))).toBeUndefined();
  });

  it("two files at one sequence are counted and shown, and do not refuse", async () => {
    const rig = fresh(small);
    const { prepared } = await pruneFully(rig, 35);
    expect(prepared.plan.duplicateFiles).toBe(2);
    expect(prepared.plan.total).toBe(SMALL + SMALL_FORKS.length);
    expect(prepared.plan.removals).toHaveLength(7);
    expect(historyNamesOf(rig)).toHaveLength(35);
  });

  it("legacy names are removed first and their count is shown", async () => {
    const rig = fresh(base);
    const seeded = await seedHistory({ node: rig.node, kv: rig.host.kv, mfsRoot: ROOT, keys, total: 60, legacy: 30 });
    const { prepared } = await pruneFully(rig, 50);
    expect(prepared.plan.legacyTotal).toBe(30);
    expect(prepared.plan.legacyRemoved).toBe(30);
    expect(prepared.plan.removals).toHaveLength(40);
    expect(historyNamesOf(rig)).toEqual(seeded.names.filter((name) => !name.startsWith("bafylegacy")).slice(10));
  });

  it("the earlier history entry a fork resolution needs survives --keep 5 (task 1.6 f)", async () => {
    const rig = fresh(small);
    const { outcome } = await pruneFully(rig, 5);
    const previous = manifestIdentity(smallSeed.manifestAt(SMALL - 1));
    const base = await resolveForkBase({ client: rig.node.client, keys, node: smallSeed.manifest, rootCid: outcome.snapshotRoot as string, previousIdentity: previous });
    expect(base.report.ancestorUsed).toBe(true);
    expect(base.report.note).toBeUndefined();
  });

  it("the publish that follows is a no-change run that writes nothing", async () => {
    const rig = fresh(small);
    await pruneFully(rig, 25);
    rig.node.calls.length = 0;
    const result = await rig.publish();
    expect(result.published).toBe(false);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a prune that has nothing to remove changes nothing on the node", async () => {
    const rig = fresh(small);
    const { prepared, outcome } = await pruneFully(rig, 100);
    expect(prepared.plan.removals).toEqual([]);
    expect(outcome.removed).toBe(0);
    expect(mutatingCalls(rig)).toEqual([]);
    expect(await journalOf(rig)).toBeUndefined();
    expect(publishCalls(rig)).toEqual([]);
  });
});

describe("what a prune refuses before it removes anything", () => {
  it("the newest entry does not authenticate", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    rig.node.files.set(entryPath(currentEntry(bigSeed)), new Uint8Array(64).fill(7));
    await refused(rig, () => pruneFully(rig, 100), "entry-unauthentic");
  });

  it("the newest entry decrypts to a sequence other than its prefix", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    rig.node.files.set(entryPath(currentEntry(bigSeed)), (await encodeManifestFile(keys, bigSeed.manifestAt(BIG - 1))).file);
    await refused(rig, () => pruneFully(rig, 100), "entry-prefix-mismatch");
  });

  it("the fifth newest entry disagrees with its prefix, or does not authenticate", { timeout: 60_000 }, async () => {
    for (const [variant, code] of [
      ["mismatch", "entry-prefix-mismatch"],
      ["junk", "entry-unauthentic"],
    ] as const) {
      const rig = fresh(big);
      const bytes = variant === "mismatch" ? (await encodeManifestFile(keys, bigSeed.manifestAt(BIG - 10))).file : new Uint8Array(80).fill(3);
      rig.node.files.set(entryPath(historyFileName(BIG - 4, bigSeed.manifest.rootCID)), bytes);
      await refused(rig, () => pruneFully(rig, 100), code);
    }
  });

  it("the entry that is the 21st newest is not read, so an old damaged file never blocks a prune", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    rig.node.files.set(entryPath(junkHistoryName(BIG - 20)), new Uint8Array(10));
    const { outcome } = await pruneFully(rig, 100);
    expect(outcome.removed).toBe(1_500);
  });

  it("the newest history entry is older than the node's manifest: the history may be withheld", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    for (const sequence of [BIG, BIG - 1, BIG - 2]) rig.node.files.delete(entryPath(historyFileName(sequence, bigSeed.manifest.rootCID)));
    const error = await refused(rig, () => pruneFully(rig, 100), "newest-sequence-mismatch");
    expect(error.message).toMatch(/withheld/);
    expect(error.message).toContain(String(BIG));
    expect(error.message).toContain(String(BIG - 3));
  });

  it("a newer entry than the node's manifest planted in the folder is refused too", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    rig.node.files.set(entryPath(junkHistoryName(BIG + 1)), new Uint8Array(30));
    await refused(rig, () => pruneFully(rig, 100), "newest-sequence-mismatch");
  });

  it("the history file of the current manifest is missing under its own name", { timeout: 60_000 }, async () => {
    const rig = fresh(big);
    const genuine = rig.node.files.get(entryPath(currentEntry(bigSeed))) as Bytes;
    rig.node.files.delete(entryPath(currentEntry(bigSeed)));
    rig.node.files.set(entryPath(historyFileName(BIG, "bafyother0000000000000000000000000000000000000")), genuine);
    await refused(rig, () => pruneFully(rig, 100), "current-entry-missing");
  });

  it("a folder of more than 2,000 entries cannot be listed, so it is refused with the way out", { timeout: 60_000 }, async () => {
    const rig = fresh(base);
    await seedHistory({ node: rig.node, kv: rig.host.kv, mfsRoot: ROOT, keys, total: 2_001 });
    const error = await refused(rig, () => pruneFully(rig, 100), "history-too-large");
    expect(error.message).toMatch(/2,000/);
    expect(error.message).toMatch(/on the node/);
    expect(error.message).toMatch(/new MFS root/);
  });

  it("a name in manifests/ that is not a history file refuses, and names publish --repair", async () => {
    const rig = fresh(small);
    rig.node.files.set(entryPath("notes.txt"), new Uint8Array([1]));
    const error = await failure(pruneFully(rig, 25));
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect((error as PublishRefusedError).code).toBe("history-junk");
    expect((error as Error).message).toContain("--repair");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a device that is not up to date refuses (the node is ahead of its record)", async () => {
    const rig = fresh(small);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("no record");
    const behind = smallSeed.manifestAt(SMALL - 1);
    await writeRootState(rig.host.kv, buildRootState({ ...state, sequence: SMALL - 1, manifest: behind, manifestIdentity: manifestIdentity(behind), highestSequence: SMALL - 1, highestIdentity: manifestIdentity(behind) }));
    await refused(rig, () => pruneFully(rig, 25), "sequence-ahead");
  });

  it("an unfinished publish on this device refuses, and the journal is not read", async () => {
    const rig = fresh(small);
    await rig.host.kv.set(rootFileNames(ROOT).journal, new Uint8Array([123]));
    await refused(rig, () => pruneFully(rig, 25), "publish-journal-pending");
  });

  it("a pending key-management journal refuses and names both ways out", async () => {
    const rig = fresh(small);
    await startRewrap(rig, keys, variantKeySlots(oldKeySlotsOf(rig), "a"));
    const error = await failure(pruneFully(rig, 25));
    expect((error as PublishRefusedError).code).toBe("maintenance-pending");
    expect((error as Error).message).toContain("keys discard");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a vault whose publication key does not exist is refused, and no key is created", async () => {
    const rig = fresh(small);
    const error = await failure(pruneFully(rig, 25, {}, { key: { absent: true } }));
    expect((error as PublishRefusedError).code).toBe("publication-key-missing");
    expect(rig.node.calls.filter((call) => call.startsWith("keyGen"))).toEqual([]);
  });

  it("a lost lock stops the prune before the first removal", async () => {
    const rig = fresh(small);
    const error = await failure(
      pruneFully(rig, 25, {
        assertHeld: () => {
          throw lockLost();
        },
      }),
    );
    expect((error as PublishRefusedError).code).toBe("lock-lost");
    expect(rmCalls(rig)).toEqual([]);
  });
});

describe("a node that lists crafted names", () => {
  /** The client with the listing of `manifests/` replaced; everything else is the fake node. */
  function withListing(rig: Rig, extra: readonly { readonly name: string; readonly type: "file" | "directory" }[]): void {
    const client = rig.node.client as unknown as { filesLs: (path: string) => Promise<readonly Record<string, unknown>[]> };
    const original = client.filesLs.bind(client);
    client.filesLs = async (path) => {
      const entries = await original(path);
      if (path !== `${ROOT}/manifests`) return entries;
      return [...entries, ...extra.map((entry) => ({ ...entry, cid: "bafyhostile000000000000000000000000000000000000", size: 1 }))];
    };
  }

  it.each([
    ["a path that climbs out of manifests/", "../keyslots.json", "file"],
    ["the parent directory", "..", "directory"],
    ["a name with a separator", "a/b.enc", "file"],
    ["the state of the root", "manifest.enc", "file"],
    ["a directory with a history-shaped name", historyFileName(3, "bafydirectory00000000000000000000000000000000"), "directory"],
  ] as const)("%s is junk: nothing is removed and keyslots.json, manifest.enc and current/ stay", async (_label, name, type) => {
    const rig = fresh(small);
    withListing(rig, [{ name, type }]);
    const error = await failure(pruneFully(rig, 25));
    expect((error as PublishRefusedError).code).toBe("history-junk");
    expect(rmCalls(rig)).toEqual([]);
    expect(mutatingCalls(rig)).toEqual([]);
    expect(rig.node.files.has(KEYSLOTS_PATH)).toBe(true);
    expect(rig.node.files.has(MANIFEST_PATH)).toBe(true);
  });

  it("a journal that names the current entry, the entry before it or a path is refused on resume before any removal", async () => {
    for (const hostile of [currentEntry(smallSeed), historyFileName(SMALL - 1, smallSeed.manifest.rootCID), historyFileName(SMALL - 1, "bafyfork0000000000000000000000000000000000000000")]) {
      const rig = fresh(small);
      const deps = depsFor(rig);
      const prepared = await preparePrune(deps, inputFor(25));
      const journal = buildPruneJournal(prepared.start.facts, [hostile]);
      await writeMaintenanceJournal(rig.host.kv, journal);
      const error = await failure(resumePrune(deps, journal, inputFor(25)));
      expect((error as PruneHistoryError).code).toBe("journal-out-of-bounds");
      expect(rmCalls(rig)).toEqual([]);
      expect(mutatingCalls(rig)).toEqual([]);
    }
  });
});

describe("a lost race", () => {
  it("the name moved before the first removal: nothing is removed and the refusal names the ways out", async () => {
    const rig = fresh(small);
    const deps = depsFor(rig);
    const prepared = await preparePrune(deps, inputFor(25));
    rig.node.published.set(OWNED, `/ipfs/${winnerRootOf(rig, new Map())}`);
    const error = await failure(executePrune(deps, prepared));
    expect((error as PublishRefusedError).code).toBe("maintenance-lost-race");
    expect((error as Error).message).toContain("keys discard");
    expect(rmCalls(rig)).toEqual([]);
    expect(publishCalls(rig)).toEqual([]);
    expect((await journalOf(rig))?.phase).toBe("journaled");
  });

  it("the name moved after the removals: nothing is published, the removals are not added back and the refusal says so", async () => {
    const rig = fresh(small);
    const winner = winnerRootOf(rig, new Map());
    const client = rig.node.client as unknown as { pinAdd: (cid: string) => Promise<void>; nameResolve: (name: string, options?: unknown) => Promise<string> };
    const resolve = client.nameResolve;
    const pin = client.pinAdd;
    let pinned = false;
    let moved = false;
    client.pinAdd = async (cid) => {
      await pin(cid);
      pinned = true;
    };
    client.nameResolve = async (name, options) => {
      const value = await resolve(name, options);
      if (pinned && !moved) {
        moved = true;
        rig.node.published.set(OWNED, `/ipfs/${winner}`);
      }
      return value;
    };
    const error = await failure(pruneFully(rig, 35));
    expect((error as PublishRefusedError).code).toBe("maintenance-lost-race");
    expect((error as Error).message).toMatch(/stay removed/);
    expect(publishCalls(rig)).toEqual([]);
    expect(publishedRoot(rig)).toBe(winner);
    expect(rmCalls(rig)).toHaveLength(7);
  });
});

describe("kill after each step: a rerun finishes the one prune and never publishes twice", () => {
  const keep = 35;

  async function finishedState(rig: Rig, where: string, expectedNames: readonly string[]): Promise<void> {
    expect(historyNamesOf(rig), where).toEqual(expectedNames);
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.rootCid, where).toBe(publishedRoot(rig));
    expect(rig.node.cidOf(ROOT), where).toBe(publishedRoot(rig));
    expect(await journalOf(rig), where).toBeUndefined();
    expect(publishCalls(rig).length, where).toBeLessThanOrEqual(1);
    expect(state?.sequence, where).toBe(SMALL);
  }

  it("every kill from the first journal write to the journal removal resumes to one publication", { timeout: 60_000 }, async () => {
    const expected = smallSeed.names.slice(7);
    let completedAt: number | undefined;
    let resumedAtPublished = 0;
    for (let k = 1; completedAt === undefined; k += 1) {
      const rig = fresh(small);
      const where = `kill after mutation ${k}`;
      rig.node.killAfterMutation = k;
      let killed = false;
      try {
        await pruneFully(rig, keep, { kv: rig.killableHost.kv });
      } catch (error) {
        if (!(error instanceof NodeKilled)) throw error;
        killed = true;
      }
      if (!killed) {
        completedAt = k;
        await finishedState(rig, where, expected);
        break;
      }
      rig.node.killAfterMutation = undefined;
      const read = await readMaintenanceJournal(rig.host.kv, ROOT);
      if (read.kind === "ok") {
        // From `published` on, the rerun needs no passphrase and no vault.
        const needsNothing = read.journal.phase === "published";
        if (needsNothing) resumedAtPublished += 1;
        const outcome = await resumePrune(depsFor(rig), read.journal, needsNothing ? bareInput(keep) : inputFor(keep));
        expect(outcome.kind, where).toBe("finished");
      } else {
        expect(read.kind, where).toBe("none");
      }
      await finishedState(rig, where, expected);
    }
    // journal, journal, 7 removals, journal, pin, publish, state, journal, journal removed: fifteen steps, then the run completes.
    expect(completedAt).toBe(16);
    expect(resumedAtPublished).toBeGreaterThan(0);
  });

  it("a kill after name/publish: the rerun finds the name at its snapshot root and publishes nothing more", async () => {
    const rig = fresh(small);
    rig.node.killAfterMutation = 12; // journal 1, 2; rm 3-9; journal 10; pin 11; publish 12
    await expect(pruneFully(rig, keep, { kv: rig.killableHost.kv })).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    expect(publishCalls(rig)).toHaveLength(1);
    expect((await journalOf(rig))?.phase).toBe("snapshotted");
    const read = await readMaintenanceJournal(rig.host.kv, ROOT);
    if (read.kind !== "ok") throw new Error("the journal is gone");
    const outcome = await resumePrune(depsFor(rig), read.journal, inputFor(keep));
    expect(outcome.kind).toBe("finished");
    expect(publishCalls(rig)).toHaveLength(1);
    expect((await readRootState(rig.host.kv, ROOT))?.rootCid).toBe(publishedRoot(rig));
    expect(await journalOf(rig)).toBeUndefined();
  });
});
