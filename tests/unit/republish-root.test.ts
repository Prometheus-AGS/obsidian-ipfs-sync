import { beforeAll, describe, expect, it } from "vitest";
import type { Bytes, HostKv } from "../../src/core/host-bridge";
import type { VaultKeys } from "../../src/crypto";
import { decodeMaintenanceJournal, discardMaintenanceJournal, readMaintenanceJournal } from "../../src/sync/maintenance-journal";
import { PublishRefusedError, ReadBackError, lockLost } from "../../src/sync/publish-refusals";
import { beginMaintenance, driveMaintenance, withdrawMaintenanceWrite } from "../../src/sync/republish-root";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { NodeKilled } from "../helpers/fake-kubo";
import {
  KEYSLOTS_PATH,
  MANIFEST_PATH,
  OWNED,
  finishRewrapLocally,
  historyNamesOf,
  journalOf,
  maintenanceDeps,
  maintenanceNodeOf,
  mutatingCalls,
  oldKeySlotsOf,
  publishedRig,
  publishedRoot,
  pruneOnce,
  resumeFromJournal,
  rewrapOnce,
  startPrune,
  startRewrap,
  variantKeySlots,
  winnerRootOf,
} from "../helpers/maintenance-rig";
import { KEY, ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

/**
 * Task 1.3: the republish primitive (`republish-root.ts`) over the recording fake node. A rewrap changes `keyslots.json` and a prune removes history
 * files; both end in the same steps (snapshot, read-back through the immutable path, pin, name re-check, `name/publish`, the state's `rootCid`).
 */

let snapshot: RigSnapshot;
let keys: VaultKeys;

beforeAll(async () => {
  const rig = await publishedRig();
  keys = await rig.keys();
  snapshot = snapshotRig(rig);
});

/** A restored rig's node knows the published root's blocks only once the tree is stat-ed, as the real node always does: do it before the test changes anything. */
const fresh = (): Rig => {
  const rig = restoreRig(snapshot);
  rig.node.cidOf(ROOT);
  return rig;
};
const refusal = async (promise: Promise<unknown>): Promise<PublishRefusedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishRefusedError);
  return error as PublishRefusedError;
};
const newSlotsOf = (rig: Rig, tag = "a") => variantKeySlots(oldKeySlotsOf(rig), tag);
const oldestHistory = (rig: Rig): string => historyNamesOf(rig)[0] as string;
const publishCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("publish "));
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);

describe("a rewrap through the primitive", () => {
  it("writes the file, snapshots, reads back, pins and publishes the snapshot root, then records the root in the state", async () => {
    const rig = fresh();
    const next = newSlotsOf(rig);
    const manifestBefore = rig.node.files.get(MANIFEST_PATH);
    const stateBefore = await readRootState(rig.host.kv, ROOT);
    const seen: string[] = [];
    const kv: HostKv = {
      ...rig.host.kv,
      set: async (key, value) => {
        await rig.host.kv.set(key, value);
        if (key === rootFileNames(ROOT).maintenance) seen.push(decodeMaintenanceJournal(value).phase);
        if (key === rootFileNames(ROOT).state) seen.push("state");
      },
    };

    const outcome = await rewrapOnce(rig, keys, next, kv);

    expect(seen).toEqual(["journaled", "file-written", "snapshotted", "state", "published"]);
    expect(mutatingCalls(rig).map((call) => call.split(" ")[0])).toEqual(["write", "pin", "publish"]);
    expect(mutatingCalls(rig)[0]).toBe(`write ${KEYSLOTS_PATH}`);
    expect(mutatingCalls(rig)[1]).toBe(`pin ${outcome.snapshotRoot}`);
    expect(mutatingCalls(rig)[2]?.split(" ")[2]).toBe(outcome.snapshotRoot);
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), next)).toBe(true);
    expect(publishedRoot(rig)).toBe(outcome.snapshotRoot);
    expect(rig.node.cidOf(ROOT)).toBe(outcome.snapshotRoot);
    // manifest.enc and the sequence are untouched; only the root CID moved.
    expect(bytesEqual(rig.node.files.get(MANIFEST_PATH), manifestBefore)).toBe(true);
    const stateAfter = await readRootState(rig.host.kv, ROOT);
    expect(stateAfter?.sequence).toBe(stateBefore?.sequence);
    expect(stateAfter?.highestSequence).toBe(stateBefore?.highestSequence);
    expect(stateAfter?.rootCid).toBe(outcome.snapshotRoot);
    expect(stateAfter?.keyslotsSha256).toBe(stateBefore?.keyslotsSha256);
    expect((await journalOf(rig))?.phase).toBe("published");
  });

  it("makes the next publish after the local steps a no-change run that writes nothing (state.rootCid is the new root)", async () => {
    const rig = fresh();
    const next = newSlotsOf(rig);
    await rewrapOnce(rig, keys, next);
    await finishRewrapLocally(rig, next);
    rig.node.calls.length = 0;
    const result = await rig.publish();
    expect(result.published).toBe(false);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("is a no-op when run again on a journal that already published", async () => {
    const rig = fresh();
    const next = newSlotsOf(rig);
    const first = await rewrapOnce(rig, keys, next);
    rig.node.calls.length = 0;
    const again = await resumeFromJournal(rig, keys, next);
    expect(again?.snapshotRoot).toBe(first.snapshotRoot);
    expect(mutatingCalls(rig)).toEqual([]);
  });
});

