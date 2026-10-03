import { beforeAll, describe, expect, it } from "vitest";
import { BLOB_WRITER_EXPONENT, blobLength, blobMfsPath, decryptBlobBytes } from "../../src/crypto";
import { sha256Hex } from "../../src/sync/hash";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import type { SkippedFile } from "../../src/sync/diff";
import { BlobTransferError, removeBlobPaths, writeEncryptedBlobs, type TransferContext } from "../../src/sync/encrypted-transfer";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { NodeKilled, createFakeNode } from "../helpers/fake-kubo";
import { POOL_DEFAULT_CONCURRENCY } from "../../src/sync/pool";
import { MemoryAdapter } from "../support/memory-adapter";
import { KEY, ROOT, createRig, restoreRig, snapshotRig, type Rig, type RigSnapshot } from "../helpers/publish-rig";

const SEGMENT = 2 ** BLOB_WRITER_EXPONENT;
const MIB = 1024 * 1024;
const OVERHEAD = 28;
const HEADER = 22;

let vault: RigSnapshot;

/** One initialised vault (its key slots cost one derivation), copied for every test. */
beforeAll(async () => {
  // The publication key already exists and is owned: creating it is not part of what these tests are about.
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: "k51owned" }]) });
  rig.owned.push("k51owned");
  await rig.init();
  vault = snapshotRig(rig);
}, 30_000);

async function rigWith(files: Record<string, Uint8Array<ArrayBuffer>>, concurrency?: number): Promise<Rig> {
  const rig = restoreRig(vault, concurrency === undefined ? {} : { concurrency });
  for (const [path, data] of Object.entries(files)) rig.host.put(path, data, 1000);
  return rig;
}

/** Deterministic, not repetitive at segment size, and fast to make even at 20 MiB. */
function patterned(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) data[index] = (index * 31 + (index >> 8)) & 0xff;
  return data;
}
const blobWrites = (rig: Rig) => rig.node.requests.filter((request) => request.line.startsWith("write ") && request.line.includes("/current/"));

