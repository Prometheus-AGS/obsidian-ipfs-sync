import type { KdfParams } from "../crypto";
import { HISTORY_KEEP_FLOOR } from "../sync/prune-history";
import { PRUNE_KEEPS_STATEMENT, PRUNE_QUESTION, PRUNE_RESTORE_STATEMENT } from "../sync/prune-history-text";
import { KEY_DIALOG_COPY, PRUNE_HISTORY_COPY as COPY } from "./encryption-copy";
import { nextProgress, reasonText, requirementsSentence, type KeyActionFailure } from "./key-dialog-shared";
import { createSecretEntry, type SecretEntry, type SecretEntryState } from "./key-secret-entry";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

/**
 * The rules of the prune-history dialog as plain data (mvp-07b task 2.5). Two steps, like accept: first the count to keep and the current passphrase are
 * entered and the caller PREVIEWS (one key derivation, every refusal of `preparePrune`, all reads, nothing written); then the dialog shows what the plan
 * would do as counts and the engine's own statements, and only an explicit press of the remove control removes anything. No node path or name ever
 * reaches this model: the caller hands over numbers and fixed text. The model never keeps typed text, only its classification.
 */

export type PrunePhase = "form" | "previewing" | "review" | "removing" | "done" | "stopped";
export type PruneRequirement = "keep" | "current";

/** What the preview found, as numbers and fixed sentences. `removing` is 0 when there is nothing to prune. */
export interface PruneReview {
  readonly removing: number;
  readonly keeping: number;
  readonly total: number;
  /** In reading order: the first sentence is the summary. Built by the caller from the engine's text; no node text. */
  readonly statements: readonly string[];
}

export type PrunePreviewResult = { readonly ok: true; readonly review: PruneReview } | KeyActionFailure;
export type PruneRemoveResult =
  | { readonly ok: true; readonly kind: "pruned" | "unchanged"; readonly removed: number; readonly kept: number }
  | KeyActionFailure;

export interface PruneHistoryInit {
  /** The cost of the key slot this device holds: one derivation at this cost happens at the preview. */
  readonly cost: KdfParams;
  readonly check: PassphraseFormatCheck;
}

export interface PruneKeepState {
  readonly status: "empty" | "ok" | "invalid";
  /** What was asked for; undefined unless `status` is `ok`. */
  readonly value: number | undefined;
  /** What the engine will keep at least: the request raised to the floor. */
  readonly effective: number | undefined;
  readonly error: string | undefined;
  /** Said in words when the request is under the floor. */
  readonly note: string | undefined;
}

export interface PruneOutcome {
  readonly kind: "pruned" | "unchanged";
  readonly removed: number;
  readonly kept: number;
}

export interface PruneHistoryState {
  readonly phase: PrunePhase;
  readonly floor: number;
  /** Said before the preview works, in reading order. */
  readonly statements: readonly string[];
  readonly keep: PruneKeepState;
  readonly current: SecretEntryState;
  readonly missing: readonly PruneRequirement[];
  readonly requirementsText: string;
  readonly canPreview: boolean;
  readonly review: PruneReview | undefined;
  /** The question the remove control answers; present in the review only. */
  readonly question: string | undefined;
  readonly nothingToPrune: boolean;
  readonly canRemove: boolean;
  readonly removeLabel: string | undefined;
  readonly busy: boolean;
  readonly progress: number | undefined;
  /** The reason the run stopped or a removal could not start, already written out for display. */
  readonly failure: string | undefined;
  readonly stoppedAt: "preview" | "remove" | undefined;
  /** What a stopped run means for the node, by where it stopped. */
  readonly stoppedText: string | undefined;
  readonly outcome: PruneOutcome | undefined;
  /** The control that takes the focus now: the count in the form, Cancel everywhere the remove control can be pressed. */
  readonly initialFocus: "keep" | "cancel";
}

export interface PruneHistoryModel {
  state(): PruneHistoryState;
  setKeep(text: string): PruneHistoryState;
  touchKeep(): PruneHistoryState;
  setCurrent(text: string): PruneHistoryState;
  touchCurrent(): PruneHistoryState;
  setCurrentRevealed(on: boolean): PruneHistoryState;
  /** Enter the previewing state and give back the count. Undefined, changing nothing, unless the gating holds. */
  beginPreview(): { readonly keep: number } | undefined;
  reportProgress(fraction: number): PruneHistoryState;
  /** The caller's real outcome of the preview. */
  settlePreview(result: PrunePreviewResult): PruneHistoryState;
  /** Enter the removing state. False, changing nothing, unless the review removes something. */
  beginRemove(): boolean;
  /** The caller's real outcome of the removal. */
  settleRemove(result: PruneRemoveResult): PruneHistoryState;
}

const MAX_DIGITS = 9;

const files = (count: number): string => (count === 1 ? "1 history file" : `${count} history files`);

export const removeLabelFor = (count: number): string => `Remove ${files(count)}`;

