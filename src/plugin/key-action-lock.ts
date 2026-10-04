import { withTokenCheck } from "../sync/lock-token-check";
import { acquirePublishLock, type LockContext, type LockFile, type PublishLock } from "../sync/publish-lock";
import { lockHeld } from "../sync/publish-refusals";
import type { HeldLock } from "./key-ports";
import { type SyncLock } from "./sync-lock";

/**
 * The two locks a key action holds, the same pair the publish and pull runners hold: the in-process `SyncLock` (so publish, pull, abandon and
 * the timer wait) and `publish.lock` on disk with the token check of the 07a standard (so the command line tool and a second window wait too).
 * Release is idempotent and takes the file lock first, then the in-process lock.
 */

export interface KeyActionLock extends HeldLock {
  release(): Promise<void>;
}

export interface KeyActionLockDeps {
  readonly lock: SyncLock;
  readonly lockFile: LockFile;
  readonly lockContext: LockContext;
}

/** Another operation holds the in-process lock. Nothing was taken. */
export interface LockBusy {
  readonly busy: true;
  readonly holder: ReturnType<SyncLock["holder"]>;
}

/**
 * Take both locks, or answer `busy` when the in-process lock is held. A lock file held elsewhere throws the engine's `PublishRefusedError`
 * (`lock-held`) with the in-process lock already given back.
 */
export async function acquireKeyActionLock(deps: KeyActionLockDeps): Promise<KeyActionLock | LockBusy> {
  const releaseProcess = deps.lock.tryAcquire("key-management");
  if (releaseProcess === undefined) return { busy: true, holder: deps.lock.holder() };
  let fileLock: PublishLock | undefined;
  try {
    const checked = withTokenCheck(deps.lockFile);
    fileLock = await acquirePublishLock(checked.file, deps.lockContext);
    // The adapter may not refuse a rename onto an existing lock file: look at the file itself before the first request.
    if (!(await checked.verifyHeld())) throw lockHeld("the lock file changed hands right after it was taken");
    const taken = fileLock;
    let released = false;
    return {
      assertHeld: () => taken.assertHeld(),
      verifyHeld: checked.verifyHeld,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await taken.release();
        } finally {
          releaseProcess();
        }
      },
    };
  } catch (error) {
    try {
      await fileLock?.release();
    } finally {
      releaseProcess();
    }
    throw error;
  }
}

export const isBusy = (taken: KeyActionLock | LockBusy): taken is LockBusy => "busy" in taken;