describe("encrypted transfer: segments, offsets and memory", () => {
  it("sends a small file (up to 1 MiB) in one request, header and segment together", async () => {
    const rig = await rigWith({ "one.bin": patterned(MIB) });
    await rig.publish();
    const writes = blobWrites(rig);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body?.length).toBe(blobLength(MIB));
    expect(writes[0]?.offset).toBeUndefined();
  });

  it("sends the header alone before a single segment larger than 1 MiB, so the segment is never copied to make room for it", async () => {
    const rig = await rigWith({ "mid.bin": patterned(MIB + 1) });
    await rig.publish();
    const writes = blobWrites(rig);
    expect(writes.map((write) => write.body?.length)).toEqual([HEADER, MIB + 1 + OVERHEAD]);
    expect(writes.map((write) => write.offset)).toEqual([undefined, HEADER]);
  });

  it("sends a 20 MiB file as its header, then three segments at increasing offsets, none larger than one segment", async () => {
    const data = patterned(20 * MIB);
    const rig = await rigWith({ "big.bin": data });
    await rig.publish();
    const writes = blobWrites(rig);
    expect(writes.map((write) => write.body?.length)).toEqual([HEADER, SEGMENT + OVERHEAD, SEGMENT + OVERHEAD, 4 * MIB + OVERHEAD]);
    expect(writes.map((write) => write.offset)).toEqual([undefined, HEADER, HEADER + SEGMENT + OVERHEAD, HEADER + 2 * (SEGMENT + OVERHEAD)]);
    expect(writes.map((write) => write.truncate)).toEqual([true, false, false, false]);
    expect(Math.max(...writes.map((write) => write.body?.length ?? 0))).toBeLessThanOrEqual(SEGMENT + OVERHEAD);

    // The host is only asked for one segment at a time, and the file is never read whole (not even to hash it).
    expect(Math.max(...rig.host.reads.rangeLengths)).toBeLessThanOrEqual(SEGMENT);
    expect(rig.host.reads.wholeReads).not.toContain("big.bin");

    const entry = (await rig.manifest()).files["big.bin"];
    const blob = rig.node.files.get(`${ROOT}/${blobMfsPath(entry?.blob ?? "")}`) as Uint8Array;
    expect(blob.length).toBe(HEADER + 3 * OVERHEAD + 20 * MIB);
    const plain = await decryptBlobBytes(await rig.keys(), entry?.blob ?? "", blob, entry?.fileId ?? "", entry?.size ?? 0);
    expect(await sha256Hex(plain)).toBe(await sha256Hex(data as Uint8Array<ArrayBuffer>));
    expect(entry?.sha256).toBe(await sha256Hex(data as Uint8Array<ArrayBuffer>));
  }, 30_000);

  it("puts the boundary between one and two segments at exactly 8 MiB", async () => {
    const rig = await rigWith({ "exact.bin": patterned(SEGMENT), "plus-one.bin": patterned(SEGMENT + 1) });
    await rig.publish();
    const perBlob = new Map<string, number>();
    for (const write of blobWrites(rig)) perBlob.set(write.line, (perBlob.get(write.line) ?? 0) + 1);
    expect([...perBlob.values()].sort()).toEqual([2, 3]); // exact: header, one segment; plus one: header, segment, segment
  });

  it("writes an empty file as a 50-byte blob without asking the host for any bytes", async () => {
    const rig = await rigWith({ "empty.md": new Uint8Array(0) });
    await rig.publish();
    const entry = (await rig.manifest()).files["empty.md"];
    expect(entry?.size).toBe(0);
    expect(entry?.sha256).toBe(await sha256Hex(new Uint8Array(0)));
    expect(rig.node.files.get(`${ROOT}/${blobMfsPath(entry?.blob ?? "")}`)?.length).toBe(HEADER + OVERHEAD);
    expect(rig.host.reads.rangeLengths).toEqual([]);
  });

  it("records the hash of the bytes it actually encrypted when the file changed after it was scanned", async () => {
    const rig = await rigWith({ "note.md": new TextEncoder().encode("first version!") });
    const read = rig.host.fs.readRange.bind(rig.host.fs);
    rig.host.fs.readRange = async (path, offset, length) => (path === "note.md" ? new TextEncoder().encode("other version!").slice(0, length) : read(path, offset, length));
    await rig.publish();
    const entry = (await rig.manifest()).files["note.md"];
    expect(entry?.sha256).toBe(await sha256Hex(new TextEncoder().encode("other version!")));
    expect(entry?.sha256).not.toBe(await sha256Hex(new TextEncoder().encode("first version!")));
  });

  it("stops without publishing when a file is shorter at upload time than when it was scanned", async () => {
    const rig = await rigWith({ "note.md": new TextEncoder().encode("0123456789") });
    const read = rig.host.fs.readRange.bind(rig.host.fs);
    rig.host.fs.readRange = async (path, offset, length) => (path === "note.md" ? (await read(path, offset, length)).slice(0, length - 1) : read(path, offset, length));
    const error = await rig.publish().then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect(error).toMatchObject({ code: "file-changed" });
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish ") || (call.startsWith("write ") && call.endsWith("/manifest.enc")))).toBe(false);
  });
});

