import { afterEach, describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { KuboHttpError, NAME_RESOLVE_ERROR_TEXTS } from "../../src/kubo";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { POOL_DEFAULT_CONCURRENCY } from "../../src/sync/pool";
import { publishVault, type PublishResult } from "../../src/sync/publish";
import { readRootState } from "../../src/sync/root-state";
import { readFloor } from "../../src/sync/sequence-floor";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { createMemoryDeviceStore, type MemoryDeviceStore } from "../helpers/memory-device-store";
import { KEY, ROOT, createRig, seedVault, type Rig } from "../helpers/publish-rig";

/**
 * Task 2.2 through the real publish path over the recording fake node: the name is read before the first write and again
 * right before `name/publish`, with the bounded timeout, and only when the key was not created by this run.
 */

const OWNED = "k51owned";
const OTHER_PATH = "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const RESOLVE = /^nameResolve \/ipns\/k51owned dht-timeout=10s$/;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

function newRig(options: { readonly key: boolean }): Rig {
  const rig = createRig({ node: createFakeNode(options.key ? [{ name: KEY, id: OWNED }] : []) });
  if (options.key) rig.owned.push(OWNED);
  seedVault(rig.host);
  return rig;
}

async function publishedOnce(): Promise<Rig> {
  const rig = newRig({ key: true });
  await rig.init();
  await rig.publish();
  rig.host.put("notes/second.md", "second", 3000);
  rig.node.calls.length = 0;
  return rig;
}

const publishedPath = (rig: Rig): string => rig.node.published.get(OWNED) ?? "";

function publishWith(rig: Rig, store: MemoryDeviceStore): Promise<PublishResult> {
  return publishVault(
    { client: rig.node.client, host: rig.killableHost, bus: createSyncEventBus(), deviceStore: store },
    {
      mfsRoot: ROOT,
      keyName: KEY,
      ownedKeys: rig.owned,
      recordOwnedKey: async (id) => void rig.owned.push(id),
      concurrency: POOL_DEFAULT_CONCURRENCY,
      passphrase: rig.passphrase,
    },
  );
}

describe("the name re-check in a publish", () => {
  it("reads the name before the first write and right before name/publish, as reads that carry the timeout", async () => {
    const rig = await publishedOnce();
    await rig.publish();
    const { calls } = rig.node;
    const resolves = calls.flatMap((line, index) => (RESOLVE.test(line) ? [index] : []));
    expect(resolves).toHaveLength(2);
    const firstWrite = calls.findIndex((line) => MUTATING.test(line));
    const publish = calls.findIndex((line) => line.startsWith("publish "));
    expect(resolves[0]).toBeLessThan(firstWrite);
    expect(resolves[1]).toBeGreaterThan(firstWrite);
    // the second read is the last request before the publication, after the key-list check
    expect(calls.slice(resolves[1] ?? 0, publish + 1)).toEqual([calls[resolves[1] ?? 0], expect.stringMatching(/^publish /)]);
    expect(calls[(resolves[1] ?? 0) - 1]).toBe("keyList");
    expect(calls.filter((line) => line.startsWith("nameResolve ")).every((line) => !MUTATING.test(line))).toBe(true);
  });

  it("a key created by this run is resolved zero times", async () => {
    const rig = newRig({ key: false });
    await rig.init();
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, keyCreated: true, sequence: 1 });
    expect(rig.node.calls.filter((line) => line.startsWith("nameResolve"))).toEqual([]);
  });

  it("not-found at both points proceeds (an owned key that was never published)", async () => {
    const rig = newRig({ key: true });
    await rig.init();
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, sequence: 1 });
    expect(rig.node.calls.filter((line) => RESOLVE.test(line))).toHaveLength(2);
  });

  it("a nothing-to-do run reads nothing", async () => {
    const rig = await publishedOnce();
    await rig.publish();
    rig.node.calls.length = 0;
    const result = await rig.publish();
    expect(result.published).toBe(false);
    expect(rig.node.calls.filter((line) => line.startsWith("nameResolve"))).toEqual([]);
  });

  it("a second publisher moves the name between the first write and name/publish: the first refuses and publishes nothing", async () => {
    const rig = await publishedOnce();
    const before = publishedPath(rig);
    rig.node.afterWrite = (path) => {
      if (path === `${ROOT}/manifest.enc`) {
        rig.node.published.set(OWNED, OTHER_PATH);
        rig.node.afterWrite = undefined;
      }
    };
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "overlapping-publish" });
    expect((error as Error).message).toContain("pull first");
    expect(rig.node.calls.some((line) => line.startsWith("publish "))).toBe(false);
    expect(publishedPath(rig)).toBe(OTHER_PATH);
    // the tree stays as written and the journal stays; the state is untouched
    expect(await readJournal(rig.host.kv, ROOT)).toMatchObject({ kind: "ok", journal: { sequence: 2, startRoot: before.replace("/ipfs/", "") } });
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
  });

  it("A-01: a second publisher completes after this publish read manifest.enc and before it read the name: refused before any write, and the winner's manifest.enc is untouched", async () => {
    const rig = await publishedOnce();
    const keys = await rig.keys();
    const winner = (await encodeManifestFile(keys, { ...(await rig.manifest()), sequence: 2, device: "device-b-111111111111", publishedAt: "2026-10-02T00:00:00.000Z" })).file;
    let fired = false;
    // The name start is the first name read of the run; the winner's whole publication lands just before it, so the start already shows the winner's root.
    rig.node.resolveFault = () => {
      if (!fired) {
        fired = true;
        rig.node.files.set(`${ROOT}/manifest.enc`, winner);
        rig.node.published.set(OWNED, OTHER_PATH);
      }
      return undefined;
    };
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "overlapping-publish" });
    expect((error as Error).message).toContain("pull first");
    expect(rig.node.calls.filter((line) => MUTATING.test(line))).toEqual([]);
    expect(rig.node.files.get(`${ROOT}/manifest.enc`)).toBe(winner);
    expect(publishedPath(rig)).toBe(OTHER_PATH);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
  });

  it("A-01: the same winner found only at the commit (it lands after the transfer began) is refused before manifest.enc is written", async () => {
    const rig = await publishedOnce();
    const keys = await rig.keys();
    const winner = (await encodeManifestFile(keys, { ...(await rig.manifest()), sequence: 2, device: "device-b-111111111111", publishedAt: "2026-10-02T00:00:00.000Z" })).file;
    let fired = false;
    rig.node.afterWrite = (path) => {
      if (!fired && path.startsWith(`${ROOT}/current/`)) {
        fired = true;
        rig.node.files.set(`${ROOT}/manifest.enc`, winner);
      }
    };
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "overlapping-publish" });
    expect(rig.node.files.get(`${ROOT}/manifest.enc`)).toBe(winner);
    expect(rig.node.calls.some((line) => line.startsWith("write ") && line.endsWith("/manifest.enc"))).toBe(false);
    expect(rig.node.calls.some((line) => line.startsWith("publish "))).toBe(false);
  });

  it("its rerun does not adopt or publish while the name is elsewhere, and finishes through the journal once the name equals the start root again", async () => {
    const rig = await publishedOnce();
    const before = publishedPath(rig);
    rig.node.afterWrite = (path) => {
      if (path === `${ROOT}/manifest.enc`) {
        rig.node.published.set(OWNED, OTHER_PATH);
        rig.node.afterWrite = undefined;
      }
    };
    await rejection(rig.publish());
    rig.node.calls.length = 0;

    const again = await rejection(rig.publish());
    expect(again).toMatchObject({ code: "overlapping-publish" });
    expect(rig.node.calls.filter((line) => MUTATING.test(line))).toEqual([]);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");

    // the name is back where the interrupted publish started: the journal is finished
    rig.node.published.set(OWNED, before);
    await rig.publish();
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.sequence).toBe(2);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("none");
    expect(publishedPath(rig)).toBe(`/ipfs/${state?.rootCid}`);
  });

  it("a text that is not in the table is failed: the publish refuses at the start and writes nothing", async () => {
    const rig = await publishedOnce();
    rig.node.resolveFault = () => new KuboHttpError("rpc", "https://node.test", 500, "some other error", "some other error");
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "name-routing-failed" });
    expect((error as Error).message).toContain("name could not be read");
    expect(rig.node.calls.filter((line) => MUTATING.test(line))).toEqual([]);
  });

  it("a failure at the second reading leaves the tree as written, publishes nothing and keeps the journal", async () => {
    const rig = await publishedOnce();
    let reads = 0;
    rig.node.resolveFault = () => {
      reads += 1;
      return reads === 2 ? new KuboHttpError("rpc", "https://node.test", 500, "some other error", "some other error") : undefined;
    };
    await expect(rig.publish()).rejects.toMatchObject({ code: "name-routing-failed" });
    expect(rig.node.calls.some((line) => line.startsWith("publish "))).toBe(false);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
  });
});