describe("a prune through the primitive", () => {
  it("removes the named history files only, then snapshots, reads back, pins and publishes", async () => {
    const rig = fresh();
    const all = historyNamesOf(rig);
    const outcome = await pruneOnce(rig, keys, [oldestHistory(rig)]);
    expect(historyNamesOf(rig)).toEqual(all.slice(1));
    expect(mutatingCalls(rig).map((call) => call.split(" ")[0])).toEqual(["rm", "pin", "publish"]);
    expect(mutatingCalls(rig)[0]).toBe(`rm ${ROOT}/manifests/${all[0]}`);
    expect(publishedRoot(rig)).toBe(outcome.snapshotRoot);
    expect((await readRootState(rig.host.kv, ROOT))?.rootCid).toBe(outcome.snapshotRoot);
    expect(rig.node.files.has(KEYSLOTS_PATH) && rig.node.files.has(MANIFEST_PATH)).toBe(true);
  });

  it("a name that is already gone is not an error", async () => {
    const rig = fresh();
    const name = oldestHistory(rig);
    rig.node.files.delete(`${ROOT}/manifests/${name}`);
    await expect(pruneOnce(rig, keys, [name])).resolves.toMatchObject({ kind: "published" });
  });
});

describe("kill after each step: the journal resumes to a safe state", () => {
  type Flow = (rig: Rig, kv: HostKv) => Promise<unknown>;

  async function killAfterEach(label: string, flow: Flow, resumeReadBack: (rig: Rig) => Bytes, expectFinal: (rig: Rig, root: string) => void): Promise<number> {
    let completedAt: number | undefined;
    for (let k = 1; completedAt === undefined; k += 1) {
      const rig = fresh();
      const where = `${label}: kill after mutation ${k}`;
      rig.node.killAfterMutation = k;
      let killed = false;
      try {
        await flow(rig, rig.killableHost.kv);
      } catch (error) {
        if (!(error instanceof NodeKilled)) throw error;
        killed = true;
      }
      if (!killed) {
        completedAt = k;
        break;
      }
      rig.node.killAfterMutation = undefined;
      const outcome = await resumeFromJournal(rig, keys, resumeReadBack(rig));
      expect(outcome, where).toBeDefined();
      expect(publishCalls(rig).length, where).toBeLessThanOrEqual(1);
      expect(publishedRoot(rig), where).toBe(outcome?.snapshotRoot);
      expect(rig.node.cidOf(ROOT), where).toBe(outcome?.snapshotRoot);
      expect((await readRootState(rig.host.kv, ROOT))?.rootCid, where).toBe(outcome?.snapshotRoot);
      expect((await journalOf(rig))?.phase, where).toBe("published");
      expectFinal(rig, outcome?.snapshotRoot ?? "");
    }
    return completedAt as number;
  }

  it("rewrap: every kill resumes to one publication of the new file, never a second", async () => {
    const next = variantKeySlots(oldKeySlotsOf(fresh()), "a");
    const steps = await killAfterEach(
      "rewrap",
      (rig, kv) => rewrapOnce(rig, keys, next, kv),
      () => next,
      (rig) => expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), next)).toBe(true),
    );
    // journal, file, journal, journal, pin, publish, state, journal: eight steps, then the run completes.
    expect(steps).toBe(9);
  });

  it("prune: every kill resumes to one publication without the removed file", async () => {
    const name = oldestHistory(fresh());
    const steps = await killAfterEach(
      "prune",
      (rig, kv) => pruneOnce(rig, keys, [name], kv),
      (rig) => oldKeySlotsOf(rig),
      (rig) => expect(historyNamesOf(rig)).not.toContain(name),
    );
    // journal, journal, rm, journal, pin, publish, state, journal: eight steps, then the run completes.
    expect(steps).toBe(9);
  });

  it("a kill after name/publish: the rerun finds the name at its snapshot root, publishes nothing more and finishes the record", async () => {
    const rig = fresh();
    const next = newSlotsOf(rig);
    // mutations: journal (1), file (2), journal (3), journal (4), pin (5), publish (6)
    rig.node.killAfterMutation = 6;
    await expect(rewrapOnce(rig, keys, next, rig.killableHost.kv)).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    expect(publishCalls(rig)).toHaveLength(1);
    expect((await journalOf(rig))?.phase).toBe("snapshotted");
    expect((await readRootState(rig.host.kv, ROOT))?.rootCid).not.toBe(publishedRoot(rig));
    const outcome = await resumeFromJournal(rig, keys, next);
    expect(publishCalls(rig)).toHaveLength(1);
    expect(outcome?.snapshotRoot).toBe(publishedRoot(rig));
    expect((await readRootState(rig.host.kv, ROOT))?.rootCid).toBe(publishedRoot(rig));
  });
});

