import type { HostFs } from "../core/host-bridge";
import type { Bytes, KdfParams, KdfProgress, CanonicalPassphrase, ParsedKeySlots, VaultKeys } from "../crypto";
import type { DeviceStore } from "./device-store";
import { checkVaultBeforeDerivation, effectiveRecord, type EffectiveRecord, type PullRefusal, type PullRefusalReason, type StateRecord } from "./pull-sequence";
import { readFloor } from "./sequence-floor";
import {
  openVaultForPull,
  persistKeySlotsCopy,
  toUnlockedVault,
  VaultKeysError,
  type LocalRootKnowledge,
  type NodeAccess,
  type PullOrigin,
  type UnlockedVault,
} from "./vault-keys";

/*
 * Unlock for pull (mvp-07a task 4.1, design decisions 5 and 6 step 4, spec encrypted-pull "Unlock on a device that did
 * not create the vault" and "One outcome for a wrong passphrase"). WebView-safe: no Node imports.
 *
 * What this module decides, in order, and what each step costs:
 *   1. The slot file that will be derived from is parsed (size cap, strict form, schema): a format error is raised
 *      before any derivation and says nothing about any passphrase.
 *   2. `--expect-vault-id` and the effective record (directory state and the sequence floor, both looked up by the
 *      PARSED vaultId) are compared with that vaultId BEFORE any derivation. A refusal is a `PullUnlockError`.
 *   3. With a local key-slot copy: the copy is unlocked first (a wrong passphrase makes no request), then the node's
 *      file is compared byte for byte; a difference is a refusal that names the accept action and no derivation runs on
 *      the node's parameters. Without a copy: the root must hold a manifest, the recorded digest (if any) must match,
 *      the cost of every slot above the default is shown and confirmed once (non-interactive hosts refuse it), and the
 *      node's slot is unlocked.
 *   4. A session-held `UnlockedVault` whose slot bytes equal the file being opened bypasses the derivation (and the
 *      cost question, which only exists for a derivation), exactly as in publish.
 *
 * Wrong passphrase, a damaged slot and a failed commitment all raise the same `CryptoError` (code
 * `wrong-passphrase-or-damaged-slot`, one message) after the same work: one Argon2id derivation per tried slot. This
 * module adds no branch, retry, delay or counter to that path.
 *
 * Nothing is written here. The key-slot copy is returned as `copyToStore` and persisted only by
 * `storeKeySlotsCopy`, which the caller invokes after the manifest authenticated and any first-pull confirmation was
 * given. No event, message or return value carries the passphrase or raw key material; `keys` is the non-extractable
 * `VaultKeys` object of the crypto module.
 */

/** A refusal decided before any derivation: a failed expectation or a record of another vault. */
export class PullUnlockError extends Error {
  readonly reason: PullRefusalReason;
  readonly refusal: PullRefusal;

  constructor(refusal: PullRefusal) {
    super(refusal.message);
    this.name = "PullUnlockError";
    this.reason = refusal.reason;
    this.refusal = refusal;
  }
}

export interface PullUnlockInput {
  /** Read-only: opening never writes. */
  readonly fs: Pick<HostFs, "read" | "stat">;
  readonly mfsRoot: string;
  /** Required unless `unlocked` covers the slots being opened; never logged or stored. */
  readonly passphrase?: CanonicalPassphrase;
  readonly unlocked?: UnlockedVault;
  readonly local: LocalRootKnowledge;
  /** Both reads are lazy: `fetchKeySlots` is not called before a copy has been unlocked locally. */
  readonly node: NodeAccess;
  /**
   * The effective record for the slot file's `vaultId`: the directory's state and the floor of THAT vault. Called with
   * the parsed `vaultId` before any derivation, so the floor is read for the vault actually being opened. Use
   * `recordLookup` to build it. Return `undefined` for no record.
   */
  readonly recordFor: (slotVaultId: string) => Promise<EffectiveRecord | undefined> | EffectiveRecord | undefined;
  /** `--expect-vault-id` (32 lowercase hex). The other flags of the pull are not this module's business. */
  readonly expectVaultId?: string;
  /** Interactive hosts only; see `PullOpenInput.confirmCost`. Absent means non-interactive: a slot above the default cost is refused. */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
}

