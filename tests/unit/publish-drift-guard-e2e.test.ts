import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { ROOT, createRig, type Rig } from "../helpers/publish-rig";

/** The rig's publishing device (`IPFS_SYNC_DEVICE` of the rig, no device store). */
const A = "test-device";
const B = "device-b-111111111111";

async function published(files: readonly string[] = ["a.md", "b.md"]): Promise<Rig> {
  const rig = createRig();
  for (const path of files) rig.host.put(path, `content of ${path}`, 1000);
  await rig.init();
  await rig.publish();
  return rig;
}

async function plantBlob(rig: Rig, prefix = "ab"): Promise<string> {
  const path = `${ROOT}/current/${prefix}/${prefix}${"c".repeat(50)}`;
  await rig.node.client.filesWrite(path, new Uint8Array([1, 2, 3]));
  return path;
}

async function seeDevice(rig: Rig, device: string, extra: Record<string, unknown> = {}): Promise<void> {
  const state = await readRootState(rig.host.kv, ROOT);
  if (state === undefined) throw new Error("state expected");
  await writeRootState(rig.host.kv, buildRootState({ ...state, devicesSeen: [...new Set([...state.devicesSeen, device])], ...extra }));
}

describe("publishVault: the drift guard (task 2.6)", () => {
  it("keeps device B's unnamed blob and reports it once B is in A's devicesSeen", async () => {
    const rig = await published();
    const stray = await plantBlob(rig);
    await seeDevice(rig, B);
    rig.host.put("a.md", "edited", 2000);

    const result = await rig.publish({ ownedKeys: rig.owned });

    expect(result).toMatchObject({ published: true, sequence: 2 });
    expect(result.anomalies).toBeGreaterThanOrEqual(1);
    expect(rig.node.files.has(stray)).toBe(true);
  });

  it("removes the stray when only this device is known and the node manifest names it", async () => {
    const rig = await published();
    const stray = await plantBlob(rig);

    const result = await rig.publish({ ownedKeys: rig.owned });

    expect(result).toMatchObject({ published: true, anomalies: 0 });
    expect(rig.node.files.has(stray)).toBe(false);
  });

  it("reports and keeps leftover blobs on a first publish onto an existing root", async () => {
    const rig = createRig();
    rig.host.put("a.md", "content", 1000);
    await rig.init();
    const stray = await plantBlob(rig);

    const result = await rig.publish();

    expect(result).toMatchObject({ published: true, sequence: 1 });
    expect(result.anomalies).toBeGreaterThanOrEqual(1);
    expect(rig.node.files.has(stray)).toBe(true);
  });

  it("never removes a carried entry's blob, alone or with another device known", async () => {
    for (const other of [false, true]) {
      const rig = await published(["CON.md", "note.md"]);
      const carried = (await rig.manifest()).files["CON.md"];
      if (carried === undefined) throw new Error("entry expected");
      const blob = `${ROOT}/${blobMfsPath(carried.blob)}`;
      rig.host.drop("CON.md");
      await seeDevice(rig, other ? B : A, { unmaterialized: ["CON.md"], complete: false });
      await plantBlob(rig);
      rig.host.put("note.md", "edited", 2000);

      const result = await rig.publish({ ownedKeys: rig.owned });

      expect(result).toMatchObject({ published: true, carried: ["CON.md"] });
      expect(rig.node.files.has(blob)).toBe(true);
    }
  });
});
