import { ABANDON_PHRASE } from "./encryption-copy";

/** The rules of the abandon-vault confirmation: the action is enabled only after the word is typed. */

export interface AbandonState {
  readonly canAbandon: boolean;
  readonly busy: boolean;
  readonly failure: string | undefined;
}

export interface AbandonModel {
  state(): AbandonState;
  setTyped(text: string): AbandonState;
  begin(): boolean;
  fail(reason: string): AbandonState;
}

export function typedConfirmation(text: string): boolean {
  return text.trim().toLowerCase() === ABANDON_PHRASE;
}

export function createAbandonModel(): AbandonModel {
  let confirmed = false;
  let busy = false;
  let failure: string | undefined;
  const state = (): AbandonState => ({ canAbandon: confirmed && !busy, busy, failure });
  return {
    state,
    setTyped: (text) => {
      confirmed = typedConfirmation(text);
      failure = undefined;
      return state();
    },
    begin: () => {
      if (!state().canAbandon) return false;
      busy = true;
      failure = undefined;
      return true;
    },
    fail: (reason) => {
      busy = false;
      failure = reason;
      return state();
    },
  };
}
