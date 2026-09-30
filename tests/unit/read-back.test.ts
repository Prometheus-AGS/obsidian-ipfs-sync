import { beforeAll, describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import type { SnapshotExpectation } from "../../src/sync/commit-ports";
import { createSnapshotVerifier } from "../../src/sync/read-back";
import { ReadBackError } from "../../src/sync/publish-refusals";
import { restoreNode, snapshotNode, type FakeNode, type NodeSnapshot } from "../helpers/fake-kubo";
import { ROOT, createRig, seedVault } from "../helpers/publish-rig";

interface Fixture {
  readonly rig: { readonly node: FakeNode };
  readonly rootCid: string;
  readonly expected: SnapshotExpectation;
  readonly written: Map<string, string>;
  readonly keySlots: Uint8Array<ArrayBuffer>;
}

interface Base {
  readonly snapshot: NodeSnapshot;
  readonly expected: SnapshotExpectation;
  readonly written: ReadonlyMap<string, string>;
}

let base: Base;

/** One published vault, built once; every test works on its own copy of the node. */
async function build(): Promise<Base> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  await rig.publish();
  const manifest = await rig.manifest();
  return {
    snapshot: snapshotNode(rig.node),
    expected: { manifest, manifestFile: Uint8Array.from(rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array) },
    written: new Map(Object.values(manifest.files).map((entry) => [entry.blob, entry.cid] as const)),
  };
}

beforeAll(async () => {
  base = await build();
}, 30_000);

async function fixture(): Promise<Fixture> {
  const node = restoreNode(base.snapshot);
  return {
    rig: { node },
    rootCid: node.cidOf(ROOT) as string,
    expected: base.expected,
    written: new Map(base.written),
    keySlots: Uint8Array.from(node.files.get(`${ROOT}/keyslots.json`) as Uint8Array),
  };
}

const verifier = (f: Fixture, overrides: { readonly written?: ReadonlyMap<string, string>; readonly keySlots?: Uint8Array<ArrayBuffer> } = {}) =>
  createSnapshotVerifier({ client: f.rig.node.client, keySlots: overrides.keySlots ?? f.keySlots, written: overrides.written ?? f.written });

