import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { blobNameFor, toHex, type Bytes, type VaultKeys } from "../../src/crypto";
import { createBlobEncryptionWith, encryptBlobBytesWith } from "../../src/crypto/blob";
import type { HostFs } from "../../src/core/host-bridge";
import { BlobFetchError, fetchBlobToTemp, sweepStaleParts, type BlobFetchEntry } from "../../src/sync/blob-fetch";
import { BlobSourceError, gatewayBlobSource, type BlobSource } from "../../src/sync/blob-source";
import { TEMP_DIR } from "../../src/sync/temp-files";
import { keysFrom } from "../vectors/blob-helpers";
import { ascending } from "../vectors/bytes";
import { createMemoryHost } from "../helpers/memory-host";

const EXPONENT = 16;
const SEGMENT = 2 ** EXPONENT;

const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));
const pattern = (length: number): Bytes => Uint8Array.from({ length }, (_, index) => (index * 7 + (index >> 8)) & 255);

interface Fixture {
  readonly keys: VaultKeys;
  readonly name: string;
  readonly plaintext: Bytes;
  readonly blob: Bytes;
  readonly entry: BlobFetchEntry;
}

async function fixture(path = "notes/a.md", plaintext: Bytes = pattern(SEGMENT * 2 + 1234)): Promise<Fixture> {
  const keys = await keysFrom(0x20, 0x50);
  const name = await blobNameFor(keys, path);
  const { blob, fileId } = await encryptBlobBytesWith(keys, name, plaintext, { exponent: EXPONENT });
  return { keys, name, plaintext, blob, entry: { fileId, size: plaintext.length, sha256: sha(plaintext) } };
}

/** A source that hands out the bytes in small pieces, optionally failing or stopping early. */
function pieces(bytes: Uint8Array, options: { readonly pieceSize?: number; readonly stopAt?: number; readonly failAt?: number; readonly closed?: { count: number } } = {}): BlobSource {
  const pieceSize = options.pieceSize ?? 5000;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for (let offset = 0; offset < bytes.length; offset += pieceSize) {
        if (options.failAt !== undefined && offset >= options.failAt) throw new Error("socket hang up");
        if (options.stopAt !== undefined && offset >= options.stopAt) return;
        yield bytes.slice(offset, Math.min(bytes.length, offset + pieceSize));
      }
    } finally {
      if (options.closed !== undefined) options.closed.count += 1;
    }
  }
  return { totalLength: bytes.length, chunks: { [Symbol.asyncIterator]: chunks } };
}

const partFiles = (host: ReturnType<typeof createMemoryHost>): string[] => [...host.files.keys()].filter((path) => path.startsWith(TEMP_DIR));

async function failureOf(promise: Promise<unknown>): Promise<BlobFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BlobFetchError);
    return error as BlobFetchError;
  }
  throw new Error("expected the fetch to fail");
}

