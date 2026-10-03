import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import type { EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { FileChangedDuringReadError } from "../../src/sync/host-errors";
import { buildPublishPlan, type Baseline } from "../../src/sync/publish-plan";
import { buildRootState, readRootState, writeRootState, type RootState } from "../../src/sync/root-state";
import { ROOT, blobPaths, createRig, type Rig } from "../helpers/publish-rig";

const MUTATING = /^(write|rm|pin|publish|keyGen) /;

/** A vault the way a Linux device published it, and the rig that will play the other device. */
async function linuxVault(paths: readonly string[]): Promise<Rig> {
  const rig = createRig();
  for (const path of paths) rig.host.put(path, `content of ${path}`, 1000);
  await rig.init();
  await rig.publish();
  return rig;
}

async function stateOf(rig: Rig): Promise<RootState> {
  const state = await readRootState(rig.host.kv, ROOT);
  if (state === undefined) throw new Error("state expected");
  return state;
}

/** What a pull on a device that could not restore `paths` leaves behind: the node's entries in the baseline, the paths listed. */
async function markUnmaterialized(rig: Rig, paths: readonly string[]): Promise<void> {
  const state = await stateOf(rig);
  await writeRootState(rig.host.kv, buildRootState({ ...state, unmaterialized: [...paths].sort(), complete: false }));
}

function blobOnNode(manifest: EncryptedManifest, path: string): string {
  return `${ROOT}/${blobMfsPath(manifest.files[path]?.blob ?? "")}`;
}

describe("publish: paths this device could not restore are carried forward", () => {
  it("keeps a Linux-only CON.md with its original entry and blob through an unrelated edit", async () => {
    const rig = await linuxVault(["CON.md", "note.md", "other.md"]);
    const first = await rig.manifest();
    const original = first.files["CON.md"];
    const originalBlob = rig.node.files.get(blobOnNode(first, "CON.md"));
    rig.host.drop("CON.md");
    await markUnmaterialized(rig, ["CON.md"]);
    rig.host.put("note.md", "edited on the other device", 2000);
    rig.events.changed.length = 0;

    const result = await rig.publish();

    expect(result).toMatchObject({ published: true, written: 1, removed: 0, sequence: 2, carried: ["CON.md"], dropped: [] });
    const second = await rig.manifest();
    expect(second.files["CON.md"]).toEqual(original);
    expect(Object.keys(second.files).sort()).toEqual(["CON.md", "note.md", "other.md"]);
    expect(rig.node.files.get(blobOnNode(second, "CON.md"))).toBe(originalBlob);
    expect(blobPaths(rig.node)).toContain(blobOnNode(second, "CON.md"));
    expect(rig.events.changed.map((event) => `${event.kind} ${event.path}`)).toEqual(["modified note.md"]);
    const state = await stateOf(rig);
    expect(state.unmaterialized).toEqual(["CON.md"]);
    expect(state.manifest.files["CON.md"]).toEqual(original);
  });

  it("keeps a Note.md/note.md pair through an unrelated publish and does not count them as removals", async () => {
    const rig = await linuxVault(["Note.md", "note.md", "other.md"]);
    const first = await rig.manifest();
    rig.host.drop("Note.md");
    rig.host.drop("note.md");
    await markUnmaterialized(rig, ["note.md", "Note.md"]);
    rig.host.put("other.md", "changed", 2000);

    const result = await rig.publish();

    expect(result).toMatchObject({ published: true, removed: 0, carried: ["Note.md", "note.md"] });
    const second = await rig.manifest();
    expect(second.files["Note.md"]).toEqual(first.files["Note.md"]);
    expect(second.files["note.md"]).toEqual(first.files["note.md"]);
    expect((await stateOf(rig)).unmaterialized).toEqual(["Note.md", "note.md"]);
  });

  it("does not publish or even read a local edit of a carried path, and lists the path", async () => {
    const rig = await linuxVault(["CON.md", "other.md"]);
    const first = await rig.manifest();
    const originalBlob = rig.node.files.get(blobOnNode(first, "CON.md"));
    await markUnmaterialized(rig, ["CON.md"]);
    rig.host.put("CON.md", "a stale local copy the user edited", 3000);
    rig.host.put("other.md", "real change", 3000);
    rig.host.reads.wholeReads.length = 0;
    rig.events.changed.length = 0;

    const result = await rig.publish();

    expect(result).toMatchObject({ published: true, written: 1, removed: 0, carried: ["CON.md"] });
    expect(rig.host.reads.wholeReads).toContain("other.md");
    expect(rig.host.reads.wholeReads).not.toContain("CON.md");
    expect(rig.events.changed.map((event) => event.path)).toEqual(["other.md"]);
    const second = await rig.manifest();
    expect(second.files["CON.md"]).toEqual(first.files["CON.md"]);
    expect(rig.node.files.get(blobOnNode(second, "CON.md"))).toBe(originalBlob);
    expect((await stateOf(rig)).mtimes).not.toHaveProperty("CON.md", 3000);
  });

  it("drops a carried path that this device now excludes: absent from the manifest, listed as excluded, blob removed, not a removal", async () => {
    const rig = await linuxVault(["drafts/x.md", "keep.md"]);
    const first = await rig.manifest();
    await markUnmaterialized(rig, ["drafts/x.md"]);
    rig.host.drop("drafts/x.md");

    const result = await rig.publish({ extraExclusions: ["drafts/"] });

    expect(result).toMatchObject({ published: true, written: 0, removed: 0, carried: [] });
    expect(result.dropped).toEqual([{ path: "drafts/x.md", reason: expect.stringContaining("excluded") }]);
    const second = await rig.manifest();
    expect(Object.keys(second.files)).toEqual(["keep.md"]);
    expect(rig.node.files.has(blobOnNode(first, "drafts/x.md"))).toBe(false);
    expect((await stateOf(rig)).unmaterialized).toEqual([]);
  });
});

describe("publish: the idle check with carried paths", () => {
  it("still returns unchanged, without deriving a key, when the only differences are carried paths", async () => {
    const rig = await linuxVault(["CON.md", "other.md"]);
    await markUnmaterialized(rig, ["CON.md"]);
    rig.host.drop("CON.md");
    rig.node.calls.length = 0;
    let derivations = 0;

    const gone = await rig.publish({ onUnlockProgress: () => void (derivations += 1) });
    expect(gone).toMatchObject({ published: false, written: 0, removed: 0, carried: ["CON.md"] });

    // an edited stale copy at the carried path is no difference either
    rig.host.put("CON.md", "edited stale copy", 9000);
    const edited = await rig.publish({ onUnlockProgress: () => void (derivations += 1) });
    expect(edited).toMatchObject({ published: false, carried: ["CON.md"] });
    expect(derivations).toBe(0);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("is not taken when a carried path is now excluded: the normal path runs and drops it", async () => {
    const rig = await linuxVault(["CON.md", "other.md"]);
    await markUnmaterialized(rig, ["CON.md"]);
    rig.host.drop("CON.md");
    let derivations = 0;

    const result = await rig.publish({ extraExclusions: ["CON.md"], onUnlockProgress: () => void (derivations += 1) });

    expect(derivations).toBeGreaterThan(0);
    expect(result).toMatchObject({ published: true, carried: [] });
    expect(result.dropped.map((entry) => entry.path)).toEqual(["CON.md"]);
  });

  it("a real edit next to carried paths is still found", async () => {
    const rig = await linuxVault(["CON.md", "other.md"]);
    await markUnmaterialized(rig, ["CON.md"]);
    rig.host.drop("CON.md");
    rig.host.put("other.md", "changed", 5000);
    expect(await rig.publish()).toMatchObject({ published: true, written: 1, carried: ["CON.md"] });
  });
});

describe("publish: planning of carried entries", () => {
  async function planWith(extra: Readonly<Record<string, string>>, carried: readonly string[], excluded?: (path: string) => boolean) {
    const rig = await linuxVault(["a.md"]);
    const manifest = await rig.manifest();
    const template = manifest.files["a.md"];
    if (template === undefined) throw new Error("entry expected");
    const files = { ...manifest.files, ...Object.fromEntries(Object.entries(extra).map(([path, blob]) => [path, { ...template, blob }] as const)) };
    const baseline: Baseline = { manifest: { ...manifest, files }, mtimes: { "a.md": 1000 } };
    return buildPublishPlan({
      keys: await rig.keys(),
      fs: rig.host.fs,
      client: rig.node.client,
      mfsRoot: ROOT,
      scanned: [{ path: "a.md", size: template.size, mtimeMs: 1000 }],
      baseline,
      view: { exists: false, rootCid: undefined, entries: new Map(), folders: [] },
      carried,
      ...(excluded === undefined ? {} : { excluded }),
    });
  }

  it("drops `.obsidian/app.json` (excluded) and `../x` (unsafe shape) from a carried list and queues their blobs for removal", async () => {
    const blobA = "a".repeat(52);
    // canonical base32 names (a 52-character name ends in a character whose low four bits are zero)
    const blobB = `${"b".repeat(51)}a`;
    const plan = await planWith({ ".obsidian/app.json": blobA, "../x": blobB, "CON.md": `${"c".repeat(51)}q` }, [".obsidian/app.json", "../x", "CON.md"], (path) => path.startsWith(".obsidian/"));

    expect(plan.carried).toEqual(["CON.md"]);
    expect(plan.dropped.map((entry) => entry.path)).toEqual(["../x", ".obsidian/app.json"]);
    expect(plan.dropped.find((entry) => entry.path === ".obsidian/app.json")?.reason).toContain("excluded");
    expect(plan.dropped.find((entry) => entry.path === "../x")?.reason).toContain("unsafe path");
    expect(Object.keys(plan.kept).sort()).toEqual(["CON.md", "a.md"]);
    expect(plan.blobRemovals).toEqual([blobMfsPath(blobA), blobMfsPath(blobB)].sort());
    expect(plan.removedPaths).toEqual([]);
  });

  it("a carried path the baseline does not hold is not carried", async () => {
    const plan = await planWith({}, ["missing.md"]);
    expect(plan.carried).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });
});

describe("publish: a file that changes while it is uploaded", () => {
  it("is left out of this publish, reported as skipped, and uploaded whole by the next one", async () => {
    const rig = await linuxVault(["note.md", "other.md"]);
    rig.host.put("note.md", "edited during upload", 2000);
    rig.host.put("other.md", "edited too", 2000);
    const original = rig.host.fs.readRange;
    Object.assign(rig.host.fs, {
      readRange: async (path: string, offset: number, length: number) => {
        if (path === "note.md") throw new FileChangedDuringReadError(path);
        return original(path, offset, length);
      },
    });
    rig.events.changed.length = 0;

    const result = await rig.publish();

    expect(result).toMatchObject({ published: true, written: 1, removed: 0 });
    expect(result.skipped.map((file) => file.path)).toEqual(["note.md"]);
    expect(rig.events.changed.map((event) => event.path)).toEqual(["other.md"]);
    expect(Object.keys((await rig.manifest()).files)).toEqual(["other.md"]);
    expect((await stateOf(rig)).mtimes).not.toHaveProperty("note.md");

    Object.assign(rig.host.fs, { readRange: original });
    const next = await rig.publish();
    expect(next).toMatchObject({ published: true, written: 1, skipped: [] });
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual(["note.md", "other.md"]);
  });
});
