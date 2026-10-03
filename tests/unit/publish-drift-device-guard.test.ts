import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import { diagnose, mayRemoveStrays, type BlobListing, type DeviceGuard } from "../../src/sync/drift";
import { createExclusionMatcher } from "../../src/sync/exclusions";
import { createRootInspector } from "../../src/sync/node-reader";
import { buildPublishPlan } from "../../src/sync/publish-plan";
import { readRootState } from "../../src/sync/root-state";
import { scanVault } from "../../src/sync/scan";
import { ROOT, createRig, type Rig } from "../helpers/publish-rig";

const A = "device-a-000000000000";
const B = "device-b-111111111111";

/** A vault device A published, with blob-shaped files of an unfinished publish by another device planted in `current/`. */
async function scenario(files: readonly string[] = ["a.md", "b.md"]) {
  const rig = createRig();
  for (const path of files) rig.host.put(path, `content of ${path}`, 1000);
  await rig.init();
  await rig.publish();
  const manifest = await rig.manifest();
  const prefix = manifest.files["a.md"]?.blob.slice(0, 2) ?? "aa";
  const planted = `${prefix}/${prefix}${"b".repeat(50)}`;
  await rig.node.client.filesWrite(`${ROOT}/current/${planted}`, new Uint8Array([1, 2, 3]));
  return { rig, manifest, planted };
}

async function planWith(rig: Rig, deviceGuard: DeviceGuard | undefined, carried: readonly string[] = []) {
  const state = await readRootState(rig.host.kv, ROOT);
  if (state === undefined) throw new Error("state expected");
  return buildPublishPlan({
    keys: await rig.keys(),
    fs: rig.host.fs,
    client: rig.node.client,
    mfsRoot: ROOT,
    scanned: await scanVault(rig.host.fs, createExclusionMatcher()),
    baseline: { manifest: state.manifest, mtimes: state.mtimes },
    view: await createRootInspector(rig.node.client, ROOT).view(),
    carried,
    ...(deviceGuard === undefined ? {} : { deviceGuard }),
  });
}

describe("drift path: other devices' blobs", () => {
  it("keeps device B's unnamed blobs and reports them once B's id is in A's state", async () => {
    const { rig, planted } = await scenario();

    const plan = await planWith(rig, { device: A, devicesSeen: [A, B], nodeDevice: A });

    expect(plan.blobRemovals.filter((path) => path.endsWith(planted))).toEqual([]);
    expect(plan.heldBack).toEqual([planted]);
    expect(plan.anomalies).toContain(planted);
  });

  it("removes the same blobs when only this device is known and the latest node manifest names it", async () => {
    const { rig, planted } = await scenario();

    const plan = await planWith(rig, { device: A, devicesSeen: [A], nodeDevice: A });

    expect(plan.blobRemovals).toEqual([`current/${planted}`]);
    expect(plan.heldBack).toEqual([]);
    expect(plan.anomalies).toEqual([]);
  });

  it("removes them when no guard is given (the single-publisher flow)", async () => {
    const { rig, planted } = await scenario();

    expect((await planWith(rig, undefined)).blobRemovals).toEqual([`current/${planted}`]);
  });

  it("keeps them when the node's latest manifest names another device, whatever the state says", async () => {
    const { rig, planted } = await scenario();

    const plan = await planWith(rig, { device: A, devicesSeen: [A], nodeDevice: B });

    expect(plan.blobRemovals).toEqual([]);
    expect(plan.heldBack).toEqual([planted]);
  });

  it("keeps them when the node has no manifest naming this device", async () => {
    const { rig, planted } = await scenario();

    const plan = await planWith(rig, { device: A, devicesSeen: [], nodeDevice: undefined });

    expect(plan.blobRemovals).toEqual([]);
    expect(plan.heldBack).toEqual([planted]);
  });

  it("never lists a carried entry's blob as a stray, with or without another device", async () => {
    for (const guard of [{ device: A, devicesSeen: [A], nodeDevice: A }, { device: A, devicesSeen: [A, B], nodeDevice: A }, undefined]) {
      const { rig, manifest } = await scenario(["CON.md", "a.md"]);
      rig.host.drop("CON.md");
      const carriedBlob = manifest.files["CON.md"]?.blob ?? "";

      const plan = await planWith(rig, guard, ["CON.md"]);

      expect(plan.carried).toEqual(["CON.md"]);
      expect(plan.kept["CON.md"]?.blob).toBe(carriedBlob);
      expect(plan.blobRemovals).not.toContain(blobMfsPath(carriedBlob));
      expect(plan.heldBack).not.toContain(`${carriedBlob.slice(0, 2)}/${carriedBlob}`);
      expect(plan.anomalies).not.toContain(`${carriedBlob.slice(0, 2)}/${carriedBlob}`);
    }
  });
});

describe("drift guard: decision and diagnosis", () => {
  const listing: BlobListing = { blobs: new Map([["aa/" + "aa" + "c".repeat(50), "cid-1"]]), anomalies: ["zz/notes.txt"] };

  it("allows removal only for a lone publisher whose manifest is the latest", () => {
    expect(mayRemoveStrays({ device: A, devicesSeen: [A], nodeDevice: A })).toBe(true);
    expect(mayRemoveStrays({ device: A, devicesSeen: [], nodeDevice: A })).toBe(true);
    expect(mayRemoveStrays({ device: A, devicesSeen: [B, A], nodeDevice: A })).toBe(false);
    expect(mayRemoveStrays({ device: A, devicesSeen: [A], nodeDevice: B })).toBe(false);
    expect(mayRemoveStrays({ device: A, devicesSeen: [A], nodeDevice: undefined })).toBe(false);
  });

  it("holds unnamed blobs back and merges them, sorted, into the anomalies", () => {
    const held = diagnose(listing, new Map(), new Set(), { device: A, devicesSeen: [A, B], nodeDevice: A });
    expect(held.strays).toEqual([]);
    expect(held.held).toEqual(["aa/" + "aa" + "c".repeat(50)]);
    expect(held.anomalies).toEqual(["aa/" + "aa" + "c".repeat(50), "zz/notes.txt"]);
  });
});
