import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "../../src/core/store";
import type { ConflictRecord, PublishRecord, PullRecord } from "../../src/core/store";

function publishRecord(rootCid: string, occurredAtMs: number): PublishRecord {
  return {
    kind: "publish",
    occurredAtMs,
    rootCid,
    manifestCid: `manifest-of-${rootCid}`,
    written: 3,
    removed: 1,
    durationMs: 12,
  };
}

function pullRecord(rootCid: string, occurredAtMs: number): PullRecord {
  return {
    kind: "pull",
    occurredAtMs,
    rootCid,
    manifestCid: `manifest-of-${rootCid}`,
    fetched: 2,
    unchanged: 5,
    conflicted: 0,
    failed: 0,
    remoteDeleted: 0,
    locallyModified: 1,
    durationMs: 30,
  };
}

function conflictRecord(rootCid: string, occurredAtMs: number): ConflictRecord {
  return {
    kind: "conflict",
    occurredAtMs,
    rootCid,
    localSha256: "aa",
    remoteSha256: "bb",
  };
}

describe("in-memory store", () => {
  it("returns an empty list and no pointer before anything is appended", async () => {
    const store = createInMemoryStore();
    expect(await store.list(0)).toEqual([]);
    expect(await store.getLastManifest()).toBeUndefined();
  });

  it("lists records newest-first by occurredAtMs and honours the limit", async () => {
    const store = createInMemoryStore();
    await store.append(publishRecord("bafy-oldest", 100));
    await store.append(pullRecord("bafy-middle", 300));
    await store.append(publishRecord("bafy-newest", 200));

    const all = await store.list(0);
    expect(all.map((r) => r.rootCid)).toEqual(["bafy-middle", "bafy-newest", "bafy-oldest"]);

    const capped = await store.list(2);
    expect(capped.map((r) => r.rootCid)).toEqual(["bafy-middle", "bafy-newest"]);

    const one = await store.list(1);
    expect(one.map((r) => r.rootCid)).toEqual(["bafy-middle"]);
  });

  it("breaks occurredAtMs ties by insertion order, newest first", async () => {
    const store = createInMemoryStore();
    await store.append(publishRecord("bafy-op", 500));
    await store.append(conflictRecord("bafy-op", 500));

    const rows = await store.list(0);
    expect(rows.map((r) => r.kind)).toEqual(["conflict", "publish"]);
  });

  it("round-trips the last-manifest pointer", async () => {
    const store = createInMemoryStore();
    const pointer = { manifestCid: "bafy-cur", rootCid: "bafy-root", updatedAtMs: 1_700_000_000_000 };
    await store.setLastManifest(pointer);
    expect(await store.getLastManifest()).toEqual(pointer);

    const later = { manifestCid: "bafy-cur-2", rootCid: "bafy-root-2", updatedAtMs: 1_700_000_001_000 };
    await store.setLastManifest(later);
    expect(await store.getLastManifest()).toEqual(later);
  });

  it("returns the appended record objects unchanged", async () => {
    const store = createInMemoryStore();
    const record = pullRecord("bafy-pull", 42);
    await store.append(record);
    const rows = await store.list(1);
    expect(rows[0]).toEqual(record);
  });
});
