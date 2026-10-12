import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { historyStoreDirectory } from "../../cli/store/location";
import { openHistoryStore } from "../../cli/store/pglite-store";
import { attachHistoryRecorder } from "../../cli/store/recorder";
import { SCHEMA_VERSION } from "../../cli/store/schema";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createSyncEventBus } from "../../src/core/events";
import { createInMemoryStore } from "../../src/core/store";
import type { MetadataStoreAdapter, SyncStateStoreAdapter } from "../../src/core/store/ports";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";
import { NODE_ENV } from "../helpers/cli-state-env";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";

const MFS_ROOT = "/obsidian-vault-sync/recorder-test";
const E2E_TIMEOUT_MS = 30_000;

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function sink(): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t) }, out, err };
}

const PUBLISH_EVENT = { rootCid: "bafy-root-publish", manifestCid: "bafy-manifest-publish", written: 3, removed: 1, durationMs: 12 } as const;
const PULL_EVENT = {
  rootCid: "bafy-root-pull",
  manifestCid: "bafy-manifest-pull",
  fetched: 2,
  unchanged: 5,
  conflicted: 1,
  failed: 0,
  remoteDeleted: 1,
  locallyModified: 1,
  forcedReverify: false,
  durationMs: 30,
} as const;
const CONFLICT_EVENT = {
  path: "secret/local-note.md",
  conflictPath: "secret/local-note (conflict 2026-10-05).md",
  localSha256: "aa".repeat(32),
  remoteSha256: "bb".repeat(32),
} as const;

describe("attachHistoryRecorder", () => {
  it("a publish event appends a publish row and moves the last-manifest pointer", async () => {
    const bus = createSyncEventBus();
    const store = createInMemoryStore();
    const recorder = attachHistoryRecorder(bus, store, sink().io, () => 1000);

    bus.emit("publish.complete", { ...PUBLISH_EVENT });
    await recorder.detach();

    expect(await store.list(0)).toEqual([{ kind: "publish", occurredAtMs: 1000, ...PUBLISH_EVENT }]);
    expect(await store.getLastManifest()).toEqual({ manifestCid: PUBLISH_EVENT.manifestCid, rootCid: PUBLISH_EVENT.rootCid, updatedAtMs: 1000 });
  });

  it("a pull event appends a pull row (forcedReverify dropped) and does not move the pointer", async () => {
    const bus = createSyncEventBus();
    const store = createInMemoryStore();
    const recorder = attachHistoryRecorder(bus, store, sink().io, () => 2000);

    bus.emit("pull.complete", { ...PULL_EVENT });
    await recorder.detach();

    const { forcedReverify: _dropped, ...kept } = PULL_EVENT;
    expect(await store.list(0)).toEqual([{ kind: "pull", occurredAtMs: 2000, ...kept }]);
    expect(await store.getLastManifest()).toBeUndefined();
  });

  it("a conflict event is stamped with the root CID of the pull.complete that follows it, and its serialization contains neither source path", async () => {
    const bus = createSyncEventBus();
    const store = createInMemoryStore();
    const recorder = attachHistoryRecorder(bus, store, sink().io, () => 3000);

    // The decrypting pull emits conflicts before pull.complete (src/sync/encrypted-pull-events.ts).
    bus.emit("conflict", { ...CONFLICT_EVENT });
    bus.emit("pull.complete", { ...PULL_EVENT });
    await recorder.detach();

    const rows = await store.list(0);
    const conflictRow = rows.find((row) => row.kind === "conflict");
    expect(conflictRow).toEqual({
      kind: "conflict",
      occurredAtMs: 3000,
      rootCid: PULL_EVENT.rootCid,
      localSha256: CONFLICT_EVENT.localSha256,
      remoteSha256: CONFLICT_EVENT.remoteSha256,
    });
    const serialized = JSON.stringify(conflictRow);
    expect(serialized).not.toContain(CONFLICT_EVENT.path);
    expect(serialized).not.toContain(CONFLICT_EVENT.conflictPath);
  });

  it("a store that throws only costs stderr lines; detach still resolves and later events are still attempted", async () => {
    const failing: MetadataStoreAdapter & SyncStateStoreAdapter = {
      append: () => Promise.reject(new Error("disk full")),
      list: () => Promise.resolve([]),
      getLastManifest: () => Promise.resolve(undefined),
      setLastManifest: () => Promise.reject(new Error("disk full")),
    };
    const bus = createSyncEventBus();
    const s = sink();
    const recorder = attachHistoryRecorder(bus, failing, s.io);

    bus.emit("conflict", { ...CONFLICT_EVENT });
    bus.emit("pull.complete", { ...PULL_EVENT });
    bus.emit("publish.complete", { ...PUBLISH_EVENT });
    await recorder.detach();

    const lines = s.err.filter((line) => line.includes("warning: sync history was not recorded"));
    // One line per event whose write unit failed (the pull's and the publish's); the run itself was never interrupted.
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes("disk full"))).toBe(true);
  });

  it("a conflict no complete event claims is dropped at detach with a stderr line, recording nothing", async () => {
    const bus = createSyncEventBus();
    const store = createInMemoryStore();
    const s = sink();
    const recorder = attachHistoryRecorder(bus, store, s.io);

    bus.emit("conflict", { ...CONFLICT_EVENT });
    await recorder.detach();

    expect(await store.list(0)).toEqual([]);
    expect(s.err.join("\n")).toContain("1 conflict record(s) had no completed operation to attach to");
  });
});

