import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import type { HostBridge } from "../../src/core/host-bridge";
import { POOL_DEFAULT_CONCURRENCY } from "../../src/sync/pool";
import { DeviceStoreError } from "../../src/sync/device-store";
import { readJournal } from "../../src/sync/journal";
import { publishVault, type PublishOptions, type PublishResult } from "../../src/sync/publish";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, decodeFloor, raiseFloor, readFloor } from "../../src/sync/sequence-floor";
import { KEY, ROOT, createRig, seedVault, type Rig } from "../helpers/publish-rig";
import { createMemoryDeviceStore, type MemoryDeviceStore } from "../helpers/memory-device-store";

/** Task 2.1: the publisher raises the sequence floor (floor first, then the state) and `--repair` reads it. */

const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const stateFile = rootFileNames(ROOT).state;

interface Ledger {
  /** Every device-store write and every state write, in order. */
  readonly order: string[];
  readonly store: MemoryDeviceStore;
  readonly host: HostBridge;
}

/** A host whose state writes are logged next to the device store's writes, so the order of the two is observable. */
function ledger(rig: Rig): Ledger {
  const order: string[] = [];
  const store = createMemoryDeviceStore();
  const original = store.set.bind(store);
  store.set = async (name, bytes) => {
    order.push(`floor:${name}`);
    await original(name, bytes);
  };
  const kv = rig.killableHost.kv;
  const host: HostBridge = {
    ...rig.killableHost,
    kv: {
      get: (key) => kv.get(key),
      list: (prefix) => kv.list(prefix),
      delete: (key) => kv.delete(key),
      set: async (key, value) => {
        if (key === stateFile) order.push("state");
        await kv.set(key, value);
      },
    },
  };
  return { order, store, host };
}

function publishWith(rig: Rig, run: Ledger, overrides: Partial<PublishOptions> = {}): Promise<PublishResult> {
  return publishVault(
    { client: rig.node.client, host: run.host, bus: createSyncEventBus(), deviceStore: run.store },
    {
      mfsRoot: ROOT,
      keyName: KEY,
      ownedKeys: rig.owned,
      recordOwnedKey: async (id) => void rig.owned.push(id),
      concurrency: POOL_DEFAULT_CONCURRENCY,
      passphrase: rig.passphrase,
      ...overrides,
    },
  );
}

async function publishedOnce(): Promise<{ readonly rig: Rig; readonly run: Ledger }> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  const run = ledger(rig);
  await publishWith(rig, run);
  return { rig, run };
}

describe("publish raises the sequence floor", () => {
  it("writes the floor before the state, with the sequence and identity of the manifest it published", async () => {
    const { rig, run } = await publishedOnce();
    expect(run.order).toEqual([`floor:${SEQUENCE_FLOOR_FILE}`, "state"]);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    const floor = await readFloor(run.store, state.vaultId);
    expect(floor).toMatchObject({ sequence: 1, identity: state.manifestIdentity });
    expect(floor?.at).toBeGreaterThan(0);

    rig.host.put("notes/second.md", "second", 3000);
    run.order.length = 0;
    await publishWith(rig, run);
    expect(run.order).toEqual([`floor:${SEQUENCE_FLOOR_FILE}`, "state"]);
    expect((await readFloor(run.store, state.vaultId))?.sequence).toBe(2);
  });

  it("does not write the floor when the publish writes no state (nothing changed)", async () => {
    const { rig, run } = await publishedOnce();
    run.order.length = 0;
    const result = await publishWith(rig, run);
    expect(result.published).toBe(false);
    expect(run.order).toEqual([]);
  });

  it("a stale write cannot lower the floor (read, merge by maximum)", async () => {
    const { rig, run } = await publishedOnce();
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    const kept = await raiseFloor(run.store, state.vaultId, { sequence: 1, identity: "b".repeat(64), at: 1 });
    expect(kept.identity).toBe(state.manifestIdentity);
  });

  it("a host with no device store publishes as before and keeps no floor", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    await expect(rig.publish()).resolves.toMatchObject({ published: true, sequence: 1 });
    expect(await readRootState(rig.host.kv, ROOT)).toBeDefined();
  });

  it("a state with complete: false does not make the publish refuse", async () => {
    const { rig, run } = await publishedOnce();
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    await writeRootState(rig.host.kv, buildRootState({ ...state, complete: false }));
    rig.host.put("notes/second.md", "second", 3000);
    await expect(publishWith(rig, run)).resolves.toMatchObject({ published: true, sequence: 2 });
    expect((await readRootState(rig.host.kv, ROOT))?.complete).toBe(true);
  });
});

