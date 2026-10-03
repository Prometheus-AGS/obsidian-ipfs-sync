// mvp-07a task 4.6a: the sequence record and the verdicts as the pull applies them (design decisions 4 and 5, specs
// rollback-detection and encrypted-pull): the effective record of the directory's state and the device's floor, refusals that
// write nothing, restore and fork without lowering the record, and what counts as an unfinished publish.
import { beforeEach, describe, expect, it, vi } from "vitest";

const kdf = vi.hoisted(() => ({ derivations: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return { ...original, argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => (kdf.derivations++, original.argon2idAsync(...args)) };
});

import { stateRecordOf } from "../../src/sync/encrypted-pull";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, decodeRootState, encodeRootState, type RootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, raiseFloor, readFloor } from "../../src/sync/sequence-floor";
import { createMemoryHost } from "../helpers/memory-host";
import { ROOT, type Rig } from "../helpers/publish-rig";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import {
  currentRoot,
  expectOnlyReads,
  forgeManifest,
  newPuller,
  publishAgain,
  publishedOnce,
  resetNodeTrace,
  runPull,
  stopOf,
  verifiedOf,
} from "../helpers/encrypted-pull-rig";

const stateFile = rootFileNames(ROOT).state;
const IDENTITY_A = "a".repeat(64);
const IDENTITY_B = "b".repeat(64);

interface Published {
  readonly rig: Rig;
  readonly root1: string;
  readonly root2: string;
}

/** Device A publishes sequence 1, then sequence 2. The roots of both stay readable on the node. */
async function twoSequences(): Promise<Published> {
  const rig = await publishedOnce();
  const root1 = currentRoot(rig.node);
  const root2 = await publishAgain(rig);
  kdf.derivations = 0;
  return { rig, root1, root2 };
}

function stateOf(rig: Rig): RootState {
  const bytes = rig.host.kvStore.get(stateFile);
  if (bytes === undefined) throw new Error("device A has no state");
  return decodeRootState(bytes);
}

beforeEach(() => {
  kdf.derivations = 0;
});

