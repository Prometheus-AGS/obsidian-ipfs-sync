/**
 * Bounds history growth under auto-publish (task 1.8). Every non-empty publish adds one history file under `manifests/` on the node,
 * the pre-publish check warns at 1,500 and refuses at 1,999, and a timer that fires on a vault that changes on every tick (a plugin
 * rewriting a hidden folder) would reach the warning in days.
 *
 * The timer keeps the user's interval. A tick that comes sooner than `MIN_AUTO_PUBLISH_INTERVAL_MINUTES` after the previous
 * completed automatic run is skipped, not queued: the next tick looks again. Only the timer goes through here; the Publish command
 * and the ribbon icon call `publishVault` directly and are never throttled.
 */

/**
 * The shortest time between two automatic publishes. 30 days hold 43,200 minutes; 43,200 / 30 = 1,440 runs, under the warning level of
 * 1,500 (`HISTORY_WARN_AT`). Any smaller value lets a vault that changes on every tick pass 1,500 inside 30 days (5 minutes gives 8,640).
 */
export const MIN_AUTO_PUBLISH_INTERVAL_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

export type AutoPublishTickResult = "ran" | "skipped";

export interface AutoPublishTickOptions {
  readonly now: () => number;
  /** One automatic run. Its rejection is the caller's to report; the gate only needs to know it ended. */
  readonly publish: () => Promise<unknown>;
  readonly minIntervalMs?: number;
}

/** The function the interval timer calls. It never rejects: a failed run still starts the wait. */
export function createAutoPublishTick(options: AutoPublishTickOptions): () => Promise<AutoPublishTickResult> {
  const minMs = options.minIntervalMs ?? MIN_AUTO_PUBLISH_INTERVAL_MINUTES * MS_PER_MINUTE;
  let lastCompletedAt: number | undefined;
  let running = false;
  return async () => {
    if (running) return "skipped";
    if (lastCompletedAt !== undefined && options.now() - lastCompletedAt < minMs) return "skipped";
    running = true;
    try {
      await options.publish();
    } catch {
      // The publish path reports its own failures (notice, status); the timer only needs the run to be over.
    } finally {
      running = false;
      lastCompletedAt = options.now();
    }
    return "ran";
  };
}
