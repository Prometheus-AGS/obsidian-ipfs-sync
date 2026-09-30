import { describe, expect, it } from "vitest";
import { createAdapterLockFile, createPluginLockContext } from "../../src/plugin/adapter-lock-file";
import { withTokenCheck } from "../../src/plugin/lock-token-check";
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS, acquirePublishLock, decodeLock, encodeLock } from "../../src/sync/publish-lock";
import { MemoryAdapter } from "../support/memory-adapter";

/** review-5 R5-01 and R5-07: the plugin lock file over an adapter whose rename overwrites, and its atomic heartbeat. */

const NOW = 1_800_000_000_000;
const LOCK = ".ipfs-sync/publish.lock";
const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const rival = (token = "rival"): Uint8Array<ArrayBuffer> => encodeLock({ token, pid: 4242, host: "cli-host", time: NOW - 1000 });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An adapter like one whose `rename` replaces an existing target (Node's `fs.rename`), with hooks at the racy points. */
class OverwritingAdapter extends MemoryAdapter {
  afterRename: ((target: string) => void) | undefined;
  onLockRead: ((count: number) => void) | undefined;
  private lockReads = 0;

  override async rename(path: string, newPath: string): Promise<void> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT ${path}`);
    this.calls.push(`rename ${path} ${newPath}`);
    this.files.delete(path);
    this.files.set(newPath, file);
    this.afterRename?.(newPath);
  }

  override async readBinary(path: string): Promise<ArrayBuffer> {
    if (path === LOCK) this.onLockRead?.((this.lockReads += 1));
    return super.readBinary(path);
  }
}

describe("R5-01: a rename that overwrites cannot make two starters both believe they hold the lock", () => {
  it("createExclusive returns false when the file read back is not ours, and leaves the other holder's file alone", async () => {
    const adapter = new OverwritingAdapter();
    adapter.afterRename = (target) => {
      if (target === LOCK) adapter.put(LOCK, rival()); // the other starter's rename lands right after ours
    };
    const file = createAdapterLockFile(adapter);
    expect(await file.createExclusive(bytes("ours"))).toBe(false);
    expect(decodeLock(adapter.files.has(LOCK) ? new Uint8Array(adapter.files.get(LOCK)!.data) : new Uint8Array())?.token).toBe("rival");
  });

  it("acquirePublishLock refuses as lock-held in that case, and the rival's file is not removed", async () => {
    const adapter = new OverwritingAdapter();
    adapter.afterRename = (target) => {
      if (target === LOCK) adapter.put(LOCK, rival());
    };
    const file = createAdapterLockFile(adapter);
    await expect(acquirePublishLock(file, createPluginLockContext(() => NOW))).rejects.toMatchObject({ code: "lock-held" });
    expect(decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data))?.token).toBe("rival");
  });

  it("an uncontended creation still succeeds on an overwriting adapter", async () => {
    const adapter = new OverwritingAdapter();
    const file = createAdapterLockFile(adapter);
    expect(await file.createExclusive(bytes("ours"))).toBe(true);
    expect(adapter.text(LOCK)).toBe("ours");
  });

  it("verifyHeld is true for the record this file created and false once another token is on disk", async () => {
    const adapter = new OverwritingAdapter();
    const checked = withTokenCheck(createAdapterLockFile(adapter));
    expect(await checked.verifyHeld()).toBe(false); // nothing created yet
    const lock = await acquirePublishLock(checked.file, createPluginLockContext(() => NOW));
    expect(await checked.verifyHeld()).toBe(true);
    adapter.put(LOCK, rival()); // a rename that overwrote us
    expect(await checked.verifyHeld()).toBe(false);
    await lock.release(); // release removes only a file that is still ours
    expect(decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data))?.token).toBe("rival");
  });
});

describe("R5-07: the heartbeat replaces the lock file atomically", () => {
  it("writes a temporary file and renames it; the lock path is never written in place", async () => {
    const adapter = new MemoryAdapter();
    const ticks: (() => void)[] = [];
    let clock = NOW;
    const ctx = { ...createPluginLockContext(() => clock), every: (_ms: number, task: () => void) => (ticks.push(task), () => undefined) };
    const lock = await acquirePublishLock(createAdapterLockFile(adapter, () => clock), ctx);
    const before = decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data));
    adapter.calls.length = 0;
    clock += LOCK_HEARTBEAT_MS;
    ticks[0]?.();
    await flush();
    const after = decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data));
    expect(after?.time).toBe(clock);
    expect(after?.token).toBe(before?.token);
    expect(adapter.calls.filter((call) => call.startsWith(`write ${LOCK}`))).toEqual([]);
    expect(adapter.calls.some((call) => /^rename \.ipfs-sync\/\.publish\.lock\..*\.tmp \.ipfs-sync\/publish\.lock$/.test(call))).toBe(true);
    expect(() => lock.assertHeld()).not.toThrow();
    await lock.release();
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("writeIfToken refuses when another token holds the file and leaves it untouched, with no scratch file behind", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    adapter.put(LOCK, rival());
    expect(await file.writeIfToken?.("mine", rival("mine"))).toBe(false);
    expect(decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data))?.token).toBe("rival");
    expect([...adapter.files.keys()]).toEqual([LOCK]);
    expect(await file.writeIfToken?.("rival", rival("rival"))).toBe(true);
  });

  it("writeIfToken refuses when the lock file is gone", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    expect(await file.writeIfToken?.("mine", rival("mine"))).toBe(false);
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("sweeps temporary files older than a minute when the lock is taken and when it is released, and leaves fresh ones and moved-aside locks", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(".ipfs-sync/.publish.lock.deadbeef0001.tmp", "x", NOW - 120_000);
    adapter.put(".ipfs-sync/.publish.lock.deadbeef0002.taken", "x", NOW - 120_000);
    adapter.put(".ipfs-sync/.publish.lock.deadbeef0003.tmp", "x", NOW - 1000);
    adapter.put(".ipfs-sync/state.abc.json", "keep", NOW - 999_999);
    const file = createAdapterLockFile(adapter, () => NOW);
    expect(await file.createExclusive(rival("mine"))).toBe(true);
    expect([...adapter.files.keys()].sort()).toEqual([
      ".ipfs-sync/.publish.lock.deadbeef0002.taken",
      ".ipfs-sync/.publish.lock.deadbeef0003.tmp",
      ".ipfs-sync/publish.lock",
      ".ipfs-sync/state.abc.json",
    ]);
    adapter.put(".ipfs-sync/.publish.lock.deadbeef0004.taken", "x", NOW - LOCK_STALE_MS);
    await file.remove();
    expect([...adapter.files.keys()].sort()).toEqual([
      ".ipfs-sync/.publish.lock.deadbeef0002.taken",
      ".ipfs-sync/.publish.lock.deadbeef0003.tmp",
      ".ipfs-sync/.publish.lock.deadbeef0004.taken",
      ".ipfs-sync/state.abc.json",
    ]);
  });

  it("C5-05: a lock moved aside by one instance survives another instance's sweep (and a sweep after a reload), and its own discard removes it", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, encodeLock({ token: "old", pid: 9, host: "h", time: NOW - LOCK_STALE_MS - 1 }), NOW - LOCK_STALE_MS - 1);
    const clearer = createAdapterLockFile(adapter, () => NOW);
    const moved = await clearer.moveAside();
    expect(moved).toBeDefined();
    const aside = [...adapter.files.keys()].filter((path) => path.endsWith(".taken"));
    expect(aside).toHaveLength(1);
    const publisher = createAdapterLockFile(adapter, () => NOW); // a second instance: the runner's own, or one built after a plugin reload
    expect(await publisher.createExclusive(rival("fresh"))).toBe(true); // this sweeps
    await publisher.remove(); // and so does this
    expect([...adapter.files.keys()]).toEqual(aside);
    await moved?.discard();
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("C5-04: a read-back that throws after our rename succeeded removes the lock file when it holds our bytes", async () => {
    const adapter = new OverwritingAdapter();
    const file = createAdapterLockFile(adapter);
    // readBinary of the lock is first called by the read-back, so fail that first call only.
    let failNext = true;
    const original = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (path: string) => {
      if (path === LOCK && failNext) {
        failNext = false;
        throw new Error("EIO read-back");
      }
      return original(path);
    };
    await expect(file.createExclusive(bytes("ours"))).rejects.toThrow("EIO read-back");
    expect(adapter.files.has(LOCK)).toBe(false);
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("C5-04: a failed read-back leaves the file alone when it holds another holder's bytes", async () => {
    const adapter = new OverwritingAdapter();
    adapter.afterRename = (target) => {
      if (target === LOCK) adapter.put(LOCK, rival());
    };
    let failNext = true;
    const original = adapter.readBinary.bind(adapter);
    adapter.readBinary = async (path: string) => {
      if (path === LOCK && failNext) {
        failNext = false;
        throw new Error("EIO read-back");
      }
      return original(path);
    };
    await expect(createAdapterLockFile(adapter).createExclusive(bytes("ours"))).rejects.toThrow("EIO read-back");
    expect(decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data))?.token).toBe("rival");
  });

  it("a takeover of a stale lock is not disturbed by the sweep: the file moved aside keeps the age of the lock and is not swept", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, encodeLock({ token: "old", pid: 9, host: "another-host", time: NOW - LOCK_STALE_MS - 1 }), NOW - LOCK_STALE_MS - 1);
    const lock = await acquirePublishLock(createAdapterLockFile(adapter, () => NOW), createPluginLockContext(() => NOW));
    expect(decodeLock(new Uint8Array(adapter.files.get(LOCK)!.data))?.token).not.toBe("old");
    await lock.release();
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("write replaces the file through a temporary file on an adapter that refuses an existing target", async () => {
    const adapter = new MemoryAdapter();
    const file = createAdapterLockFile(adapter);
    await file.createExclusive(bytes("one"));
    adapter.calls.length = 0;
    await file.write(bytes("two"));
    expect(adapter.text(LOCK)).toBe("two");
    expect(adapter.calls.filter((call) => call === `write ${LOCK}`)).toEqual([]);
    expect([...adapter.files.keys()]).toEqual([LOCK]);
  });
});
