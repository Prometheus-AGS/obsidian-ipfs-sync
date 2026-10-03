import { CryptoError, canonicalizePassphraseText, wipe, type CanonicalPassphrase } from "../crypto";
import type { UnlockFailure, UnlockRequest } from "./session-keys";

/**
 * Where a pull gets a passphrase when no unlocked vault is held. The pull never opens a dialog by itself: the host
 * supplies this port (the unlock dialog), and a run that cannot ask (the catch-up pull) supplies none.
 *
 * The passphrase text exists only for the length of one attempt: it is canonicalised, handed to the engine and wiped.
 * Nothing here stores it, logs it or puts it into an outcome.
 */
export interface PassphrasePort {
  /** Ask for the next entry. `request.failure` says why the previous one was refused. `undefined` means the user cancelled. */
  ask(request: UnlockRequest): Promise<string | undefined>;
  /** Progress of the key derivation as a fraction from 0 to 1, for the dialog's indicator. */
  progress?(fraction: number): void;
  /** The attempt sequence is over: success closes the dialog; a refusal is shown in it. Called at most once per sequence. */
  settle?(verdict: PassphraseVerdict): void;
}

export type PassphraseVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** What one attempt with a canonical passphrase found. `wrong` asks again; anything else ends the sequence. */
export type AttemptResult<T> = { readonly kind: "wrong"; readonly failure?: UnlockFailure } | { readonly kind: "done"; readonly value: T };

export type Prompted<T> = { readonly kind: "cancelled" } | { readonly kind: "done"; readonly value: T };

const isFormatError = (error: unknown): boolean => error instanceof CryptoError && error.code === "passphrase-format";

/** Ask until an attempt is not `wrong`, or the user cancels. Each entry is canonicalised, used for one attempt and wiped. */
export async function askUntilAccepted<T>(port: PassphrasePort, attempt: (passphrase: CanonicalPassphrase) => Promise<AttemptResult<T>>): Promise<Prompted<T>> {
  let failure: UnlockFailure | undefined;
  for (let count = 1; ; count += 1) {
    const typed = await port.ask(failure === undefined ? { attempt: count } : { attempt: count, failure });
    if (typed === undefined) return { kind: "cancelled" };
    let passphrase: CanonicalPassphrase;
    try {
      passphrase = canonicalizePassphraseText(typed);
    } catch (error) {
      if (!isFormatError(error)) throw error;
      failure = "format";
      continue;
    }
    try {
      const result = await attempt(passphrase);
      if (result.kind === "done") return result;
      failure = result.failure ?? "wrong-passphrase";
    } finally {
      wipe(passphrase);
    }
  }
}
