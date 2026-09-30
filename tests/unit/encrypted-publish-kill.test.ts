import { beforeAll, describe, expect, it } from "vitest";
import { blobMfsPath, decryptBlobBytes } from "../../src/crypto";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { BlobTransferError } from "../../src/sync/encrypted-transfer";
import { sha256Hex } from "../../src/sync/hash";
import { readJournal } from "../../src/sync/journal";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { classifySequence } from "../../src/sync/sequence-rules";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, blobPaths, createRig, restoreRig, seedVault, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

/**
 * A kill after each step of the FULL publish path: every request that changes the node (blob writes, removals,
 * manifest, history file, pin, name publication) and every change to the local record (journal, state, journal
 * removal) is one step on one clock. A run is killed right after step k, then rerun. Each rerun must finish or
 * refuse specifically, must leave exactly one manifest.enc per sequence, no journal, a node tree that matches its
 * manifest blob for blob, and a published pointer at the verified root.
 *
 * Creating the publication key is not a step of the protocol (its ID is recorded by the host's config store); the
 * scenarios start with an owned key on the node.
 */

const OWNED = "k51owned";
const FIRST_STEPS = 10; // 3 blob writes, journal, manifest.enc, history, pin, publish, state, journal removal
const DELTA_STEPS = 10; // edit + add (2 writes), 1 removal, journal, manifest.enc, history, pin, publish, state, journal removal
const SLOTS_STEPS = 11; // the key-slot file (an interrupted init), then the ten steps of a first publish

async function firstPublishState(): Promise<RigSnapshot> {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  return snapshotRig(rig);
}

const EDITS = (rig: Rig): void => {
  rig.host.put("Daily/2026-09-30.md", "# Notes\nedited after the first publish.\n", 2000);
  rig.host.put("notes/new.md", "brand new note", 2000);
  rig.host.drop("attachment.bin");
};

/** `init` died after the local copy and before the node had the key slots: the first publish writes them first. */
async function missingSlotsState(): Promise<RigSnapshot> {
  const rig = restoreRig(await firstPublishState());
  rig.node.files.delete(`${ROOT}/keyslots.json`);
  return snapshotRig(rig);
}

async function deltaPublishState(): Promise<RigSnapshot> {
  const rig = restoreRig(await firstPublishState());
  await rig.publish();
  EDITS(rig);
  return snapshotRig(rig);
}

/** Sequences of every manifest.enc the node was ever sent, from the recorded write bodies. */
async function writtenSequences(rig: Rig): Promise<number[]> {
  const keys = await rig.keys();
  const bodies = rig.node.requests.filter((request) => request.line.startsWith("write ") && request.line.endsWith("/manifest.enc") && request.body !== undefined);
  return Promise.all(bodies.map(async (request) => (await decodeManifestFile(keys, request.body as Uint8Array)).sequence));
}

/** The node's tree equals its manifest, blob for blob, and every blob decrypts to the vault's current file. */
async function expectConsistent(rig: Rig, sequence: number): Promise<void> {
  const keys = await rig.keys();
  const manifest = await rig.manifest();
  expect(manifest.sequence).toBe(sequence);
  expect(manifest.rootCID).toBe(rig.node.cidOf(`${ROOT}/current`));
  expect(blobPaths(rig.node)).toHaveLength(Object.keys(manifest.files).length);
  for (const [path, entry] of Object.entries(manifest.files)) {
    const blobPath = `${ROOT}/${blobMfsPath(entry.blob)}`;
    expect(rig.node.cidOf(blobPath)).toBe(entry.cid);
    const plain = await decryptBlobBytes(keys, entry.blob, rig.node.files.get(blobPath) as Uint8Array, entry.fileId, entry.size);
    expect(await sha256Hex(plain)).toBe(entry.sha256);
    expect(entry.sha256).toBe(await sha256Hex(rig.host.files.get(path)?.data ?? new Uint8Array()));
  }
  expect(Object.keys(manifest.files).sort()).toEqual([...rig.host.files.keys()].filter((path) => !path.startsWith(".")).sort());
  expect(rig.node.files.get(`${ROOT}/manifests/${manifest.rootCID}.enc`)).toEqual(rig.node.files.get(`${ROOT}/manifest.enc`));
  const state = await readRootState(rig.host.kv, ROOT);
  expect(state?.sequence).toBe(sequence);
  expect(classifySequence(state, manifest)).toEqual({ kind: "in-sync" });
  expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
  const copy = rig.host.files.get(`.ipfs-sync/${rootFileNames(ROOT).keyslots}`)?.data;
  expect(rig.node.files.get(`${ROOT}/keyslots.json`)).toEqual(copy); // the node holds exactly the key slots this device keeps
  expect(rig.node.published.get(OWNED)).toBe(`/ipfs/${rig.node.cidOf(ROOT)}`);
  expect(state?.rootCid).toBe(rig.node.cidOf(ROOT));
}