describe("fetchBlobToTemp", () => {
  it("decrypts a multi-segment blob into a part file and returns it unrenamed", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    host.put("notes/a.md", "local text");
    const staged = await fetchBlobToTemp({ fs: host.fs, newId: () => "one" }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob) });
    expect(staged).toEqual({ temp: `${TEMP_DIR}/one.part`, size: f.plaintext.length, sha256: f.entry.sha256 });
    expect(host.files.get(staged.temp)?.data).toEqual(f.plaintext);
    expect(textOf(host.files.get("notes/a.md")?.data ?? new Uint8Array())).toBe("local text");
    expect(host.mutations.some((m) => m.startsWith("rename"))).toBe(false);
  });

  it("handles an empty file", async () => {
    const host = createMemoryHost();
    const f = await fixture("empty.md", new Uint8Array(0));
    const staged = await fetchBlobToTemp({ fs: host.fs, newId: () => "e" }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob) });
    expect(staged.size).toBe(0);
    expect(host.files.get(staged.temp)?.data.length).toBe(0);
  });

  it("fails one flipped bit as integrity-failed, leaves the destination alone and leaves no part file", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    host.put("notes/a.md", "local text");
    for (const position of [30, SEGMENT + 100, f.blob.length - 5]) {
      const bad = f.blob.slice();
      bad[position] = (bad[position] ?? 0) ^ 1;
      const error = await failureOf(fetchBlobToTemp({ fs: host.fs, newId: () => "x" }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(bad) }));
      expect(error.outcome).toBe("integrity-failed");
      expect(error.reason).toBe("authentication-failed");
      expect(partFiles(host)).toEqual([]);
    }
    expect(textOf(host.files.get("notes/a.md")?.data ?? new Uint8Array())).toBe("local text");
    expect(host.mutations.every((m) => m.includes(TEMP_DIR))).toBe(true);
  });

  it("fails the blob of another path", async () => {
    const host = createMemoryHost();
    const a = await fixture("notes/a.md");
    const bName = await blobNameFor(a.keys, "notes/b.md");
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: a.keys, nodeName: bName, entry: a.entry, source: pieces(a.blob) }));
    expect(error.outcome).toBe("integrity-failed");
    expect(error.reason).toBe("authentication-failed");
    expect(partFiles(host)).toEqual([]);
  });

  it("fails a replayed older blob whose file identifier is not the manifest's", async () => {
    const host = createMemoryHost();
    const older = await fixture("notes/a.md", pattern(1000));
    const newer = await fixture("notes/a.md", pattern(1000));
    expect(older.entry.fileId).not.toBe(newer.entry.fileId);
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: newer.keys, nodeName: newer.name, entry: newer.entry, source: pieces(older.blob) }));
    expect(error.outcome).toBe("integrity-failed");
    expect(error.reason).toBe("manifest-mismatch");
    expect(partFiles(host)).toEqual([]);
  });

  it("fails a header whose identifier was changed", async () => {
    const host = createMemoryHost();
    const f = await fixture("notes/a.md", pattern(1000));
    const bad = f.blob.slice();
    bad[6] = (bad[6] ?? 0) ^ 0xff;
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(bad) }));
    expect(error.reason).toBe("manifest-mismatch");
    expect(partFiles(host)).toEqual([]);
  });

  it("fails a blob whose length does not fit the manifest's size", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: { ...f.entry, size: f.entry.size + 1 }, source: pieces(f.blob) }));
    expect(error.reason).toBe("manifest-mismatch");
    expect(partFiles(host)).toEqual([]);
  });

  it("fails an exponent above 24 and a bad magic before any segment is decrypted", async () => {
    const host = createMemoryHost();
    const f = await fixture("notes/a.md", pattern(1000));
    const wide = f.blob.slice();
    wide[5] = 25;
    const magic = f.blob.slice();
    magic[0] = 0x58;
    for (const bad of [wide, magic]) {
      const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(bad) }));
      expect(error.outcome).toBe("integrity-failed");
      expect(error.reason).toBe("malformed-blob");
    }
    expect(partFiles(host)).toEqual([]);
  });

  it("fails a wrong sha256 in the manifest after full authentication, and removes the part file", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: { ...f.entry, sha256: "0".repeat(64) }, source: pieces(f.blob) }));
    expect(error.reason).toBe("hash-mismatch");
    expect(partFiles(host)).toEqual([]);
  });

  it("leaves nothing when the stream breaks, and closes the source", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const closed = { count: 0 };
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob, { failAt: SEGMENT + 500, closed }) }));
    expect(error.outcome).toBe("integrity-failed");
    expect(error.reason).toBe("fetch-failed");
    expect(partFiles(host)).toEqual([]);
    expect(closed.count).toBe(1);
  });

  it("leaves nothing when the stream ends early, and when it carries extra bytes", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const short = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob, { stopAt: SEGMENT + 500 }) }));
    expect(short.reason).toBe("malformed-blob");
    const extra = new Uint8Array(f.blob.length + 10);
    extra.set(f.blob);
    const long = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: { totalLength: f.blob.length, chunks: pieces(extra).chunks } }));
    expect(long.reason).toBe("malformed-blob");
    expect(partFiles(host)).toEqual([]);
  });

  it("counts a write failure as unfetched with the reason, not as tampering, and removes the part file", async () => {
    const host = createMemoryHost();
    host.failOn.append = /\.part$/;
    const f = await fixture();
    const closed = { count: 0 };
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs, newId: () => "w" }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob, { closed }) }));
    expect(error.outcome).toBe("unfetched");
    expect(error.reason).toBe("could-not-write");
    expect(error.message).toBe("could not write");
    expect(partFiles(host)).toEqual([]);
    expect(host.mutations).toContain(`remove ${TEMP_DIR}/w.part`);
    expect(closed.count).toBe(1);
  });

  it("counts a failure to create the part file as unfetched", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const broken: Pick<HostFs, "write" | "append" | "remove"> = { ...host.fs, write: () => Promise.reject(new Error("disk full")) };
    const error = await failureOf(fetchBlobToTemp({ fs: broken }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(f.blob) }));
    expect(error.outcome).toBe("unfetched");
  });

  it("puts no passphrase-derived or key material in an error message", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const bad = f.blob.slice();
    bad[40] = (bad[40] ?? 0) ^ 1;
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source: pieces(bad) }));
    const shown = `${error.message} ${error.name} ${error.reason} ${error.outcome}`;
    expect(shown).not.toContain(toHex(ascending(0x50, 32)));
    expect(shown).not.toContain(f.name);
    expect(shown).not.toContain("notes/a.md");
  });
});

