import { describe, expect, it } from "vitest";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { RootStateError } from "../../src/sync/local-record";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { EmptyVaultError } from "../../src/sync/publish-errors";
import { ROOT, createRig, seedVault, type Rig } from "../helpers/publish-rig";

const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const writes = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("write "));

interface Backup {
  readonly manifestSeq1: Uint8Array<ArrayBuffer>;
  readonly stateSeq1: Uint8Array<ArrayBuffer>;
}

/** A vault published twice (sequence 2), with the sequence-1 manifest and record kept aside. */
async function publishedTwice(): Promise<{ readonly rig: Rig; readonly backup: Backup }> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  await rig.publish();
  const state = rootFileNames(ROOT).state;
  const backup: Backup = { manifestSeq1: Uint8Array.from(rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array), stateSeq1: Uint8Array.from(rig.host.kvStore.get(state) as Uint8Array) };
  rig.host.put("notes/second.md", "second publish", 2000);
  await rig.publish({ ownedKeys: rig.owned });
  rig.node.calls.length = 0;
  return { rig, backup };
}

describe("--repair: the node serves an older genuine manifest (behind)", () => {
  it("is refused without --repair, naming the action and never advising to delete state", async () => {
    const { rig, backup } = await publishedTwice();
    rig.node.files.set(`${ROOT}/manifest.enc`, backup.manifestSeq1);
    const error = await rejection(rig.publish({ ownedKeys: rig.owned }));
    expect(error).toMatchObject({ code: "sequence-behind" });
    expect((error as Error).message).toContain("--repair");
    expect((error as Error).message).not.toMatch(/delete/i);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("publishes at the local sequence plus one with --repair, replacing the older history file for the unchanged tree", async () => {
    const { rig, backup } = await publishedTwice();
    rig.node.files.set(`${ROOT}/manifest.enc`, backup.manifestSeq1);
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true });
    expect(result).toMatchObject({ published: true, written: 0, removed: 0, sequence: 3 });
    const manifest = await rig.manifest();
    expect(manifest.sequence).toBe(3);
    expect(writes(rig).map((call) => call.replace(ROOT, "<root>").replace(/[a-z0-9]{50,}/, "<cid>"))).toEqual(["write <root>/manifest.enc", "write <root>/manifests/<cid>.enc"]);
    // The tree did not change, so the new manifest has the same rootCID as sequence 2 and replaces that history file.
    expect(rig.node.files.get(`${ROOT}/manifests/${manifest.rootCID}.enc`)).toEqual(rig.node.files.get(`${ROOT}/manifest.enc`));
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(3);
    expect(rig.node.published.get(rig.owned[0] ?? "")).toBe(`/ipfs/${rig.node.cidOf(ROOT)}`);
  });
});

describe("--repair: this device's record is missing or older than the node (ahead)", () => {
  async function restoredBackup(): Promise<Rig> {
    const { rig, backup } = await publishedTwice();
    rig.host.kvStore.set(rootFileNames(ROOT).state, backup.stateSeq1);
    return rig;
  }

  it("is refused without --repair", async () => {
    const rig = await restoredBackup();
    const error = await rejection(rig.publish({ ownedKeys: rig.owned }));
    expect(error).toMatchObject({ code: "sequence-ahead" });
    expect((error as Error).message).toContain("--repair");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("cannot be confirmed by a run that cannot ask, and stops when the user says no", async () => {
    const rig = await restoredBackup();
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => false })).rejects.toMatchObject({ code: "repair-declined" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("warns that other publishers' changes are discarded, then publishes from the node's manifest at the next sequence", async () => {
    const rig = await restoredBackup();
    const warnings: string[] = [];
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async (warning) => (warnings.push(warning), true) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/discarded/);
    expect(result).toMatchObject({ published: true, sequence: 3, written: 0 });
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state?.sequence).toBe(3);
    expect(Object.keys(state?.manifest.files ?? {})).toContain("notes/second.md");
  });

  it("continues from the node when the local record is unreadable, but only with --repair", async () => {
    const { rig } = await publishedTwice();
    rig.host.kvStore.set(rootFileNames(ROOT).state, new TextEncoder().encode("{ not json"));
    const error = await rejection(rig.publish({ ownedKeys: rig.owned }));
    expect(error).toBeInstanceOf(RootStateError);
    expect((error as Error).message).toContain("--repair");
    expect((error as Error).message).not.toMatch(/delete/i);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);

    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => true });
    expect(result).toMatchObject({ published: true, sequence: 3 });
  });

  it("refuses to publish an empty folder over the node's vault", async () => {
    const rig = await restoredBackup();
    for (const path of [...rig.host.files.keys()].filter((path) => !path.startsWith("."))) rig.host.drop(path);
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => true })).rejects.toBeInstanceOf(EmptyVaultError);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});

describe("--repair: what it does not cover", () => {
  it("is not allowed when the node's key slots differ from this device's copy (the copy is checked first)", async () => {
    const { rig, backup } = await publishedTwice();
    const stranger = createRig();
    await stranger.init();
    rig.node.files.set(`${ROOT}/manifest.enc`, backup.manifestSeq1);
    rig.node.files.set(`${ROOT}/keyslots.json`, stranger.node.files.get(`${ROOT}/keyslots.json`) as Uint8Array);
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => true })).rejects.toMatchObject({ code: "vault-mismatch" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("does not apply to a fork: another publisher wrote a different manifest at the same sequence", async () => {
    const { rig } = await publishedTwice();
    const manifest = await rig.manifest();
    const other = `b${"a".repeat(58)}`;
    const forked = await encodeManifestFile(await rig.keys(), { ...manifest, rootCID: other });
    rig.node.files.set(`${ROOT}/manifest.enc`, forked.file);
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "sequence-fork" });
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("W-04: a node that lost its manifest.enc is repaired only with a confirmation, at this device's sequence plus one", async () => {
    const { rig } = await publishedTwice();
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "node-manifest-missing" });
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true })).rejects.toMatchObject({ code: "repair-refused" });
    await expect(rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => false })).rejects.toMatchObject({ code: "repair-declined" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    const result = await rig.publish({ ownedKeys: rig.owned, repair: true, confirmRepair: async () => true });
    expect(result).toMatchObject({ published: true, sequence: 3 });
  });

  it("changes nothing on a healthy vault: the flag only lifts refusals", async () => {
    const { rig } = await publishedTwice();
    expect(await rig.publish({ ownedKeys: rig.owned, repair: true })).toMatchObject({ published: false });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});