/**
 * The routing-timeout rule needs a node text that is classified as a timeout, and none is recorded yet (see
 * `NAME_RESOLVE_ERROR_TEXTS`). These tests register a SYNTHETIC marker for the length of one test to prove the wiring from
 * the classifier through the port to the rule; the marker is not a kubo text and is removed afterwards.
 */
describe("a routing timeout (wiring, with a synthetic marker text)", () => {
  const MARKER = "SYNTHETIC-TEST-ONLY-TIMEOUT";
  const timeouts = NAME_RESOLVE_ERROR_TEXTS.timeout as string[];
  afterEach(() => {
    const at = timeouts.indexOf(MARKER);
    if (at >= 0) timeouts.splice(at, 1);
  });
  const timeoutFault = () => new KuboHttpError("rpc", "https://node.test", 500, MARKER, MARKER);

  it("on a vault that has a manifest on the node it refuses and names routing", async () => {
    timeouts.push(MARKER);
    const rig = await publishedOnce();
    rig.node.resolveFault = timeoutFault;
    await expect(rig.publish()).rejects.toMatchObject({ code: "name-routing-failed" });
    expect(rig.node.calls.filter((line) => MUTATING.test(line))).toEqual([]);
  });

  it("on the first publish of a vault (no manifest on the node, no state) it counts as not found and the publish goes on", async () => {
    timeouts.push(MARKER);
    const rig = newRig({ key: true });
    await rig.init();
    rig.node.resolveFault = timeoutFault;
    await expect(rig.publish()).resolves.toMatchObject({ published: true, sequence: 1 });
    expect(rig.node.calls.filter((line) => RESOLVE.test(line))).toHaveLength(2);
  });

  it("without the marker in the table the same fault is an unrecognised text and refuses even on the first publish", async () => {
    const rig = newRig({ key: true });
    await rig.init();
    rig.node.resolveFault = timeoutFault;
    await expect(rig.publish()).rejects.toMatchObject({ code: "name-routing-failed" });
    expect(rig.node.calls.filter((line) => MUTATING.test(line))).toEqual([]);
  });
});

