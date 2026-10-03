// mvp-07a task 6.1: the plugin's decrypting pull over a gateway that honours Range and over one that ignores it, through the plugin's
// pull runner (`createPullRunner`) and the real engine, against a vault published by another device. Nothing here ran in Obsidian: the
// transport is the recording fake node, not `requestUrl` (a 07b operator-run assertion).
import { describe, expect, it } from "vitest";
import { blobMfsPath } from "../../src/crypto";
import { createDevices, mutatingCalls, type Devices } from "../helpers/integration-devices";
import { pluginThrough, publishFromPlugin, rangeLoggingClient } from "../helpers/integration-plugin";

const MIB = 1024 * 1024;
/** One ciphertext segment on the wire at the writer's exponent 23. */
const WIRE_SEGMENT = 2 ** 23 + 28;
const MEDIUM = "Big/volume.bin";
const LARGE = "Big/library.bin";
/** `<tree cid>/<two letters>/<52-character blob name>` */
const BLOB_TARGET = /\/[a-z2-7]{2}\/[a-z2-7]{52}$/;

/** A buffer that differs from segment to segment without costing a callback per byte. */
function filled(length: number, salt: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 4093) bytes[index] = ((index >> 12) + salt) & 255 || 1;
  return bytes;
}

async function publishedWith(files: Record<string, Uint8Array<ArrayBuffer>>): Promise<Devices> {
  return createDevices({
    seed: (host) => {
      for (const [path, data] of Object.entries(files)) host.put(path, data, 1000);
    },
  });
}

const blobPathOf = async (devices: Devices, path: string): Promise<string> => {
  const entry = (await devices.rig.manifest()).files[path];
  if (entry === undefined) throw new Error("the fixture changed");
  return blobMfsPath(entry.blob).replace(/^current\//, "");
};

const bytesAt = (adapter: { files: Map<string, { data: ArrayBuffer | Uint8Array }> }, path: string): Uint8Array => new Uint8Array(adapter.files.get(path)?.data ?? new ArrayBuffer(0));

describe("plugin pull over a gateway that honours Range", () => {
  it("probes the smallest blob alone first, then fetches a 9 MiB file one segment-aligned range at a time, byte for byte", async () => {
    const original = filled(9 * MIB, 1);
    const devices = await publishedWith({ [MEDIUM]: original });
    const gateway = rangeLoggingClient(devices.node.client, "honour");
    const b = pluginThrough(devices.rig, gateway.client);

    const outcome = await b.pull();

    expect(outcome.kind).toBe("completed");
    expect(Buffer.compare(Buffer.from(bytesAt(b.adapter, MEDIUM)), Buffer.from(original))).toBe(0);
    for (const path of ["Daily/2026-09-30.md", "attachment.bin", "Projects/Secret Merger/Quarterly plan.md"]) expect(b.texts()[path], path).toBe(devices.a.texts()[path]);
    const smallest = await blobPathOf(devices, "attachment.bin");
    // Blob reads only (the key slots and the manifest are read first, through the same gateway).
    const blobReads = gateway.reads.filter((read) => BLOB_TARGET.test(read.target));
    expect(blobReads[0]).toMatchObject({ range: { start: 0, length: 22 }, status: 206 });
    expect(blobReads[0]?.target.endsWith(smallest)).toBe(true);
    const bigBlob = await blobPathOf(devices, MEDIUM);
    const bigReads = blobReads.filter((read) => read.target.endsWith(bigBlob));
    expect(bigReads.map((read) => [read.range?.start, read.range?.length, read.status])).toEqual([
      [0, 22, 206],
      [22, WIRE_SEGMENT, 206],
      [22 + WIRE_SEGMENT, 1 * MIB + 28, 206],
    ]);
    expect(mutatingCalls(devices.node)).toEqual([]);
    expect(await b.state()).toMatchObject({ complete: true, unmaterialized: [] });
  });
});

describe("plugin pull over a gateway that ignores Range", () => {
  it("a file within the whole-body limit is fetched whole; a file above it is unfetched with no request for it, the others arrive, and the retry on an honouring gateway completes", async () => {
    const medium = filled(9 * MIB, 2);
    const large = filled(33 * MIB, 3);
    const devices = await publishedWith({ [MEDIUM]: medium, [LARGE]: large });
    const ignoring = rangeLoggingClient(devices.node.client, "ignore");
    const b = pluginThrough(devices.rig, ignoring.client);

    const outcome = await b.pull();

    expect(outcome.kind).toBe("unfinished");
    if (outcome.kind !== "unfinished") return;
    expect(outcome.report.unfetched.map((note) => note.path)).toEqual([LARGE]);
    expect(outcome.report.unfetched[0]?.reason).toMatch(/Range/);
    expect(outcome.report.integrityFailed).toEqual([]);
    expect(outcome.notice).toContain("Pull incomplete");
    expect(Buffer.compare(Buffer.from(bytesAt(b.adapter, MEDIUM)), Buffer.from(medium))).toBe(0);
    expect(b.texts()[LARGE]).toBeUndefined();
    const largeBlob = await blobPathOf(devices, LARGE);
    expect(ignoring.reads.filter((read) => read.target.endsWith(largeBlob))).toEqual([]);
    expect(ignoring.reads.every((read) => read.status === 200)).toBe(true);
    expect(await b.state()).toMatchObject({ complete: false, unmaterialized: [LARGE] });
    expect(mutatingCalls(devices.node)).toEqual([]);

    // The same plugin data over a gateway that honours Range: the pull restores the path and the record completes.
    const honouring = rangeLoggingClient(devices.node.client, "honour");
    const retry = pluginThrough(devices.rig, honouring.client, { adapter: b.adapter, store: b.store });
    expect((await retry.pull()).kind).toBe("completed");
    expect(Buffer.compare(Buffer.from(bytesAt(retry.adapter, LARGE)), Buffer.from(large))).toBe(0);
    expect(await retry.state()).toMatchObject({ complete: true, unmaterialized: [] });
  });

  it("a plugin device that could not fetch the large file still publishes: the file stays in the vault for every other device", async () => {
    const devices = await publishedWith({ [LARGE]: filled(33 * MIB, 4) });
    const first = await devices.rig.manifest();
    const b = pluginThrough(devices.rig, rangeLoggingClient(devices.node.client, "ignore").client);
    const pulled = await b.pull();
    expect(pulled.kind).toBe("unfinished");
    b.adapter.put(".ipfs-sync-fixture", "fixture\n");
    b.adapter.put("From the phone.md", "written in the plugin\n", 9000);

    const published = await publishFromPlugin(b);

    expect(published.kind).toBe("published");
    const second = await devices.rig.manifest();
    expect(second.sequence).toBe(2);
    expect(second.files[LARGE]).toEqual(first.files[LARGE]);
    expect(Object.keys(second.files)).toContain("From the phone.md");
  });
});