describe("a lost race", () => {
  it("rewrap against a publisher that completed: the loser's keyslots.json is taken back out, so the winner can publish", async () => {
    const rig = fresh();
    const old = oldKeySlotsOf(rig);
    const winner = winnerRootOf(rig, new Map());
    rig.node.afterWrite = (path) => {
      if (path === KEYSLOTS_PATH) rig.node.published.set(OWNED, `/ipfs/${winner}`);
    };
    const error = await refusal(rewrapOnce(rig, keys, newSlotsOf(rig)));
    rig.node.afterWrite = undefined;

    expect(error.code).toBe("maintenance-lost-race");
    expect(error.message).toContain("keys discard");
    expect(error.message).toContain("keys accept-slots");
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), old)).toBe(true);
    expect(publishCalls(rig)).toEqual([]);
    expect(publishedRoot(rig)).toBe(winner);

    // The winner's device has no maintenance journal; this one shares the rig, so it is dropped the way `keys discard` does.
    await discardMaintenanceJournal(rig.host.kv, ROOT);
    rig.host.put("notes/after.md", "after the race", 9000);
    expect((await rig.publish()).published).toBe(true);
  });

  it("rewrap against another rewrap: the winner's file is put back, because it is the one the name points at", async () => {
    const rig = fresh();
    const winnerSlots = newSlotsOf(rig, "b");
    const winner = winnerRootOf(rig, new Map([["keyslots.json", winnerSlots]]));
    rig.node.afterWrite = (path) => {
      if (path === KEYSLOTS_PATH) rig.node.published.set(OWNED, `/ipfs/${winner}`);
    };
    const error = await refusal(rewrapOnce(rig, keys, newSlotsOf(rig, "a")));
    rig.node.afterWrite = undefined;
    expect(error.code).toBe("maintenance-lost-race");
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), winnerSlots)).toBe(true);
  });

  it("does not touch a keyslots.json that is no longer the one this rewrap wrote", async () => {
    const rig = fresh();
    const winner = winnerRootOf(rig, new Map());
    const someoneElses = newSlotsOf(rig, "c");
    rig.node.afterWrite = (path) => {
      if (path !== KEYSLOTS_PATH) return;
      rig.node.published.set(OWNED, `/ipfs/${winner}`);
      rig.node.files.set(KEYSLOTS_PATH, someoneElses);
    };
    await refusal(rewrapOnce(rig, keys, newSlotsOf(rig, "a")));
    rig.node.afterWrite = undefined;
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), someoneElses)).toBe(true);
  });

  it("prune against a publisher that completed: nothing is added back, nothing is published, and the refusal says so", async () => {
    const rig = fresh();
    const name = oldestHistory(rig);
    const winner = winnerRootOf(rig, new Map());
    const client = rig.node.client as unknown as { filesRm: (path: string, options?: { recursive?: boolean }) => Promise<void> };
    const original = client.filesRm;
    client.filesRm = async (path, options) => {
      await original(path, options);
      rig.node.published.set(OWNED, `/ipfs/${winner}`);
    };
    const error = await refusal(pruneOnce(rig, keys, [name]));
    expect(error.code).toBe("maintenance-lost-race");
    expect(error.message).toContain("not added back");
    expect(historyNamesOf(rig)).not.toContain(name);
    expect(publishCalls(rig)).toEqual([]);
    expect(mutatingCalls(rig).filter((call) => call.startsWith("write "))).toEqual([]);
    expect(publishedRoot(rig)).toBe(winner);
  });

  it("a name that moves after the primitive's own read but before name/publish is caught by the adapter's re-check", async () => {
    const rig = fresh();
    const winner = winnerRootOf(rig, new Map());
    const client = rig.node.client as unknown as { pinAdd: (cid: string) => Promise<void>; nameResolve: (name: string, options?: unknown) => Promise<string> };
    const resolve = client.nameResolve;
    let pinned = false;
    let moved = false;
    const pin = client.pinAdd;
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
    const error = await refusal(rewrapOnce(rig, keys, newSlotsOf(rig)));
    expect(error.code).toBe("maintenance-lost-race");
    expect(publishCalls(rig)).toEqual([]);
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), oldKeySlotsOf(rig))).toBe(true);
  });

  it("a resume finds the name moved before any work and refuses with no node write", async () => {
    const rig = fresh();
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    rig.node.published.set(OWNED, `/ipfs/${winnerRootOf(rig, new Map())}`);
    const error = await refusal(driveMaintenance(deps, journal));
    expect(error.code).toBe("maintenance-lost-race");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("a resume finds manifest.enc replaced by another publisher and refuses with no node write (the A-01 guard)", async () => {
    const rig = fresh();
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    rig.node.files.set(MANIFEST_PATH, new Uint8Array([1, 2, 3]));
    const error = await refusal(driveMaintenance(deps, journal));
    expect(error.code).toBe("maintenance-lost-race");
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it.each([2, 3])("a node file that matches neither the journal's bytes nor the old bytes is refused naming the commands, after mutation %i", async (kill) => {
    const rig = fresh();
    const next = newSlotsOf(rig);
    rig.node.killAfterMutation = kill;
    await expect(rewrapOnce(rig, keys, next, rig.killableHost.kv)).rejects.toBeInstanceOf(NodeKilled);
    rig.node.killAfterMutation = undefined;
    rig.node.files.set(KEYSLOTS_PATH, newSlotsOf(rig, "c"));
    rig.node.calls.length = 0;
    const error = await refusal(resumeFromJournal(rig, keys, next) as Promise<unknown>);
    expect(error.code).toBe("maintenance-lost-race");
    expect(error.message).toContain("keys discard");
    expect(error.message).toContain("keys accept-slots");
    expect(mutatingCalls(rig)).toEqual([]);
  });
});

describe("the guards around the primitive", () => {
  it("refuses a snapshot that fails the read-back before it is pinned or published", async () => {
    const rig = fresh();
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    rig.node.files.set(`${ROOT}/stray.txt`, new Uint8Array([1]));
    const error = await driveMaintenance(deps, journal).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadBackError);
    expect(mutatingCalls(rig).map((call) => call.split(" ")[0])).toEqual(["write"]);
    expect((await journalOf(rig))?.phase).toBe("snapshotted");
  });

  it("checks the lock before every node write: a lost lock stops the rewrap with nothing written", async () => {
    const rig = fresh();
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    const guarded = { ...deps, node: maintenanceNodeOf(rig, () => { throw lockLost(); }) };
    await expect(driveMaintenance(guarded, journal)).rejects.toMatchObject({ code: "lock-lost" });
    expect(mutatingCalls(rig)).toEqual([]);
    expect((await journalOf(rig))?.phase).toBe("journaled");
  });

  it("checks the lock before a history removal too", async () => {
    const rig = fresh();
    const { deps, journal } = await startPrune(rig, keys, [oldestHistory(rig)]);
    const guarded = { ...deps, node: maintenanceNodeOf(rig, () => { throw lockLost(); }) };
    await expect(driveMaintenance(guarded, journal)).rejects.toMatchObject({ code: "lock-lost" });
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("refuses to begin when the publication key does not exist, and creates nothing", async () => {
    const rig = fresh();
    const deps = maintenanceDeps(rig, keys, oldKeySlotsOf(rig));
    const state = await readRootState(rig.host.kv, ROOT);
    const error = await refusal(beginMaintenance(deps, { target: { mfsRoot: ROOT, key: KEY, vaultId: state?.vaultId ?? "", keyslotsSha256: state?.keyslotsSha256 ?? "" }, state, floor: undefined, key: { absent: true }, startedAt: "2026-10-03T10:00:00.000Z" }));
    expect(error.code).toBe("publication-key-missing");
    expect(rig.node.calls.filter((call) => call.startsWith("keyGen"))).toEqual([]);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("reads manifest.enc, the name, then manifest.enc again, and refuses when the second read differs (a publisher completed in the gap)", async () => {
    const rig = fresh();
    const deps = maintenanceDeps(rig, keys, oldKeySlotsOf(rig));
    let reads = 0;
    const node = {
      ...deps.node,
      readManifestFile: async () => {
        reads += 1;
        const real = await deps.node.readManifestFile();
        return reads === 1 ? real : new Uint8Array([...(real ?? []), 0]);
      },
    };
    const state = await readRootState(rig.host.kv, ROOT);
    const error = await refusal(
      beginMaintenance({ ...deps, node }, { target: { mfsRoot: ROOT, key: KEY, vaultId: state?.vaultId ?? "", keyslotsSha256: state?.keyslotsSha256 ?? "" }, state, floor: undefined, key: { absent: false }, startedAt: "2026-10-03T10:00:00.000Z" }),
    );
    expect(error.code).toBe("overlapping-publish");
    expect(reads).toBe(2);
    expect(mutatingCalls(rig)).toEqual([]);
    expect((await readMaintenanceJournal(rig.host.kv, ROOT)).kind).toBe("none");
  });

  it("refuses to begin below the sequence floor even when the record equals the node's manifest", async () => {
    const rig = fresh();
    const deps = maintenanceDeps(rig, keys, oldKeySlotsOf(rig));
    const state = await readRootState(rig.host.kv, ROOT);
    const error = await refusal(
      beginMaintenance(deps, {
        target: { mfsRoot: ROOT, key: KEY, vaultId: state?.vaultId ?? "", keyslotsSha256: state?.keyslotsSha256 ?? "" },
        state,
        floor: { sequence: (state?.sequence ?? 0) + 3, identity: "f".repeat(64), at: 1 },
        key: { absent: false },
        startedAt: "2026-10-03T10:00:00.000Z",
      }),
    );
    expect(error.code).toBe("sequence-below-floor");
    expect(mutatingCalls(rig)).toEqual([]);
  });
});

describe("withdrawMaintenanceWrite (what keys discard calls)", () => {
  it("puts the published file back when the shared tree still holds this rewrap's pending bytes", async () => {
    const rig = fresh();
    const old = oldKeySlotsOf(rig);
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    await deps.node.writeKeySlotsFile(newSlotsOf(rig));
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), old)).toBe(false);
    expect(await withdrawMaintenanceWrite(deps, journal)).toBe(true);
    expect(bytesEqual(rig.node.files.get(KEYSLOTS_PATH), old)).toBe(true);
  });

  it("leaves a file alone that is not the journal's, and reports that nothing was withdrawn", async () => {
    const rig = fresh();
    const { deps, journal } = await startRewrap(rig, keys, newSlotsOf(rig));
    expect(await withdrawMaintenanceWrite(deps, journal)).toBe(false);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("has nothing to withdraw for a prune", async () => {
    const rig = fresh();
    const { deps, journal } = await startPrune(rig, keys, [oldestHistory(rig)]);
    expect(await withdrawMaintenanceWrite(deps, journal)).toBe(false);
  });
});
