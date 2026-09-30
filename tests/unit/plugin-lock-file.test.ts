import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeLockContext, createNodeLockFile } from "../../cli/publish-lock-file";
import { createAdapterLockFile, createPluginLockContext } from "../../src/plugin/adapter-lock-file";
import { LOCK_STALE_MS, acquirePublishLock, encodeLock } from "../../src/sync/publish-lock";
import { MemoryAdapter } from "../support/memory-adapter";
import { createNodeFsAdapter } from "../support/node-fs-adapter";

const NOW = 1_800_000_000_000;
const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const LOCK = ".ipfs-sync/publish.lock";

describe("plugin lock file over the vault adapter", () => {
  it("creates exclusively: the second creation fails, and the first file is never replaced", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    expect(await file.createExclusive(bytes("first"))).toBe(true);
    expect(await file.createExclusive(bytes("second"))).toBe(false);
    expect(adapter.text(LOCK)).toBe("first");
  });

  it("leaves no scratch file behind after creating, failing to create, taking aside and removing", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    await file.createExclusive(bytes("a"));
    await file.createExclusive(bytes("b"));
    const moved = await file.moveAside();
    expect(new TextDecoder().decode(moved?.bytes)).toBe("a");
    await moved?.discard();
    await file.createExclusive(bytes("c"));
    await file.remove();
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("read returns the bytes or undefined, write replaces, remove is idempotent", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    expect(await file.read()).toBeUndefined();
    await file.createExclusive(bytes("one"));
    expect(new TextDecoder().decode(await file.read())).toBe("one");
    await file.write(bytes("two"));
    expect(adapter.text(LOCK)).toBe("two");
    await file.remove();
    await file.remove();
    expect(await file.read()).toBeUndefined();
  });

  it("of two callers that see the same file, only one takes it aside", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    await file.createExclusive(bytes("stale"));
    const [a, b] = await Promise.all([file.moveAside(), file.moveAside()]);
    expect([a, b].filter((moved) => moved !== undefined)).toHaveLength(1);
  });

  it("the plugin context names a host unique to the session and never claims a process is alive on its own say-so", () => {
    const a = createPluginLockContext(() => NOW);
    const b = createPluginLockContext(() => NOW);
    expect(a.host).toMatch(/^obsidian-[0-9a-f]{8}$/);
    expect(a.host).not.toBe(b.host);
    expect(a.pid).toBe(0);
  });
});

describe("the plugin and the command line share one lock file on a real directory", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("a plugin lock refuses a command-line publish, and the reverse", async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-lock-"));
    const plugin = createAdapterLockFile(createNodeFsAdapter(dir));
    const cli = createNodeLockFile(dir);
    const pluginLock = await acquirePublishLock(plugin, createPluginLockContext(() => Date.now()));
    await expect(acquirePublishLock(cli, createNodeLockContext(() => Date.now()))).rejects.toMatchObject({ code: "lock-held" });
    await pluginLock.release();
    const cliLock = await acquirePublishLock(cli, createNodeLockContext(() => Date.now()));
    await expect(acquirePublishLock(plugin, createPluginLockContext(() => Date.now()))).rejects.toMatchObject({ code: "lock-held" });
    await cliLock.release();
    const again = await acquirePublishLock(plugin, createPluginLockContext(() => Date.now()));
    await again.release();
  });

  it("a stale lock left by the command line is replaced by the plugin; a fresh one from another host is not", async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-lock-"));
    const adapter = createNodeFsAdapter(dir);
    const file = createAdapterLockFile(adapter);
    await file.createExclusive(encodeLock({ token: "old", pid: 99, host: "another-host", time: NOW - LOCK_STALE_MS - 1 }));
    const taken = await acquirePublishLock(file, createPluginLockContext(() => NOW));
    await taken.release();
    await file.createExclusive(encodeLock({ token: "new", pid: 99, host: "another-host", time: NOW - 1000 }));
    await expect(acquirePublishLock(file, createPluginLockContext(() => NOW))).rejects.toMatchObject({ code: "lock-held" });
  });
});
