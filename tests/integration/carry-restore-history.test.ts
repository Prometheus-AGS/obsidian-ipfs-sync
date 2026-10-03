// mvp-07a task 6.1: restore by explicit root, the carry-forward of paths a device could not restore (one bad blob, a name only another
// platform can write, entries of an older build), and mixed history names, through `publishVault` and the decrypting pull with real
// state, floor and locks over the recording fake node.
import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import { sortHistoryNames } from "../../src/sync/history-names";
import { readFloor } from "../../src/sync/sequence-floor";
import { currentRoot, expectOnlyReads, pointNameAt, resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import { ALL_FILES, DAILY, PLAN, addManifestEntries, blobReads, createDevices, deviceOf, editAndPublish, leftovers, mutatingCalls } from "../helpers/integration-devices";
import { createMemoryHost } from "../helpers/memory-host";
import { ROOT, SECRET_WORD, blobPaths } from "../helpers/publish-rig";
import { pulledOf } from "../helpers/pull-stage-rig";

const ORIGINAL_DAILY = `# Notes\nCall about ${SECRET_WORD}.\n`;
const SECOND_DAILY = "A second edition of the daily note.\n";

describe("replay by explicit root", () => {
  it("an older root by --root-cid is refused and names the flag; with the flag it restores, keeps the record, and the next publish carries the restored text", async () => {
    const { rig, node, a, b } = await createDevices();
    const olderRoot = servedRoot(node);
    await editAndPublish(rig, a, { [DAILY]: SECOND_DAILY });
    pulledOf(await b.pull());
    b.allowPublish();
    b.host.put("Later/kept.md", "added after the older version\n");
    const state = await b.state();
    const floorBefore = await readFloor(b.puller.store, state?.vaultId ?? "");
    const writesBefore = b.puller.store.writes.length;
    const target = { kind: "root-cid" as const, cid: olderRoot };

    // The explicit root of the newest manifest proceeds normally, with or without the flag.
    expect(pulledOf(await b.pull({ options: { target: { kind: "root-cid", cid: servedRoot(node) } } })).result.verdict).toBe("same");

    // Without the flag: refused, and the message names the flag (an explicit target may be accepted deliberately).
    resetNodeTrace(node);
    const refused = await b.pull({ options: { target } });
    expect(refused.kind).toBe("stopped");
    if (refused.kind === "stopped") {
      expect(refused.stop.reason).toBe("older");
      expect(refused.stop.message).toContain("--allow-rollback");
      expect(refused.stop.message).toContain("recorded sequence 2");
    }
    expect(b.texts()[DAILY]).toBe(SECOND_DAILY);
    expect(blobReads(node)).toEqual([]);
    expect(await b.state()).toEqual(state);

    // With the flag: the vault takes the older text, the record and the floor stay, restoredFrom is set, and the pull wrote nothing to the node.
    resetNodeTrace(node);
    const { result } = pulledOf(await b.pull({ options: { target, flags: { allowRollback: true } } }));
    expect(result.verdict).toBe("restore");
    expect(b.texts()[DAILY]).toBe(ORIGINAL_DAILY);
    expect(b.texts()["Later/kept.md"]).toBe("added after the older version\n");
    expectOnlyReads(node);
    expect(await b.state()).toMatchObject({ sequence: 2, highestSequence: 2, restoredFrom: 1, complete: true });
    expect(await readFloor(b.puller.store, state?.vaultId ?? "")).toEqual(floorBefore);
    expect(b.puller.store.writes.length).toBe(writesBefore);
    expect(leftovers(b.host)).toEqual([]);

    // A plain pull after the restore does not undo it: the restored files are local edits against the baseline.
    const plain = pulledOf(await b.pull());
    expect(plain.result.verdict).toBe("same");
    expect(plain.result.settlement.locallyModified).toContain(DAILY);
    expect(b.texts()[DAILY]).toBe(ORIGINAL_DAILY);

    // Restore never deletes and the restore is a local change against the baseline: the publish after it is sequence 3 with the restored text.
    const published = await editAndPublish(rig, b, {});
    expect(published).toMatchObject({ published: true, sequence: 3 });
    pulledOf(await a.pull());
    expect(a.texts()[DAILY]).toBe(ORIGINAL_DAILY);
    expect(a.texts()["Later/kept.md"]).toBe("added after the older version\n");
  });
});

describe("one bad blob, then a publish, then a good pull", () => {
  it("the publish succeeds and carries the failed entry unchanged; the later pull restores the path and leaves nothing unmaterialized", async () => {
    const { rig, node, a, b } = await createDevices();
    const first = await rig.manifest();
    const entry = first.files[PLAN];
    if (entry === undefined) throw new Error("the fixture changed");
    const blobCid = node.cidOf(`${ROOT}/${blobMfsPath(entry.blob)}`) as string;
    const original = node.bytesOf(blobCid) as Uint8Array;
    node.corruptRead = (cid) => {
      if (cid !== blobCid) return undefined;
      const flipped = Uint8Array.from(original);
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
      return flipped;
    };

    const { result } = pulledOf(await b.pull());
    expect(result.settlement.integrityFailed.map((problem) => problem.path)).toEqual([PLAN]);
    expect(b.texts()[PLAN]).toBeUndefined();
    expect(await b.state()).toMatchObject({ complete: false, unmaterialized: [PLAN] });

    // The failed path does not lock the device out: its publish carries the node's entry unchanged and does not count it as a removal.
    b.allowPublish();
    const published = await editAndPublish(rig, b, { [DAILY]: "B edited the daily note.\n" });
    expect(published).toMatchObject({ published: true, sequence: 2, removed: 0, carried: [PLAN] });
    const second = await rig.manifest();
    expect(second.files[PLAN]).toEqual(entry);
    expect(blobPaths(node)).toContain(`${ROOT}/${blobMfsPath(entry.blob)}`);
    expect(await b.state()).toMatchObject({ unmaterialized: [PLAN] });

    // The node's blob is good again: a pull restores the path, completes, and the carried list empties.
    node.corruptRead = undefined;
    const retry = pulledOf(await b.pull());
    expect(retry.result.verdict).toBe("same");
    expect(retry.result.settlement.restored).toEqual([PLAN]);
    expect(b.texts()[PLAN]).toBe(a.texts()[PLAN]);
    expect(await b.state()).toMatchObject({ complete: true, unmaterialized: [] });
    expect(b.texts()[DAILY]).toBe("B edited the daily note.\n");
  });
});

describe("a local edit of a path this device could not restore", () => {
  it("is not published (the carried entry is unchanged) and the next pull keeps it as a conflict copy beside the node's text", async () => {
    const { rig, node, a, b } = await createDevices();
    const first = await rig.manifest();
    const entry = first.files[PLAN];
    if (entry === undefined) throw new Error("the fixture changed");
    const blobCid = node.cidOf(`${ROOT}/${blobMfsPath(entry.blob)}`) as string;
    const original = node.bytesOf(blobCid) as Uint8Array;
    node.corruptRead = (cid) => (cid === blobCid ? Uint8Array.from(original, (byte, index) => (index === 40 ? byte ^ 1 : byte)) : undefined);
    expect(pulledOf(await b.pull()).result.settlement.integrityFailed.map((problem) => problem.path)).toEqual([PLAN]);

    b.allowPublish();
    b.host.put(PLAN, "B's own text for a plan it never received\n");
    const published = await editAndPublish(rig, b, { [DAILY]: "B edited the daily note.\n" });

    expect(published).toMatchObject({ published: true, written: 1, removed: 0, carried: [PLAN] });
    expect((await rig.manifest()).files[PLAN]).toEqual(entry);

    node.corruptRead = undefined;
    const { result } = pulledOf(await b.pull());
    const copy = result.settlement.conflicts.find((conflict) => conflict.path === PLAN)?.conflictPath ?? "";
    expect(copy).not.toBe("");
    expect(b.texts()[PLAN]).toBe(a.texts()[PLAN]);
    expect(b.texts()[copy]).toBe("B's own text for a plan it never received\n");
  });
});

describe("a name only another platform can write", () => {
  const linuxVault = (host: { put(path: string, content: string, mtimeMs?: number): void }): void => {
    host.put("CON.md", "written on Linux, where CON is an ordinary name\n", 1000);
    host.put("note.md", "an ordinary note\n", 1000);
  };

  it("survives the publish of a device that skips it: the manifest keeps the originating device's entry and blob", async () => {
    const { rig, node, b } = await createDevices({ seed: linuxVault });
    const first = await rig.manifest();
    const original = first.files["CON.md"];
    expect(original).toBeDefined();

    const { result } = pulledOf(await b.pull());
    expect(result.settlement.skipped).toMatchObject([{ path: "CON.md", severity: "unsafe", class: "platform" }]);
    expect(result.settlement.needsAttention).toBe(true);
    expect(b.texts()["CON.md"]).toBeUndefined();
    expect(await b.state()).toMatchObject({ unmaterialized: ["CON.md"] });

    b.allowPublish();
    const published = await editAndPublish(rig, b, { "note.md": "edited on the device that cannot hold CON.md\n" });
    expect(published).toMatchObject({ published: true, sequence: 2, removed: 0, carried: ["CON.md"] });
    const second = await rig.manifest();
    expect(second.files["CON.md"]).toEqual(original);
    expect(blobPaths(node)).toContain(`${ROOT}/${blobMfsPath(original?.blob ?? "")}`);
  });

  it("a Note.md and note.md pair is skipped on the pulling device and both entries survive its unrelated publish", async () => {
    const { rig, b } = await createDevices({
      seed: (host) => {
        host.put("Note.md", "capital note\n", 1000);
        host.put("note.md", "lower note\n", 1000);
      },
    });
    const first = await rig.manifest();
    expect(pulledOf(await b.pull()).result.settlement.skipped.map((skip) => skip.path)).toEqual(["Note.md", "note.md"]);

    b.allowPublish();
    const published = await editAndPublish(rig, b, { [DAILY]: "B edited the daily note.\n" });

    expect(published).toMatchObject({ published: true, removed: 0, carried: ["Note.md", "note.md"] });
    const second = await rig.manifest();
    expect(second.files["Note.md"]).toEqual(first.files["Note.md"]);
    expect(second.files["note.md"]).toEqual(first.files["note.md"]);
  });

  it("the publisher is warned that other devices will not restore the path", async () => {
    const { a } = await createDevices({ seed: linuxVault, publish: false });
    const result = await a.publish();
    expect(result.warnings.join("\n")).toContain("CON.md");
  });

  it("a fresh device on Linux does not write CON.md either: skipped as unsafe/platform (exit 1), recorded as unmaterialized, and its next publish carries the entry unchanged", async () => {
    const { rig, b } = await createDevices({ seed: linuxVault });
    const original = (await rig.manifest()).files["CON.md"];
    pulledOf(await b.pull());
    b.allowPublish();
    await editAndPublish(rig, b, { "note.md": "edited on the device that cannot hold CON.md\n" });
    const c = deviceOf(rig, createMemoryHost({ env: { IPFS_SYNC_DEVICE: "device-c" } }), "device-c");

    const { result } = pulledOf(await c.pull());

    // The path policy refuses Windows forms on every host: the name is never written, whatever the host.
    expect(result.settlement.skipped).toMatchObject([{ path: "CON.md", severity: "unsafe", class: "platform" }]);
    expect(result.settlement.needsAttention).toBe(true);
    expect(c.texts()["CON.md"]).toBeUndefined();
    expect(await c.state()).toMatchObject({ unmaterialized: ["CON.md"], complete: true });

    c.allowPublish();
    const published = await editAndPublish(rig, c, { "note.md": "edited on device C\n" });
    expect(published).toMatchObject({ published: true, removed: 0, carried: ["CON.md"] });
    expect((await rig.manifest()).files["CON.md"]).toEqual(original);
  });
});

describe("entries of an older build and the plugin path", () => {
  it("an .obsidian/ entry is skipped as expected (exit 0), is in neither baseline nor carry, and the next publish leaves it out", async () => {
    const { rig, node, b } = await createDevices();
    await addManifestEntries(rig, [".obsidian/app.json"]);

    const { result } = pulledOf(await b.pull());

    expect(result.settlement.skipped).toMatchObject([{ path: ".obsidian/app.json", severity: "expected" }]);
    expect(result.settlement.needsAttention).toBe(false);
    expect(result.settlement.complete).toBe(true);
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
    expect((await b.state())?.manifest.files[".obsidian/app.json"]).toBeUndefined();
    expect((await b.state())?.unmaterialized).toEqual([]);

    b.allowPublish();
    // The forged manifest was sequence 1 with other bytes: the node's name is already at it; B has nothing newer to say, so it edits.
    resetNodeTrace(node);
    const published = await editAndPublish(rig, b, { [DAILY]: "B edited the daily note.\n" });
    expect(published).toMatchObject({ published: true, sequence: 2, carried: [], removed: 0 });
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual(ALL_FILES);
  });

  it("an .obsidian/plugins/ entry is skipped as unsafe (exit 1), writes nothing, is not carried, and the next publish leaves it out", async () => {
    const { rig, b } = await createDevices();
    await addManifestEntries(rig, [".obsidian/plugins/x/main.js"]);

    const { result } = pulledOf(await b.pull());

    expect(result.settlement.skipped).toMatchObject([{ path: ".obsidian/plugins/x/main.js", severity: "unsafe", class: "shape" }]);
    expect(result.settlement.needsAttention).toBe(true);
    expect([...b.host.files.keys()].some((path) => path.startsWith(".obsidian/"))).toBe(false);
    expect((await b.state())?.unmaterialized).toEqual([]);
    expect((await b.state())?.manifest.files[".obsidian/plugins/x/main.js"]).toBeUndefined();

    b.allowPublish();
    const published = await editAndPublish(rig, b, { [DAILY]: "B edited the daily note.\n" });
    expect(published).toMatchObject({ published: true, carried: [] });
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual(ALL_FILES);
  });
});

describe("history names, legacy and prefixed", () => {
  it("a folder holding both forms is accepted by the next publish, and --manifest reads either form", async () => {
    const { rig, node, a, b } = await createDevices();
    const sequenceOne = (await rig.manifest()).rootCID;
    await editAndPublish(rig, a, { [DAILY]: SECOND_DAILY });
    const sequenceTwo = (await rig.manifest()).rootCID;

    // An mvp-06 development build wrote `<cid>.enc`: rename the first entry back to that form.
    const prefixedOne = [...node.files.keys()].find((path) => path.startsWith(`${ROOT}/manifests/0000000000000001-`));
    const bytes = prefixedOne === undefined ? undefined : node.files.get(prefixedOne);
    if (prefixedOne === undefined || bytes === undefined) throw new Error("the fixture changed");
    node.files.delete(prefixedOne);
    node.files.set(`${ROOT}/manifests/${sequenceOne}.enc`, bytes);
    pointNameAt(node);

    const published = await editAndPublish(rig, a, { [DAILY]: "A third edition of the daily note.\n" });
    expect(published).toMatchObject({ published: true, sequence: 3 });
    const names = [...node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`)).map((path) => path.slice(path.lastIndexOf("/") + 1));
    expect(names).toHaveLength(3);
    // The publisher's name form is `<16-digit sequence>-<tree cid>.enc`, and sorting the prefixed names gives the publish order.
    const sequenceThree = (await rig.manifest()).rootCID;
    expect(names).toContain(`0000000000000003-${sequenceThree}.enc`);
    expect(names).toContain(`0000000000000002-${sequenceTwo}.enc`);
    expect(names.filter((name) => /^\d{16}-/.test(name)).sort()).toEqual([`0000000000000002-${sequenceTwo}.enc`, `0000000000000003-${sequenceThree}.enc`]);
    // The reader's order: the legacy name first, then the prefixed names by sequence.
    const ordered = sortHistoryNames(names);
    expect(ordered.map((entry) => entry.sequence)).toEqual([undefined, 2, 3]);
    expect(ordered[0]?.name).toBe(`${sequenceOne}.enc`);

    // B pulls the newest, then restores the legacy entry and the prefixed one by tree CID, each by its own name form.
    pulledOf(await b.pull());
    resetNodeTrace(node);
    const legacy = pulledOf(await b.pull({ options: { target: { kind: "manifest", cid: sequenceOne }, flags: { allowRollback: true } } }));
    expect(legacy.result.verdict).toBe("restore");
    expect(legacy.result.sequence).toBe(1);
    expect(b.texts()[DAILY]).toBe(ORIGINAL_DAILY);
    const prefixed = pulledOf(await b.pull({ options: { target: { kind: "manifest", cid: sequenceTwo }, flags: { allowRollback: true } } }));
    expect(prefixed.result.sequence).toBe(2);
    expect(b.texts()[DAILY]).toBe(SECOND_DAILY);
    expectOnlyReads(node);
    expect(currentRoot(node)).toBeDefined();
    expect(mutatingCalls(node)).toEqual([]);
  });
});
