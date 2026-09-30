import { SETUP_COPY } from "./encryption-copy";

/**
 * The rules of the setup dialog as plain data: how the generated passphrase is grouped for display, whether the
 * re-entry matches it, and when Create is allowed. The model is handed the generated passphrase by the caller; it
 * never generates one. It compares each re-entry and keeps only the outcome (empty, incomplete, mismatch, match),
 * never the typed text. `dispose` drops the passphrase.
 */

const GROUP_SIZE = 5;

export type ReentryStatus = "empty" | "incomplete" | "mismatch" | "match";
export type Requirement = "reentry" | "acknowledgement";

export interface SetupState {
  /** The passphrase in groups of 5, for display. Empty after `dispose`. */
  readonly groups: readonly string[];
  readonly reentry: ReentryStatus;
  /** Text error for the re-entry field; undefined while there is nothing to report. */
  readonly reentryError: string | undefined;
  readonly acknowledged: boolean;
  readonly revealed: boolean;
  readonly canCreate: boolean;
  /** What still blocks Create, in reading order. */
  readonly missing: readonly Requirement[];
  /** The sentence that says what still blocks Create; empty when nothing does. */
  readonly requirementsText: string;
  readonly busy: boolean;
  /** 0 to 1 while a derivation reports progress; undefined when it does not (or when not busy). */
  readonly progress: number | undefined;
  readonly failure: string | undefined;
}

export interface SetupModel {
  state(): SetupState;
  /** The user typed or pasted into the re-entry field. The text is compared and not kept. */
  setReentry(text: string): SetupState;
  /** The re-entry field lost focus or Enter was pressed: an incomplete entry now counts as an error. */
  touchReentry(): SetupState;
  setAcknowledged(on: boolean): SetupState;
  setRevealed(on: boolean): SetupState;
  /** Enter the busy state. Returns false, changing nothing, unless Create is allowed. */
  begin(): boolean;
  reportProgress(fraction: number): SetupState;
  /** Creation failed: leave the busy state and keep the dialog usable. `reason` is shown as text. */
  fail(reason: string): SetupState;
  /** Creation succeeded: leave the busy state. */
  succeed(): SetupState;
  /** Forget the passphrase. Later state calls show no groups and Create stays disabled. */
  dispose(): void;
}

/** Remove hyphens and spaces and upper-case, so a pasted, lower-case or ungrouped entry compares equal. */
export function normalizeForCompare(text: string): string {
  return text.replaceAll("-", "").replace(/\s+/g, "").toUpperCase();
}

/** The passphrase as groups of 5 symbols. The caller passes 25 symbols, with or without separators. */
export function groupPassphrase(passphrase: string): readonly string[] {
  const symbols = normalizeForCompare(passphrase);
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP_SIZE) groups.push(symbols.slice(i, i + GROUP_SIZE));
  return groups;
}

function classify(target: string | undefined, entered: string): ReentryStatus {
  const normalized = normalizeForCompare(entered);
  if (normalized === "") return "empty";
  if (target === undefined) return "mismatch";
  if (normalized === target) return "match";
  return target.startsWith(normalized) ? "incomplete" : "mismatch";
}

export function requirementsSentence(missing: readonly Requirement[]): string {
  if (missing.length === 0) return "";
  const parts = missing.map((need) => (need === "reentry" ? SETUP_COPY.needReentry : SETUP_COPY.needAcknowledgement));
  return `${SETUP_COPY.requirementsIntro} ${parts.join(", and ")}.`;
}

export function createSetupModel(passphrase: string): SetupModel {
  let target: string | undefined = normalizeForCompare(passphrase);
  let reentry: ReentryStatus = "empty";
  let enteredLength = 0;
  let touched = false;
  let acknowledged = false;
  let revealed = false;
  let busy = false;
  let progress: number | undefined;
  let failure: string | undefined;

  const reentryError = (): string | undefined => {
    if (reentry === "mismatch" && (touched || (target !== undefined && enteredLength >= target.length))) return SETUP_COPY.mismatch;
    if (reentry === "incomplete" && touched) return SETUP_COPY.incomplete;
    return undefined;
  };

  const state = (): SetupState => {
    const missing: Requirement[] = [];
    if (reentry !== "match") missing.push("reentry");
    if (!acknowledged) missing.push("acknowledgement");
    return {
      groups: target === undefined ? [] : groupPassphrase(target),
      reentry,
      reentryError: reentryError(),
      acknowledged,
      revealed,
      canCreate: target !== undefined && missing.length === 0 && !busy,
      missing,
      requirementsText: requirementsSentence(missing),
      busy,
      progress: busy ? progress : undefined,
      failure,
    };
  };

  return {
    state,
    setReentry: (text) => {
      enteredLength = normalizeForCompare(text).length;
      reentry = classify(target, text);
      failure = undefined;
      return state();
    },
    touchReentry: () => {
      touched = true;
      return state();
    },
    setAcknowledged: (on) => {
      acknowledged = on;
      return state();
    },
    setRevealed: (on) => {
      revealed = on;
      return state();
    },
    begin: () => {
      if (!state().canCreate) return false;
      busy = true;
      progress = undefined;
      failure = undefined;
      return true;
    },
    reportProgress: (fraction) => {
      if (busy && Number.isFinite(fraction)) progress = Math.min(1, Math.max(0, fraction));
      return state();
    },
    fail: (reason) => {
      busy = false;
      progress = undefined;
      failure = reason;
      return state();
    },
    succeed: () => {
      busy = false;
      progress = undefined;
      return state();
    },
    dispose: () => {
      target = undefined;
      reentry = "empty";
    },
  };
}