describe("a 100 MiB file", () => {
  it("never has more than two segments between the source and the part file", async () => {
    const exponent = 20;
    const segment = 2 ** exponent;
    const wire = segment + 28;
    const size = 100 * 1024 * 1024;
    const keys = await keysFrom(0x20, 0x50);
    const name = await blobNameFor(keys, "big/file.bin");
    const encryption = await createBlobEncryptionWith({ keys, nodeName: name, size }, { exponent });

    const read = async (offset: number, length: number): Promise<Bytes> => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = (offset + i) & 255;
      return out;
    };

    let produced = 0;
    let appended = 0;
    let appendCalls = 0;
    let largestAppend = 0;
    let maxLead = 0;
    const fs: Pick<HostFs, "write" | "append" | "remove"> = {
      write: async () => undefined,
      append: async (_path, data) => {
        appended += data.length;
        appendCalls += 1;
        largestAppend = Math.max(largestAppend, data.length);
      },
      remove: async () => undefined,
    };
    const piece = 16 * 1024;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for await (const part of encryption.chunks(read)) {
        for (let offset = 0; offset < part.length; offset += piece) {
          produced += Math.min(piece, part.length - offset);
          // Wire bytes the source has handed out that the part file has not yet received as plaintext.
          maxLead = Math.max(maxLead, produced - 22 - appended - 28 * appendCalls);
          yield part.subarray(offset, Math.min(part.length, offset + piece));
        }
      }
    }
    // The expected hash is only known once the generator has read the data, so verify with an independent pass.
    const expected = sha256.create();
    for (let offset = 0; offset < size; offset += segment) {
      const part = new Uint8Array(Math.min(segment, size - offset));
      for (let i = 0; i < part.length; i++) part[i] = (offset + i) & 255;
      expected.update(part);
    }
    const entry: BlobFetchEntry = { fileId: encryption.fileId, size, sha256: bytesToHex(expected.digest()) };

    const staged = await fetchBlobToTemp({ fs, newId: () => "big" }, { keys, nodeName: name, entry, source: { totalLength: encryption.blobLength, chunks: { [Symbol.asyncIterator]: chunks } } });
    expect(staged.size).toBe(size);
    expect(staged.sha256).toBe(entry.sha256);
    expect(appended).toBe(size);
    expect(largestAppend).toBeLessThanOrEqual(segment);
    expect(maxLead).toBeLessThan(2 * wire);
  }, 60_000);
});