describe("a resumed publish raises the sequence floor (end to end)", () => {
  it("killed right after name/publish and before the state, the rerun finishes the journal and the floor reaches the resumed sequence", async () => {
    const rig = await publishedOnce();
    const store = createMemoryDeviceStore();
    // sequence 1 published without a store; the floor starts empty
    const state1 = await readRootState(rig.host.kv, ROOT);
    if (state1 === undefined) throw new Error("state expected");
    expect(await readFloor(store, state1.vaultId)).toBeUndefined();

    // edit + new file: 2 blob writes, journal, manifest.enc, history, pin, publish (8th mutation), state, journal removal
    rig.host.put("Daily/2026-09-30.md", "# Notes\nedited after the first publish.\n", 4000);
    rig.node.killAfterMutation = rig.node.mutations + 7;
    const killed = await rejection(publishWith(rig, store));
    expect(killed).toBeInstanceOf(NodeKilled);
    expect(rig.node.calls.some((line) => line.startsWith("publish "))).toBe(true);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
    expect(await readFloor(store, state1.vaultId)).toBeUndefined();
    const publishedByTheKilledRun = publishedPath(rig);

    rig.node.killAfterMutation = undefined;
    await publishWith(rig, store);
    const state2 = await readRootState(rig.host.kv, ROOT);
    expect(state2).toMatchObject({ sequence: 2 });
    expect(await readFloor(store, state1.vaultId)).toMatchObject({ sequence: 2, identity: state2?.highestIdentity });
    // the resume repeated the publication of the same root (idempotent) and did not move the name elsewhere
    expect(publishedPath(rig)).toBe(publishedByTheKilledRun);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("none");
  });
});
