import { beforeAll, describe, expect, it } from "vitest";
import { historyFileName } from "../../src/sync/history-names";
import { PublishRefusedError, lockLost } from "../../src/sync/publish-refusals";
import { KEYSLOTS_PATH, historyNamesOf, maintenanceNodeOf, mutatingCalls, oldKeySlotsOf, publishedRig, variantKeySlots } from "../helpers/maintenance-rig";
import { ROOT, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

/** The node port of key management: bounded reads, writes only inside the root, the lock checked before each write. */

let snapshot: RigSnapshot;

beforeAll(async () => {
  snapshot = snapshotRig(await publishedRig());
});

const fresh = (): Rig => {
  const rig = restoreRig(snapshot);
  rig.node.cidOf(ROOT);
  return rig;
};

describe("createMaintenanceNode", () => {
  it("reads keyslots.json from the tree and from an immutable root, and nothing for something that is not a CID", async () => {
    const rig = fresh();
    const node = maintenanceNodeOf(rig);
    const root = rig.node.cidOf(ROOT) as string;
    expect(await node.readKeySlotsFile()).toEqual(oldKeySlotsOf(rig));
    expect(await node.readKeySlotsFileAt(root)).toEqual(oldKeySlotsOf(rig));
    expect(await node.readKeySlotsFileAt("../etc/passwd")).toBeUndefined();
    expect(await node.readKeySlotsFileAt("short")).toBeUndefined();
  });

  it("writes keyslots.json only at <root>/keyslots.json", async () => {
    const rig = fresh();
    await maintenanceNodeOf(rig).writeKeySlotsFile(variantKeySlots(oldKeySlotsOf(rig), "a"));
    expect(mutatingCalls(rig)).toEqual([`write ${KEYSLOTS_PATH}`]);
  });

  it("removes one history file, non-recursively", async () => {
    const rig = fresh();
    const [oldest] = historyNamesOf(rig) as [string];
    await maintenanceNodeOf(rig).removeHistoryFile(oldest);
    expect(mutatingCalls(rig)).toEqual([`rm ${ROOT}/manifests/${oldest}`]);
    expect(historyNamesOf(rig)).not.toContain(oldest);
  });

  it("treats a history file that is already gone as done", async () => {
    const rig = fresh();
    await expect(maintenanceNodeOf(rig).removeHistoryFile(historyFileName(77, "c".repeat(40)))).resolves.toBeUndefined();
  });

  it.each(["../manifest.enc", "current", "manifests", "a/b.enc", "notes.md", ""])("refuses to remove %j: it is not a history file name", async (name) => {
    const rig = fresh();
    const error = await maintenanceNodeOf(rig).removeHistoryFile(name).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect(mutatingCalls(rig)).toEqual([]);
  });

  it("asks the lock check before every write, pin and name publication", async () => {
    const rig = fresh();
    const node = maintenanceNodeOf(rig, () => {
      throw lockLost();
    });
    const root = rig.node.cidOf(ROOT) as string;
    await expect(node.writeKeySlotsFile(oldKeySlotsOf(rig))).rejects.toMatchObject({ code: "lock-lost" });
    await expect(node.removeHistoryFile(historyNamesOf(rig)[0] as string)).rejects.toMatchObject({ code: "lock-lost" });
    await expect(node.pinRoot(root)).rejects.toMatchObject({ code: "lock-lost" });
    await expect(node.publishRoot(root, { root, firstPublish: false })).rejects.toMatchObject({ code: "lock-lost" });
    expect(mutatingCalls(rig)).toEqual([]);
  });
});
