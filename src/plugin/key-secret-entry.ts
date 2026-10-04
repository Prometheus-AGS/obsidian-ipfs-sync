import { UNLOCK_COPY } from "./encryption-copy";
import { reasonText } from "./key-dialog-shared";
import type { PassphraseFormatCheck, PassphraseProblem } from "./unlock-dialog-model";

/**
 * The "current passphrase" field of the key dialogs as plain data. It never keeps the typed text: `setText` classifies it
 * (empty, well formed, malformed) and drops it. A local problem is shown only once the field is left, so half-typed text is not
 * flagged; the caller's refusal (a wrong passphrase) is shown at once and goes away when the text changes.
 */

export type SecretStatus = "empty" | "ok" | "invalid";

export interface SecretEntryState {
  readonly status: SecretStatus;
  /** Text error for the field; undefined when there is none. */
  readonly error: string | undefined;
  readonly revealed: boolean;
}

export interface SecretEntry {
  state(): SecretEntryState;
  /** The field's text changed. Classified and not kept. Clears a refusal that described the old text. */
  setText(text: string): SecretEntryState;
  /** The field lost focus: a malformed entry now counts as an error. */
  touch(): SecretEntryState;
  setRevealed(on: boolean): SecretEntryState;
  /** The dialog emptied the field (the text went to the caller). */
  cleared(): SecretEntryState;
  /** The caller refused the entry; `reason` is shown as text. */
  refused(reason: string): SecretEntryState;
}

const PROBLEM_TEXT: Readonly<Record<PassphraseProblem, string>> = {
  "wrong-length": UNLOCK_COPY.wrongLength,
  "wrong-characters": UNLOCK_COPY.wrongCharacters,
  "check-failed": UNLOCK_COPY.checkFailed,
};

export function createSecretEntry(check: PassphraseFormatCheck): SecretEntry {
  let status: SecretStatus = "empty";
  let problem: PassphraseProblem | undefined;
  let touched = false;
  let refusal: string | undefined;
  let revealed = false;

  const state = (): SecretEntryState => ({
    status,
    error: refusal ?? (touched && problem !== undefined ? PROBLEM_TEXT[problem] : undefined),
    revealed,
  });

  return {
    state,
    setText: (text) => {
      refusal = undefined;
      if (text.trim() === "") {
        status = "empty";
        problem = undefined;
      } else {
        problem = check(text);
        status = problem === undefined ? "ok" : "invalid";
      }
      return state();
    },
    touch: () => {
      touched = true;
      return state();
    },
    setRevealed: (on) => {
      revealed = on;
      return state();
    },
    cleared: () => {
      status = "empty";
      problem = undefined;
      touched = false;
      return state();
    },
    refused: (reason) => {
      status = "empty";
      problem = undefined;
      touched = false;
      refusal = reasonText(reason);
      return state();
    },
  };
}