describe("the read-back before the pin", () => {
  it("accepts the snapshot that was written, for a publish that wrote blobs and for one that wrote none", async () => {
    const f = await fixture();
    await expect(verifier(f)(f.rootCid, f.expected)).resolves.toBeUndefined();
    await expect(verifier(f, { written: new Map() })(f.rootCid, f.expected)).resolves.toBeUndefined();
  });

  it("stops when a blob written in this run has another CID than the one recorded at write time", async () => {
    const f = await fixture();
    const [name] = [...f.written.keys()];
    const wrong = new Map(f.written).set(name as string, f.written.get(name as string)?.replace(/.$/, (c) => (c === "a" ? "b" : "a")) ?? "");
    await expect(verifier(f, { written: wrong })(f.rootCid, f.expected)).rejects.toThrow(/not the object that was written/);
  });

  it("stops when a blob written in this run is missing from its prefix folder", async () => {
    const f = await fixture();
    const missing = new Map(f.written).set(`aa${"a".repeat(50)}`, f.written.values().next().value as string);
    await expect(verifier(f, { written: missing })(f.rootCid, f.expected)).rejects.toThrow(/^read-back of the snapshot failed: a touched prefix folder is missing from the snapshot$/);
  });

  it("stops when keyslots.json differs from the local copy", async () => {
    const f = await fixture();
    const other = Uint8Array.from(f.keySlots);
    other[10] = (other[10] ?? 0) ^ 1;
    await expect(verifier(f, { keySlots: other })(f.rootCid, f.expected)).rejects.toThrow(/keyslots\.json/);
  });

  it("stops when manifest.enc differs from the bytes just written", async () => {
    const f = await fixture();
    const other = Uint8Array.from(f.expected.manifestFile);
    other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 1;
    await expect(verifier(f)(f.rootCid, { ...f.expected, manifestFile: other })).rejects.toThrow(/manifest\.enc/);
  });

  it("stops when current/ is not the tree the manifest describes", async () => {
    const f = await fixture();
    const manifest = { ...f.expected.manifest, rootCID: `b${"a".repeat(58)}` };
    await expect(verifier(f)(f.rootCid, { ...f.expected, manifest })).rejects.toThrow(/current\//);
  });

  it("stops when the history file for the snapshot is missing", async () => {
    const f = await fixture();
    f.rig.node.files.delete(`${ROOT}/manifests/${f.expected.manifest.rootCID}.enc`);
    const root = f.rig.node.cidOf(ROOT) as string;
    await expect(verifier(f)(root, f.expected)).rejects.toThrow(/history file/);
  });

  it("stops when the history file holds other bytes than the manifest", async () => {
    const f = await fixture();
    f.rig.node.files.set(`${ROOT}/manifests/${f.expected.manifest.rootCID}.enc`, new Uint8Array([1, 2, 3]));
    await expect(verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected)).rejects.toThrow(/history file/);
  });

  it("stops when manifests/ holds a name that is not <cid>.enc", async () => {
    const f = await fixture();
    f.rig.node.files.set(`${ROOT}/manifests/notes.txt`, new Uint8Array([1]));
    await expect(verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected)).rejects.toThrow(/manifests\//);
  });

  it("stops on an extra top-level entry, and on a top-level entry of the wrong kind", async () => {
    const f = await fixture();
    f.rig.node.files.set(`${ROOT}/stray.txt`, new Uint8Array([1]));
    await expect(verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected)).rejects.toThrow(/unexpected top-level/);
    f.rig.node.files.delete(`${ROOT}/stray.txt`);
    f.rig.node.files.delete(`${ROOT}/keyslots.json`);
    f.rig.node.dirs.add(`${ROOT}/keyslots.json`);
    await expect(verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected)).rejects.toThrow(/keyslots\.json/);
  });

  it("reports a listing over the client cap as a ReadBackError, so a cap can never wedge a journal", async () => {
    const f = await fixture();
    for (let index = 0; index < 2001; index += 1) f.rig.node.files.set(`${ROOT}/manifests/b${index.toString(32).padStart(58, "w")}.enc`, new Uint8Array([1]));
    const failure = await verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReadBackError);
    expect((failure as Error).message).toMatch(/manifests\/ is too large to list/);
  });

  it("stops on a root identifier that is not a CID, and reports a read-back verdict as a ReadBackError", async () => {
    const f = await fixture();
    const failure = await verifier(f)("../../etc", f.expected).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReadBackError);
    expect(blobMfsPath([...f.written.keys()][0] as string)).toMatch(/^current\//);
  });

  it("N3-07: a snapshot file larger than what was written is a ReadBackError, not a size refusal", async () => {
    const f = await fixture();
    f.rig.node.files.set(`${ROOT}/manifest.enc`, new Uint8Array(f.expected.manifestFile.length + 10));
    const failure = await verifier(f)(f.rig.node.cidOf(ROOT) as string, f.expected).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReadBackError);
    expect((failure as Error).message).toBe("read-back of the snapshot failed: manifest.enc in the snapshot is not the file that was written (wrong kind or size)");
  });

  it("W-09: reads each expected object with a cap of its own expected length, never 64 MiB", async () => {
    const f = await fixture();
    const lengths: number[] = [];
    const real = f.rig.node.client;
    const spy = { ipfsLs: real.ipfsLs.bind(real), gatewayStream: (...args: Parameters<typeof real.gatewayStream>) => (lengths.push(args[2]?.length ?? -1), real.gatewayStream(...args)) };
    await createSnapshotVerifier({ client: spy, keySlots: f.keySlots, written: new Map() })(f.rootCid, f.expected);
    const allowed = new Set([f.expected.manifestFile.length + 1, f.keySlots.length + 1]);
    expect(lengths.length).toBeGreaterThanOrEqual(2);
    expect(lengths.every((length) => allowed.has(length))).toBe(true);
  });
});
