import { ConfigError } from "../core/config";
import { CryptoError, PassphraseFormatError } from "../crypto";
import { KuboError } from "../kubo";
import { DeviceStoreError } from "../sync/device-store";
import { ManifestFormatError } from "../sync/encrypted-manifest";
import { KeyManagementError } from "../sync/key-management";
import { WriteVerificationError } from "../sync/publish-errors";
import { MAINTENANCE_WAYS_OUT, PublishRefusedError, ReadBackError } from "../sync/publish-refusals";
import { PullSourceError, PullTargetError } from "../sync/pull-errors";
import { PruneHistoryError } from "../sync/prune-history";
import { PullUnlockError } from "../sync/pull-unlock";
import { RootStateError } from "../sync/root-state";
import { SequenceFloorError } from "../sync/sequence-floor";
import { SlotAcceptanceError } from "../sync/slot-acceptance";
import { VaultKeysError } from "../sync/vault-keys";
import type { KeyActionFailure } from "./key-dialog-shared";
import { busyNotice, type SyncOperation } from "./sync-lock";

/**
 * How a key action's error becomes the answer a dialog shows (mvp-07b task 2.2, contract of task 2.1). Only a refusal that wrote nothing and that a
 * second try can fix is `retryable`: a wrong or malformed passphrase, and a busy lock. Everything else locks the form, because either nothing can
 * change by trying again (a refusal of the engine) or the node or this device may already have changed.
 *
 * The reason is text the dialog escapes and shows through `textContent`. Messages of the listed error classes are fixed text without a passphrase or
 * a key (the contract of those layers); any other error is shown as a generic line and its message is never read.
 */

export const WRONG_PASSPHRASE_TEXT = "That passphrase did not open this vault. Check it and try again. Nothing was changed.";
export const FORMAT_PASSPHRASE_TEXT = "That is not a valid passphrase. Check it and try again. Nothing was changed.";
export const UNEXPECTED_FAILURE_TEXT = "The key action stopped for a reason this plugin does not recognise. Check the vault status; the key-slot file on this device was not replaced unless the result above says so.";
export const MANIFEST_REFUSED_TEXT =
  "The vault manifest on the node holds something this build refuses to read, so key management stays refused until that is fixed. Nothing was changed.";

const SAFE_ERRORS = [
  KeyManagementError,
  // Its messages are fixed text built from counts and sequences: they never contain a history name, a path or any other text the node chose.
  PruneHistoryError,
  PublishRefusedError,
  ReadBackError,
  WriteVerificationError,
  VaultKeysError,
  CryptoError,
  RootStateError,
  DeviceStoreError,
  SequenceFloorError,
  KuboError,
  PullUnlockError,
  SlotAcceptanceError,
  PullTargetError,
  PullSourceError,
  ConfigError,
] as const;

const isWrongPassphrase = (error: unknown): boolean => error instanceof CryptoError && error.code === "wrong-passphrase-or-damaged-slot";

/**
 * The failure a dialog shows for `error`. `journalPending` adds the ways out when a key-management journal is on this device; `operation` names what
 * the journal belongs to (a rewrap unless the caller is a history prune).
 */
export function failureOf(
  error: unknown,
  options: { readonly journalPending?: boolean; readonly operation?: "key-slot rewrap" | "history prune" | "key-management operation" } = {},
): KeyActionFailure {
  if (error instanceof PassphraseFormatError) return { ok: false, reason: FORMAT_PASSPHRASE_TEXT, retryable: true };
  if (isWrongPassphrase(error)) return { ok: false, reason: WRONG_PASSPHRASE_TEXT, retryable: true };
  if (error instanceof ManifestFormatError) return { ok: false, reason: MANIFEST_REFUSED_TEXT, retryable: false };
  // The lock file is held by another process (the command line tool, a second window): nothing was started and it can be tried again.
  const lockedElsewhere = error instanceof PublishRefusedError && error.code === "lock-held";
  const known = SAFE_ERRORS.some((safe) => error instanceof safe);
  const message = known ? (error as Error).message : UNEXPECTED_FAILURE_TEXT;
  const alreadyNamed = message.includes(MAINTENANCE_WAYS_OUT);
  const operation = options.operation ?? "key-slot rewrap";
  const ways = options.journalPending === true && !alreadyNamed ? ` A ${operation} is pending on this device, so publish and pull are paused. ${MAINTENANCE_WAYS_OUT}` : "";
  return { ok: false, reason: `${message}${ways}`, retryable: lockedElsewhere };
}

/** Another operation holds the lock. Nothing was started, so the person can try again when it ends. */
export function busyFailure(holder: SyncOperation | undefined): KeyActionFailure {
  return { ok: false, reason: busyNotice(holder), retryable: true };
}
