import { beforeAll, describe, expect, it } from "vitest";
import { readJournal } from "../../src/sync/journal";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

const OWNED = "k51owned";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const yes = async (): Promise<boolean> => true;

async function ownedRig(): Promise<Rig> {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  return rig;
}

let once: RigSnapshot;
beforeAll(async () => {
  const rig = await ownedRig();
  await rig.publish();
  once = snapshotRig(rig);
}, 30_000);

/** Publish sequence 2 after an edit and kill it right after `manifest.enc` was written: a journal is left. */
async function killedAfterManifest(): Promise<Rig> {
  const rig = restoreRig(once);
  rig.host.put("Daily/2026-09-30.md", "# edited for the kill\n", 5000);
  rig.node.mutations = 0;
  rig.node.killAfterMutation = 3;
  expect(await rejection(rig.publish())).toBeInstanceOf(NodeKilled);
  rig.node.killAfterMutation = undefined;
  rig.node.calls.length = 0;
  return rig;
}

describe("W-07: an idle tick derives no key", () => {
  /** The unlock progress callback is called while Argon2id runs; counting its calls counts derivations. */
  function counter(): { readonly hook: (fraction: number) => void; readonly runs: () => number } {
    let calls = 0;
    return { hook: () => void (calls += 1), runs: () => calls };
  }

  it("positive control: a publish with a change unlocks, and the hook sees it", async () => {
    const rig = restoreRig(once);
    rig.host.put("notes/new.md", "new file", 6000);
    const derivations = counter();
    await rig.publish({ onUnlockProgress: derivations.hook });
    expect(derivations.runs()).toBeGreaterThan(0);
  });

  it("an unchanged vault returns unchanged with no derivation, no write, and only a stat and a key lookup on the node", async () => {
    const rig = restoreRig(once);
    rig.node.calls.length = 0;
    const derivations = counter();
    const before = [...rig.host.files.keys()];
    const result = await rig.publish({ onUnlockProgress: derivations.hook });
    expect(result).toMatchObject({ published: false, written: 0, removed: 0, keyCreated: false, keyId: OWNED });
    expect(derivations.runs()).toBe(0);
    expect(rig.node.calls).toEqual([expect.stringMatching(/^stat /), "keyList"]);
    expect([...rig.host.files.keys()]).toEqual(before);
  });

  it("five idle ticks in a row derive nothing", async () => {
    const rig = restoreRig(once);
    const derivations = counter();
    for (let tick = 0; tick < 5; tick += 1) await rig.publish({ onUnlockProgress: derivations.hook });
    expect(derivations.runs()).toBe(0);
  });

  it.each([
    ["a file was edited", (rig: Rig) => rig.host.put("Daily/2026-09-30.md", "# edited\n", 7000)],
    ["a file was added", (rig: Rig) => rig.host.put("notes/added.md", "added", 7000)],
    ["a file was removed", (rig: Rig) => rig.host.drop("attachment.bin")],
    ["a file was touched (same size, new time)", (rig: Rig) => rig.host.put("Daily/2026-09-30.md", rig.host.files.get("Daily/2026-09-30.md")?.data ?? "", 99_000)],
  ])("does not take the shortcut when %s", async (_label, change) => {
    const rig = restoreRig(once);
    change(rig);
    const derivations = counter();
    await rig.publish({ onUnlockProgress: derivations.hook });
    expect(derivations.runs()).toBeGreaterThan(0);
  });

  it("does not take the shortcut when the node's root is not the one last published", async () => {
    const rig = restoreRig(once);
    rig.node.files.set(`${ROOT}/manifests/${"z".repeat(52)}.enc`, new Uint8Array([1]));
    const derivations = counter();
    await rejection(rig.publish({ onUnlockProgress: derivations.hook }));
    expect(derivations.runs()).toBeGreaterThan(0);
  });

  it("does not take the shortcut with --repair, with a journal, or with the key absent", async () => {
    const repairRig = restoreRig(once);
    const repairs = counter();
    await repairRig.publish({ repair: true, onUnlockProgress: repairs.hook });
    expect(repairs.runs()).toBeGreaterThan(0);

    const journalRig = await killedAfterManifest();
    const journals = counter();
    await journalRig.publish({ onUnlockProgress: journals.hook });
    expect(journals.runs()).toBeGreaterThan(0);

    const keyless = restoreRig(once);
    keyless.node.keys.length = 0;
    const keyless1 = counter();
    await rejection(keyless.publish({ onUnlockProgress: keyless1.hook }));
    expect(keyless1.runs()).toBeGreaterThan(0);
  });

  it("without a passphrase it still stops before any request (the shortcut comes after that check)", async () => {
    const rig = restoreRig(once);
    rig.node.calls.length = 0;
    await expect(rig.publish({ passphrase: undefined })).rejects.toMatchObject({ code: "passphrase-required" });
    expect(rig.node.calls).toEqual([]);
  });
});