describe("recorder wiring through runCli (stub node)", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let state: string;
  let node: FakeNode;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-recorder-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    state = join(dir, "xdg");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, MFS_ROOT, node);
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, [])));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const env = (): Record<string, string> => ({ ...NODE_ENV, XDG_STATE_HOME: state });
  const deps = (): CliDeps => ({ env: env(), now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent, passphrase: referencePassphraseSource });
  const publish = (s: Sink): Promise<number> => runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT], deps(), s.io);

  it(
    "an end-to-end publish exits 0 and leaves a publish row and the pointer in the on-disk store",
    async () => {
      const s = sink();
      expect(await publish(s)).toBe(0);

      const store = await openHistoryStore({ directory: historyStoreDirectory(env()) });
      const rows = await store.list(0);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.kind).toBe("publish");
      // The CID the command printed as published is the one in the row.
      expect(s.out.join("\n")).toContain(`root CID   ${row?.rootCid ?? ""}`);
      const pointer = await store.getLastManifest();
      expect(pointer?.rootCid).toBe(row?.rootCid);
      expect(pointer?.manifestCid).toBe(row?.kind === "publish" ? row.manifestCid : undefined);
      await store.close();
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "a history store that refuses to open leaves the publish's exit path untouched (warning on stderr, exit 0, publish done)",
    async () => {
      // Seed a database, then bump its schema version so the next open refuses fail-closed.
      const directory = historyStoreDirectory(env());
      const seed = await openHistoryStore({ directory });
      await seed.close();
      const tamper = new PGlite(directory);
      await tamper.waitReady;
      await tamper.query("UPDATE schema_version SET version = $1", [SCHEMA_VERSION + 1]);
      await tamper.close();

      const s = sink();
      expect(await publish(s)).toBe(0);
      const err = s.err.join("\n");
      expect(err).toContain("warning: sync history is unavailable on this device");
      expect(err).toContain("schema version");
      // The publish itself ran: the result line is on stdout.
      expect(s.out.join("\n")).toMatch(/\d+ written, \d+ removed/);
      // Nothing was recorded: opening the store still refuses.
      await expect(openHistoryStore({ directory })).rejects.toThrow(/schema version/);
    },
    E2E_TIMEOUT_MS,
  );
});