describe("a lower sequence", () => {
  it("served by name is refused as a stale or hostile node, never with the rollback flag in the text, and writes nothing", async () => {
    const { rig, root1 } = await twoSequences();
    const b = newPuller();
    verifiedOf(await runPull(rig, b)); // first pull of sequence 2: floor 2
    const writesBefore = { host: [...b.host.mutations], store: [...b.store.writes] };
    rig.node.published.set(rig.node.keys[0]?.id ?? "", `/ipfs/${root1}`);
    resetNodeTrace(rig.node);

    const stop = stopOf(await runPull(rig, newPuller(b.host, b.store)));
    expect(stop.reason).toBe("older");
    expect(stop.message).toContain("sequence 1");
    expect(stop.message).toContain("sequence 2");
    expect(stop.message).toMatch(/older state or may be hostile/);
    expect(stop.message).not.toMatch(/allow-rollback/);
    expect(b.host.mutations).toEqual(writesBefore.host);
    expect(b.store.writes).toEqual(writesBefore.store);
    expectOnlyReads(rig.node);
  });

  it("is refused in a fresh directory too, by the floor alone, with no key-slot copy stored (abandon then pull older)", async () => {
    const { rig, root1 } = await twoSequences();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    rig.node.published.set(rig.node.keys[0]?.id ?? "", `/ipfs/${root1}`);
    const fresh = newPuller(createMemoryHost(), b.store);
    const stop = stopOf(await runPull(rig, fresh));
    expect(stop.reason).toBe("older");
    expect(fresh.host.mutations).toEqual([]);
    expect(fresh.host.kvStore.size).toBe(0);
    expect(fresh.staged).toEqual([]);
  });

  it("an explicit older root is refused with a message that names the flag; with the flag it is a restore and the record is not lowered", async () => {
    const { rig, root1 } = await twoSequences();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    const floorBefore = b.store.entries.get(SEQUENCE_FLOOR_FILE);
    const dir = newPuller(createMemoryHost(), b.store);

    const refused = stopOf(await runPull(rig, dir, { options: { target: { kind: "root-cid", cid: root1 } } }));
    expect(refused.reason).toBe("older");
    expect(refused.message).toContain("--allow-rollback");
    expect(dir.host.mutations).toEqual([]);

    const restored = verifiedOf(await runPull(rig, dir, { options: { target: { kind: "root-cid", cid: root1 }, flags: { allowRollback: true } } }));
    expect(restored.verdict).toEqual({ kind: "restore", recordedSequence: 2, candidateSequence: 1 });
    expect(restored.firstPullConfirmed).toBe(false); // a record exists (the floor), so this is not a first pull
    expect(restored.floorWritten).toBe(false);
    expect(b.store.entries.get(SEQUENCE_FLOOR_FILE)).toEqual(floorBefore);
    const floor = await readFloor(b.store, restored.manifest.vaultId);
    expect(floor?.sequence).toBe(2);
  });

  it("a restore into a directory whose state is ahead of an empty floor heals the floor to the state's record, never to the restored sequence", async () => {
    const { rig, root1 } = await twoSequences();
    const state = stateOf(rig);
    expect(state.highestSequence).toBe(2);
    const store = createMemoryDeviceStore();
    const a = newPuller(rig.host, store);
    const restored = verifiedOf(await runPull(rig, a, { options: { target: { kind: "root-cid", cid: root1 }, flags: { allowRollback: true } } }));
    expect(restored.verdict.kind).toBe("restore");
    expect(restored.floorWritten).toBe(true);
    const floor = await readFloor(store, state.vaultId);
    expect(floor).toMatchObject({ sequence: 2, identity: state.highestIdentity });
    expect(restored.state).toEqual(state);
  });
});

describe("equal and higher sequences", () => {
  it("the same manifest in another directory needs no confirmation and does not rewrite the floor", async () => {
    const { rig } = await twoSequences();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    let asked = 0;
    const second = newPuller(createMemoryHost(), b.store);
    const verified = verifiedOf(await runPull(rig, second, { options: { acceptFirstPull: false }, deps: { confirmFirstPull: async () => (asked++, true) } }));
    expect(verified.verdict.kind).toBe("same");
    expect(asked).toBe(0);
    expect(verified.firstPullConfirmed).toBe(false);
    expect(verified.floorWritten).toBe(false);
    expect(b.store.writes).toEqual([SEQUENCE_FLOOR_FILE]);
    expect(verified.keySlotsStored).toBe(true); // a new directory still gets the copy
  });

  it("a higher sequence raises the floor", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const first = verifiedOf(await runPull(rig, b));
    expect(first.manifest.sequence).toBe(1);
    await publishAgain(rig);
    const second = verifiedOf(await runPull(rig, newPuller(b.host, b.store)));
    expect(second.verdict).toEqual({ kind: "newer", from: 1, to: 2 });
    expect(second.floorWritten).toBe(true);
    expect((await readFloor(b.store, second.manifest.vaultId))?.sequence).toBe(2);
    expect(b.store.writes).toEqual([SEQUENCE_FLOOR_FILE, SEQUENCE_FLOOR_FILE]);
  });
});

