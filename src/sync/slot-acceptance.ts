import { CryptoError, OversizeInputError, parseKeySlots, prepareTriedSlots, type Bytes, type CanonicalPassphrase, type KdfParams, type KdfProgress } from "../crypto";
import type { DeviceStore } from "./device-store";
import { ManifestFormatError, decodeManifestFile, type EncryptedManifest } from "./encrypted-manifest";
import { sha256Hex } from "./hash";
import { manifestIdentity } from "./manifest-identity";
import { isUnreadableManifest } from "./manifest-auth";
import { evaluatePullVerdict, type EffectiveRecord, type PullFlags, type PullRefusal, type PullTargetKind, type PullVerdict, type StateRecord } from "./pull-sequence";
import { PullUnlockError, assertManifestVault, recordLookup, unlockForPull } from "./pull-unlock";
import type { UnlockedVault } from "./vault-keys";

/*
 * Slot acceptance (mvp-07b task 1.2, design 3, spec key-management "Other devices accept changed key slots").
 * WebView-safe: no Node imports, no I/O. The caller (task 1.5) holds `publish.lock`, resolves the name once, reads
 * `keyslots.json` and `manifest.enc` from that one immutable root, and passes their bytes in; this module decides
 * whether those bytes may replace the device's key-slot copy, and writes nothing.
 *
 * Order, and what each step costs:
 *   1. Before any derivation: the incoming slot file's `vaultId` is compared with the vault this device records (the
 *      state and the floor, via `recordLookup`, so a damaged floor file stops here as `SequenceFloorError`), with the
 *      vaultId of the current copy, and with `--expect-vault-id`. A device that records no vault and holds no copy has
 *      nothing to accept: acceptance never stands in for the first-pull confirmation.
 *   2. One Argon2id derivation per tried slot, through `unlockForPull` with `local: { hasState: false }` and a file
 *      capability that holds no copy. That is the copy-less path of `openVaultForPull`: the copy that differs from the
 *      node's file is exactly what `openVaultForPull` refuses, and accept is the action that replaces it. A slot above
 *      the default cost is derived only after `confirmCost` (non-interactive hosts refuse, before any derivation).
 *   3. `manifest.enc` of the same root must authenticate under the keys that unlocked, and its `vaultId` must match.
 *      A slot file that unlocks but whose manifest does not authenticate is never accepted.
 *   4. The 07a verdict function judges that manifest against the effective record. Only `first-pull`, `same`,
 *      `newer` and `restore` pass; a lower sequence needs an explicit target and the rollback flag, as in a pull.
 *   5. The cost of the weakest tried slot is compared with the current copy's. A lower memory or iteration count sets
 *      `downgrade`; `acceptedSlotBytes` releases the bytes only after that confirmation.
 *
 * What this does NOT prove: the manifest authenticating proves the slot file and the manifest share one vault key. It
 * does not prove that key is the vault's original one. A node that also knows the typed passphrase could serve a slot
 * file and a manifest of its own key under this vault's id; with a session-held `heldVault` that case is refused
 * (`key-changed`); without one it is not, and the sequence verdict plus the downgrade confirmation are the only
 * defences. Freshness is not proven either: any genuine slot of the vault passes.
 */

export type SlotAcceptanceErrorCode =
  | "nothing-to-accept"
  | "other-vault"
  | "manifest-not-authentic"
  | "manifest-unsupported"
  | "key-changed"
  | "verdict-refused"
  | "downgrade-unconfirmed";

/** A refusal made by this module. Messages are fixed text; they never contain a passphrase, key, identity or path. */
export class SlotAcceptanceError extends Error {
  readonly code: SlotAcceptanceErrorCode;
  /** Present for `verdict-refused`: the 07a refusal, with its reason and message. */
  readonly refusal: PullRefusal | undefined;

