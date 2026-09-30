import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import { BlobTransferError } from "../../src/sync/encrypted-transfer";
import { WriteVerificationError } from "../../src/sync/publish-errors";
import { ReadBackError } from "../../src/sync/publish-refusals";
import { readJournal } from "../../src/sync/journal";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { ROOT, SECRET_FOLDER, SECRET_TITLE, blobPaths, createRig, seedVault, type Rig } from "../helpers/publish-rig";

const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const MIB = 1024 * 1024;

async function published(): Promise<Rig> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  await rig.publish();
  rig.node.calls.length = 0;
  return rig;
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);
const blobOf = async (rig: Rig, path: string): Promise<string> => `${ROOT}/${blobMfsPath((await rig.manifest()).files[path]?.blob ?? "")}`;
const writes = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("write "));
const removals = (rig: Rig): string[] => rig.node.calls.filter((call) => call.startsWith("rm "));

/** A removal may only ever name a blob under current/: never manifests/, keyslots.json or manifest.enc. */
function expectOnlyBlobRemovals(rig: Rig): void {
  for (const call of removals(rig)) expect(call).toMatch(/^rm .*\/current\/[a-z2-7]{2}\/[a-z2-7]{52}$/);
}

describe("encrypted publish: the baseline check diagnoses before it rewrites", () => {
  it("rewrites only the one blob that was replaced on the node, and uploads nothing else", async () => {
    const rig = await published();
    const others = blobPaths(rig.node);
    const target = await blobOf(rig, "attachment.bin");
    const before = new Map(others.map((path) => [path, rig.node.cidOf(path)]));
    rig.node.files.set(target, new Uint8Array(78).fill(9));
    rig.node.calls.length = 0;

    const result = await rig.publish({ ownedKeys: rig.owned });
    expect(result).toMatchObject({ published: true, written: 1, removed: 0, sequence: 2 });
    expect(writes(rig).map((call) => call.replace(/^write .*\/current\/.*/, "blob"))).toEqual(["blob", `write ${ROOT}/manifest.enc`, expect.stringContaining("/manifests/")]);
    expect(writes(rig)[0]).toBe(`write ${target}`);
    for (const path of others.filter((path) => path !== target)) expect(rig.node.cidOf(path)).toBe(before.get(path));
    expect((await rig.manifest()).files["attachment.bin"]?.cid).toBe(rig.node.cidOf(target));
    expect(rig.events.changed.filter((event) => event.path === "attachment.bin")).toHaveLength(1); // only the first publish's event
  });

  it("rewrites a blob that went missing from the node", async () => {
    const rig = await published();
    const target = await blobOf(rig, "Daily/2026-09-30.md");
    rig.node.files.delete(target);
    rig.node.calls.length = 0;
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ written: 1, sequence: 2 });
    expect(rig.node.files.has(target)).toBe(true);
  });

  it("removes blob-shaped names that the new manifest does not list (an earlier run died before its manifest)", async () => {
    const rig = await published();
    const prefix = (await blobOf(rig, "attachment.bin")).split("/").at(-2) ?? "aa";
    const stray = `${ROOT}/current/${prefix}/${prefix}${"a".repeat(50)}`;
    await rig.node.client.filesWrite(stray, new Uint8Array([1, 2, 3]));
    rig.node.calls.length = 0;
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, written: 0, removed: 0, sequence: 2 });
    expect(rig.node.files.has(stray)).toBe(false);
    expect(removals(rig)).toEqual([`rm ${stray}`]);
    expectOnlyBlobRemovals(rig);
  });

  it("reports an entry that is not a blob and leaves it where it is, even while publishing other changes", async () => {
    const rig = await published();
    const prefix = (await blobOf(rig, "attachment.bin")).split("/").at(-2) ?? "aa";
    const unknown = `${ROOT}/current/${prefix}/notes.txt`;
    await rig.node.client.filesWrite(unknown, new Uint8Array([1]));
    rig.node.calls.length = 0;

    // The snapshot changed without a publication, so the device publishes once to re-baseline; the entry is reported, not removed.
    const first = await rig.publish({ ownedKeys: rig.owned });
    expect(first).toMatchObject({ published: true, written: 0, anomalies: 1, sequence: 2 });
    expect(writes(rig).some((call) => call.includes("/current/"))).toBe(false);
    expect(removals(rig)).toEqual([]);
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: false });

    rig.host.put("notes/new.md", "new", 5000);
    const busy = await rig.publish({ ownedKeys: rig.owned });
    expect(busy).toMatchObject({ published: true, written: 1, sequence: 3 });
    expect(rig.node.files.has(unknown)).toBe(true);
    expect(removals(rig)).toEqual([]);
  });

  it("removals never name manifests/, keyslots.json or manifest.enc", async () => {
    const rig = await published();
    const prefix = (await blobOf(rig, "attachment.bin")).split("/").at(-2) ?? "aa";
    await rig.node.client.filesWrite(`${ROOT}/current/${prefix}/${prefix}${"b".repeat(50)}`, new Uint8Array([1]));
    rig.host.drop("attachment.bin");
    rig.node.calls.length = 0;
    await rig.publish({ ownedKeys: rig.owned });
    expect(removals(rig).length).toBe(2);
    expectOnlyBlobRemovals(rig);
    expect(rig.node.files.has(`${ROOT}/keyslots.json`)).toBe(true);
    expect(rig.node.files.has(`${ROOT}/manifest.enc`)).toBe(true);
  });

  it("refuses to upload more than 256 MiB of lost files again without an explicit go-ahead, and asks when it can", async () => {
    const rig = await published();
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    // Pretend the recorded attachment is 257 MiB: unchanged by size and time, so it is never read, only found missing.
    const entry = state.manifest.files["attachment.bin"];
    if (entry === undefined) throw new Error("entry expected");
    await writeRootState(rig.host.kv, buildRootState({ ...state, manifest: { ...state.manifest, files: { ...state.manifest.files, "attachment.bin": { ...entry, size: 257 * MIB } } } }));
    rig.host.put("attachment.bin", new Uint8Array(257 * MIB), 1000);
    rig.node.files.delete(await blobOf(rig, "attachment.bin"));
    rig.node.calls.length = 0;

    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "large-reupload" });
    const asked: number[] = [];
    await expect(rig.publish({ ownedKeys: rig.owned, confirmFullReupload: async (bytes) => (asked.push(bytes), false) })).rejects.toMatchObject({ code: "large-reupload" });
    expect(asked).toEqual([257 * MIB]);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});

