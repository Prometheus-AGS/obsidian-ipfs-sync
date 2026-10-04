import { DEFAULT_KDF_PARAMS, describeKdfCost, type CostPolicy, type KdfParams } from "../crypto";
import { COST_CONFIRM_COPY as COPY } from "./encryption-copy";

/**
 * The rules of the cost-confirm dialog as plain data (mvp-07b task 2.4). The engine refuses to derive a key from a slot that costs more than the
 * default (`enforceCostPolicy`, `pullCostPolicy`) unless an interactive host says yes first, before any derivation. This dialog is that yes.
 *
 * Every number shown is an engine value (the parameters of a tried slot, read from slot bytes by the format parser); nothing here parses text and
 * nothing from the node is shown as text. Cancel is the default focus, a yes comes only from an explicit confirm and is taken once, and every other
 * way out (Cancel, Escape, closing the window) is a no. A cost that is missing or not a finite number cannot be confirmed: the dialog fails closed.
 *
 * The dialog settles the approval only. The real outcome of the unlock that follows (a wrong passphrase, a refused check) is reported by the key
 * dialog or runner that asked, through its own contract (`settleUnlock`, the key-action `KeyActionFailure`), never by this dialog.
 */

export interface CostConfirmView {
  readonly title: string;
  /** One sentence naming each cost and the default it is above. */
  readonly summary: string;
  /** The same costs as separate lines, for a list. */
  readonly costLines: readonly string[];
  readonly effects: string;
  readonly nothingWritten: string;
  /** Present only when the dialog cannot be approved. */
  readonly blocked: string | undefined;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** The control that takes the initial focus, so an accidental Enter says no. */
  readonly initialFocus: "cancel";
}

export interface CostConfirmState {
  readonly canConfirm: boolean;
  /** An answer has been taken (a yes or a no). */
  readonly decided: boolean;
}

export interface CostConfirmModel {
  view(): CostConfirmView;
  state(): CostConfirmState;
  /** Take the yes. True at most once, never after a cancel, and never for a cost that cannot be confirmed. */
  confirm(): boolean;
  /** Take the no. */
  cancel(): void;
}

const isNumber = (value: number): boolean => Number.isFinite(value) && value > 0;

function blockedReason(costs: readonly KdfParams[]): string | undefined {
  if (costs.length === 0) return COPY.blockedNothing;
  return costs.every((cost) => isNumber(cost.m) && isNumber(cost.t)) ? undefined : COPY.blockedInvalid;
}

function summaryOf(costs: readonly KdfParams[], blocked: boolean): string {
  const limit = describeKdfCost(DEFAULT_KDF_PARAMS);
  if (blocked) return `A key slot costs more to unlock than the default of ${limit}.`;
  if (costs.length === 1) return `This key slot costs ${describeKdfCost(costs[0] as KdfParams)} to unlock, above the default of ${limit}.`;
  return `These key slots cost ${costs.map(describeKdfCost).join("; ")} to unlock, above the default of ${limit}.`;
}

export function createCostConfirmModel(costs: readonly KdfParams[]): CostConfirmModel {
  const blocked = blockedReason(costs);
  let decided = false;
  const view: CostConfirmView = {
    title: COPY.title,
    summary: summaryOf(costs, blocked !== undefined),
    costLines: blocked === undefined ? costs.map(describeKdfCost) : [],
    effects: COPY.effects,
    nothingWritten: COPY.nothingWritten,
    blocked,
    confirmLabel: COPY.confirm,
    cancelLabel: COPY.cancel,
    initialFocus: "cancel",
  };
  return {
    view: () => view,
    state: () => ({ canConfirm: blocked === undefined && !decided, decided }),
    confirm: () => {
      if (blocked !== undefined || decided) return false;
      decided = true;
      return true;
    },
    cancel: () => {
      decided = true;
    },
  };
}

/** The two halves the plugin hands the key actions: `policy` for unlocking the current slot and `confirm` for incoming slots. Structurally `CostConfirmation` in `key-actions.ts`. */
export interface CostConfirmationPorts {
  readonly policy: CostPolicy;
  readonly confirm: (costs: readonly KdfParams[]) => Promise<boolean>;
}

/**
 * Build both halves over one asking function (the dialog, or a stub in a test). The policy asks once for each tried slot above the default, as the
 * engine calls `approveCost`; `confirm` asks once for all tried slots. Only a `true` answer approves: a rejected or non-boolean answer is a no.
 */
export function costConfirmationFrom(ask: (costs: readonly KdfParams[]) => Promise<boolean>): CostConfirmationPorts {
  const approved = async (costs: readonly KdfParams[]): Promise<boolean> => {
    try {
      return (await ask(costs)) === true;
    } catch {
      return false;
    }
  };
  return { policy: { approveCost: (params) => approved([params]) }, confirm: approved };
}