describe("--repair and the sequence floor (ahead)", () => {
  /** Published twice on this device (floor at 2); the node then moves to a sequence this device has not seen. */
  async function nodeAhead(): Promise<{ readonly rig: Rig; readonly run: Ledger; readonly vaultId: string }> {
    const { rig, run } = await publishedOnce();
    rig.host.put("notes/second.md", "second", 3000);
    await publishWith(rig, run);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    // the node serves sequence 3, authored by "another device"
    const { encodeManifestFile } = await import("../../src/sync/encrypted-manifest");
    const forged = await encodeManifestFile(await rig.keys(), { ...(await rig.manifest()), sequence: 3, publishedAt: "2026-10-02T00:00:00.000Z", device: "other-111111111111" });
    rig.node.files.set(`${ROOT}/manifest.enc`, forged.file);
    rig.node.calls.length = 0;
    return { rig, run, vaultId: state.vaultId };
  }

  it("ahead with a baseline says pull first and does not suggest --repair; --repair refuses too", async () => {
    const { rig, run } = await nodeAhead();
    const refused = await rejection(publishWith(rig, run));
    expect(refused).toMatchObject({ code: "sequence-ahead" });
    expect((refused as Error).message).toContain("pull first");
    expect((refused as Error).message).not.toContain("--repair");
    const repair = await rejection(publishWith(rig, run, { repair: true, confirmRepair: async () => true }));
    expect(repair).toMatchObject({ code: "repair-refused" });
    expect((repair as Error).message).toContain("pull first");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("ahead after the state file was deleted (floor present, no state) refuses --repair and says pull first", async () => {
    const { rig, run } = await nodeAhead();
    rig.host.kvStore.delete(stateFile);
    const error = await rejection(publishWith(rig, run, { repair: true, confirmRepair: async () => true }));
    expect(error).toMatchObject({ code: "repair-refused" });
    expect((error as Error).message).toMatch(/sequence floor/);
    expect((error as Error).message).toContain("pull first");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("a state that does not decode with a floor present is refused as well", async () => {
    const { rig, run } = await nodeAhead();
    rig.host.kvStore.set(stateFile, new TextEncoder().encode("{ not json"));
    const error = await rejection(publishWith(rig, run, { repair: true, confirmRepair: async () => true }));
    expect(error).toMatchObject({ code: "repair-refused" });
    expect((error as Error).message).toContain("pull first");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("a state that does not decode and no floor still reaches the confirmation, whose warning recommends pull", async () => {
    const { rig } = await nodeAhead();
    rig.host.kvStore.set(stateFile, new TextEncoder().encode("{ not json"));
    const empty = ledger(rig); // a device store with no floor
    const warnings: string[] = [];
    const result = await publishWith(rig, empty, { repair: true, confirmRepair: async (warning) => (warnings.push(warning), true) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("run pull");
    expect(result).toMatchObject({ published: true, sequence: 4 });
    // the repair publish raised the floor to the sequence it published
    const floor = decodeFloor(empty.store.entries.get(SEQUENCE_FLOOR_FILE) ?? new Uint8Array());
    expect(Object.values(floor.floors)[0]?.sequence).toBe(4);
  });

  // Changed by review-final A-02: this test used to assert that a plain publish never read the floor. A publish now reads it on every run
  // (before it asks the node anything about the sequence), because the floor is what refuses a restart below it.
  it("a plain publish reads the floor from the device store before any sequence decision", async () => {
    const { rig, run } = await nodeAhead();
    const reads: string[] = [];
    const get = run.store.get.bind(run.store);
    run.store.get = async (name) => (reads.push(name), get(name));
    await rejection(publishWith(rig, run));
    expect(reads).toContain(SEQUENCE_FLOOR_FILE);
  });
});

describe("publish never goes below the sequence floor (review-final A-02)", () => {
  const WIPED = /^\/obsidian-vault-sync\/enc-test\/(manifest\.enc|keyslots\.json|manifests\/.*)$/;
  /** Published twice on this device: the floor and the state are at 2. */
  async function publishedTwice(): Promise<{ readonly rig: Rig; readonly run: Ledger; readonly vaultId: string }> {
    const { rig, run } = await publishedOnce();
    rig.host.put("notes/second.md", "second", 3000);
    await publishWith(rig, run);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    expect((await readFloor(run.store, state.vaultId))?.sequence).toBe(2);
    return { rig, run, vaultId: state.vaultId };
  }
  const wipeNode = (rig: Rig, files: RegExp): void => {
    for (const path of [...rig.node.files.keys()]) if (files.test(path)) rig.node.files.delete(path);
    rig.node.calls.length = 0;
  };
  const expectPullFirst = (error: unknown, floor: number): void => {
    expect(error).toMatchObject({ code: "sequence-below-floor" });
    expect((error as Error).message).toContain("pull first");
    expect((error as Error).message).toContain(`sequence ${floor}`);
  };

  it("first publish: the state file is lost, the key-slot copy and the floor remain, and the node shows no manifest.enc: refused, nothing written", async () => {
    const { rig, run } = await publishedTwice();
    rig.host.kvStore.delete(stateFile);
    wipeNode(rig, /^\/obsidian-vault-sync\/enc-test\/(manifest\.enc|manifests\/.*)$/);
    rig.host.put("notes/third.md", "third", 4000);
    expectPullFirst(await rejection(publishWith(rig, run)), 2);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(await readRootState(rig.host.kv, ROOT)).toBeUndefined();
  });

  it("resumed creation: the node also lost keyslots.json, so the vault opens as an interrupted creation: refused, nothing written", async () => {
    const { rig, run } = await publishedTwice();
    rig.host.kvStore.delete(stateFile);
    wipeNode(rig, WIPED);
    rig.host.put("notes/third.md", "third", 4000);
    expectPullFirst(await rejection(publishWith(rig, run)), 2);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("rebuild: --repair with a state below the floor and a node that lost manifest.enc is refused, even with a yes", async () => {
    const { rig, run, vaultId } = await publishedTwice();
    await raiseFloor(run.store, vaultId, { sequence: 9, identity: "c".repeat(64), at: 5 });
    wipeNode(rig, /^\/obsidian-vault-sync\/enc-test\/manifest\.enc$/);
    rig.host.put("notes/third.md", "third", 4000);
    const error = await rejection(publishWith(rig, run, { repair: true, confirmRepair: async () => true }));
    expectPullFirst(error, 9);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("a pull that raised the floor and died before its state was written leaves the node in sync with an older state: publish says pull first", async () => {
    const { rig, run, vaultId } = await publishedTwice();
    await raiseFloor(run.store, vaultId, { sequence: 3, identity: "d".repeat(64), at: 5 });
    rig.host.put("notes/third.md", "third", 4000);
    rig.node.calls.length = 0;
    expectPullFirst(await rejection(publishWith(rig, run)), 3);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("a state at the floor publishes as before, and so does a device whose store holds no floor for the vault", async () => {
    const { rig, run } = await publishedTwice();
    rig.host.put("notes/third.md", "third", 4000);
    await expect(publishWith(rig, run)).resolves.toMatchObject({ published: true, sequence: 3 });
    const noFloor = ledger(rig);
    rig.host.put("notes/fourth.md", "fourth", 5000);
    await expect(publishWith(rig, noFloor)).resolves.toMatchObject({ published: true, sequence: 4 });
  });

  it("a damaged floor file stops the publish before it writes anything", async () => {
    const { rig, run } = await publishedTwice();
    run.store.entries.set(SEQUENCE_FLOOR_FILE, new TextEncoder().encode("{ not json"));
    rig.host.put("notes/third.md", "third", 4000);
    rig.node.calls.length = 0;
    await expect(publishWith(rig, run)).rejects.toThrow(/sequence floor file is damaged/);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});

describe("fork text", () => {
  it("names pull --resolve-fork and not abandon or --repair", async () => {
    const { rig, run } = await publishedOnce();
    const { encodeManifestFile } = await import("../../src/sync/encrypted-manifest");
    const forked = await encodeManifestFile(await rig.keys(), { ...(await rig.manifest()), rootCID: `b${"a".repeat(58)}` });
    rig.node.files.set(`${ROOT}/manifest.enc`, forked.file);
    const error = await rejection(publishWith(rig, run));
    expect(error).toMatchObject({ code: "sequence-fork" });
    expect((error as Error).message).toContain("pull --resolve-fork");
    expect((error as Error).message).not.toMatch(/abandon|--repair/i);
  });
});

describe("the floor raise fails after the name was published (review-final N-04)", () => {
  /** Published once; the next publish finds a device store that cannot take the floor write (a lock wait that timed out, a full disk). */
  async function failingRaise(): Promise<{ readonly rig: Rig; readonly run: Ledger; readonly error: unknown }> {
    const { rig, run } = await publishedOnce();
    rig.host.put("notes/second.md", "second", 3000);
    const set = run.store.set.bind(run.store);
    run.store.set = async (name, bytes) => {
      if (name === SEQUENCE_FLOOR_FILE) throw new DeviceStoreError("the device store is locked by another ipfs-sync process (/state/ipfs-sync/.store.lock) that did not finish in 10 s. If no ipfs-sync process is running, remove that lock file and run again");
      await set(name, bytes);
    };
    const error = await rejection(publishWith(rig, run));
    run.store.set = set;
    return { rig, run, error };
  }

  it("says the publication happened and that the next run completes it, not that nothing was written", async () => {
    const { rig, error } = await failingRaise();
    expect(error).toMatchObject({ code: "floor-not-recorded" });
    const message = (error as Error).message;
    expect(message).toMatch(/was published/);
    expect(message).toMatch(/publish again/);
    expect(message).not.toMatch(/nothing was written/i);
    expect(message).toContain(".store.lock");
    // The name was published before the raise, and the raise was not moved ahead of it.
    expect(rig.node.calls.filter((call) => call.startsWith("publish "))).toHaveLength(2);
  });

  it("leaves the state unwritten and the journal in place, and the next run finishes the same publication", async () => {
    const { rig, run } = await failingRaise();
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.sequence).toBe(1);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    await publishWith(rig, run);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("none");
    const floor = await readFloor(run.store, (await readRootState(rig.host.kv, ROOT))?.vaultId ?? "");
    expect(floor?.sequence).toBe(2);
  });
});
