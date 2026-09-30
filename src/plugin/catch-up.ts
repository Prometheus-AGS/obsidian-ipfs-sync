export interface CatchUpDeps {
  /** The stored "pull on load" setting. */
  readonly enabled: boolean;
  /** `app.workspace.onLayoutReady`: runs the callback once the workspace is ready (at once if it already is). */
  readonly onLayoutReady: (callback: () => void) => void;
  /** One quiet pull. It reports its own outcome and does not reject; a rejection here is a bug, and goes to `onError`. */
  readonly pull: () => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}

/**
 * On-load catch-up: one pull after the workspace layout is ready, only when the setting is on. It registers a
 * callback and returns, so plugin loading never waits for the node; the pull itself obeys the same guards as a
 * manual one (destination guard, lock, target) because it is the same runner.
 */
export function scheduleCatchUp(deps: CatchUpDeps): void {
  if (!deps.enabled) return;
  deps.onLayoutReady(() => {
    deps.pull().catch(deps.onError);
  });
}
