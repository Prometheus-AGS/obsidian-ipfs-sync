import type { KdfParams } from "../crypto";
import { escapeForDisplay } from "../sync/path-policy";
import type { RewrapCostPlan } from "../sync/key-management-text";
import { KEY_DIALOG_COPY } from "./encryption-copy";

/**
 * Parts the three key dialogs (change passphrase, increase cost, accept key slots) share: the result a caller reports,
 * the outcome a dialog reports, how a cost compares with another, and the sentence that says what still blocks the button.
 * Pure: no host imports.
 */

/**
 * What the caller reports after it ran the engine. This is the real outcome, as `settleUnlock` and the pull runner's `verdict`
 * are for the unlock dialog: only `ok: true` finishes the dialog as done. `retryable` is true only for a refusal that wrote nothing
 * (a wrong passphrase, a refused check); the form then reopens. False means the node or this device may have changed: the form locks.
 * A reason is shown as text after `escapeForDisplay`; it must not contain a passphrase.
 */
export type KeyActionFailure = { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/** How a key dialog ended: `done` after a success, `stopped` after a failure that may have changed something, `cancelled` for every other way out. */
export type KeyDialogOutcome = "done" | "stopped" | "cancelled";

export type CostRelation = "same" | "higher" | "lower";

/** Lower when memory or iterations fall (a mixed change counts as lower: the cheaper axis is what an attacker uses). */
export function relateCost(current: KdfParams, next: KdfParams): CostRelation {
  if (next.m < current.m || next.t < current.t) return "lower";
  if (next.m > current.m || next.t > current.t) return "higher";
  return "same";
}

export function costPlan(current: KdfParams, next: KdfParams): RewrapCostPlan {
  const relation = relateCost(current, next);
  return { current, next, raises: next.m > current.m || next.t > current.t, downgrade: relation === "lower" };
}

/** A reason from the caller, safe to show: control, bidirectional and invisible characters are written out. */
export function reasonText(reason: string): string {
  return escapeForDisplay(reason);
}

/** "To enable the button: enter X, and tick Y." Empty when nothing is missing. */
export function requirementsSentence(parts: readonly string[]): string {
  return parts.length === 0 ? "" : `${KEY_DIALOG_COPY.requirementsIntro} ${parts.join(", and ")}.`;
}

/** The progress to show after a report: clamped to 0..1, and unchanged when the report is not a finite number (as the setup model does). */
export function nextProgress(previous: number | undefined, fraction: number): number | undefined {
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : previous;
}