describe("encrypted publish: writes are verified and failures leave the published pointer alone", () => {
  it("stops on a short write, names no plaintext path, publishes nothing, and a rerun converges", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    rig.node.shortWriteFor = /\/current\//;
    const error = await rejection(rig.publish());
    expect(error).toBeInstanceOf(BlobTransferError);
    expect(((error as BlobTransferError).failures[0]?.error) instanceof WriteVerificationError).toBe(true);
    for (const secret of [SECRET_TITLE, SECRET_FOLDER, "attachment", "Daily"]) expect((error as Error).message).not.toContain(secret);
    expect(rig.node.calls.some((call) => call.startsWith("publish ") || call.startsWith("pin "))).toBe(false);
    expect(await readRootState(rig.host.kv, ROOT)).toBeUndefined();
    expect(rig.events.completed).toEqual([]);

    rig.node.shortWriteFor = undefined;
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, written: 3, sequence: 1 });
  });

  it("stops when a write is rejected, does not advance the record, and a rerun converges", async () => {
    const rig = await published();
    rig.host.put("notes/new.md", "new", 5000);
    rig.node.failWriteFor = /\/current\//;
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toBeInstanceOf(BlobTransferError);
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(1);
    expect(rig.node.calls.some((call) => call.startsWith("publish "))).toBe(false);
    rig.node.failWriteFor = undefined;
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, written: 1, sequence: 2 });
  });

  it("converges after a partial removal (the blob is already gone from the node)", async () => {
    const rig = await published();
    rig.node.files.delete(await blobOf(rig, "attachment.bin"));
    rig.host.drop("attachment.bin");
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, removed: 1 });
  });
});

describe("encrypted publish: the read-back before the pin", () => {
  it("stops before the pin when an extra top-level entry appears after the manifest was written, and finishes once it is gone", async () => {
    const rig = await published();
    rig.host.put("notes/new.md", "new", 5000);
    rig.node.afterWrite = (path) => {
      if (path.endsWith("/manifest.enc")) rig.node.files.set(`${ROOT}/planted.txt`, new Uint8Array([1]));
    };
    rig.node.calls.length = 0;
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toBeInstanceOf(ReadBackError);
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
    expect((await readJournal(rig.host.kv, ROOT)).kind).toBe("ok");

    rig.node.afterWrite = undefined;
    rig.node.files.delete(`${ROOT}/planted.txt`);
    const result = await rig.publish({ ownedKeys: rig.owned });
    expect(result).toMatchObject({ written: 0 });
    expect((await rig.manifest()).sequence).toBe(2);
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect(rig.node.calls.filter((call) => call.startsWith("publish ")).length).toBe(1);
  });

  it("does not lock the publisher out when the extra entry stays: the pending state is adopted and the entry named", async () => {
    const rig = await published();
    rig.host.put("notes/new.md", "new", 5000);
    rig.node.afterWrite = (path) => {
      if (path.endsWith("/manifest.enc")) rig.node.files.set(`${ROOT}/planted.txt`, new Uint8Array([1]));
    };
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toBeInstanceOf(ReadBackError);
    rig.node.afterWrite = undefined;
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "unexpected-root-entry" });
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect((await readRootState(rig.host.kv, ROOT))?.sequence).toBe(2);
    // the stray is removed by hand; the adopted, never-published state publishes at the next sequence
    rig.node.files.delete(`${ROOT}/planted.txt`);
    expect(await rig.publish({ ownedKeys: rig.owned })).toMatchObject({ published: true, sequence: 3 });
  });

  it("stops before the pin when a blob is swapped after the manifest was written", async () => {
    const rig = await published();
    rig.host.put("notes/new.md", "new", 5000);
    const target = blobPaths(rig.node)[0] as string;
    rig.node.afterWrite = (path) => {
      if (path.endsWith("/manifest.enc")) rig.node.files.set(target, new Uint8Array(99));
    };
    rig.node.calls.length = 0;
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toBeInstanceOf(ReadBackError);
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
  });

  it("refuses when the history file for the snapshot already holds different bytes, before writing manifest.enc", async () => {
    const rig = await published();
    const before = rig.node.files.get(`${ROOT}/manifest.enc`);
    rig.host.put("attachment.bin", new Uint8Array([9, 9]), 3000);
    rig.node.afterWrite = (path) => {
      if (path.includes("/current/")) rig.node.files.set(`${ROOT}/manifests/${rig.node.cidOf(`${ROOT}/current`)}.enc`, new Uint8Array([1, 2, 3]));
    };
    rig.node.calls.length = 0;
    await expect(rig.publish({ ownedKeys: rig.owned })).rejects.toMatchObject({ code: "history-conflict" });
    expect(rig.node.files.get(`${ROOT}/manifest.enc`)).toEqual(before);
    expect(writes(rig).some((call) => call.endsWith("/manifest.enc"))).toBe(false);
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  });
});
