/**
 * The rules shared by the pull confirmations (first pull, restore, fork, large pull) as plain data. A dialog is a
 * `ConfirmView`: what to show and what blocks the yes. The model holds the one piece of state, the acknowledgement,
 * and answers whether Confirm is allowed. Nothing here writes anything: a dialog only reports yes or no, and the
 * caller acts on a yes. Cancel, Escape and every other way out are a no.
 */

export interface ConfirmFact {
  readonly label: string;
  /** Shown as text, never as markup: the value can come from the node. */
  readonly value: string;
}

export interface ConfirmList {
  readonly heading?: string;
  readonly items: readonly string[];
  readonly ordered?: boolean;
  /** A sentence printed under the list. */
  readonly after?: string;
}

export interface ConfirmView {
  /** Prefix of the element ids, unique per dialog kind. */
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly facts: readonly ConfirmFact[];
  /** A sentence printed after the facts. */
  readonly factsNote?: string;
  readonly lists: readonly ConfirmList[];
  /** When present the user must tick this before Confirm is enabled. */
  readonly acknowledgement?: { readonly label: string; readonly needText: string };
  /** When present Confirm stays disabled for good and the text is shown as an error. */
  readonly blocker?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** `warning` marks an action that replaces files; the label, not the colour, carries the meaning. */
  readonly confirmStyle: "cta" | "warning";
}

export interface ConfirmState {
  readonly acknowledged: boolean;
  readonly canConfirm: boolean;
  /** What still blocks Confirm, as a sentence; empty when nothing does. */
  readonly needText: string;
  readonly blocker: string | undefined;
}

export interface ConfirmModel {
  state(): ConfirmState;
  setAcknowledged(on: boolean): ConfirmState;
  /** Take the yes. Returns false, changing nothing, unless Confirm is allowed; true at most once. */
  confirm(): boolean;
}

export function createConfirmModel(view: Pick<ConfirmView, "acknowledgement" | "blocker">): ConfirmModel {
  let acknowledged = false;
  let taken = false;
  const state = (): ConfirmState => {
    const blocked = view.blocker !== undefined;
    const needsAck = view.acknowledgement !== undefined && !acknowledged;
    return {
      acknowledged,
      canConfirm: !blocked && !needsAck && !taken,
      needText: blocked ? "" : needsAck ? (view.acknowledgement?.needText ?? "") : "",
      blocker: view.blocker,
    };
  };
  return {
    state,
    setAcknowledged: (on) => {
      acknowledged = on;
      return state();
    },
    confirm: () => {
      if (!state().canConfirm) return false;
      taken = true;
      return true;
    },
  };
}