describe("W-04: a manifest.enc that does not authenticate", () => {
  const truncate = (rig: Rig): void => {
    const file = rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array;
    rig.node.files.set(`${ROOT}/manifest.enc`, file.slice(0, Math.floor(file.length / 2)));
  };

  it("with no journal: refused, then --repair rewrites it only after a yes, at this device's sequence plus one", async () => {
    const rig = restoreRig(once);
    truncate(rig);
    await expect(rig.publish()).rejects.toMatchObject({ code: "node-manifest-unreadable" });
    await expect(rig.publish({ repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    await expect(rig.publish({ repair: true, confirmRepair: async () => false })).rejects.toMatchObject({ code: "repair-declined" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    const result = await rig.publish({ repair: true, confirmRepair: yes });
    expect(result).toMatchObject({ published: true, sequence: 2 });
    expect((await rig.manifest()).sequence).toBe(2);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
  });

  it("is refused for a device with no local record of publishing there", async () => {
    const rig = restoreRig(once);
    truncate(rig);
    await rig.host.kv.delete(rootFileNames(ROOT).state);
    const error = await rejection(rig.publish({ repair: true, confirmRepair: yes }));
    expect(error).toMatchObject({ code: "repair-refused" });
    expect((error as Error).message).toContain("no record");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("after a journal (torn manifest write): the next publish rewrites it from the journal with no flag and completes", async () => {
    const rig = await killedAfterManifest();
    truncate(rig);
    const result = await rig.publish();
    expect(result).toMatchObject({ published: false });
    expect((await rig.manifest()).sequence).toBe(2);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect(rig.node.published.size).toBeGreaterThan(0);
  });
});

describe("W-10: the publication key", () => {
  it("a run refused before its first write leaves no key behind", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    rig.node.files.set(`${ROOT}/manifests/${"j".repeat(20)}.txt`, new Uint8Array([1]));
    await expect(rig.publish()).rejects.toMatchObject({ code: "history-junk" });
    expect(rig.node.keys).toEqual([]);
    expect(rig.node.calls.filter((call) => call.startsWith("keyGen"))).toEqual([]);
  });

  it("resuming a journal never generates a key: with the key gone from the node it stops before name/publish", async () => {
    const rig = await killedAfterManifest();
    rig.node.keys.length = 0;
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "publication-key-changed" });
    expect(rig.node.calls.filter((call) => call.startsWith("keyGen") || call.startsWith("publish "))).toEqual([]);
    expect(rig.node.keys).toEqual([]);
  });

  it("a key swapped on the node between the lookup and name/publish is caught by the second key/list", async () => {
    const rig = await ownedRig();
    const real = rig.node.client.keyList.bind(rig.node.client);
    let lookups = 0;
    (rig.node.client as { keyList: typeof real }).keyList = async () => {
      lookups += 1;
      const keys = await real();
      return lookups >= 2 ? keys.map((key) => ({ ...key, id: "k51swapped" })) : keys;
    };
    await expect(rig.publish()).rejects.toMatchObject({ code: "publication-key-changed" });
    expect(lookups).toBe(2);
    expect(rig.node.calls.filter((call) => call.startsWith("publish "))).toEqual([]);
  });
});

describe("W-05: local state writes are preceded by the lock check", () => {
  it("every write or delete of local state is immediately preceded by assertHeld", async () => {
    const rig = restoreRig(once);
    rig.host.put("notes/new.md", "new", 6000);
    const order: string[] = [];
    const kv = rig.host.kv;
    const set = kv.set.bind(kv);
    const remove = kv.delete.bind(kv);
    kv.set = async (key, value) => (order.push(`set ${key.split(".")[0] ?? ""}`), set(key, value));
    kv.delete = async (key) => (order.push(`delete ${key.split(".")[0] ?? ""}`), remove(key));
    await rig.publish({ assertHeld: () => void order.push("check") });
    const writes = order.flatMap((entry, index) => (entry.startsWith("set ") || entry.startsWith("delete ") ? [index] : []));
    expect(writes.length).toBeGreaterThanOrEqual(3); // journal, state, journal removal
    for (const index of writes) expect(order[index - 1]).toBe("check");
  });

  it("a lock that lapses at any point leaves the local record consistent and writes nothing after the failing check", async () => {
    let total = 0;
    {
      const rig = restoreRig(once);
      rig.host.put("notes/new.md", "new", 6000);
      await rig.publish({ assertHeld: () => void (total += 1) });
    }
    expect(total).toBeGreaterThanOrEqual(6);
    for (let failAt = 1; failAt <= total; failAt += 1) {
      const rig = restoreRig(once);
      rig.host.put("notes/new.md", "new", 6000);
      let calls = 0;
      let lost = false;
      const kv = rig.host.kv;
      const set = kv.set.bind(kv);
      const remove = kv.delete.bind(kv);
      kv.set = async (key, value) => (expect(lost).toBe(false), set(key, value));
      kv.delete = async (key) => (expect(lost).toBe(false), remove(key));
      const error = await rejection(
        rig.publish({
          assertHeld: () => {
            calls += 1;
            if (calls === failAt) {
              lost = true;
              throw Object.assign(new Error("lock lost"), { code: "lock-lost" });
            }
          },
        }),
      );
      expect((error as Error).message).toContain("lock lost");
      expect([1, 2]).toContain((await readRootState(rig.host.kv, ROOT))?.sequence);
    }
  }, 60_000);
});
