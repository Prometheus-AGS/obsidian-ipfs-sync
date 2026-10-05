import type { App } from "obsidian";
import { ConfigError } from "../core/config";
import { CryptoError, PassphraseFormatError, canonicalizePassphraseText, wipe } from "../crypto";
import { KuboError } from "../kubo";
import { PublishRefusedError } from "../sync/publish-refusals";
import { RootStateError } from "../sync/root-state";
import { VaultKeysError } from "../sync/vault-keys";
import { SetupVaultDialog, type SetupCreateResult, type SetupDialogRequest } from "./setup-dialog";
import type { DialogCallbacks, SessionKeys, UnlockFailure, UnlockOutcome, UnlockingEvent } from "./session-keys";
import { UnlockVaultDialog, type UnlockDialogRequest, type UnlockResult } from "./unlock-dialog";
import type { PassphraseProblem } from "./unlock-dialog-model";
import { VaultSetupRefusedError } from "./vault-opener";

/**
 * Connects the key session (`session-keys.ts`) to the setup and unlock dialogs (`setup-dialog.ts`,
 * `unlock-dialog.ts`). The two sides are shaped differently on purpose. The session asks a dialog for text and does
 * the derivation itself, asking again after a wrong passphrase; each dialog instead calls a function with the text
 * and waits for a verdict, showing the failure in place. This module lets one dialog span the whole attempt sequence:
 *
 *   - The dialog's submit hands the text to the session (the promise `DialogCallbacks.unlock` returned) and keeps its
 *     own call pending as the verdict.
 *   - A second request from the session with a `failure` answers that verdict as "not accepted" and the dialog stays
 *     open for the next entry.
 *   - `settling(session)` answers the last verdict when an `unlock()` or `setup()` call ends: success closes the
 *     dialog, an error or a cancellation shows its reason in it.
 *   - After a terminal answer (an error, not a wrong passphrase) the session call is over, so a further submit in the
 *     same dialog cannot be served: it is told to close the dialog and start again.
 *
 * The passphrase is passed through and never kept: the unlock text goes straight to the session, and the setup
 * dialog is given the display string the session generated. Every reason shown comes from fixed messages of the
 * shared layers or from this file; none contains the entered text.
 */

export const UNLOCK_WRONG_TEXT = "That passphrase did not open this vault. Check it and try again. Nothing was changed.";
export const UNLOCK_FORMAT_TEXT = "That is not a valid passphrase. Check it and try again.";
export const CLOSE_AND_RETRY_TEXT = "This attempt is over. Close this dialog and start again from the plugin.";
export const ENDED_TEXT = "The vault was locked or the plugin was stopped before this finished. Nothing was changed.";
export const UNEXPECTED_TEXT = "an unexpected error occurred; see the developer console for details";

/** Errors whose messages the shared layers promise are fixed text without secrets. Any other error shows a generic line. */
const SAFE_ERRORS = [ConfigError, CryptoError, VaultKeysError, VaultSetupRefusedError, PublishRefusedError, RootStateError, KuboError] as const;

export function describeDialogError(error: unknown): string {
  return SAFE_ERRORS.some((safe) => error instanceof safe) ? (error as Error).message : UNEXPECTED_TEXT;
}

const PROBLEM: Readonly<Record<string, PassphraseProblem>> = { length: "wrong-length", alphabet: "wrong-characters", check: "check-failed" };

/**
 * The unlock dialog's local check: the public canonical-passphrase function decides, so the dialog and the session
 * can never disagree about what a well-formed passphrase is. The canonical bytes are wiped at once.
 */
export function passphraseFormatCheck(input: string): PassphraseProblem | undefined {
  try {
    wipe(canonicalizePassphraseText(input));
    return undefined;
  } catch (error) {
    if (error instanceof PassphraseFormatError) return PROBLEM[error.reason] ?? "check-failed";
    throw error;
  }
}

export interface DialogHandle {
  close(): void;
}

export interface DialogFactories {
  unlock(request: UnlockDialogRequest, onFinish: (outcome: "unlocked" | "cancelled") => void): DialogHandle;
  setup(request: SetupDialogRequest, onFinish: (outcome: "created" | "cancelled") => void): DialogHandle;
}

