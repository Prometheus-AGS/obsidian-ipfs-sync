/**
 * One sync operation at a time in a vault. Publish and pull both write the engine's state file
 * (`.ipfs-sync/state.json`), so they share one lock: the second request is refused, not queued.
 */

export type SyncOperation = "publish" | "pull" | "abandon" | "clear-stale-lock" | "key-management";

const OPERATION_LABEL: Readonly<Record<SyncOperation, string>> = {
  publish: "a publish",
  pull: "a pull",
  abandon: "an abandon",
  "clear-stale-lock": "a stale-lock clearing",
  "key-management": "a key-management action",
};

export interface SyncLock {
  /** The operation holding the lock, or undefined when it is free. */
  holder(): SyncOperation | undefined;
  /**
   * Take the lock for `operation`. Returns the function that releases it (call it in `finally`; calling it
   * again is harmless), or undefined when another operation holds the lock.
   */
  tryAcquire(operation: SyncOperation): (() => void) | undefined;
}

export function createSyncLock(): SyncLock {
  let held: SyncOperation | undefined;
  return {
    holder: () => held,
    tryAcquire: (operation) => {
      if (held !== undefined) return undefined;
      held = operation;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held = undefined;
      };
    },
  };
}

/** The notice for a request made while `holder` runs. */
export function busyNotice(holder: SyncOperation | undefined): string {
  const running = holder === undefined ? "a sync operation" : OPERATION_LABEL[holder];
  return `IPFS Sync: ${running} is already in progress. Wait for it to finish.`;
}
