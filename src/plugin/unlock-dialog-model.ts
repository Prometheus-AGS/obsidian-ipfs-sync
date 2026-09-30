import { UNLOCK_COPY } from "./encryption-copy";

/**
 * The rules of the unlock dialog. The model never holds the passphrase: the dialog passes the field's text to
 * `validate` and to the caller's `unlock`, and clears the field afterwards. A failed local check is reported as
 * a probable typo without contacting the node.
 */

export type PassphraseProblem = "wrong-length" | "wrong-characters" | "check-failed";

/**
 * Local format check over the entered text (separators and case allowed). Returns undefined when the text is a
 * well-formed generated passphrase. The lead adapts the crypto module's canonical-passphrase function to this
 * shape; nothing here imports it.
 */
export type PassphraseFormatCheck = (input: string) => PassphraseProblem | undefined;

export interface UnlockState {
  readonly revealed: boolean;
  /** Text error for the field (local check or the caller's refusal); undefined when there is none. */
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly progress: number | undefined;
}

export type Validation = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface UnlockModel {
  state(): UnlockState;
  /** Check the field's text locally. Does not keep the text. */
  validate(text: string): Validation;
  setRevealed(on: boolean): UnlockState;
  /** The field changed: a shown error no longer describes it. */
  edited(): UnlockState;
  begin(): boolean;
  reportProgress(fraction: number): UnlockState;
  /** The caller refused (for example a wrong passphrase). `reason` is shown as text. */
  fail(reason: string): UnlockState;
  succeed(): UnlockState;
}

const PROBLEM_TEXT: Readonly<Record<PassphraseProblem, string>> = {
  "wrong-length": UNLOCK_COPY.wrongLength,
  "wrong-characters": UNLOCK_COPY.wrongCharacters,
  "check-failed": UNLOCK_COPY.checkFailed,
};

export function createUnlockModel(check: PassphraseFormatCheck): UnlockModel {
  let revealed = false;
  let error: string | undefined;
  let busy = false;
  let progress: number | undefined;

  const state = (): UnlockState => ({ revealed, error, busy, progress: busy ? progress : undefined });

  return {
    state,
    validate: (text) => {
      if (text.trim() === "") {
        error = UNLOCK_COPY.empty;
        return { ok: false, error };
      }
      const problem = check(text);
      if (problem !== undefined) {
        error = PROBLEM_TEXT[problem];
        return { ok: false, error };
      }
      error = undefined;
      return { ok: true };
    },
    setRevealed: (on) => {
      revealed = on;
      return state();
    },
    edited: () => {
      error = undefined;
      return state();
    },
    begin: () => {
      if (busy) return false;
      busy = true;
      progress = undefined;
      error = undefined;
      return true;
    },
    reportProgress: (fraction) => {
      if (busy && Number.isFinite(fraction)) progress = Math.min(1, Math.max(0, fraction));
      return state();
    },
    fail: (reason) => {
      busy = false;
      progress = undefined;
      error = reason;
      return state();
    },
    succeed: () => {
      busy = false;
      progress = undefined;
      return state();
    },
  };
}