describe("forks", () => {
  it("equal sequence with a different identity is a fork: refused by name (naming --resolve-fork), refused for an explicit target even with the rollback flag", async () => {
    const { rig } = await twoSequences();
    const b = newPuller();
    const genuine = verifiedOf(await runPull(rig, b));
    const writes = [...b.store.writes];
    await forgeManifest(rig, ["Daily/2026-09-30.md"], { sequence: 2, publishedAt: "2026-10-01T09:00:00.000Z", device: "other-device" });

    const byName = stopOf(await runPull(rig, newPuller(b.host, b.store)));
    expect(byName.reason).toBe("fork");
    expect(byName.message).toContain("--resolve-fork");

    const explicit = stopOf(
      await runPull(rig, newPuller(b.host, b.store), { options: { target: { kind: "root-cid", cid: currentRoot(rig.node) }, flags: { allowRollback: true } } }),
    );
    expect(explicit.reason).toBe("fork");
    expect(explicit.message).not.toContain("--resolve-fork");
    expect(b.store.writes).toEqual(writes);

    // With --resolve-fork on a name target the verdict lets the pull go on; the floor identity is rewritten only after the fetch (task 4.7).
    const resolving = verifiedOf(await runPull(rig, newPuller(b.host, b.store), { options: { flags: { resolveFork: true } } }));
    expect(resolving.verdict).toEqual({ kind: "fork-resolution", sequence: 2 });
    expect(resolving.floorWritten).toBe(false);
    expect(b.store.writes).toEqual(writes);
    expect(resolving.identity).not.toBe(genuine.identity);
  });

  it("a state and a floor at one sequence with different identities make every candidate at that sequence a fork", async () => {
    const { rig } = await twoSequences();
    const state = stateOf(rig);
    const store = createMemoryDeviceStore();
    await raiseFloor(store, state.vaultId, { sequence: 2, identity: IDENTITY_B, at: 1 });
    expect(state.highestIdentity).not.toBe(IDENTITY_B);
    const stop = stopOf(await runPull(rig, newPuller(rig.host, store)));
    expect(stop.reason).toBe("fork");
  });
});

describe("a vault other than the directory's", () => {
  it("is refused before any derivation when the directory's state records another vault", async () => {
    const mine = await twoSequences();
    const other = await publishedOnce();
    kdf.derivations = 0;
    const host = createMemoryHost();
    host.kvStore.set(stateFile, encodeRootState(stateOf(mine.rig)));
    const stop = stopOf(await runPull(other, newPuller(host)));
    expect(stop.reason).toBe("other-vault");
    expect(kdf.derivations).toBe(0);
    expect(host.mutations).toEqual([]);
  });

  it("a floor for another vault says nothing about this one: it is a first pull, not a refusal", async () => {
    const mine = await publishedOnce();
    const store = createMemoryDeviceStore();
    verifiedOf(await runPull(mine, newPuller(createMemoryHost(), store)));
    const other = await publishedOnce();
    const verified = verifiedOf(await runPull(other, newPuller(createMemoryHost(), store)));
    expect(verified.verdict.kind).toBe("first-pull");
    expect(await readFloor(store, verified.manifest.vaultId)).toMatchObject({ sequence: 1 });
    expect(await readFloor(store, (await mine.manifest()).vaultId)).toMatchObject({ sequence: 1 });
  });
});

