// mvp-07a task 6.1: fork by two publishes then `--resolve-fork`; `--repair` for a node that is ahead; lock contention between pull and
// publish; the token hook at the three places a publish can first write. Real `publishVault`, decrypting pull, state, floor and locks.
import { describe, expect, it } from "vitest";
import { acquirePublishLock, decodeLock, encodeLock, type LockContext } from "../../src/sync/publish-lock";
import { rootFileNames } from "../../src/sync/root-files";
import { readFloor } from "../../src/sync/sequence-floor";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { expectOnlyReads, resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import { DAILY, PLAN, blobReads, createDevices, deviceOf, editAndPublish, mutatingCalls, syncedTexts, type Device, type Devices } from "../helpers/integration-devices";
import { ROOT, restoreRig, snapshotRig, type Rig } from "../helpers/publish-rig";
import { pulledOf } from "../helpers/pull-stage-rig";
import { dyingAfterJournal } from "../helpers/safety-scenarios";

const A_DAILY = "A wrote this daily note.\n";
const B_DAILY = "B wrote this daily note.\n";
const A_PLAN = "A rewrote the quarterly plan.\n";
const ORIGINAL_PLAN = "The zebra-quokka-unicorn merger closes in the third quarter.\n";

interface Fork extends Devices {
  /** The second node: device B's publishes land here, device A's land on the first. */
  readonly rigB: Rig;
  /** Each device as a publisher to the OTHER node. */
  readonly aOnNodeB: Device;
  readonly bOnNodeB: Device;
  readonly identityX: string;
  readonly identityY: string;
}

/** Both devices hold sequence 1; each publishes a sequence 2 to its own copy of the node (the later `name/publish` of a real race). */
async function fork(aEdits: Record<string, string>, bEdits: Record<string, string>): Promise<Fork> {
  const devices = await createDevices();
  const { rig, a, b } = devices;
  pulledOf(await b.pull());
  b.allowPublish();
  const rigB = restoreRig(snapshotRig(rig));
  servedRoot(rigB.node);
  const bOnNodeB = deviceOf(rigB, b.host, "device-b", b.host, b.puller);
  const aOnNodeB = deviceOf(rigB, a.host, "device-a", a.host, a.puller);
  expect((await editAndPublish(rig, a, aEdits)).sequence).toBe(2);
  expect((await editAndPublish(rigB, bOnNodeB, bEdits)).sequence).toBe(2);
  const identityX = manifestIdentity(await rig.manifest());
  const identityY = manifestIdentity(await rigB.manifest());
  expect(identityX).not.toBe(identityY);
  return { ...devices, rigB, aOnNodeB, bOnNodeB, identityX, identityY };
}

describe("fork by two publishes, then --resolve-fork", () => {
  it("a plain pull refuses the fork and names the flag; with it the node's text takes the path, this device's text survives in the dated copy, and nothing is written to the node", async () => {
    const { a, rigB } = await fork({ [DAILY]: A_DAILY, [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    const before = a.texts();

    const refused = await a.pull({}, rigB);
    expect(refused.kind).toBe("stopped");
    if (refused.kind === "stopped") {
      expect(refused.stop.reason).toBe("fork");
      expect(refused.stop.message).toContain("--resolve-fork");
    }
    expect(a.texts()).toEqual(before);

    resetNodeTrace(rigB.node);
    const { verified, result } = pulledOf(await a.pull({ options: { flags: { resolveFork: true } } }, rigB));

    expect(verified.verdict.kind).toBe("fork-resolution");
    expect(result.forkResolution).toEqual({ ancestorUsed: true, note: undefined });
    expect(result.settlement.conflicts.map((conflict) => conflict.path)).toEqual([DAILY]);
    const copy = result.settlement.conflicts[0]?.conflictPath ?? "";
    expect(a.texts()[DAILY]).toBe(B_DAILY);
    expect(a.texts()[copy]).toBe(A_DAILY);
    // Edited only here: it stays, and is published next.
    expect(result.settlement.locallyModified).toEqual([PLAN]);
    expect(a.texts()[PLAN]).toBe(A_PLAN);
    expectOnlyReads(rigB.node);
  });

  it("the record and the floor take the node manifest's identity, previousIdentity is null, and the next publish is sequence 3 with this device's edit and copy", async () => {
    const { a, b, rigB, aOnNodeB, identityX, identityY } = await fork({ [DAILY]: A_DAILY, [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    expect(await a.state()).toMatchObject({ manifestIdentity: identityX });

    const { result } = pulledOf(await a.pull({ options: { flags: { resolveFork: true } } }, rigB));
    const copy = result.settlement.conflicts[0]?.conflictPath ?? "";

    const state = await a.state();
    expect(state).toMatchObject({ sequence: 2, highestSequence: 2, manifestIdentity: identityY, highestIdentity: identityY, previousIdentity: null, complete: true });
    expect(await readFloor(a.puller.store, state?.vaultId ?? "")).toMatchObject({ sequence: 2, identity: identityY });
    expect(pulledOf(await a.pull({}, rigB)).result.verdict).toBe("same");

    const published = await editAndPublish(rigB, aOnNodeB, {});
    expect(published).toMatchObject({ published: true, sequence: 3 });
    pulledOf(await b.pull({}, rigB));
    expect(b.texts()[PLAN]).toBe(A_PLAN);
    expect(b.texts()[copy]).toBe(A_DAILY);
    expect(b.texts()[DAILY]).toBe(B_DAILY);
    expect(syncedTexts(b)).toEqual(syncedTexts(a));
  });

  it("with --allow-rollback and an explicit target it is still refused as a fork", async () => {
    const { a, rigB } = await fork({ [DAILY]: A_DAILY }, { [DAILY]: B_DAILY });
    const root = servedRoot(rigB.node);
    const before = a.texts();

    const outcome = await a.pull({ options: { target: { kind: "root-cid", cid: root }, flags: { allowRollback: true } } }, rigB);

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") expect(outcome.stop.reason).toBe("fork");
    expect(a.texts()).toEqual(before);
  });

  it("without a recorded ancestor every differing file gets a copy and no local text is lost", async () => {
    const { a, rigB } = await fork({ [PLAN]: A_PLAN }, { [DAILY]: B_DAILY });
    const stateKey = rootFileNames(ROOT).state;
    const stored = JSON.parse(new TextDecoder().decode(a.host.kvStore.get(stateKey))) as Record<string, unknown>;
    a.host.kvStore.set(stateKey, new TextEncoder().encode(JSON.stringify({ ...stored, previousIdentity: null })));

    const { result } = pulledOf(await a.pull({ options: { flags: { resolveFork: true } } }, rigB));

    expect(result.forkResolution?.ancestorUsed).toBe(false);
    expect(result.forkResolution?.note).toMatch(/no record of the manifest it built on/);
    expect(a.texts()[PLAN]).toBe(ORIGINAL_PLAN);
    const copies = Object.fromEntries(result.settlement.conflicts.map((conflict) => [conflict.path, a.texts()[conflict.conflictPath]]));
    expect(copies[PLAN]).toBe(A_PLAN);
  });
});

describe("--repair for a node that is ahead", () => {
  it("is refused while a floor exists for the vault, with or without a state, and pull first is the way out", async () => {
    const { rig, node, a, b } = await createDevices();
    pulledOf(await b.pull());
    b.allowPublish();
    await editAndPublish(rig, a, { [DAILY]: A_DAILY });
    // Device B loses its record (the state file); its floor lives in the per-user store and stays.
    b.host.kvStore.delete(rootFileNames(ROOT).state);
    expect(await readFloor(b.puller.store, (await a.state())?.vaultId ?? "")).toMatchObject({ sequence: 1 });
    resetNodeTrace(node);

    const plain = await b.publish().then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(plain?.code).toBe("sequence-ahead");
    expect(plain?.message).toContain("pull first");
    expect(plain?.message).not.toContain("--repair");

    const repair = await b.publish({ repair: true, confirmRepair: async () => true }).then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(repair?.code).toBe("repair-refused");
    expect(repair?.message).toMatch(/sequence floor/);
    expect(repair?.message).toContain("pull first");
    expect(mutatingCalls(node)).toEqual([]);

    const { result } = pulledOf(await b.pull());
    expect(result.verdict).toBe("newer");
    b.host.put("Inbox/after-pull.md", "written after the pull\n");
    expect((await b.publish()).sequence).toBe(3);
  });
});

describe("--repair for a state that does not decode", () => {
  it("with no floor for the vault the ahead case is offered behind its confirmation, whose warning recommends pull, and the repair publishes above the node", async () => {
    const { rig, a, b } = await createDevices();
    pulledOf(await b.pull());
    b.allowPublish();
    await editAndPublish(rig, a, { [DAILY]: A_DAILY });
    b.host.kvStore.set(rootFileNames(ROOT).state, new TextEncoder().encode("{ not json"));
    b.puller.store.entries.clear(); // no floor for the vault on this device
    const warnings: string[] = [];

    const published = await b.publish({ repair: true, confirmRepair: async (warning) => (warnings.push(warning), true) });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("run pull");
    expect(published).toMatchObject({ published: true, sequence: 3 });
  });
});

/** A second process with a fresh heartbeat holds `publish.lock` in the directory. */
async function holdLockElsewhere(device: Device): Promise<() => Promise<void>> {
  const { ctx } = device.puller.locks;
  const stranger: LockContext = { ...ctx, host: "other-host", pid: 777, newToken: () => "token-of-the-other-process", isProcessAlive: () => true };
  const lock = await acquirePublishLock(device.puller.locks.file, stranger);
  return () => lock.release();
}

describe("lock contention between pull and publish", () => {
  it("a pull refuses with publish's text while a publish holds the lock: no request, no write, the other's lock untouched", async () => {
    const { node, b } = await createDevices();
    const release = await holdLockElsewhere(b);
    const lockBefore = b.puller.locks.file.bytes;
    resetNodeTrace(node);

    const outcome = await b.pull();

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.stop.reason).toBe("lock-held");
      expect(outcome.stop.message).toContain("another publish is running in this vault");
    }
    expect(node.calls).toEqual([]);
    expect(b.host.mutations).toEqual([]);
    expect(b.puller.locks.file.bytes).toEqual(lockBefore);
    await release();
    expect(b.puller.locks.file.bytes).toBeUndefined();
    pulledOf(await b.pull());
  });

  it("a publish refuses with the lock-held error while a pull holds the lock, and the pull still completes and releases", async () => {
    const { node, b } = await createDevices();
    b.allowPublish();
    let publishRefusal: (Error & { code?: string }) | undefined;
    let during: boolean | undefined;

    const outcome = await b.pull({
      options: { acceptFirstPull: false },
      deps: {
        confirmFirstPull: async () => {
          during = b.puller.locks.file.bytes !== undefined;
          resetNodeTrace(node);
          publishRefusal = await b.publish({}, { lockContext: { ...b.puller.locks.ctx, isProcessAlive: () => true } }).then(() => undefined, (error: unknown) => error as Error & { code?: string });
          return true;
        },
      },
    });

    expect(during).toBe(true);
    expect(publishRefusal?.code).toBe("lock-held");
    expect(mutatingCalls(node)).toEqual([]);
    expect(pulledOf(outcome).result.verdict).toBe("first-pull");
    expect(b.puller.locks.file.bytes).toBeUndefined();
    expect(blobReads(node).length).toBeGreaterThan(0);
  });

  it("releases the lock on every path of a pull: completed, declined and refused by the sequence rule", async () => {
    const { rig, node, a, b } = await createDevices();
    await b.pull({ options: { acceptFirstPull: false }, deps: { confirmFirstPull: async () => false } });
    expect(b.puller.locks.file.bytes).toBeUndefined();
    pulledOf(await b.pull());
    expect(b.puller.locks.file.bytes).toBeUndefined();
    const olderRoot = servedRoot(node);
    await editAndPublish(rig, a, { [DAILY]: A_DAILY });
    pulledOf(await b.pull());
    node.published.set([...node.published.keys()][0] ?? "", `/ipfs/${olderRoot}`);
    const refused = await b.pull();
    expect(refused.kind).toBe("stopped");
    expect(b.puller.locks.file.bytes).toBeUndefined();
  });
});

/** From the Nth read of `publish.lock` on, the file shows another holder's token: the check the engine awaits before a first write fails. */
function takeOverAtCheck(device: Device, nth: number): { readonly reads: () => number } {
  const file = device.puller.locks.file;
  const original = file.read.bind(file);
  let reads = 0;
  file.read = async () => {
    reads += 1;
    const bytes = await original();
    const record = bytes === undefined ? undefined : decodeLock(bytes);
    return reads === nth && record !== undefined ? encodeLock({ ...record, token: "taken-over-by-another-process" }) : bytes;
  };
  return { reads: () => reads };
}

describe("the token check before the first write", () => {
  const refusal = (run: Promise<unknown>): Promise<(Error & { code?: string }) | undefined> => run.then(() => undefined, (error: unknown) => error as Error & { code?: string });

  it("is awaited twice by a plain publish (before the resume, before the key and the first blob) and a run that keeps the lock writes normally", async () => {
    const { rig, a } = await createDevices();
    const check = takeOverAtCheck(a, Number.POSITIVE_INFINITY);
    expect((await editAndPublish(rig, a, { [DAILY]: A_DAILY })).sequence).toBe(2);
    // Two checks, plus the read the lock makes when it is released.
    expect(check.reads()).toBe(3);
  });

  it("before the resume of an interrupted publish: refused, the journal stays, nothing is sent", async () => {
    const { node, a } = await createDevices();
    a.host.clock += 60_000;
    a.host.put(DAILY, A_DAILY);
    await expect(a.publish({}, { host: dyingAfterJournal(a.publishHost) })).rejects.toThrow();
    resetNodeTrace(node);
    takeOverAtCheck(a, 1);

    const refused = await refusal(a.publish());

    expect(refused?.code).toBe("lock-held");
    expect(mutatingCalls(node)).toEqual([]);
    expect(a.host.kvStore.has(rootFileNames(ROOT).journal)).toBe(true);
    expect((await a.state())?.sequence).toBe(1);
  });

  it("before the junk in manifests/ is removed under --repair: refused, the junk stays, nothing is sent", async () => {
    const { node, a } = await createDevices();
    node.files.set(`${ROOT}/manifests/x`, new Uint8Array([1]));
    a.host.clock += 60_000;
    a.host.put(DAILY, A_DAILY);
    resetNodeTrace(node);
    takeOverAtCheck(a, 2);

    const refused = await refusal(a.publish({ repair: true, confirmRepair: async () => true }));

    expect(refused?.code).toBe("lock-held");
    expect(mutatingCalls(node)).toEqual([]);
    expect(node.files.has(`${ROOT}/manifests/x`)).toBe(true);
  });

  it("before the publication key is ensured and the first blob is written: refused, nothing is sent", async () => {
    const { node, a } = await createDevices();
    a.host.clock += 60_000;
    a.host.put(DAILY, A_DAILY);
    resetNodeTrace(node);
    takeOverAtCheck(a, 2);

    const refused = await refusal(a.publish());

    expect(refused?.code).toBe("lock-held");
    expect(mutatingCalls(node)).toEqual([]);
    expect((await a.state())?.sequence).toBe(1);
  });
});
