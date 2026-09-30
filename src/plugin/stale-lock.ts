import { decodeLock, describeLock, LOCK_STALE_MS, type LockFile, type LockRecord } from "../sync/publish-lock";
import type { SyncLock } from "./sync-lock";

/**
 * "Clear stale lock": the plugin-side counterpart of `ipfs-sync publish --break-lock`, for a device that has no command
 * line (a phone). A plugin that crashed leaves `publish.lock` behind under a host name unique to that session, so no
 * later session can tell the holder is dead; the lock expires by itself 15 minutes after its last heartbeat, and this
 * action is offered only from that point on. It never removes a lock whose heartbeat is younger than the staleness
 * window, whoever holds it, and it holds the plugin's sync lock for its whole duration, so it takes nothing while a sync operation runs and none can start meanwhile.
 */

export type StaleLockView =
  /** No lock file. */
  | { readonly kind: "none" }
  /** A lock with a heartbeat inside the staleness window: a publish may be running. Not clearable. */
  | { readonly kind: "held"; readonly description: string }
  /** The heartbeat is older than the staleness window. `description` names process, host and age; never the token. */
  | { readonly kind: "stale"; readonly description: string }
  /** A lock file that is not a lock record; its age is unknown, so this action does not touch it. */
  | { readonly kind: "unreadable" };

export type ClearOutcome =
  | { readonly kind: "cleared" }
  | { readonly kind: "none" }
  /** The lock is not old enough (or changed hands while the dialog was open). Nothing was removed. */
  | { readonly kind: "not-stale" }
  | { readonly kind: "unreadable" }
  /** A publish, pull or abandon is running in this plugin. */
  | { readonly kind: "busy" };

export interface StaleLockControl {
  inspect(): Promise<StaleLockView>;
  /** Re-check the age and remove the lock only if it is still the stale one that was seen. */
  clear(): Promise<ClearOutcome>;
}

export interface StaleLockDeps {
  readonly lockFile: LockFile;
  readonly now: () => number;
  readonly syncLock: Pick<SyncLock, "tryAcquire">;
}

const isAged = (record: LockRecord, now: number): boolean => now - record.time >= LOCK_STALE_MS;

async function readLock(file: LockFile): Promise<{ readonly present: boolean; readonly record: LockRecord | undefined }> {
  const bytes = await file.read();
  return bytes === undefined ? { present: false, record: undefined } : { present: true, record: decodeLock(bytes) };
}

export function createStaleLockControl(deps: StaleLockDeps): StaleLockControl {
  return {
    inspect: async () => {
      const { present, record } = await readLock(deps.lockFile);
      if (!present) return { kind: "none" };
      if (record === undefined) return { kind: "unreadable" };
      const now = deps.now();
      const description = describeLock(record, now);
      return isAged(record, now) ? { kind: "stale", description } : { kind: "held", description };
    },
    clear: async () => {
      // Held for the whole clearing: a publish that starts in the middle would take a fresh lock that the move-aside
      // below could take from it. A publish, pull or abandon that already runs makes this refuse as busy.
      const release = deps.syncLock.tryAcquire("clear-stale-lock");
      if (release === undefined) return { kind: "busy" };
      try {
        return await clearUnderSyncLock(deps);
      } finally {
        release();
      }
    },
  };
}

async function clearUnderSyncLock(deps: StaleLockDeps): Promise<ClearOutcome> {
  const seen = await readLock(deps.lockFile);
  if (!seen.present) return { kind: "none" };
  if (seen.record === undefined) return { kind: "unreadable" };
  if (!isAged(seen.record, deps.now())) return { kind: "not-stale" };
  // Move the file aside first: of a clearer and a fresh holder that both saw the stale file, only one gets it, and
  // what was moved is checked again before it is discarded.
  const moved = await deps.lockFile.moveAside();
  if (moved === undefined) return { kind: "none" };
  const taken = decodeLock(moved.bytes);
  if (taken !== undefined && taken.token === seen.record.token && isAged(taken, deps.now())) {
    await moved.discard();
    return { kind: "cleared" };
  }
  // Not the lock that was seen (its holder just replaced it, or it was refreshed): put it back.
  if (!(await deps.lockFile.createExclusive(moved.bytes))) {
    throw new Error("a lock was moved aside while clearing and could not be put back; it was kept under a temporary name in .ipfs-sync/");
  }
  await moved.discard();
  return { kind: "not-stale" };
}