/** The statements before the preview: the derivation it takes, then what a prune keeps and what it costs. */
export function pruneFormStatements(cost: KdfParams): readonly string[] {
  return [
    `Showing what would be removed takes one key derivation on this device, about ${cost.m / 1024} MiB of memory and ${cost.t} iterations, with the current passphrase. Removing does not derive again.`,
    PRUNE_KEEPS_STATEMENT,
    PRUNE_RESTORE_STATEMENT,
  ];
}

function classifyKeep(text: string): { readonly status: "empty" | "ok" | "invalid"; readonly value: number | undefined } {
  const trimmed = text.trim();
  if (trimmed === "") return { status: "empty", value: undefined };
  if (!new RegExp(`^[0-9]{1,${MAX_DIGITS}}$`).test(trimmed)) return { status: "invalid", value: undefined };
  const value = Number(trimmed);
  return value >= 1 ? { status: "ok", value } : { status: "invalid", value: undefined };
}

const raisedNote = (): string => `Raised to ${HISTORY_KEEP_FLOOR}: at least the newest ${HISTORY_KEEP_FLOOR} history files are always kept.`;

export function createPruneHistoryModel(init: PruneHistoryInit): PruneHistoryModel {
  const entry: SecretEntry = createSecretEntry(init.check);
  const statements = pruneFormStatements(init.cost);
  let phase: PrunePhase = "form";
  let keepText = "";
  let keepTouched = false;
  let progress: number | undefined;
  let failure: string | undefined;
  let review: PruneReview | undefined;
  let stoppedAt: "preview" | "remove" | undefined;
  let outcome: PruneOutcome | undefined;

  const keepState = (): PruneKeepState => {
    const { status, value } = classifyKeep(keepText);
    return {
      status,
      value,
      effective: value === undefined ? undefined : Math.max(value, HISTORY_KEEP_FLOOR),
      error: status === "invalid" && keepTouched ? COPY.keepInvalid : undefined,
      note: value !== undefined && value < HISTORY_KEEP_FLOOR ? raisedNote() : undefined,
    };
  };

  const state = (): PruneHistoryState => {
    const keep = keepState();
    const current = entry.state();
    const missing: PruneRequirement[] = [];
    if (keep.status !== "ok") missing.push("keep");
    if (current.status !== "ok") missing.push("current");
    const form = phase === "form";
    const nothing = review !== undefined && review.removing === 0;
    const reviewing = phase === "review" || phase === "removing";
    return {
      phase,
      floor: HISTORY_KEEP_FLOOR,
      statements,
      keep,
      current,
      missing,
      requirementsText: form ? requirementsSentence(missing.map((need) => (need === "keep" ? COPY.needKeep : KEY_DIALOG_COPY.needCurrent))) : "",
      canPreview: form && missing.length === 0,
      review,
      question: reviewing && !nothing ? PRUNE_QUESTION : undefined,
      nothingToPrune: nothing,
      canRemove: phase === "review" && review !== undefined && review.removing > 0,
      removeLabel: review !== undefined && review.removing > 0 ? removeLabelFor(review.removing) : undefined,
      busy: phase === "previewing" || phase === "removing",
      progress: phase === "previewing" ? progress : undefined,
      failure,
      stoppedAt,
      stoppedText: phase !== "stopped" ? undefined : stoppedAt === "remove" ? COPY.stoppedAtRemove : COPY.stoppedAtPreview,
      outcome,
      initialFocus: form ? "keep" : "cancel",
    };
  };

  return {
    state,
    setKeep: (text) => {
      keepText = text;
      return state();
    },
    touchKeep: () => {
      keepTouched = true;
      return state();
    },
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
    beginPreview: () => {
      const now = state();
      if (!now.canPreview || now.keep.value === undefined) return undefined;
      phase = "previewing";
      progress = undefined;
      failure = undefined;
      entry.cleared();
      return { keep: now.keep.value };
    },
    reportProgress: (fraction) => {
      if (phase === "previewing") progress = nextProgress(progress, fraction);
      return state();
    },
    settlePreview: (result) => {
      progress = undefined;
      if (result.ok) {
        phase = "review";
        review = result.review;
      } else if (result.retryable) {
        phase = "form";
        entry.refused(result.reason);
      } else {
        phase = "stopped";
        stoppedAt = "preview";
        failure = reasonText(result.reason);
      }
      return state();
    },
    beginRemove: () => {
      if (!state().canRemove) return false;
      phase = "removing";
      failure = undefined;
      return true;
    },
    settleRemove: (result) => {
      if (result.ok) {
        phase = "done";
        outcome = { kind: result.kind, removed: result.removed, kept: result.kept };
      } else if (result.retryable) {
        phase = "review";
        failure = reasonText(result.reason);
      } else {
        phase = "stopped";
        stoppedAt = "remove";
        failure = reasonText(result.reason);
      }
      return state();
    },
  };
}
