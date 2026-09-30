import { beforeAll, describe, expect, it } from "vitest";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

const OWNED = "k51owned";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

async function ownedRig() {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  return rig;
}

/** A vault published once (sequence 1). */
async function publishedOnce(): Promise<RigSnapshot> {
  const rig = await ownedRig();
  await rig.publish();
  return snapshotRig(rig);
}

/** Publish sequence `n`+1 with an edit and kill it right after `manifest.enc` was written (blob, journal, manifest = step 3). */
async function killedAfterManifest(from: RigSnapshot, edit = "second"): Promise<Rig> {
  const rig = restoreRig(from);
  rig.host.put("Daily/2026-09-30.md", `# edited ${edit}\n`, 5000);
  rig.node.mutations = 0;
  rig.node.killAfterMutation = 3;
  const error = await rejection(rig.publish());
  expect(error).toBeInstanceOf(NodeKilled);
  rig.node.killAfterMutation = undefined;
  rig.node.calls.length = 0;
  return rig;
}

const yes = async (): Promise<boolean> => true;

describe("W-01: --repair reaches a journal that resume refuses", () => {
  let once: RigSnapshot;
  let twice: RigSnapshot;
  let twiceManifestOne: Uint8Array;

  beforeAll(async () => {
    once = await publishedOnce();
    const rig = restoreRig(once);
    const first = Uint8Array.from(rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array);
    rig.host.put("Daily/2026-09-30.md", "# edited first\n", 4000);
    await rig.publish();
    twice = snapshotRig(rig);
    twiceManifestOne = first;
  }, 30_000);

  async function forgeNodeManifest(rig: Rig, change: (m: Awaited<ReturnType<Rig["manifest"]>>) => Awaited<ReturnType<Rig["manifest"]>>): Promise<void> {
    const forged = await encodeManifestFile(await rig.keys(), change(await rig.manifest()));
    rig.node.files.set(`${ROOT}/manifest.enc`, forged.file);
  }

  it("sequence-ahead: refused without --repair; with it and a yes the publish completes at the node's sequence plus one; without a yes it refuses naming the condition", async () => {
    const rig = await killedAfterManifest(once);
    await forgeNodeManifest(rig, (m) => ({ ...m, sequence: 5 }));
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "sequence-ahead" });
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: yes });
    expect(result).toMatchObject({ published: true, sequence: 6 });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("journal-manifest-mismatch: the node holds a different manifest at the journal's sequence", async () => {
    const rig = await killedAfterManifest(once);
    await forgeNodeManifest(rig, (m) => ({ ...m, rootCID: `b${"a".repeat(58)}` }));
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "journal-manifest-mismatch" });
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: yes });
    expect(result).toMatchObject({ published: true, sequence: 3 });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("journal-conflict (the record is already past the journal): the journal is dropped and the publish continues", async () => {
    const rig = await killedAfterManifest(once);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    await writeRootState(rig.host.kv, buildRootState({ ...state, sequence: 3, manifest: { ...state.manifest, sequence: 3 } }));
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "journal-conflict" });
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true });
    expect(result).toMatchObject({ published: true, sequence: 4 });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("journal-conflict (the node is more than one behind the journal): repair publishes from this device's record", async () => {
    const rig = await killedAfterManifest(twice, "third");
    rig.node.files.set(`${ROOT}/manifest.enc`, twiceManifestOne);
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "journal-conflict" });
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true });
    // N3-02: the deferred journal was for sequence 3 and its name/publish may have happened, so the repair goes past it (state 2, journal 3 -> 4).
    expect(result).toMatchObject({ published: true, sequence: 4 });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });

  it("node-manifest-missing (W-04): the node lost manifest.enc after the journal; refused, then repaired with a confirmation and a yes", async () => {
    const rig = await killedAfterManifest(once);
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "node-manifest-missing" });
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => false })).rejects.toMatchObject({ code: "repair-declined" });
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: yes });
    // N3-02: the journal was for sequence 2 (state 1); its name/publish may have happened, so the rebuilt manifest is sequence 3, not a second 2.
    expect(result).toMatchObject({ published: true, sequence: 3 });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect((await rig.manifest()).sequence).toBe(3);
  });

  it("a healthy journal is still finished by resume when --repair is passed: the flag lifts refusals only", async () => {
    const rig = await killedAfterManifest(once);
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true });
    expect(result).toMatchObject({ published: false });
    expect((await rig.manifest()).sequence).toBe(2);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
  });
});

describe("W-02: a planted history file cannot wedge the journal", () => {
  it("adopts around a planted manifests/<currentCID>.enc, refuses the fresh publish before writing, and works once the tree changes", async () => {
    const rig = await killedAfterManifest(await publishedOnce());
    rig.node.files.set(`${ROOT}/manifests/${rig.node.cidOf(`${ROOT}/current`)}.enc`, new Uint8Array([1, 2, 3]));
    const error = await rejection(rig.publish({ ownedKeys: rig.owned }));
    expect(error).toMatchObject({ code: "history-conflict" });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);

    rig.host.put("notes/new.md", "the tree changes", 6000);
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, sequence: 3 });
  });
});

