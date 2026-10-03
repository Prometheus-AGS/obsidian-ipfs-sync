import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { readJournal } from "../../src/sync/journal";
import { POOL_DEFAULT_CONCURRENCY } from "../../src/sync/pool";
import { publishVault, type PublishOptions, type PublishResult } from "../../src/sync/publish";
import { lockHeld } from "../../src/sync/publish-refusals";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

/**
 * Task 2.3 (review-5c C5-02): `PublishDeps.beforeFirstWrite` is awaited right before the run's first request that can
 * change the node, at three places: before an interrupted publish is resumed, before the publication key is created or
 * the first blob is written, and before junk in `manifests/` is removed. A hook that throws stops the run with no
 * mutating request recorded. A host that passes no hook publishes as before.
 */

const OWNED = "k51owned";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const mutating = (rig: Rig): string[] => rig.node.calls.filter((call) => MUTATING.test(call));
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

interface Hook {
  readonly beforeFirstWrite: () => Promise<void>;
  /** Mutating requests already on the node at each call of the hook. */
  readonly seen: number[];
}

/** A hook that counts its calls, notes how much had been written at each, and throws `lock-held` on call number `failAt`. */
function hook(rig: Rig, failAt?: number): Hook {
  const seen: number[] = [];
  return {
    seen,
    beforeFirstWrite: async () => {
      seen.push(mutating(rig).length);
      if (seen.length === failAt) throw lockHeld("the lock file no longer carries this run's token");
    },
  };
}

function run(rig: Rig, beforeFirstWrite: (() => Promise<void>) | undefined, overrides: Partial<PublishOptions> = {}): Promise<PublishResult> {
  return publishVault(
    { client: rig.node.client, host: rig.killableHost, bus: createSyncEventBus(), ...(beforeFirstWrite === undefined ? {} : { beforeFirstWrite }) },
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

async function initialised(owned: boolean): Promise<Rig> {
  const rig = createRig(owned ? { node: createFakeNode([{ name: KEY, id: OWNED }]) } : {});
  if (owned) rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  rig.node.calls.length = 0; // the key-slot file `init` wrote is not part of the publish under test
  return rig;
}

describe("beforeFirstWrite: where the engine awaits it", () => {
  it("is awaited at the start (before resume) and again before the first blob, each time with nothing written yet", async () => {
    const rig = await initialised(true);
    const spy = hook(rig);
    const result = await run(rig, spy.beforeFirstWrite);
    expect(result.published).toBe(true);
    expect(spy.seen).toEqual([0, 0]);
  }, 30_000);

  it("is awaited a third time, before the junk is removed, when --repair has junk to clear", async () => {
    const rig = await initialised(true);
    rig.node.files.set(`${ROOT}/manifests/x`, new Uint8Array([1]));
    const spy = hook(rig);
    const result = await run(rig, spy.beforeFirstWrite, { repair: true, confirmRepair: async () => true });
    expect(result.published).toBe(true);
    expect(spy.seen).toEqual([0, 0, 1]); // the junk removal is the only mutation before the third call: it happens after the second
    expect(rig.node.files.has(`${ROOT}/manifests/x`)).toBe(false);
  }, 30_000);

  it("a host that passes no hook publishes exactly as before", async () => {
    const withHook = await initialised(true);
    const without = await initialised(true);
    await run(withHook, hook(withHook).beforeFirstWrite);
    await run(without, undefined);
    // Blob names differ between two vaults (random keys), so compare the kinds of request, in order of kind.
    const kinds = (rig: Rig): string[] => mutating(rig).map((call) => call.split(" ")[0] ?? "").sort();
    expect(kinds(without)).toEqual(kinds(withHook));
    expect(kinds(without).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("beforeFirstWrite: a lost lock stops the run before the node is changed", () => {
  it("place 1, before resume: an interrupted publish is neither completed nor adopted, and its journal stays", async () => {
    const rig = await initialised(true);
    await run(rig, undefined);
    const published: RigSnapshot = snapshotRig(rig);
    const killed = restoreRig(published);
    killed.host.put("Daily/2026-09-30.md", "# edited\n", 5000);
    killed.node.mutations = 0;
    killed.node.killAfterMutation = 3; // blob, journal, manifest.enc
    expect(await rejection(run(killed, undefined))).toBeInstanceOf(NodeKilled);
    killed.node.killAfterMutation = undefined;
    killed.node.calls.length = 0;

    const spy = hook(killed, 1);
    const error = await rejection(run(killed, spy.beforeFirstWrite));
    expect(error).toMatchObject({ code: "lock-held" });
    expect(spy.seen).toEqual([0]);
    expect(mutating(killed)).toEqual([]);
    expect((await readJournal(killed.host.kv, ROOT)).kind).not.toBe("none");
  }, 60_000);

  it("place 2, before key creation and the first blob: no key is generated and nothing is written", async () => {
    const rig = await initialised(false);
    rig.node.calls.length = 0;
    const spy = hook(rig, 2);
    const error = await rejection(run(rig, spy.beforeFirstWrite));
    expect(error).toMatchObject({ code: "lock-held" });
    expect(spy.seen).toEqual([0, 0]);
    expect(mutating(rig)).toEqual([]);
    expect(rig.owned).toEqual([]);
  }, 30_000);

  it("place 3, before the junk removal under --repair: the junk stays and nothing is removed", async () => {
    const rig = await initialised(true);
    rig.node.files.set(`${ROOT}/manifests/x`, new Uint8Array([1]));
    rig.node.calls.length = 0;
    const spy = hook(rig, 2);
    const error = await rejection(run(rig, spy.beforeFirstWrite, { repair: true, confirmRepair: async () => true }));
    expect(error).toMatchObject({ code: "lock-held" });
    expect(spy.seen).toEqual([0, 0]);
    expect(mutating(rig)).toEqual([]);
    expect(rig.node.files.has(`${ROOT}/manifests/x`)).toBe(true);
  }, 30_000);
});