/** A kill inside a blob write surfaces wrapped, as the pool reports every failed transfer; a real process would simply be gone. */
function isKill(error: unknown): boolean {
  return error instanceof NodeKilled || (error instanceof BlobTransferError && error.failures.some((failure) => failure.error instanceof NodeKilled));
}

async function killed(run: Promise<unknown>): Promise<void> {
  const error = await run.then(() => undefined, (failure: unknown) => failure);
  expect(isKill(error), error instanceof Error ? error.message : "the run was not killed").toBe(true);
}

async function killThenRerun(snapshot: RigSnapshot, step: number): Promise<Rig> {
  const rig = restoreRig(snapshot);
  rig.node.mutations = 0;
  rig.node.killAfterMutation = step;
  await killed(rig.publish());
  rig.node.killAfterMutation = undefined;
  await rig.publish();
  return rig;
}

describe.each([
  { name: "first publish", steps: FIRST_STEPS, sequence: 1, load: firstPublishState },
  { name: "edit, add and delete", steps: DELTA_STEPS, sequence: 2, load: deltaPublishState },
  { name: "first publish after an interrupted init (key slots not on the node)", steps: SLOTS_STEPS, sequence: 1, load: missingSlotsState },
])("kill matrix: $name", ({ steps, sequence, load }) => {
  let snapshot: RigSnapshot;

  beforeAll(async () => {
    snapshot = await load();
  }, 30_000);

  it("has exactly the steps this matrix covers", async () => {
    const rig = restoreRig(snapshot);
    rig.node.mutations = 0;
    await rig.publish();
    expect(rig.node.mutations).toBe(steps);
    await expectConsistent(rig, sequence);
  });

  it.each(Array.from({ length: steps }, (_, index) => index + 1))("a rerun after a kill following step %i converges", async (step) => {
    const rig = await killThenRerun(snapshot, step);
    await expectConsistent(rig, sequence);
    const sequences = await writtenSequences(rig);
    expect(new Set(sequences).size).toBe(sequences.length); // never a second manifest for one sequence
    expect(sequences.every((value) => value === sequence)).toBe(true);
  });

  it("a kill on every step of two consecutive runs still converges", async () => {
    const rig = restoreRig(snapshot);
    rig.node.mutations = 0;
    rig.node.killAfterMutation = 1;
    await killed(rig.publish());
    rig.node.mutations = 0;
    rig.node.killAfterMutation = steps - 1;
    await killed(rig.publish());
    rig.node.killAfterMutation = undefined;
    await rig.publish();
    await expectConsistent(rig, sequence);
  });
});

describe("kill matrix: an object planted while the publisher was down", () => {
  async function killedAfterManifest(): Promise<{ readonly rig: Rig; readonly prefix: string }> {
    const rig = restoreRig(await firstPublishState());
    rig.node.mutations = 0;
    rig.node.killAfterMutation = 5; // 3 blobs, journal, manifest.enc
    await killed(rig.publish());
    rig.node.killAfterMutation = undefined;
    const prefix = (blobPaths(rig.node)[0] as string).split("/").at(-2) ?? "aa";
    return { rig, prefix };
  }

  it("a blob-shaped stray under current/ is adopted around and removed by the drift path, never a lockout", async () => {
    const { rig, prefix } = await killedAfterManifest();
    const stray = `${ROOT}/current/${prefix}/${prefix}${"c".repeat(50)}`;
    rig.node.files.set(stray, new Uint8Array([1]));
    await rig.publish();
    expect(rig.node.files.has(stray)).toBe(false);
    await expectConsistent(rig, 2); // the interrupted sequence 1 was adopted, then sequence 2 published from the drift path
    expect(await writtenSequences(rig)).toEqual([1, 2]);
  });

  it("an unknown entry is adopted around and left in place", async () => {
    const { rig, prefix } = await killedAfterManifest();
    const unknown = `${ROOT}/current/${prefix}/notes.txt`;
    rig.node.files.set(unknown, new Uint8Array([1]));
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, sequence: 2, anomalies: 1 });
    expect(rig.node.files.has(unknown)).toBe(true);
  });
});
