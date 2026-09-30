import {
  CryptoError,
  canonicalizePassphraseText,
  formatPassphrase,
  generatePassphrase,
  wipe,
  type CanonicalPassphrase,
  type GeneratedPassphrase,
  type KdfProgress,
} from "../crypto";
import { keySlotsCopyPath, type UnlockedVault } from "../sync/vault-keys";
import type { HostFs } from "../core/host-bridge";

/*
 * The plugin's in-memory key session (mvp-06 task 4.2, review-3 W-07).
 *
 * What it holds: one `UnlockedVault` (the non-extractable `VaultKeys` plus the public key-slot bytes it was unlocked
 * from) and nothing else. It never holds a passphrase past the derivation call, never writes anything (there is no
 * storage dependency in this file: no plugin data, no vault file, no browser storage) and never derives on its own:
 * derivation happens inside the `open` port the host supplies, and only after a dialog produced a passphrase.
 *
 * One prompt per session: `unlock()` and `setup()` return the held vault without a prompt when unlocked, and two
 * concurrent calls share one dialog. `provider()` is the already-unlocked key provider for the publish engine
 * (`PublishOptions.unlocked`): it is synchronous, never prompts and never derives, which is what a timer tick uses.
 * `lock()` drops the reference; the next publish that needs the keys prompts again. Lock on plugin unload with `dispose()`.
 *
 * Stated limits: a dialog's passphrase is an interface string and cannot be zeroed; the bytes derived from it are
 * overwritten after use. The `VaultKeys` object is a derivation oracle for code in the same JavaScript context (another
 * plugin); non-extractability stops key export, not use. `lock()` releases the reference, and the runtime decides when
 * the memory goes.
 */

/** `not-set-up`: no local key-slot copy (no vault created or recovered on this device). `locked`: a vault exists, no keys held. */
export type SessionState = "not-set-up" | "locked" | "unlocked";

/** Why the unlock dialog is being shown again. Absent on the first request. */
export type UnlockFailure = "wrong-passphrase" | "format";

export interface UnlockRequest {
  /** 1 for the first request of this attempt sequence. */
  readonly attempt: number;
  readonly failure?: UnlockFailure;
}

/** The setup dialog is shown the generated passphrase (grouped, case-insensitive) and must return its re-entry and the acknowledgement. */
export interface SetupRequest {
  /** The generated passphrase in display form, 5 groups of 5. The only place it exists as a string. */
  readonly passphrase: string;
}

export interface SetupResult {
  /** The Create action, taken after the no-recovery acknowledgement. */
  readonly confirmed: boolean;
  /** What the user typed to confirm they saved it. Compared after canonicalisation. */
  readonly reentered: string;
}

/** What the unlocking indicator ("keep the app in the foreground") follows. */
export type UnlockingEvent = { readonly kind: "start" } | { readonly kind: "progress"; readonly fraction: number } | { readonly kind: "end" };

export interface DialogCallbacks {
  /** Ask for the vault passphrase. `undefined` means the user cancelled. */
  unlock(request: UnlockRequest): Promise<string | undefined>;
  /** Show the generated passphrase and collect the re-entry. `undefined` or `confirmed: false` means the user cancelled. */
  setup(request: SetupRequest): Promise<SetupResult | undefined>;
  /** Optional progress of the key derivation. */
  unlocking?(event: UnlockingEvent): void;
}

export interface OpenRequest {
  readonly passphrase: CanonicalPassphrase;
  /** Present for setup: the generated passphrase (the same bytes as `passphrase`). The host creates the vault. */
  readonly create?: GeneratedPassphrase;
  readonly onProgress: KdfProgress;
}

/**
 * The derivation port, supplied by the runner: it wraps `openVault` with node access and the cost policy, and returns
 * `toUnlockedVault(opened)`. It is the only place Argon2id runs for this session.
 */
export type OpenVault = (request: OpenRequest) => Promise<UnlockedVault>;

export type UnlockOutcome =
  | { readonly kind: "unlocked"; readonly vault: UnlockedVault }
  | { readonly kind: "cancelled" }
  /** `unlock()` on a device with no vault; the caller decides whether to offer `setup()`. */
  | { readonly kind: "not-set-up" };

export interface SessionKeys {
  /** Current state. Call `refresh()` once at load; `not-set-up` is the answer until then. */
  state(): SessionState;
  /** Re-read whether a vault exists on this device. */
  refresh(): Promise<SessionState>;
  /** The held vault, or `undefined` when locked. Synchronous, no prompt, no derivation. Safe to pass detached as `PublishOptions.unlocked`. */
  readonly provider: () => UnlockedVault | undefined;
  /** Unlock with the dialog unless already unlocked. One prompt sequence per session; concurrent calls share it. */
  unlock(): Promise<UnlockOutcome>;
  /** Create a vault through the setup dialog. Never runs implicitly. When already unlocked it returns the held vault. */
  setup(): Promise<UnlockOutcome>;
  /** Drop the held keys. Idempotent. An unlock in flight finishes but its keys are discarded. */
  lock(): void;
  /** Lock and refuse all further prompts (plugin unload). */
  dispose(): void;
}

