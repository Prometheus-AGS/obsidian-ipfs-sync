import { describe, expect, it } from "vitest";
import { WRITE_CHUNK_BYTES, writeFileToMfs, type WriteClient } from "../../src/sync/chunked-write";
import { WriteVerificationError } from "../../src/sync/publish-errors";
import { POOL_MAX_CONCURRENCY, runPool } from "../../src/sync/pool";
import { createMemoryHost } from "../helpers/memory-host";

const MIB = 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runPool", () => {
  it("never exceeds 6 in flight and keeps at least 4 running while work remains", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const samplesWhileWorkRemains: number[] = [];
    const items = Array.from({ length: 100 }, (_, index) => index);
    const outcome = await runPool(items, async (item) => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      // Ramp-up (the first lane starts) and drain-down (the last items) are excluded.
      if (item >= POOL_MAX_CONCURRENCY && item < items.length - POOL_MAX_CONCURRENCY) samplesWhileWorkRemains.push(inFlight);
      await delay(1 + (item % 3));
      inFlight -= 1;
      return item * 2;
    });
    expect(maxSeen).toBe(6);
    expect(Math.min(...samplesWhileWorkRemains)).toBeGreaterThanOrEqual(4);
    expect(outcome.failures).toEqual([]);
    expect(outcome.completed.map((c) => c.value)).toEqual(items.map((i) => i * 2));
  });

  it("clamps a larger request to 6", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    await runPool(
      Array.from({ length: 30 }, (_, i) => i),
      async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await delay(2);
        inFlight -= 1;
      },
      50,
    );
    expect(maxSeen).toBe(6);
  });

  it("starts no new work after the first failure and lets running items finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const outcome = await runPool(
      Array.from({ length: 40 }, (_, i) => i),
      async (item) => {
        started.push(item);
        await delay(3);
        if (item === 2) throw new Error("node said no");
        finished.push(item);
        return item;
      },
    );
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.item).toBe(2);
    expect(started.length).toBeLessThan(40);
    expect(started.length).toBeLessThanOrEqual(2 + POOL_MAX_CONCURRENCY);
    expect(finished).toEqual(expect.arrayContaining([0, 1]));
  });
});

describe("writeFileToMfs", () => {
  function fakeClient(reportedSize?: (path: string, written: number) => number) {
    const writes: { path: string; length: number; offset: number | undefined; truncate: boolean | undefined }[] = [];
    let written = 0;
    const client: WriteClient = {
      filesWrite: async (path, data, options) => {
        writes.push({ path, length: data.length, offset: options?.offset, truncate: options?.truncate });
        written += data.length;
      },
      filesStat: async (path) => ({
        cid: "bafkreifilecid0000",
        size: reportedSize?.(path, written) ?? written,
        cumulativeSize: written,
        type: "file",
      }),
    };
    return { client, writes };
  }

  it("sends a small file in one request and returns the stat CID", async () => {
    const host = createMemoryHost();
    host.put("a.md", "hello");
    const { client, writes } = fakeClient();
    const result = await writeFileToMfs(client, host.fs, "a.md", "/obsidian-vault-sync/default/current/a.md", 5);
    expect(writes).toEqual([{ path: "/obsidian-vault-sync/default/current/a.md", length: 5, offset: undefined, truncate: undefined }]);
    expect(result).toEqual({ cid: "bafkreifilecid0000", size: 5 });
  });

  it("sends a 40 MB file as 5 chunks at offsets 0, 8, 16, 24, 32 MB with only the first truncating", async () => {
    const host = createMemoryHost();
    host.put("big.bin", new Uint8Array(40 * MIB));
    const { client, writes } = fakeClient();
    await writeFileToMfs(client, host.fs, "big.bin", "/obsidian-vault-sync/default/current/big.bin", 40 * MIB);
    expect(writes.map((w) => w.offset)).toEqual([0, 8 * MIB, 16 * MIB, 24 * MIB, 32 * MIB]);
    expect(writes.map((w) => w.truncate)).toEqual([true, false, false, false, false]);
    expect(Math.max(...writes.map((w) => w.length))).toBeLessThanOrEqual(WRITE_CHUNK_BYTES);
    expect(host.reads.wholeReads).toEqual([]);
  });

  it("uses a single request at exactly 32 MB", async () => {
    const host = createMemoryHost();
    host.put("edge.bin", new Uint8Array(32 * MIB));
    const { client, writes } = fakeClient();
    await writeFileToMfs(client, host.fs, "edge.bin", "/obsidian-vault-sync/default/current/edge.bin", 32 * MIB);
    expect(writes).toHaveLength(1);
  });

  it("fails the file when files/stat reports a different size", async () => {
    const host = createMemoryHost();
    host.put("short.md", "hello");
    const { client } = fakeClient((_path, written) => written - 1);
    const error = await writeFileToMfs(client, host.fs, "short.md", "/obsidian-vault-sync/default/current/short.md", 5).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WriteVerificationError);
    expect((error as WriteVerificationError).message).toContain('"short.md"');
    expect((error as WriteVerificationError).expected).toBe(5);
    expect((error as WriteVerificationError).actual).toBe(4);
  });
});