/** The real dialogs, opened over the app. */
export function obsidianDialogFactories(app: App): DialogFactories {
  return {
    unlock: (request, onFinish) => {
      const dialog = new UnlockVaultDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
    setup: (request, onFinish) => {
      const dialog = new SetupVaultDialog(app, request, onFinish);
      dialog.open();
      return dialog;
    },
  };
}

type Verdict = UnlockResult | SetupCreateResult;

/** One open dialog and the promises that connect it to the session. */
interface Flow<Typed> {
  handle: DialogHandle | undefined;
  /** The session is waiting for the user's next entry. */
  entry: ((typed: Typed | undefined) => void) | undefined;
  /** The dialog's own call is waiting to hear whether its entry was accepted. */
  verdict: ((verdict: Verdict) => void) | undefined;
  /** Progress sink of the dialog's pending call. */
  progress: ((fraction: number) => void) | undefined;
}

const emptyFlow = <Typed>(): Flow<Typed> => ({ handle: undefined, entry: undefined, verdict: undefined, progress: undefined });

function answer(flow: Pick<Flow<never>, "verdict" | "progress"> | undefined, verdict: Verdict): void {
  if (flow === undefined) return;
  const pending = flow.verdict;
  flow.verdict = undefined;
  flow.progress = undefined;
  pending?.(verdict);
}

export interface SessionDialogs {
  readonly callbacks: DialogCallbacks;
  /** The session with its `unlock` and `setup` wrapped so that the dialog they used is answered and closed when they end. */
  settling(session: SessionKeys): SessionKeys;
  /**
   * Answer the unlock dialog's pending entry from outside the session. The pull asks for its passphrase through `callbacks.unlock`
   * and ends the sequence with this: success closes the dialog, a refusal is shown in it. No-op when no unlock dialog is waiting.
   */
  settleUnlock(verdict: UnlockResult): void;
  /** Close any open dialog without answering it (plugin unload). */
  dispose(): void;
}

export function createSessionDialogs(factories: DialogFactories): SessionDialogs {
  let unlockFlow: Flow<string> | undefined;
  let setupFlow: Flow<{ readonly confirmed: boolean; readonly reentered: string }> | undefined;

  function openUnlock(): Flow<string> {
    const flow = emptyFlow<string>();
    flow.handle = factories.unlock(
      {
        check: passphraseFormatCheck,
        unlock: (text, onProgress) =>
          new Promise<UnlockResult>((resolve) => {
            const waiting = flow.entry;
            if (waiting === undefined) {
              resolve({ ok: false, reason: CLOSE_AND_RETRY_TEXT });
              return;
            }
            flow.entry = undefined;
            flow.verdict = resolve;
            flow.progress = onProgress;
            waiting(text);
          }),
      },
      () => {
        if (unlockFlow === flow) unlockFlow = undefined;
        flow.entry?.(undefined);
        flow.entry = undefined;
      },
    );
    unlockFlow = flow;
    return flow;
  }

  const failureText = (failure: UnlockFailure): string => (failure === "format" ? UNLOCK_FORMAT_TEXT : UNLOCK_WRONG_TEXT);

  const callbacks: DialogCallbacks = {
    unlock: (request) => {
      const flow = unlockFlow ?? openUnlock();
      if (request.failure !== undefined) answer(flow, { ok: false, reason: failureText(request.failure) });
      return new Promise<string | undefined>((resolve) => {
        flow.entry = resolve;
      });
    },
    setup: (request) =>
      new Promise((resolve) => {
        const flow = emptyFlow<{ readonly confirmed: boolean; readonly reentered: string }>();
        flow.entry = resolve;
        setupFlow = flow;
        flow.handle = factories.setup(
          {
            passphrase: request.passphrase,
            create: (onProgress) =>
              new Promise<SetupCreateResult>((done) => {
                const waiting = flow.entry;
                if (waiting === undefined) {
                  done({ ok: false, reason: CLOSE_AND_RETRY_TEXT });
                  return;
                }
                flow.entry = undefined;
                flow.verdict = done;
                flow.progress = onProgress;
                // The dialog has compared the re-entry with this passphrase and required the acknowledgement before it called `create`;
                // it does not hand the typed text on, so the session's own comparison receives the passphrase it displayed.
                waiting({ confirmed: true, reentered: request.passphrase });
              }),
          },
          () => {
            if (setupFlow === flow) setupFlow = undefined;
            flow.entry?.(undefined);
            flow.entry = undefined;
          },
        );
      }),
    unlocking: (event: UnlockingEvent) => {
      if (event.kind !== "progress") return;
      (unlockFlow?.progress ?? setupFlow?.progress)?.(event.fraction);
    },
  };

  function settle(verdict: Verdict): void {
    answer(unlockFlow, verdict);
    answer(setupFlow, verdict);
  }

  async function settled(run: () => Promise<UnlockOutcome>): Promise<UnlockOutcome> {
    try {
      const outcome = await run();
      settle(outcome.kind === "unlocked" ? { ok: true } : { ok: false, reason: ENDED_TEXT });
      return outcome;
    } catch (error) {
      settle({ ok: false, reason: describeDialogError(error) });
      throw error;
    }
  }

  return {
    callbacks,
    settling: (session) => ({ ...session, unlock: () => settled(() => session.unlock()), setup: () => settled(() => session.setup()) }),
    settleUnlock: (verdict) => answer(unlockFlow, verdict),
    dispose: () => {
      unlockFlow?.handle?.close();
      setupFlow?.handle?.close();
    },
  };
}