describe("encrypted transfer: a kill in the middle of a multi-segment blob", () => {
  it.each([1, 2, 3])("a kill after request %i of a 9 MiB blob (header, segment, segment) leaves a truncated blob that the rerun replaces", async (step) => {
    const rig = await rigWith({ "big.bin": patterned(9 * MIB), "small.md": new TextEncoder().encode("small") });
    rig.node.mutations = 0;
    rig.node.killAfterMutation = step;
    const error = await rig.publish().then(() => undefined, (failure: unknown) => failure);
    const killed = error instanceof NodeKilled || (error instanceof BlobTransferError && error.failures.some((failure) => failure.error instanceof NodeKilled));
    expect(killed).toBe(true);
    rig.node.killAfterMutation = undefined;
    const result = await rig.publish({ ownedKeys: rig.owned });
    expect(result).toMatchObject({ published: true, sequence: 1 });
    const manifest = await rig.manifest();
    for (const [path, entry] of Object.entries(manifest.files)) {
      const blob = rig.node.files.get(`${ROOT}/${blobMfsPath(entry.blob)}`) as Uint8Array;
      const plain = await decryptBlobBytes(await rig.keys(), entry.blob, blob, entry.fileId, entry.size);
      expect(await sha256Hex(plain)).toBe(entry.sha256);
      expect(entry.size).toBe(plain.length);
      expect(path.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

describe("encrypted transfer: many files at once", () => {
  it("uploads 40 small files with the default concurrency, every blob verified, and a second run sends nothing", async () => {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (let index = 0; index < 40; index += 1) files[`bulk/note-${String(index).padStart(2, "0")}.md`] = new TextEncoder().encode(`note number ${index}`);
    const rig = await rigWith(files);
    const first = await rig.publish({ concurrency: undefined });
    expect(first).toMatchObject({ published: true, written: 40, sequence: 1 });
    expect(blobWrites(rig)).toHaveLength(40);
    rig.node.calls.length = 0;
    expect(await rig.publish({ ownedKeys: rig.owned, concurrency: undefined })).toMatchObject({ published: false, written: 0 });
    expect(rig.node.calls.filter((call) => /^(write|rm|pin|publish) /.test(call))).toEqual([]);
  }, 30_000);
});

describe("encrypted transfer: what an error may say, and which errors keep their code", () => {
  it("names a file that cannot be read by its blob only: the host's message, which holds the path, stays as the cause", async () => {
    const rig = await rigWith({ "Secret Merger/plan.md": new TextEncoder().encode("body") });
    rig.host.fs.readRange = async (path) => {
      throw new Error(`EACCES: permission denied, open '/home/me/vault/${path}'`);
    };
    const error = await rig.publish().then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: "file-unreadable" });
    expect((error as Error).message).not.toMatch(/Secret Merger|plan\.md|EACCES|\/home/);
    expect(((error as Error).cause as Error).message).toContain("EACCES");
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
  });

  it("rethrows a lost publish lock with its code instead of wrapping it in a transfer error", async () => {
    const rig = await rigWith({ "a.md": new TextEncoder().encode("a"), "b.md": new TextEncoder().encode("b"), "c.md": new TextEncoder().encode("c") });
    let calls = 0;
    const error = await rig
      .publish({
        assertHeld: () => {
          calls += 1;
          if (calls === 3) throw new PublishRefusedError("lock-lost", "the publish lock was taken over");
        },
      })
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect(error).toMatchObject({ code: "lock-lost" });
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
  });

  it("cuts and cleans a node-supplied error message before it is shown", async () => {
    const rig = await rigWith({ "a.md": new TextEncoder().encode("a") });
    const write = rig.node.client.filesWrite;
    rig.node.client.filesWrite = async (path, data, options) => {
      if (path.includes("/current/")) throw new Error(`evil\u001b[2J\u001b[31m ${"x".repeat(500)}`);
      return write(path, data, options);
    };
    const error = (await rig.publish().then(() => undefined, (failure: unknown) => failure)) as Error;
    expect(error).toBeInstanceOf(BlobTransferError);
    expect(error.message).not.toContain("\u001b");
    expect(error.message.length).toBeLessThan(400);
  });

  it("refuses a CID the manifest cannot carry as soon as the blob is written, before any further upload (serial: one write at a time)", async () => {
    const rig = await rigWith({ "a.md": new TextEncoder().encode("a"), "b.md": new TextEncoder().encode("b") }, 1);
    rig.node.cidLie = (name) => (/^[a-z2-7]{52}$/.test(name) ? "not a cid at all" : undefined);
    const error = await rig.publish().then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: "remote-object-invalid" });
    expect(rig.node.calls.filter((call) => call.startsWith("write ") && call.includes("/current/"))).toHaveLength(1);
  });

  it("refuses a CID the manifest cannot carry with the real pool: no more blob writes than the pool holds, and nothing published after", async () => {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {};
    for (let index = 0; index < POOL_DEFAULT_CONCURRENCY * 3; index += 1) files[`f${index}.md`] = new TextEncoder().encode(`file ${index}`);
    const rig = await rigWith(files);
    rig.node.cidLie = (name) => (/^[a-z2-7]{52}$/.test(name) ? "not a cid at all" : undefined);
    const error = await rig.publish().then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: "remote-object-invalid" });
    const started = rig.node.calls.filter((call) => call.startsWith("write ") && call.includes("/current/")).length;
    expect(started).toBeGreaterThanOrEqual(1);
    expect(started).toBeLessThanOrEqual(POOL_DEFAULT_CONCURRENCY);
    expect(rig.node.calls.some((call) => call.includes("manifest.enc") && call.startsWith("write "))).toBe(false);
    expect(rig.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
  });

  it("never removes anything but a blob under current/, whatever it is asked", async () => {
    const rig = await rigWith({ "a.md": new TextEncoder().encode("a") });
    const ctx = { client: rig.node.client, mfsRoot: ROOT, beforeWrite: () => undefined, concurrency: 1 };
    for (const path of ["keyslots.json", "manifest.enc", `manifests/${"b".repeat(59)}.enc`, "current/ab/notes.md", `current/ab/${"c".repeat(52)}`, `current/ab/ac${"d".repeat(50)}x`]) {
      await expect(removeBlobPaths(ctx, [path])).rejects.toMatchObject({ code: "remote-object-invalid" });
    }
    expect(rig.node.calls.filter((call) => call.startsWith("rm "))).toEqual([]);
  });

  it("bounds a remote read by asking for at most the cap plus one byte", async () => {
    const rig = await rigWith({ "a.md": new TextEncoder().encode("a") });
    await rig.publish();
    const ranges = rig.node.calls.filter((call) => call.startsWith("GET ") && call.includes("Range: bytes=0-"));
    const written = (rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array).length;
    expect(ranges.some((call) => call.endsWith("bytes=0-16384"))).toBe(true); // keyslots.json: 16 KiB + 1 (the node read before unlocking)
    expect(ranges.some((call) => call.endsWith(`bytes=0-${written}`))).toBe(true); // read-back of manifest.enc: its expected length + 1 (W-09)
    expect(ranges.some((call) => call.endsWith(`bytes=0-${64 * MIB}`))).toBe(false); // no read-back with the 64 MiB cap
  });
});

describe("encrypted transfer: a file edited while it is uploaded (W-16, Obsidian adapter)", () => {
  async function setup(size: number, onSkipped?: (file: SkippedFile) => void) {
    const rig = await rigWith({});
    const adapter = new MemoryAdapter();
    adapter.put("big.bin", patterned(size), 1000);
    const { fs } = createObsidianHostBridge({ adapter });
    const ctx: TransferContext = { client: rig.node.client, fs, keys: await rig.keys(), mfsRoot: ROOT, concurrency: 2, beforeWrite: () => undefined, onSkipped };
    return { rig, adapter, fs, ctx };
  }

  it("skips a two-segment file edited between its segments with a notice, and uploads it whole on the next run", async () => {
    const skipped: SkippedFile[] = [];
    const { rig, adapter, fs, ctx } = await setup(SEGMENT + MIB, (file) => void skipped.push(file));
    const readRange = fs.readRange.bind(fs);
    let edited = false;
    const editing: TransferContext = {
      ...ctx,
      fs: {
        readRange: async (path, offset, length) => {
          const chunk = await readRange(path, offset, length);
          if (!edited) {
            edited = true;
            adapter.put("big.bin", patterned(SEGMENT + MIB), 2000);
          }
          return chunk;
        },
      },
    };
    const first = await writeEncryptedBlobs(editing, [{ path: "big.bin", size: SEGMENT + MIB }]);
    expect(first).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toBe("big.bin");
    expect(skipped[0]?.reason).toContain("next one");

    adapter.reads.length = 0;
    const second = await writeEncryptedBlobs(ctx, [{ path: "big.bin", size: SEGMENT + MIB }]);
    expect(second).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(adapter.reads).toEqual(["big.bin"]);
    const blob = rig.node.files.get(`${ROOT}/${blobMfsPath(second[0]?.blob ?? "")}`) as Uint8Array;
    const plain = await decryptBlobBytes(await rig.keys(), second[0]?.blob ?? "", blob, second[0]?.fileId ?? "", SEGMENT + MIB);
    expect(await sha256Hex(plain)).toBe(second[0]?.sha256);
  }, 30_000);

  it("reads a file once per upload, however many segments it has", async () => {
    const { adapter, ctx } = await setup(2 * SEGMENT + MIB);
    const written = await writeEncryptedBlobs(ctx, [{ path: "big.bin", size: 2 * SEGMENT + MIB }]);
    expect(written).toHaveLength(1);
    expect(adapter.reads).toEqual(["big.bin"]);
  }, 30_000);

  it("stops the publish with the file-changed refusal when nobody listens for skipped files", async () => {
    const { adapter, fs, ctx } = await setup(SEGMENT + MIB);
    const readRange = fs.readRange.bind(fs);
    const editing: TransferContext = {
      ...ctx,
      fs: {
        readRange: async (path, offset, length) => {
          const chunk = await readRange(path, offset, length);
          adapter.put("big.bin", patterned(SEGMENT + MIB), 3000);
          return chunk;
        },
      },
    };
    const error = await writeEncryptedBlobs(editing, [{ path: "big.bin", size: SEGMENT + MIB }]).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect(error).toMatchObject({ code: "file-changed" });
  }, 30_000);
});
