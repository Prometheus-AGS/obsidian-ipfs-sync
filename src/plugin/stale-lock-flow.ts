import type { ClearLockDialogRequest, ClearLockOutcome, ClearLockResult } from "./clear-stale-lock-dialog";
import { STALE_LOCK_COPY as COPY } from "./stale-lock-copy";
import type { ClearOutcome, StaleLockControl, StaleLockView } from "./stale-lock";

/**
 * The plugin side of "Clear stale lock": look at the lock, and only when its heartbeat is older than the staleness
 * window open the confirmation dialog; the age is checked again when the button in the dialog is pressed. The text
 * to show afterwards (`notice`) is empty when the user cancelled.
 */

export interface ClearLockDialogHandle {
  close(): void;
}

export interface StaleLockFlowDeps {
  readonly control: StaleLockControl;
  readonly openDialog: (request: ClearLockDialogRequest, onFinish: (outcome: ClearLockOutcome) => void) => ClearLockDialogHandle;
}

export interface StaleLockFlow {
  /** What the settings row shows: the lock's state. */
  inspect(): Promise<StaleLockView>;
  /** Open the confirmation when the lock is stale. Resolves when the dialog is done, with the text to show (empty on cancel). */
  open(): Promise<{ readonly notice: string }>;
  dispose(): void;
}

const REFUSAL: Readonly<Record<Exclude<ClearOutcome["kind"], "cleared">, string>> = {
  none: "there is no publish lock any more",
  "not-stale": "the lock is no longer stale (a publish refreshed it)",
  unreadable: "the lock file cannot be read",
  busy: "a sync operation is running in this plugin",
};

function toResult(outcome: ClearOutcome): ClearLockResult {
  return outcome.kind === "cleared" ? { ok: true } : { ok: false, reason: REFUSAL[outcome.kind] };
}

const NOTICE_FOR_VIEW: Readonly<Record<Exclude<StaleLockView["kind"], "stale">, string>> = {
  none: COPY.noneNotice,
  held: COPY.freshNotice,
  unreadable: COPY.unreadableNotice,
};

export function createStaleLockFlow(deps: StaleLockFlowDeps): StaleLockFlow {
  let open: ClearLockDialogHandle | undefined;

  return {
    inspect: () => deps.control.inspect(),
    open: async () => {
      const view = await deps.control.inspect();
      if (view.kind !== "stale") return { notice: NOTICE_FOR_VIEW[view.kind] };
      open?.close();
      return new Promise((resolve) => {
        open = deps.openDialog({ description: view.description, clear: async () => toResult(await deps.control.clear()) }, (outcome) => {
          open = undefined;
          resolve({ notice: outcome.cleared ? COPY.cleared : "" });
        });
      });
    },
    dispose: () => {
      open?.close();
      open = undefined;
    },
  };
}