describe("W-03: manifests/ is looked at before anything is written", () => {
  let base: RigSnapshot;
  beforeAll(async () => {
    base = await publishedOnce();
  }, 30_000);

  /** A published vault whose manifests/ holds exactly `count` history files (one is the real one) plus `extra` entries. */
  function withHistory(count: number, extra: Record<string, Uint8Array> = {}): Rig {
    const rig = restoreRig(base);
    for (let index = 1; index < count; index += 1) rig.node.files.set(`${ROOT}/manifests/b${index.toString(32).padStart(58, "w")}.enc`, new Uint8Array([1]));
    for (const [name, data] of Object.entries(extra)) rig.node.files.set(`${ROOT}/manifests/${name}`, data);
    rig.host.put("notes/new.md", "one more", 7000);
    rig.node.calls.length = 0;
    return rig;
  }

  it("publishes silently with 1,499 history files", async () => {
    const result = await withHistory(1499).publish({ ownedKeys: [OWNED] });
    expect(result).toMatchObject({ published: true });
    expect(result.warnings).toEqual([]);
  }, 30_000);

  it("publishes with 1,500 and warns, naming ipfs-sync prune-history", async () => {
    const result = await withHistory(1500).publish({ ownedKeys: [OWNED] });
    expect(result.published).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("1500");
    expect(result.warnings[0]).toContain("prune-history");
  }, 30_000);

  it.each([1999, 2000, 2001])("refuses with %i history files, naming ipfs-sync prune-history, before any write", async (count) => {
    const rig = withHistory(count);
    const error = await rejection(rig.publish({ ownedKeys: [OWNED] }));
    expect(error).toMatchObject({ code: "history-full" });
    expect((error as Error).message).toContain("prune-history");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  }, 30_000);

  it("keeps refusing on every rerun, writing nothing, so a timer cannot loop on it", async () => {
    const rig = withHistory(2001);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(rig.publish({ ownedKeys: [OWNED] })).rejects.toMatchObject({ code: "history-full" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  }, 30_000);

  it("refuses a junk name in manifests/ before any write; --repair alone cannot remove it; a no leaves it; a yes removes only it and publishes", async () => {
    const rig = withHistory(1, { x: new Uint8Array([1]) });
    await expect(rig.publish({ ownedKeys: [OWNED] })).rejects.toMatchObject({ code: "history-junk" });
    await expect(rig.publish({ ownedKeys: [OWNED], repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    await expect(rig.publish({ ownedKeys: [OWNED], repair: true, confirmRepair: async () => false })).rejects.toMatchObject({ code: "repair-declined" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(rig.node.files.has(`${ROOT}/manifests/x`)).toBe(true);

    const asked: string[] = [];
    const result = await rig.publish({ ownedKeys: [OWNED], repair: true, confirmRepair: async (warning) => (asked.push(warning), true) });
    expect(result.published).toBe(true);
    expect(asked[0]).toContain('"x"');
    expect(rig.node.files.has(`${ROOT}/manifests/x`)).toBe(false);
    expect(rig.node.calls.filter((call) => call.startsWith("rm "))).toEqual([`rm ${ROOT}/manifests/x`]);
    expect([...rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`))).toHaveLength(2);
  }, 30_000);

  it("treats a history-shaped name that is a folder as junk, and a non-recursive removal that fails as a failure", async () => {
    const rig = withHistory(1);
    rig.node.files.set(`${ROOT}/manifests/b${"z".repeat(58)}.enc/inner`, new Uint8Array([1]));
    await expect(rig.publish({ ownedKeys: [OWNED] })).rejects.toMatchObject({ code: "history-junk" });
    await expect(rig.publish({ ownedKeys: [OWNED], repair: true, confirmRepair: yes })).rejects.toThrow(/without recursive/);
    expect(rig.node.files.has(`${ROOT}/manifests/b${"z".repeat(58)}.enc/inner`)).toBe(true);
  }, 30_000);

  it("refuses a planted prefix folder of 2,001 entries by name before any write", async () => {
    const rig = restoreRig(base);
    const prefix = [...rig.node.files.keys()].find((path) => /\/current\/[a-z2-7]{2}\//.test(path))?.split("/").at(-2) ?? "aa";
    for (let index = 0; index < 2001; index += 1) rig.node.files.set(`${ROOT}/current/${prefix}/junk${index}`, new Uint8Array([1]));
    rig.host.put("notes/new.md", "one more", 7000);
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish({ ownedKeys: [OWNED] }));
    expect(error).toMatchObject({ code: "remote-object-too-large" });
    expect((error as Error).message).toContain(`current/${prefix}/`);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  }, 30_000);
});

export { rootFileNames };
