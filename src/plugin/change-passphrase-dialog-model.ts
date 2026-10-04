import type { KdfParams } from "../crypto";
import { CHANGE_PASSPHRASE_COPY as COPY, KEY_DIALOG_COPY } from "./encryption-copy";
import { nextProgress, reasonText, requirementsSentence, type KeyActionFailure } from "./key-dialog-shared";
import { createSecretEntry, type SecretEntry, type SecretEntryState } from "./key-secret-entry";
import { createSetupModel, type ReentryStatus, type SetupModel } from "./setup-dialog-model";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";
import { PHONE_STATEMENT, REVOCATION_STATEMENT, costLine, derivationsStatement } from "../sync/key-management-text";

/**
 * The rules of the change-passphrase dialog as plain data. The caller hands over the passphrase it generated (this model only shows it in
 * groups and compares the re-entry with it; there is no field for choosing one's own) and the cost of the current slot, which a change of
 * passphrase keeps. The confirm control is enabled only when the current passphrase is well formed, the new passphrase was entered again
 * exactly, and the statement about old passphrases is acknowledged. The model never keeps typed text, only its classification.
 */

export type ChangeRequirement = "current" | "reentry" | "acknowledgement";
export type ChangePhase = "form" | "working" | "done" | "stopped";

export type ChangePassphraseResult = { readonly ok: true; readonly testUnlock: "verified" | "not-run" } | KeyActionFailure;

export interface ChangePassphraseInit {
  /** The generated passphrase, with or without hyphens. */
  readonly passphrase: string;
  /** The cost of the current slot; the new slot keeps it. */
  readonly cost: KdfParams;
  readonly check: PassphraseFormatCheck;
}

export interface ChangePassphraseState {
  readonly phase: ChangePhase;
  /** The new passphrase in groups of 5; empty after `dispose`. */
  readonly groups: readonly string[];
  /** Said before the button works, in reading order. */
  readonly statements: readonly string[];
  readonly current: SecretEntryState;
  readonly reentry: ReentryStatus;
  readonly reentryError: string | undefined;
  readonly reentryRevealed: boolean;
  readonly acknowledged: boolean;
  readonly canConfirm: boolean;
  readonly missing: readonly ChangeRequirement[];
  readonly requirementsText: string;
  readonly busy: boolean;
  readonly progress: number | undefined;
  /** Set when the run stopped without finishing; the form is locked. */
  readonly failure: string | undefined;
  /** Set when the run succeeded: the result of the test unlock. */
  readonly testUnlock: "verified" | "not-run" | undefined;
}

export interface ChangePassphraseModel {
  state(): ChangePassphraseState;
  setCurrent(text: string): ChangePassphraseState;
  touchCurrent(): ChangePassphraseState;
  setCurrentRevealed(on: boolean): ChangePassphraseState;
  setReentry(text: string): ChangePassphraseState;
  touchReentry(): ChangePassphraseState;
  setReentryRevealed(on: boolean): ChangePassphraseState;
  setAcknowledged(on: boolean): ChangePassphraseState;
  /** Enter the working state. Returns false, changing nothing, unless confirm is allowed. */
  begin(): boolean;
  reportProgress(fraction: number): ChangePassphraseState;
  /** The caller's real outcome. */
  settle(result: ChangePassphraseResult): ChangePassphraseState;
  /** Forget the new passphrase. */
  dispose(): void;
}

const NEED: Readonly<Record<ChangeRequirement, string>> = {
  current: KEY_DIALOG_COPY.needCurrent,
  reentry: COPY.needReentry,
  acknowledgement: COPY.needAcknowledgement,
};

export function changePassphraseStatements(cost: KdfParams): readonly string[] {
  return [
    costLine({ current: cost, next: cost, raises: false, downgrade: false }),
    derivationsStatement(cost),
    PHONE_STATEMENT,
    REVOCATION_STATEMENT,
    KEY_DIALOG_COPY.otherDevices,
  ];
}

export function createChangePassphraseModel(init: ChangePassphraseInit): ChangePassphraseModel {
  const setup: SetupModel = createSetupModel(init.passphrase);
  const entry: SecretEntry = createSecretEntry(init.check);
  const statements = changePassphraseStatements(init.cost);
  let phase: ChangePhase = "form";
  let progress: number | undefined;
  let failure: string | undefined;
  let testUnlock: "verified" | "not-run" | undefined;

  const state = (): ChangePassphraseState => {
    const inner = setup.state();
    const current = entry.state();
    const missing: ChangeRequirement[] = [];
    if (current.status !== "ok") missing.push("current");
    if (inner.reentry !== "match") missing.push("reentry");
    if (!inner.acknowledged) missing.push("acknowledgement");
    const form = phase === "form";
    return {
      phase,
      groups: inner.groups,
      statements,
      current,
      reentry: inner.reentry,
      reentryError: inner.reentryError,
      reentryRevealed: inner.revealed,
      acknowledged: inner.acknowledged,
      canConfirm: form && missing.length === 0 && inner.groups.length > 0,
      missing,
      requirementsText: form ? requirementsSentence(missing.map((need) => NEED[need])) : "",
      busy: phase === "working",
      progress: phase === "working" ? progress : undefined,
      failure,
      testUnlock,
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
    setReentry: (text) => {
      setup.setReentry(text);
      return state();
    },
    touchReentry: () => {
      setup.touchReentry();
      return state();
    },
    setReentryRevealed: (on) => {
      setup.setRevealed(on);
      return state();
    },
    setAcknowledged: (on) => {
      setup.setAcknowledged(on);
      return state();
    },
    begin: () => {
      if (!state().canConfirm) return false;
      phase = "working";
      progress = undefined;
      failure = undefined;
      entry.cleared();
      return true;
    },
    reportProgress: (fraction) => {
      if (phase === "working") progress = nextProgress(progress, fraction);
      return state();
    },
    settle: (result) => {
      progress = undefined;
      if (result.ok) {
        phase = "done";
        testUnlock = result.testUnlock;
      } else if (result.retryable) {
        phase = "form";
        entry.refused(result.reason);
      } else {
        phase = "stopped";
        failure = reasonText(result.reason);
      }
      return state();
    },
    dispose: () => setup.dispose(),
  };
}
