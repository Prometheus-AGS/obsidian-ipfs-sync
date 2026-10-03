import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeDeviceStore } from "../../cli/device-store-node";

/**
 * review-final N-03: taking over a stale lock and releasing a lock compare what the lock file says (a random token), not an inode
 * number, and a takeover cannot delete a lock a faster waiter has just created. The race is made deterministic by holding the first
 * removal of the lock file for as long as the test wants: the slow waiter is stopped exactly where the old code deleted a fresh lock.
 */

const hooks = vi.hoisted(() => ({ beforeLockRm: undefined as undefined | (() => Promise<void>) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const hook = hooks.beforeLockRm;
      if (hook !== undefined && String(path).endsWith("/.store.lock")) {
        hooks.beforeLockRm = undefined;
        await hook();
      }
      return actual.rm(path, options);
    },
  };
});

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

posixOnly("node device store lock: token compare (N-03)", () => {
  let directory: string;
  let lock: string;

  beforeEach(async () => {
    hooks.beforeLockRm = undefined;
    const root = await mkdtemp(join(tmpdir(), "ipfs-sync-lockrace-"));
    directory = join(root, "ipfs-sync");
    lock = join(directory, ".store.lock");
    // A store call creates the directory (0700).
    await createNodeDeviceStore({ directory }).get("probe.json");
  });

  async function staleLock(content: string): Promise<void> {
    await writeFile(lock, content, { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
  }

  it("two waiters racing for one stale lock never hold it together: the slow one cannot delete the fast one's fresh lock", async () => {
    await staleLock("pid 1\n");
    const slowReachedRemoval = deferred();
    const slowMayRemove = deferred();
    hooks.beforeLockRm = async () => {
      slowReachedRemoval.open();
      await slowMayRemove.promise;
    };
    let fastInside = false;
    let overlap = false;
    const fastMayLeave = deferred();

    const slow = createNodeDeviceStore({ directory }).exclusive(async () => {
      if (fastInside) overlap = true;
    });
    await slowReachedRemoval.promise;
    const fast = createNodeDeviceStore({ directory }).exclusive(async () => {
      fastInside = true;
      await fastMayLeave.promise;
      fastInside = false;
    });
    await sleep(200);
    slowMayRemove.open();
    await sleep(200);
    fastMayLeave.open();
    await Promise.all([slow, fast]);

    expect(overlap).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it("a holder suspended past the stale age, whose lock another process took over, leaves the new holder's lock alone on release", async () => {
    const holderMayFinish = deferred();
    const holderInside = deferred();
    const holder = createNodeDeviceStore({ directory }).exclusive(async () => {
      holderInside.open();
      await holderMayFinish.promise;
    });
    await holderInside.promise;
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);

    const takerMayFinish = deferred();
    const takerInside = deferred();
    const taker = createNodeDeviceStore({ directory }).exclusive(async () => {
      takerInside.open();
      await takerMayFinish.promise;
    });
    await takerInside.promise;
    const takerLock = await readFile(lock, "utf8");

    holderMayFinish.open();
    await holder;
    // The old holder's release found another token and kept its hands off.
    expect(await readFile(lock, "utf8")).toBe(takerLock);

    takerMayFinish.open();
    await taker;
    expect(await readdir(directory)).toEqual([]);
  });

  it("writes a random token into the lock file, a different one for each holder", async () => {
    const seen: string[] = [];
    const store = createNodeDeviceStore({ directory });
    for (let round = 0; round < 2; round += 1) await store.exclusive(async () => void seen.push(await readFile(lock, "utf8")));
    expect(seen[0]).toMatch(/token [0-9a-f]{32}/);
    expect(seen[1]).toMatch(/token [0-9a-f]{32}/);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("removes a stale lock that carries no token (written by an earlier build) and takes the lock", async () => {
    await staleLock("pid 1\n");
    await createNodeDeviceStore({ directory }).exclusive(async () => undefined);
    expect(await readdir(directory)).toEqual([]);
  });
});
