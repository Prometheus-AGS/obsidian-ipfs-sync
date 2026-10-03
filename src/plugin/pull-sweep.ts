import type { HostFs } from "../core/host-bridge";
import { sweepStaleParts } from "../sync/blob-fetch";
import { withTokenCheck } from "../sync/lock-token-check";
import { acquirePublishLock, type LockContext, type LockFile, type PublishLock } from "../sync/publish-lock";
import { PublishRefusedError } from "../sync/publish-refusals";
import { TEMP_DIR } from "../sync/temp-files";

/**
 * The sweep of `.ipfs-sync/tmp/` when the plugin loads (spec plugin-pull-ui "Ranged fetch, single-read upload and temp
 * sweep"). A part file belongs to a pull that may still be running in another process, so the sweep runs only while it
 * holds `publish.lock`, by a try-acquire: a held lock means someone is working and the sweep is skipped, not waited for.
 * A vault with no temp folder takes no lock and writes nothing. The caller schedules it after the workspace is ready, so
 * plugin loading never waits for storage.
 */

export interface SweepOutcome {
  /** True when the lock was held by this sweep and the folder was swept. */
  readonly ran: boolean;
  readonly removed: number;
}

export interface SweepInput {
  readonly fs: Pick<HostFs, "stat" | "list" | "remove">;
  readonly lockFile: LockFile;
  readonly lockContext: LockContext;
}

const SKIPPED: SweepOutcome = { ran: false, removed: 0 };

export async function sweepTempFiles(input: SweepInput): Promise<SweepOutcome> {
  if ((await input.fs.stat(TEMP_DIR))?.kind !== "directory") return SKIPPED;
  let lock: PublishLock;
  const checked = withTokenCheck(input.lockFile);
  try {
    lock = await acquirePublishLock(checked.file, input.lockContext);
  } catch (error) {
    if (error instanceof PublishRefusedError && (error.code === "lock-held" || error.code === "lock-unreadable")) return SKIPPED;
    throw error;
  }
  try {
    // The adapter's rename may replace an existing lock file: look at the file itself before deleting anything (final review A-07).
    if (!(await checked.verifyHeld())) return SKIPPED;
    return { ran: true, removed: (await sweepStaleParts(input.fs)).removed };
  } finally {
    await lock.release();
  }
}
