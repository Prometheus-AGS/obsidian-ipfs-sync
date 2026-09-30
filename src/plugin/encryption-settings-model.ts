import { ENCRYPTION_COPY } from "./encryption-copy";

/**
 * What the Encryption section of the settings tab shows. The plugin session (written elsewhere) is adapted to
 * `EncryptionStatusSource` at wiring time; nothing here imports it.
 */

export type EncryptionState = "not-set-up" | "locked" | "unlocked";

export interface EncryptionStatusSource {
  state(): EncryptionState;
  /** Discard the unlocked key. Does nothing unless the vault is unlocked. */
  lock(): void;
  /** Optional: be told when the state changes elsewhere, for example after an unlock dialog. Returns the unsubscribe function. */
  subscribe?(listener: () => void): () => void;
  /** Optional: open the setup dialog. When absent, no Set up button is shown. */
  openSetup?(): void;
  /** Optional: open the unlock dialog. When absent, no Unlock button is shown. */
  openUnlock?(): void;
  /** Optional: open the abandon-vault confirmation. When absent, no Abandon row is shown. */
  openAbandon?(): void;
}

export interface EncryptionView {
  readonly state: EncryptionState;
  /** The state as a word, so nothing depends on colour. */
  readonly label: string;
  readonly description: string;
  readonly canLock: boolean;
  readonly lockDescription: string;
  /** The optional action that suits the state: set up when not set up, unlock when locked. */
  readonly action: "setup" | "unlock" | undefined;
}

export function describeEncryption(state: EncryptionState, source: Pick<EncryptionStatusSource, "openSetup" | "openUnlock"> = {}): EncryptionView {
  const canLock = state === "unlocked";
  const lockDescription = canLock ? ENCRYPTION_COPY.lockDesc : `${ENCRYPTION_COPY.lockDesc} ${ENCRYPTION_COPY.lockUnavailable}`;
  if (state === "not-set-up") {
    return {
      state,
      label: ENCRYPTION_COPY.notSetUp,
      description: ENCRYPTION_COPY.notSetUpDesc,
      canLock,
      lockDescription,
      action: source.openSetup === undefined ? undefined : "setup",
    };
  }
  if (state === "locked") {
    return {
      state,
      label: ENCRYPTION_COPY.locked,
      description: ENCRYPTION_COPY.lockedDesc,
      canLock,
      lockDescription,
      action: source.openUnlock === undefined ? undefined : "unlock",
    };
  }
  return { state, label: ENCRYPTION_COPY.unlocked, description: ENCRYPTION_COPY.unlockedDesc, canLock, lockDescription, action: undefined };
}