  constructor(code: SlotAcceptanceErrorCode, message: string, options: { readonly refusal?: PullRefusal; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SlotAcceptanceError";
    this.code = code;
    this.refusal = options.refusal;
  }
}

/** The flags of a pull that apply to acceptance. `resolveFork` is absent on purpose: acceptance never resolves a fork. */
export type SlotAcceptanceFlags = Pick<PullFlags, "allowRollback" | "expectVaultId" | "expectMinSequence">;

export interface SlotAcceptanceInput {
  /** `keyslots.json` of the one resolved root, exactly as read. */
  readonly keySlots: Uint8Array;
  /** `manifest.enc` of the same root, exactly as read. */
  readonly manifestFile: Uint8Array;
  /** The typed passphrase; never logged or stored. */
  readonly passphrase: CanonicalPassphrase;
  readonly mfsRoot: string;
  /** This device's current key-slot copy, for the cost comparison and the vault check. `undefined` when it holds none. */
  readonly currentCopy: Uint8Array | undefined;
  /** The directory's state as a record (`stateRecordOf`), or `undefined` when the directory has none. */
  readonly state: StateRecord | undefined;
  readonly deviceStore: DeviceStore;
  /** How the root was named: only an explicit target (`root-cid`, `manifest`) can carry `allowRollback`. */
  readonly target: PullTargetKind;
  readonly flags?: SlotAcceptanceFlags;
  /** Interactive hosts only; see `PullUnlockInput.confirmCost`. Absent means a slot above the default cost is refused. */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
  /** Keys this device already holds for the vault (a plugin session). When present the manifest must authenticate under them too. */
  readonly heldVault?: UnlockedVault;
}

export interface SlotDowngrade {
  /** The weakest tried slot of the current copy. */
  readonly current: KdfParams;
  /** The weakest tried slot of the incoming file. */
  readonly incoming: KdfParams;
}

export type AcceptedVerdict = Exclude<PullVerdict, { readonly kind: "refused" | "fork-resolution" }>;

export interface SlotAcceptance {
  /** A copy of the bytes that unlocked: what the caller stores as the new local copy. Equal to the input. */
  readonly keySlots: Bytes;
  readonly keySlotsSha256: string;
  readonly vaultId: string;
  /** The incoming bytes differ from the current copy. `false` means accepting changes nothing. */
  readonly changed: boolean;
  /** The authenticated manifest of the root being accepted. */
  readonly manifest: { readonly sequence: number; readonly identity: string };
  readonly verdict: AcceptedVerdict;
  /** Set when the incoming slot is cheaper in memory or iterations than the current copy; confirm before storing. */
  readonly downgrade: SlotDowngrade | undefined;
  /** The vault the keys came from, for a session that wants to keep it. */
  readonly vault: UnlockedVault;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** The weakest memory and iteration count over the slots an unlock would try. */
function weakestCost(bytes: Uint8Array): KdfParams {
  const costs = prepareTriedSlots(parseKeySlots(bytes)).map((slot) => slot.params);
  const first = costs[0] as KdfParams;
  return costs.reduce((weakest, cost) => ({ m: Math.min(weakest.m, cost.m), t: Math.min(weakest.t, cost.t), p: Math.min(weakest.p, cost.p) }), first);
}

function downgradeOf(currentCopy: Uint8Array | undefined, incoming: Uint8Array): SlotDowngrade | undefined {
  if (currentCopy === undefined) return undefined;
  const current = weakestCost(currentCopy);
  const next = weakestCost(incoming);
  return next.m < current.m || next.t < current.t ? { current, incoming: next } : undefined;
}

/** After a successful unlock, a manifest that does not decode is forged, damaged, or newer than this build. One message per kind, none an oracle on the passphrase. */
async function authenticate(keys: Parameters<typeof decodeManifestFile>[0], file: Uint8Array): Promise<EncryptedManifest> {
  try {
    return await decodeManifestFile(keys, file);
  } catch (error) {
    if (error instanceof ManifestFormatError || error instanceof OversizeInputError || (error instanceof CryptoError && error.code === "unsupported-format")) {
      throw new SlotAcceptanceError("manifest-unsupported", "manifest.enc authenticated but holds something this build does not read; the key-slot copy was not replaced", { cause: error });
    }
    if (isUnreadableManifest(error)) {
      throw new SlotAcceptanceError(
        "manifest-not-authentic",
        "manifest.enc of this root does not authenticate under the key these slots unlock: the slot file is not this vault's, or a file was forged or damaged; the key-slot copy was not replaced",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Decide whether the slot file and manifest of one resolved root may replace this device's key-slot copy.
 * Errors: `PullUnlockError` (expectation or another vault's record, before any derivation), `SequenceFloorError` (a
 * damaged floor, before any derivation), `SlotAcceptanceError`, `VaultKeysError` (`vault-mismatch`), `CryptoError`
 * (`wrong-passphrase-or-damaged-slot`, `kdf-cost-refused`, format and bounds). Nothing is written.
 */
export async function evaluateSlotAcceptance(input: SlotAcceptanceInput): Promise<SlotAcceptance> {
  // The current copy is parsed before any derivation: a damaged copy stops here, and its vault is compared below.
  const currentVaultId = input.currentCopy === undefined ? undefined : parseKeySlots(input.currentCopy).vaultId;
  const lookup = recordLookup({ state: input.state, deviceStore: input.deviceStore });
  let record: EffectiveRecord | undefined;
  const recordFor = async (slotVaultId: string): Promise<EffectiveRecord | undefined> => {
    if (currentVaultId !== undefined && currentVaultId !== slotVaultId) {
      throw new SlotAcceptanceError("other-vault", "these key slots belong to a different vault than this device's key-slot copy; the key-slot copy was not replaced and nothing was derived");
    }
    record = await lookup(slotVaultId);
    if (record === undefined && currentVaultId === undefined) {
      throw new SlotAcceptanceError("nothing-to-accept", 'this device records no vault for this root and holds no key-slot copy; to restore a vault here, run "ipfs-sync pull" with the vault passphrase; nothing was derived');
    }
    return record;
  };
  const keySlots = new Uint8Array(input.keySlots);
  const unlock = await unlockForPull({
    fs: { read: async () => new Uint8Array(0), stat: async () => undefined },
    mfsRoot: input.mfsRoot,
    passphrase: input.passphrase,
    local: { hasState: false },
    node: { fetchKeySlots: async () => keySlots, manifestPresent: async () => input.manifestFile.length > 0 },
    recordFor,
    expectVaultId: input.flags?.expectVaultId,
    confirmCost: input.confirmCost,
    onProgress: input.onProgress,
  });
  const manifest = await authenticate(unlock.keys, input.manifestFile);
  assertManifestVault(unlock, manifest.vaultId);
  if (input.heldVault !== undefined) {
    try {
      await decodeManifestFile(input.heldVault.keys, input.manifestFile);
    } catch (error) {
      throw new SlotAcceptanceError("key-changed", "manifest.enc does not authenticate under the key this device already holds for the vault: these slots carry a different vault key; the key-slot copy was not replaced", { cause: error });
    }
  }
  const identity = manifestIdentity(manifest);
  const verdict = evaluatePullVerdict({ record, candidate: { vaultId: manifest.vaultId, sequence: manifest.sequence, identity }, target: input.target, flags: input.flags ?? {} });
  if (verdict.kind === "refused") throw new SlotAcceptanceError("verdict-refused", verdict.message, { refusal: verdict });
  if (verdict.kind === "fork-resolution") throw new Error("fork resolution is not a slot-acceptance verdict");
  return {
    keySlots: new Uint8Array(unlock.vault.keySlots),
    keySlotsSha256: unlock.keySlotsSha256,
    vaultId: unlock.vaultId,
    changed: input.currentCopy === undefined || !sameBytes(input.currentCopy, unlock.vault.keySlots),
    manifest: { sequence: manifest.sequence, identity },
    verdict,
    downgrade: downgradeOf(input.currentCopy, unlock.vault.keySlots),
    vault: unlock.vault,
  };
}

/**
 * The bytes to store as the new local copy. A downgrade needs `downgradeConfirmed: true`, given after both costs were
 * shown; without it nothing is released, so a caller cannot replace the copy with a cheaper slot silently.
 */
export function acceptedSlotBytes(accepted: SlotAcceptance, confirmation: { readonly downgradeConfirmed?: boolean }): Bytes {
  if (accepted.downgrade !== undefined && confirmation.downgradeConfirmed !== true) {
    throw new SlotAcceptanceError("downgrade-unconfirmed", "the incoming key slot is cheaper to attack than this device's copy and the downgrade was not confirmed; the key-slot copy was not replaced");
  }
  return new Uint8Array(accepted.keySlots);
}
