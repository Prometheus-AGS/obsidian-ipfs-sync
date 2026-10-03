// mvp-07a final review A-07: the pull and the plugin temp sweep take publish.lock through the same post-acquire token check
// publish has. An adapter whose rename can replace an existing lock file lets two starters of a stale lock both believe
// they hold it; the token read-back shows the loser, and a second look before the pull's first write catches a lock
// that changed hands while the first-pull dialog was open (no heartbeat has run in between).
import { describe, expect, it } from "vitest";
import { sweepTempFiles } from "../../src/plugin/pull-sweep";
import { encodeLock, type LockFile } from "../../src/sync/publish-lock";
import { createMemoryHost } from "../helpers/memory-host";
import { NOW, expectNothingWritten, lockRig, newPuller, publishedOnce, runPull, stopOf } from "../helpers/encrypted-pull-rig";

const OTHER = encodeLock({ token: "the-other-starter", pid: 7, host: "another-host", time: NOW });

/** A lock file whose create reports success and is then overwritten by a competing starter (rename onto an existing file). */
function losesTheRace(inner: ReturnType<typeof lockRig>["file"]): LockFile {
  return {
    ...inner,
    createExclusive: async (bytes) => {
      const created = await inner.createExclusive(bytes);
      inner.bytes = OTHER;
      return created;
    },
  };
}

describe("the pull's publish.lock is verified by its token", () => {
  it("stops with lock-held right after the lock is taken, before the sweep, any request or any write", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    await b.host.fs.write(".ipfs-sync/tmp/aaaa-1111.part", new Uint8Array([1]));
    b.host.mutations.length = 0;
    const stop = stopOf(await runPull(rig, b, { deps: { lockFile: losesTheRace(b.locks.file) } }));
    expect(stop.reason).toBe("lock-held");
    expect(stop.message).toContain("changed hands right after it was taken");
    expect(rig.node.calls).toEqual([]);
    expectNothingWritten(b);
    expect((await b.host.fs.stat(".ipfs-sync/tmp/aaaa-1111.part"))?.kind).toBe("file");
    expect(b.locks.file.bytes).toEqual(OTHER); // the other starter's lock is not removed
  });

  it("stops with lock-lost when the lock changed hands during the first-pull dialog, with no heartbeat in between; nothing is stored", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const stop = stopOf(
      await runPull(rig, b, {
        options: { acceptFirstPull: false },
        deps: {
          confirmFirstPull: async () => {
            b.locks.file.bytes = OTHER; // no tick: assertHeld alone cannot see this
            return true;
          },
        },
      }),
    );
    expect(stop.reason).toBe("lock-lost");
    expectNothingWritten(b);
  });

  it("a pull that keeps its lock still completes and releases it", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const outcome = await runPull(rig, b);
    expect(outcome.kind).toBe("completed");
    expect(b.locks.file.bytes).toBeUndefined();
  });
});

describe("the plugin temp sweep's publish.lock is verified by its token", () => {
  it("does not sweep when the lock changed hands right after it was taken", async () => {
    const host = createMemoryHost();
    await host.fs.write(".ipfs-sync/tmp/aaaa-1111.part", new Uint8Array([1]));
    const locks = lockRig();
    const outcome = await sweepTempFiles({ fs: host.fs, lockFile: losesTheRace(locks.file), lockContext: locks.ctx });
    expect(outcome).toEqual({ ran: false, removed: 0 });
    expect((await host.fs.stat(".ipfs-sync/tmp/aaaa-1111.part"))?.kind).toBe("file");
    expect(locks.file.bytes).toEqual(OTHER);
  });

  it("still sweeps and releases the lock when it is held", async () => {
    const host = createMemoryHost();
    await host.fs.write(".ipfs-sync/tmp/aaaa-1111.part", new Uint8Array([1]));
    const locks = lockRig();
    expect(await sweepTempFiles({ fs: host.fs, lockFile: locks.file, lockContext: locks.ctx })).toEqual({ ran: true, removed: 1 });
    expect(locks.file.bytes).toBeUndefined();
  });
});