export interface PullUnlock {
  /** The non-extractable key set. Keep it out of reach of other plugins (see `src/crypto/index.ts`). */
  readonly keys: VaultKeys;
  readonly vaultId: string;
  readonly mfsRoot: string;
  /** Digest of the slot file the keys came from: what the state records as `keyslotsSha256` once the copy is stored. */
  readonly keySlotsSha256: string;
  readonly origin: PullOrigin;
  /** A vault a session can hold for later opens (plugin); minted by `vault-keys`, never a passphrase. */
  readonly vault: UnlockedVault;
  /** The bytes to store as the local copy, or `undefined` when the device already holds the copy. Not stored yet. */
  readonly copyToStore: Bytes | undefined;
}

/**
 * Unlock the vault a pull is about to read. Errors: `PullUnlockError` (expectation or other vault, nothing derived),
 * `VaultKeysError` (`vault-mismatch` for a differing node file or an unrecorded vault, `slots-without-manifest`,
 * `no-key-slots`, `locked`), `CryptoError` (`wrong-passphrase-or-damaged-slot`, `kdf-cost-refused`, format and bounds).
 */
export async function unlockForPull(input: PullUnlockInput): Promise<PullUnlock> {
  const beforeDerivation = async (document: ParsedKeySlots): Promise<void> => {
    const record = await input.recordFor(document.vaultId);
    const refusal = checkVaultBeforeDerivation({ slotVaultId: document.vaultId, record, flags: { expectVaultId: input.expectVaultId } });
    if (refusal !== undefined) throw new PullUnlockError(refusal);
  };
  const opened = await openVaultForPull({
    fs: input.fs,
    mfsRoot: input.mfsRoot,
    passphrase: input.passphrase,
    unlocked: input.unlocked,
    local: input.local,
    node: input.node,
    beforeDerivation,
    confirmCost: input.confirmCost,
    onProgress: input.onProgress,
  });
  const vault = toUnlockedVault(opened);
  return {
    keys: opened.keys,
    vaultId: opened.vaultId,
    mfsRoot: input.mfsRoot,
    keySlotsSha256: opened.keySlotsSha256,
    origin: opened.origin,
    vault,
    copyToStore: opened.copyToStore === undefined ? undefined : new Uint8Array(opened.copyToStore),
  };
}

/**
 * The authenticated manifest must belong to the vault whose slots were unlocked. Call it right after `manifest.enc`
 * authenticated; a difference stops the pull with nothing written and no copy stored.
 */
export function assertManifestVault(unlock: Pick<PullUnlock, "vaultId">, manifestVaultId: string): void {
  if (manifestVaultId !== unlock.vaultId) {
    throw new VaultKeysError("vault-mismatch", "the manifest belongs to a different vault than the key slots; nothing was written and no key-slot copy was stored");
  }
}

/** What the caller must say before the copy is written. Literal types: a caller cannot pass the flags by accident. */
export interface CopyStoreProof {
  /** `manifest.enc` authenticated under the unlocked keys, and its `vaultId` equals the slot file's. */
  readonly manifestAuthenticated: true;
  /** The first-pull confirmation was given (or none was required). */
  readonly confirmationGiven: true;
}

/**
 * Persist the key-slot copy of a pull. Refuses without both statements, so a failed authentication, a declined first
 * pull and a refused verdict never leave a copy behind. A no-op when the device already holds the copy.
 * Returns whether a file was written.
 */
export async function storeKeySlotsCopy(unlock: PullUnlock, fs: Pick<HostFs, "write">, proof: CopyStoreProof): Promise<boolean> {
  if ((proof as { manifestAuthenticated?: unknown }).manifestAuthenticated !== true || (proof as { confirmationGiven?: unknown }).confirmationGiven !== true) {
    throw new Error("the key-slot copy is stored only after the manifest authenticated and the confirmation was given; nothing was written");
  }
  if (unlock.copyToStore === undefined) return false;
  await persistKeySlotsCopy(fs, unlock.mfsRoot, unlock.copyToStore);
  return true;
}

/**
 * The `recordFor` of a pull: the directory's state (if the directory has one) and the floor of the vault being opened,
 * combined by `effectiveRecord`. A damaged floor file throws `SequenceFloorError`, before any derivation: fail closed.
 */
export function recordLookup(input: { readonly state: StateRecord | undefined; readonly deviceStore: DeviceStore }): (slotVaultId: string) => Promise<EffectiveRecord | undefined> {
  return async (slotVaultId) => {
    const entry = await readFloor(input.deviceStore, slotVaultId);
    return effectiveRecord(input.state, entry === undefined ? undefined : { vaultId: slotVaultId, sequence: entry.sequence, identity: entry.identity });
  };
}
