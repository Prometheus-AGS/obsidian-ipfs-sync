import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyStoreDirectory } from "../../cli/store/location";
import { SCHEMA_VERSION } from "../../cli/store/schema";
import { HistoryStoreError, openHistoryStore } from "../../cli/store/pglite-store";
import type { ConflictRecord, PublishRecord, PullRecord } from "../../src/core/store";

const TEST_TIMEOUT_MS = 30_000;

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
    conflicted: 1,
    failed: 0,
    remoteDeleted: 1,
    locallyModified: 1,
    durationMs: 30,
    sequence: 7,
    complete: false,
    integrityFailed: 1,
    unfetched: 2,
    policySkipped: 3,
    restored: 4,
  };
}

function conflictRecord(rootCid: string, occurredAtMs: number): ConflictRecord {
  return {
    kind: "conflict",
    occurredAtMs,
    rootCid,
    localSha256: "aa".repeat(32),
    remoteSha256: "bb".repeat(32),
  };
}

describe("history store location", () => {
  it("lives under the per-user state directory in history/, XDG honoured on every platform", () => {
    expect(historyStoreDirectory({ HOME: "/home/u" }, "linux")).toBe("/home/u/.local/state/ipfs-sync/history");
    expect(historyStoreDirectory({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support/ipfs-sync/history");
    expect(historyStoreDirectory({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local\\ipfs-sync\\history");
    expect(historyStoreDirectory({ HOME: "/home/u", XDG_STATE_HOME: "/state" }, "linux")).toBe("/state/ipfs-sync/history");
    expect(historyStoreDirectory({ HOME: "/Users/u", XDG_STATE_HOME: "/state" }, "darwin")).toBe("/state/ipfs-sync/history");
  });
});

describe("pglite history store", () => {
  let root: string;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-history-"));
    directory = join(root, "history");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "appends and lists newest-first, honours the limit, and round-trips every record kind",
    async () => {
      const store = await openHistoryStore({ directory });
      const publish = publishRecord("bafy-oldest", 100);
      const pull = pullRecord("bafy-middle", 300);
      const conflict = conflictRecord("bafy-middle", 300);
      const newest = publishRecord("bafy-newest", 200);
      await store.append(publish);
      await store.append(pull);
      await store.append(conflict);
      await store.append(newest);

      const all = await store.list(0);
      expect(all.map((record) => record.rootCid)).toEqual(["bafy-middle", "bafy-middle", "bafy-newest", "bafy-oldest"]);
      // The occurredAtMs tie between the pull and the conflict breaks by insertion order, newest first.
      expect(all[0]).toEqual(conflict);
      expect(all[1]).toEqual(pull);
      expect(all[2]).toEqual(newest);
      expect(all[3]).toEqual(publish);

      const capped = await store.list(2);
      expect(capped).toEqual([conflict, pull]);

      const one = await store.list(1);
      expect(one).toEqual([conflict]);

      await store.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves optional mvp-07a counters absent when they were never set",
    async () => {
      const store = await openHistoryStore({ directory });
      const plain: PullRecord = { ...pullRecord("bafy-plain", 100), sequence: undefined, complete: undefined, integrityFailed: undefined, unfetched: undefined, policySkipped: undefined, restored: undefined };
      await store.append(plain);
      const listed = await store.list(0);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(plain);
      expect("sequence" in (listed[0] ?? {})).toBe(false);
      await store.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sets and replaces the last-manifest pointer",
    async () => {
      const store = await openHistoryStore({ directory });
      expect(await store.getLastManifest()).toBeUndefined();
      await store.setLastManifest({ manifestCid: "bafy-manifest-1", rootCid: "bafy-root-1", updatedAtMs: 100 });
      expect(await store.getLastManifest()).toEqual({ manifestCid: "bafy-manifest-1", rootCid: "bafy-root-1", updatedAtMs: 100 });
      await store.setLastManifest({ manifestCid: "bafy-manifest-2", rootCid: "bafy-root-2", updatedAtMs: 200 });
      expect(await store.getLastManifest()).toEqual({ manifestCid: "bafy-manifest-2", rootCid: "bafy-root-2", updatedAtMs: 200 });
      await store.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps rows and the pointer across a close and reopen from the same directory",
    async () => {
      const first = await openHistoryStore({ directory });
      await first.append(publishRecord("bafy-kept", 100));
      await first.append(conflictRecord("bafy-kept", 150));
      await first.setLastManifest({ manifestCid: "bafy-manifest-kept", rootCid: "bafy-kept", updatedAtMs: 150 });
      await first.close();

      const second = await openHistoryStore({ directory });
      const rows = await second.list(0);
      expect(rows).toEqual([conflictRecord("bafy-kept", 150), publishRecord("bafy-kept", 100)]);
      expect(await second.getLastManifest()).toEqual({ manifestCid: "bafy-manifest-kept", rootCid: "bafy-kept", updatedAtMs: 150 });
      await second.close();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses fail-closed when the schema version is unknown",
    async () => {
      const seed = await openHistoryStore({ directory });
      await seed.close();
      const tamper = new PGlite(directory);
      await tamper.waitReady;
      await tamper.query("UPDATE schema_version SET version = $1", [SCHEMA_VERSION + 1]);
      await tamper.close();

      await expect(openHistoryStore({ directory })).rejects.toThrow(HistoryStoreError);
      await expect(openHistoryStore({ directory })).rejects.toThrow(/schema version/);
    },
    TEST_TIMEOUT_MS,
  );
});