describe("gatewayBlobSource", () => {
  const client = (status: number, body: Uint8Array, seen: { count: number; args: unknown[] }) => ({
    gatewayStream: async (cid: string, path?: string, range?: unknown) => {
      seen.args.push([cid, path, range]);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          for (let offset = 0; offset < body.length; offset += 4000) yield body.slice(offset, offset + 4000);
        } finally {
          seen.count += 1;
        }
      }
      return { status, contentRange: undefined, chunks: chunks() };
    },
  });

  it("streams one plain request with no Range and feeds the fetch", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const seen = { count: 0, args: [] as unknown[] };
    const source = gatewayBlobSource(client(200, f.blob, seen), { cid: "bafyroot", path: `${f.name.slice(0, 2)}/${f.name}`, totalLength: f.blob.length });
    expect(seen.args).toEqual([]);
    const staged = await fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source });
    expect(host.files.get(staged.temp)?.data).toEqual(f.plaintext);
    expect(seen.args).toEqual([["bafyroot", `${f.name.slice(0, 2)}/${f.name}`, undefined]]);
  });

  it("refuses a status other than 200 and releases the response", async () => {
    const host = createMemoryHost();
    const f = await fixture();
    const seen = { count: 0, args: [] as unknown[] };
    const source = gatewayBlobSource(client(206, f.blob, seen), { cid: "bafyroot", path: "ab/x", totalLength: f.blob.length });
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: f.keys, nodeName: f.name, entry: f.entry, source }));
    expect(error.reason).toBe("fetch-failed");
    expect(error.cause).toBeInstanceOf(BlobSourceError);
    expect(seen.count).toBe(1);
    expect(partFiles(host)).toEqual([]);
  });
});

describe("sweepStaleParts", () => {
  it("removes part files only and counts failures without stopping", async () => {
    const host = createMemoryHost();
    host.put(`${TEMP_DIR}/a-1.part`, "x");
    host.put(`${TEMP_DIR}/b2.part`, "y");
    host.put(`${TEMP_DIR}/keep.txt`, "z");
    host.put(`${TEMP_DIR}/sub/inner.part`, "w");
    expect(await sweepStaleParts(host.fs)).toEqual({ removed: 2, failed: 0 });
    expect([...host.files.keys()].sort()).toEqual([`${TEMP_DIR}/keep.txt`, `${TEMP_DIR}/sub/inner.part`]);

    host.put(`${TEMP_DIR}/c.part`, "1");
    host.put(`${TEMP_DIR}/d.part`, "2");
    const flaky: Pick<HostFs, "stat" | "list" | "remove"> = {
      stat: host.fs.stat,
      list: host.fs.list,
      remove: async (path) => {
        if (path.endsWith("c.part")) throw new Error("busy");
        await host.fs.remove(path);
      },
    };
    expect(await sweepStaleParts(flaky)).toEqual({ removed: 1, failed: 1 });
    expect(host.files.has(`${TEMP_DIR}/d.part`)).toBe(false);
  });

  it("removes stale conflict-copy temps (<id>.copy) and leaves other names and nested paths alone", async () => {
    const host = createMemoryHost();
    host.put(`${TEMP_DIR}/part-4.copy`, "x");
    host.put(`${TEMP_DIR}/9f8e-1.copy`, "y");
    host.put(`${TEMP_DIR}/notes.md`, "z");
    host.put(`${TEMP_DIR}/sub/inner.copy`, "w");
    host.put(`${TEMP_DIR}/a.b.copy`, "v");
    expect(await sweepStaleParts(host.fs)).toEqual({ removed: 2, failed: 0 });
    expect([...host.files.keys()].sort()).toEqual([`${TEMP_DIR}/a.b.copy`, `${TEMP_DIR}/notes.md`, `${TEMP_DIR}/sub/inner.copy`]);
  });

  it("does nothing when the folder does not exist", async () => {
    expect(await sweepStaleParts(createMemoryHost().fs)).toEqual({ removed: 0, failed: 0 });
  });
});