export interface SessionKeysDeps {
  readonly dialogs: DialogCallbacks;
  readonly open: OpenVault;
  /** Whether this device already has a vault (see `hasLocalKeySlots`). */
  readonly vaultExists: () => Promise<boolean>;
}

/** The usual `vaultExists`: this root's local key-slot copy is present. */
export async function hasLocalKeySlots(fs: Pick<HostFs, "stat">, mfsRoot: string): Promise<boolean> {
  return (await fs.stat(await keySlotsCopyPath(mfsRoot)))?.kind === "file";
}

const isWrongPassphrase = (error: unknown): boolean => error instanceof CryptoError && error.code === "wrong-passphrase-or-damaged-slot";
const isFormatError = (error: unknown): boolean => error instanceof CryptoError && error.code === "passphrase-format";

export function createSessionKeys(deps: SessionKeysDeps): SessionKeys {
  let held: UnlockedVault | undefined;
  let setUp = false;
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<UnlockOutcome> | undefined;

  const notify = (event: UnlockingEvent): void => {
    try {
      deps.dialogs.unlocking?.(event);
    } catch {
      // A broken indicator must not decide whether the vault unlocks.
    }
  };

  /** Runs the derivation port with the indicator; wipes the passphrase bytes whatever happens. */
  async function derive(passphrase: CanonicalPassphrase, create?: GeneratedPassphrase): Promise<UnlockedVault> {
    notify({ kind: "start" });
    try {
      return await deps.open({ passphrase, create, onProgress: (fraction) => notify({ kind: "progress", fraction }) });
    } finally {
      wipe(passphrase);
      notify({ kind: "end" });
    }
  }

  /** Keep the vault only if `lock()` or `dispose()` was not called since this attempt began. */
  function keep(vault: UnlockedVault, startedIn: number): UnlockOutcome {
    if (startedIn !== generation || disposed) return { kind: "cancelled" };
    held = vault;
    setUp = true;
    return { kind: "unlocked", vault };
  }

  async function runUnlock(startedIn: number): Promise<UnlockOutcome> {
    let failure: UnlockFailure | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const typed = await deps.dialogs.unlock({ attempt, failure });
      if (typed === undefined || disposed || startedIn !== generation) return { kind: "cancelled" };
      let passphrase: CanonicalPassphrase;
      try {
        passphrase = canonicalizePassphraseText(typed);
      } catch (error) {
        if (!isFormatError(error)) throw error;
        failure = "format";
        continue;
      }
      try {
        return keep(await derive(passphrase), startedIn);
      } catch (error) {
        if (!isWrongPassphrase(error)) throw error;
        failure = "wrong-passphrase";
      }
    }
  }

  async function runSetup(startedIn: number): Promise<UnlockOutcome> {
    const generated = generatePassphrase();
    try {
      const result = await deps.dialogs.setup({ passphrase: formatPassphrase(generated) });
      if (result === undefined || result.confirmed !== true || disposed || startedIn !== generation) return { kind: "cancelled" };
      const reentered = canonicalizeOrUndefined(result.reentered);
      const same = reentered !== undefined && reentered.length === generated.length && reentered.every((byte, index) => byte === generated[index]);
      if (reentered !== undefined) wipe(reentered);
      if (!same) throw new CryptoError("invalid-argument", "the re-entered passphrase does not match the generated one; no vault was created");
      // The bytes are wiped in `derive`; `create` is the same array as `passphrase`.
      return keep(await derive(generated, generated), startedIn);
    } finally {
      wipe(generated);
    }
  }

  function canonicalizeOrUndefined(text: string): CanonicalPassphrase | undefined {
    try {
      return canonicalizePassphraseText(text);
    } catch (error) {
      if (isFormatError(error)) return undefined;
      throw error;
    }
  }

  /** Exactly one dialog sequence runs at a time; a caller that arrives meanwhile awaits the same one. */
  function single(run: (startedIn: number) => Promise<UnlockOutcome>): Promise<UnlockOutcome> {
    if (inFlight !== undefined) return inFlight;
    const current = run(generation).finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  }

  return {
    state: () => (held !== undefined ? "unlocked" : setUp ? "locked" : "not-set-up"),
    async refresh() {
      if (held === undefined) setUp = await deps.vaultExists();
      return held !== undefined ? "unlocked" : setUp ? "locked" : "not-set-up";
    },
    provider: () => held,
    async unlock() {
      if (disposed) return { kind: "cancelled" };
      if (held !== undefined) return { kind: "unlocked", vault: held };
      if (inFlight === undefined) setUp = await deps.vaultExists();
      if (held !== undefined) return { kind: "unlocked", vault: held };
      if (!setUp && inFlight === undefined) return { kind: "not-set-up" };
      return single(runUnlock);
    },
    async setup() {
      if (disposed) return { kind: "cancelled" };
      if (held !== undefined) return { kind: "unlocked", vault: held };
      return single(runSetup);
    },
    lock() {
      held = undefined;
      generation += 1;
      inFlight = undefined;
    },
    dispose() {
      disposed = true;
      held = undefined;
      generation += 1;
      inFlight = undefined;
    },
  };
}