describe("an unfinished publish is told apart from a rollback", () => {
  async function pullingDevicesOwnDirectory(state: RootState, floor: number | undefined, rig: Rig, target: "name" | "root-cid", root1: string) {
    rig.host.kvStore.set(stateFile, encodeRootState(state));
    const store = createMemoryDeviceStore();
    if (floor !== undefined) await raiseFloor(store, state.vaultId, { sequence: floor, identity: IDENTITY_A, at: 1 });
    rig.node.published.set(rig.node.keys[0]?.id ?? "", `/ipfs/${root1}`);
    return runPull(rig, newPuller(rig.host, store), target === "name" ? {} : { options: { target: { kind: "root-cid", cid: root1 } } });
  }

  it("a state above the floor whose root is not the one the name serves is a rollback, as is a format 2 upgrade with no floor", async () => {
    const { rig, root1, root2 } = await twoSequences();
    const state = stateOf(rig);
    expect(state.rootCid).toBe(root2);
    const withFloor = stopOf(await pullingDevicesOwnDirectory(state, 1, rig, "name", root1));
    expect(withFloor.reason).toBe("older");
    expect(withFloor.message).toMatch(/older state or may be hostile/);
    const noFloor = stopOf(await pullingDevicesOwnDirectory(state, undefined, rig, "name", root1));
    expect(noFloor.reason).toBe("older");
  });

  it("an adopted state (above the floor, still on the root the name serves) says an unfinished publish is pending; so does a null root", async () => {
    const { rig, root1 } = await twoSequences();
    const state = stateOf(rig);
    for (const rootCid of [root1, null]) {
      const adopted = buildRootState({ ...state, rootCid });
      const stop = stopOf(await pullingDevicesOwnDirectory(adopted, 1, rig, "name", root1));
      expect(stop.reason).toBe("unfinished-publish");
      expect(stop.message).toBe("an unfinished publish of sequence 2 is pending; run publish");
    }
  });

  it("a state that the floor already confirms is never pending", async () => {
    const { rig, root1 } = await twoSequences();
    const adopted = buildRootState({ ...stateOf(rig), rootCid: root1 });
    const stop = stopOf(await pullingDevicesOwnDirectory(adopted, 2, rig, "name", root1));
    expect(stop.reason).toBe("older");
  });

  it("an explicit target never uses the unfinished-publish text", async () => {
    const { rig, root1 } = await twoSequences();
    const adopted = buildRootState({ ...stateOf(rig), rootCid: root1 });
    const stop = stopOf(await pullingDevicesOwnDirectory(adopted, 1, rig, "root-cid", root1));
    expect(stop.reason).toBe("older");
    expect(stop.message).toContain("--allow-rollback");
  });

  it("stateRecordOf: pending needs the state above the floor and the same root (or none recorded)", () => {
    const base = { highestSequence: 5, highestIdentity: IDENTITY_A, vaultId: "1".repeat(32), rootCid: "bafyroot0000000000" } as RootState;
    expect(stateRecordOf(undefined, undefined, "bafyroot0000000000")).toBeUndefined();
    expect(stateRecordOf(base, { sequence: 4, identity: IDENTITY_A, at: 1 }, "bafyroot0000000000")?.pendingPublish).toBe(true);
    expect(stateRecordOf(base, { sequence: 5, identity: IDENTITY_A, at: 1 }, "bafyroot0000000000")?.pendingPublish).toBe(false);
    expect(stateRecordOf(base, undefined, "bafyother000000000")?.pendingPublish).toBe(false);
    expect(stateRecordOf(base, undefined, undefined)?.pendingPublish).toBe(false);
    expect(stateRecordOf({ ...base, rootCid: null } as RootState, undefined, "bafyother000000000")?.pendingPublish).toBe(true);
    expect(stateRecordOf(base, undefined, "bafyroot0000000000")).toEqual({ vaultId: "1".repeat(32), sequence: 5, identity: IDENTITY_A, pendingPublish: true });
  });
});

describe("what a refusal leaves behind", () => {
  it("the record of a refused verdict is unchanged and nothing was stored", async () => {
    const { rig } = await twoSequences();
    const store = createMemoryDeviceStore();
    const state = stateOf(rig);
    await raiseFloor(store, state.vaultId, { sequence: 9, identity: IDENTITY_B, at: 1 });
    const before = store.entries.get(SEQUENCE_FLOOR_FILE);
    const fresh = newPuller(createMemoryHost(), store);
    const stop = stopOf(await runPull(rig, fresh));
    expect(stop.reason).toBe("older");
    expect(store.entries.get(SEQUENCE_FLOOR_FILE)).toBe(before);
    expect(store.writes).toEqual([SEQUENCE_FLOOR_FILE]); // only the setup write above
    expect(fresh.host.mutations).toEqual([]);
    expect(fresh.host.kvStore.size).toBe(0);
    expect(fresh.staged).toEqual([]);
    expect(manifestIdentity(await rig.manifest())).toBe(state.highestIdentity);
  });
});
