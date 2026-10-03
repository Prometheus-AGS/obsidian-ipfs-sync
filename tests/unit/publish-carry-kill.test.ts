import { describe, expect, it } from "vitest";
import { printPathLists } from "../../cli/publish-command";
import { blobMfsPath } from "../../src/crypto";
import { BlobTransferError } from "../../src/sync/encrypted-transfer";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { NodeKilled } from "../helpers/fake-kubo";
import { ROOT, createRig, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

const isKill = (error: unknown): boolean => error instanceof NodeKilled || (error instanceof BlobTransferError && error.failures.some((failure) => failure.error instanceof NodeKilled));

/** Device B has CON.md carried (no local copy), edited other.md, and is about to publish sequence 2. */
async function carriedScene(): Promise<RigSnapshot> {
  const rig = createRig();
  for (const path of ["CON.md", "other.md"]) rig.host.put(path, `content of ${path}`, 1000);
  await rig.init();
  await rig.publish();
  const state = await readRootState(rig.host.kv, ROOT);
  if (state === undefined) throw new Error("state expected");
  await writeRootState(rig.host.kv, buildRootState({ ...state, unmaterialized: ["CON.md"], complete: false }));
  rig.host.drop("CON.md");
  rig.host.put("other.md", "edited", 2000);
  return snapshotRig(rig);
}

async function stepsOfFullRun(snapshot: RigSnapshot): Promise<number> {
  const rig = restoreRig(snapshot);
  rig.node.mutations = 0;
  await rig.publish();
  return rig.node.mutations;
}

async function assertCarried(rig: Rig, originalBlob: string): Promise<void> {
  const state = await readRootState(rig.host.kv, ROOT);
  expect(state?.unmaterialized).toEqual(["CON.md"]);
  const before = rig.node.files.get(originalBlob);
  rig.host.put("other.md", "edited again", 3000);
  const next = await rig.publish();
  expect(next).toMatchObject({ published: true, removed: 0, carried: ["CON.md"] });
  expect(Object.keys((await rig.manifest()).files).sort()).toEqual(["CON.md", "other.md"]);
  expect(rig.node.files.get(originalBlob)).toBe(before);
}

describe("kill matrix with a carried path", () => {
  it("every kill point converges, keeps CON.md in `unmaterialized`, and the next publish keeps its entry and blob", async () => {
    const snapshot = await carriedScene();
    const probe = restoreRig(snapshot);
    const originalEntry = (await probe.manifest()).files["CON.md"];
    const blobPath = `${ROOT}/${blobMfsPath(originalEntry?.blob ?? "")}`;
    const steps = await stepsOfFullRun(snapshot);
    expect(steps).toBeGreaterThan(5);
    for (let step = 1; step <= steps; step += 1) {
      const rig = restoreRig(snapshot);
      rig.node.mutations = 0;
      rig.node.killAfterMutation = step;
      const error = await rig.publish().then(() => undefined, (caught: unknown) => caught);
      if (error !== undefined) expect(isKill(error), `step ${step}`).toBe(true);
      rig.node.killAfterMutation = undefined;
      await rig.publish();
      expect((await rig.manifest()).files["CON.md"], `step ${step}`).toEqual(originalEntry);
      await assertCarried(rig, blobPath);
    }
  }, 120_000);
});

describe("printPathLists", () => {
  const hostile = "evil\u001b[2J\u009b‮exe\nline.md";
  const run = (result: Partial<Parameters<typeof printPathLists>[1]>): string[] => {
    const out: string[] = [];
    printPathLists({ out: (t) => void out.push(t), err: () => undefined }, { carried: [], dropped: [], skipped: [], ...result } as Parameters<typeof printPathLists>[1]);
    return out;
  };

  it("replaces control and bidi characters in carried, dropped and skipped names", () => {
    const lines = run({ carried: [hostile], dropped: [{ path: hostile, reason: "x" }], skipped: [{ path: hostile, reason: "y" }] });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
      expect(line).toContain('"evil?[2J??exe?line.md"');
    }
  });

  it("prints three names and a count for more", () => {
    const lines = run({ carried: ["a", "b", "c", "d", "e"] });
    expect(lines).toEqual(['note: 5 paths not published from this device (no current copy here; kept as the node has them): "a", "b", "c" and 2 more']);
  });

  it("prints nothing for empty lists", () => {
    expect(run({})).toEqual([]);
  });
});
