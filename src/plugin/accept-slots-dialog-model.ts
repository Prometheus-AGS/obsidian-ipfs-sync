import { describeKdfCost, type KdfParams } from "../crypto";
import {
  ACCEPT_NO_FLOOR_STATEMENT,
  ACCEPT_ONE_ROOT_STATEMENT,
  ACCEPT_RESIDUAL_STATEMENT,
  ACCEPT_RESTORE_STATEMENT,
  acceptDowngradeQuestion,
} from "../sync/key-management-text";
import { ACCEPT_SLOTS_COPY as COPY } from "./encryption-copy";
import { nextProgress, reasonText, relateCost, type KeyActionFailure } from "./key-dialog-shared";
import { createSecretEntry, type SecretEntry, type SecretEntryState } from "./key-secret-entry";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

/**
 * The rules of the accept-key-slots dialog as plain data. It has two steps. First the passphrase of the changed key slots is entered and the
 * caller checks the slots on the node (one root, one derivation, manifest authentication, the sequence verdict). Then the dialog shows what
 * would change: the cost of this device's copy and of the incoming slots when they differ, and a confirmation that a cheaper incoming slot
 * needs. Only then does Accept run. The model never keeps typed text.
 */

export type AcceptPhase = "enter" | "checking" | "review" | "accepting" | "done" | "stopped";

/** What the check found, as plain numbers; the caller takes them from the prepared acceptance. */
export interface AcceptReview {
  /** The weakest tried slot of this device's copy; absent when it holds none. */
  readonly current: KdfParams | undefined;
  /** The weakest tried slot of the incoming file. */
  readonly incoming: KdfParams;
  /** False when the copy and the records already match, so accepting would change nothing. */
  readonly changes: boolean;
}

export type AcceptCheckResult = { readonly ok: true; readonly review: AcceptReview } | KeyActionFailure;
export type AcceptCommitResult = { readonly ok: true; readonly kind: "accepted" | "unchanged" } | KeyActionFailure;

export interface AcceptSlotsInit {
  /** `name`: the node's current root. `root-cid`: a root the person named, which may hold older slots. */
  readonly target: "name" | "root-cid";
  readonly check: PassphraseFormatCheck;
}

export interface CostFact {
  readonly label: string;
  readonly value: string;
}

export interface AcceptSlotsState {
  readonly phase: AcceptPhase;
  readonly intro: string;
  readonly statements: readonly string[];
  readonly current: SecretEntryState;
  readonly canCheck: boolean;
  readonly review: AcceptReview | undefined;
  /** The costs to show: both when they differ, one when they are equal or this device holds no copy. */
  readonly costFacts: readonly CostFact[];
  readonly needsDowngradeConfirmation: boolean;
  readonly downgradeQuestion: string | undefined;
  readonly downgradeConfirmed: boolean;
  readonly nothingToAccept: boolean;
  readonly canAccept: boolean;
  readonly busy: boolean;
  readonly progress: number | undefined;
  readonly failure: string | undefined;
  readonly acceptedKind: "accepted" | "unchanged" | undefined;
}

export interface AcceptSlotsModel {
  state(): AcceptSlotsState;
  setCurrent(text: string): AcceptSlotsState;
  touchCurrent(): AcceptSlotsState;
  setCurrentRevealed(on: boolean): AcceptSlotsState;
  beginCheck(): boolean;
  reportProgress(fraction: number): AcceptSlotsState;
  settleCheck(result: AcceptCheckResult): AcceptSlotsState;
  setDowngradeConfirmed(on: boolean): AcceptSlotsState;
  beginAccept(): boolean;
  settleAccept(result: AcceptCommitResult): AcceptSlotsState;
}

export function acceptStatementsFor(target: "name" | "root-cid"): readonly string[] {
  return [
    ACCEPT_ONE_ROOT_STATEMENT,
    ACCEPT_RESIDUAL_STATEMENT,
    ACCEPT_NO_FLOOR_STATEMENT,
    COPY.dropsPending,
    ...(target === "root-cid" ? [ACCEPT_RESTORE_STATEMENT] : []),
  ];
}

function costFacts(review: AcceptReview | undefined): readonly CostFact[] {
  if (review === undefined) return [];
  const incoming = describeKdfCost(review.incoming);
  if (review.current === undefined) return [{ label: COPY.incomingCostName, value: incoming }];
  if (relateCost(review.current, review.incoming) === "same") return [{ label: COPY.sameCostName, value: incoming }];
  return [
    { label: COPY.currentCostName, value: describeKdfCost(review.current) },
    { label: COPY.incomingCostName, value: incoming },
  ];
}

export function createAcceptSlotsModel(init: AcceptSlotsInit): AcceptSlotsModel {
  const entry: SecretEntry = createSecretEntry(init.check);
  const statements = acceptStatementsFor(init.target);
  let phase: AcceptPhase = "enter";
  let review: AcceptReview | undefined;
  let downgradeConfirmed = false;
  let progress: number | undefined;
  let failure: string | undefined;
  let acceptedKind: "accepted" | "unchanged" | undefined;

  const state = (): AcceptSlotsState => {
    const downgrade = review?.current !== undefined && relateCost(review.current, review.incoming) === "lower";
    const nothing = review !== undefined && !review.changes;
    return {
      phase,
      intro: COPY.intro,
      statements,
      current: entry.state(),
      canCheck: phase === "enter" && entry.state().status === "ok",
      review,
      costFacts: costFacts(review),
      needsDowngradeConfirmation: downgrade,
      downgradeQuestion: downgrade && review?.current !== undefined ? acceptDowngradeQuestion({ current: review.current, incoming: review.incoming }) : undefined,
      downgradeConfirmed,
      nothingToAccept: nothing,
      canAccept: phase === "review" && !nothing && (!downgrade || downgradeConfirmed),
      busy: phase === "checking" || phase === "accepting",
      progress: phase === "checking" ? progress : undefined,
      failure,
      acceptedKind,
    };
  };

  return {
    state,
    setCurrent: (text) => {
      entry.setText(text);
      return state();
    },
    touchCurrent: () => {
      entry.touch();
      return state();
    },
    setCurrentRevealed: (on) => {
      entry.setRevealed(on);
      return state();
    },
    beginCheck: () => {
      if (!state().canCheck) return false;
      phase = "checking";
      progress = undefined;
      failure = undefined;
      entry.cleared();
      return true;
    },
    reportProgress: (fraction) => {
      if (phase === "checking") progress = nextProgress(progress, fraction);
      return state();
    },
    settleCheck: (result) => {
      progress = undefined;
      if (result.ok) {
        phase = "review";
        review = result.review;
        downgradeConfirmed = false;
      } else if (result.retryable) {
        phase = "enter";
        entry.refused(result.reason);
      } else {
        phase = "stopped";
        failure = reasonText(result.reason);
      }
      return state();
    },
    setDowngradeConfirmed: (on) => {
      downgradeConfirmed = on && state().needsDowngradeConfirmation;
      return state();
    },
    beginAccept: () => {
      if (!state().canAccept) return false;
      phase = "accepting";
      failure = undefined;
      return true;
    },
    settleAccept: (result) => {
      if (result.ok) {
        phase = "done";
        acceptedKind = result.kind;
      } else if (result.retryable) {
        phase = "review";
        failure = reasonText(result.reason);
      } else {
        phase = "stopped";
        failure = reasonText(result.reason);
      }
      return state();
    },
  };
}
