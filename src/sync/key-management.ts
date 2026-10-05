import type { Bytes, HostFs, HostKv } from "../core/host-bridge";
import {
  CryptoError,
  KDF_ITERATIONS_CEILING,
  KDF_ITERATIONS_DEFAULT,
  KDF_MEMORY_CEILING_KIB,
  KDF_MEMORY_DEFAULT_KIB,
  KDF_PARALLELISM,
  assertKdfParams,
  describeKdfCost,
  isPassphraseSlot,
  parseKeySlots,
  prepareTriedSlots,
  rewrapKeySlots,
  unlockKeySlotsBytes,
  type CanonicalPassphrase,
  type CostPolicy,
  type KdfParams,
  type KdfProgress,
  type RewrapInput,
  type RewrapSecret,
  type RewrappedKeySlots,
  type UnlockedVault as CryptoUnlockedVault,
} from "../crypto";
import type { DeviceStore } from "./device-store";
import { stateRecordOf } from "./encrypted-pull";
import { decodeManifestFile } from "./encrypted-manifest";
import { guardKv } from "./guarded-kv";
import { sha256Hex } from "./hash";
import { buildJournal, readJournal, writeJournal, type PublishJournal } from "./journal";
import { isCidToken } from "./local-record";
import { isUnreadableManifest } from "./manifest-auth";
import type { RewrapCostPlan, RewrapKind } from "./key-management-text";
import {
  advance,
  assertNoPublishJournal,
  discardMaintenanceJournal,
  readMaintenanceJournal,
  reached,
  rewrapBytes,
  buildRewrapJournal,
  writeMaintenanceJournal,
  type MaintenanceJournal,
  type MaintenancePhase,
  type MaintenanceRead,
  type RewrapJournal,
} from "./maintenance-journal";
import type { MaintenanceNode } from "./maintenance-node";
import { rootOfReading } from "./name-recheck";
import { maintenanceLostRace, maintenancePending, passphraseRequired, publicationKeyMissing } from "./publish-refusals";
import type { PublicationKey } from "./publish-key";
import { beginMaintenance, driveMaintenance, withdrawMaintenanceWrite, type MaintenanceStart, type RepublishDeps } from "./republish-root";
import { buildRootState, readRootState, writeRootState, type RootState } from "./root-state";
import { sameBytes } from "./same-bytes";
import { readFloor } from "./sequence-floor";
import { acceptedSlotBytes, evaluateSlotAcceptance, type SlotAcceptance, type SlotAcceptanceFlags } from "./slot-acceptance";
import { keySlotsCopyPath, openVault, persistKeySlotsCopy, type OpenedVault, type UnlockedVault } from "./vault-keys";

export type { RewrapCostPlan, RewrapKind } from "./key-management-text";

/**
 * Key management over the node's shared tree (mvp-07b task 1.4): `change-passphrase` and `increase-cost`, both a rewrap. The vault key stays
 * the same and is wrapped by a fresh slot in a file that holds only that slot; nothing is re-encrypted and `manifest.enc` and the sequence are
 * not touched. WebView-safe: no Node imports, every effect goes through a port in `KeyManagementDeps`. The command line
 * (`cli/keys-command.ts`) and, later, the plugin dialogs are thin callers; task 1.5 adds `accept-slots` and `discard` to this file.
 *
 * The order is the safety property:
 *
 *   prepare  (reads only)  no pending journal of either kind; the local key-slot copy and the record exist; the file holds no slot type this
 *                          version does not know (before any derivation); unlock the local copy (derivation 1); the up-to-date and floor check.
 *   plan     (pure)        `planRewrapCost`; the caller prints `rewrapStatements`, asks for the confirmations, shows or saves the new passphrase.
 *   execute               the rewrap (derivations 2 and 3; nothing written yet), the maintenance journal at `journaled`, then `driveMaintenance`
 *                          (file, snapshot, read-back, pin, name re-check, `name/publish`, `state.rootCid`), then the TEST UNLOCK of the new slot
 *                          (derivation 4), and only then the local steps: key-slot copy, `keyslotsSha256`, journal at `local-updated`, journal removed.
 *   resume                 reads the phase. Before `published` it finishes the republish (the old passphrase is needed for the manifest check); from
 *                          `published` on it needs no passphrase: it checks that the published root still holds this rewrap's file, byte for byte, and
 *                          finishes the local steps. It never calls the rewrap, so it can never make a second slot.
 *
 * The caller holds `publish.lock` for the whole operation; every local write here is behind `assertHeld`, every node write behind the node's
 * `beforeWrite` (the caller builds both from the same lock).
 */

/** The cryptography this orchestration calls, as callbacks: tests substitute fast stand-ins; production passes `REAL_KEY_OPERATIONS`. */
export interface KeyOperations {
  readonly rewrap: (input: RewrapInput) => Promise<RewrappedKeySlots>;
  readonly unlock: (bytes: Bytes, passphrase: CanonicalPassphrase, options?: { readonly onProgress?: KdfProgress; readonly costPolicy?: CostPolicy }) => Promise<CryptoUnlockedVault>;
}

export const REAL_KEY_OPERATIONS: KeyOperations = { rewrap: rewrapKeySlots, unlock: unlockKeySlotsBytes };

/** The two costs a person can choose. Both are within the ceilings of `key-slots` (131,072 KiB, 4 iterations). */
export const COST_PRESETS = {
  standard: { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM },
  high: { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM },
} as const satisfies Readonly<Record<string, KdfParams>>;

export type CostPresetName = keyof typeof COST_PRESETS;

export type KeyManagementErrorCode =
  | "no-key-slot-copy"
  | "no-record"
  | "unknown-slot-type"
  | "cost-missing"
  | "cost-not-higher"
  | "test-unlock-failed"
  | "copy-changed"
  | "record-mismatch"
  | "root-incomplete";

/** A refusal of this module. Messages are fixed text; they never contain a passphrase, a key or node-supplied text. */
export class KeyManagementError extends Error {
  readonly code: KeyManagementErrorCode;

  constructor(code: KeyManagementErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "KeyManagementError";
    this.code = code;
  }
}

export interface KeyManagementDeps {
  /** The node port. Its `beforeWrite` is the caller's `assertHeld`, and its key id is the owned publication key's. */
  readonly node: MaintenanceNode;
  /** The vault's host files: the key-slot copy is read and replaced here. */
  readonly fs: Pick<HostFs, "read" | "write" | "stat">;
  /** The device-local record store (state, journals). Writes are put behind `assertHeld` here. */
  readonly kv: HostKv;
  /** For the sequence floor; `undefined` when the host keeps none. */
  readonly deviceStore: DeviceStore | undefined;
  readonly ops: KeyOperations;
  /** ISO-8601 UTC time for the journal. */
  readonly now: () => string;
  /** The read-back of the snapshot a rewrap publishes, given the `keyslots.json` bytes it must hold (`createSnapshotVerifier`). */
  readonly snapshotVerifier: (keySlots: Bytes) => RepublishDeps["verifySnapshot"];
  /** Throws when `publish.lock` is no longer held. */
  readonly assertHeld: () => void;
  /** Re-reads the lock token right before the first change (the 07a standard, `lock-token-check.ts`). */
  readonly beforeFirstWrite?: () => Promise<void>;
}

export interface KeyManagementInput {
  readonly mfsRoot: string;
  /** The IPNS key name of the publication. */
  readonly keyName: string;
  /** The current passphrase. May be absent only when `unlocked` covers the local copy, or when a resume starts at `published` or later. */
  readonly passphrase: CanonicalPassphrase | undefined;
  /** Keys a session already holds for the local copy: no derivation runs to open it. */
  readonly unlocked?: UnlockedVault;
  /** Needed to unlock a current slot that costs more than the default. */
  readonly costPolicy?: CostPolicy;
  readonly onProgress?: KdfProgress;
  /** From `openPublicationKey`. An absent key refuses: a rewrap never creates one. */
  readonly key: Pick<PublicationKey, "absent">;
}

/* ---------- cost ---------- */

/** The largest memory and iteration count over the slots an unlock tries: the floor `rewrapKeySlots` holds a new slot to. */
export function costFloorOf(keySlots: Bytes): KdfParams {
  const tried = prepareTriedSlots(parseKeySlots(keySlots)).map((slot) => slot.params);
  return { m: Math.max(...tried.map((p) => p.m)), t: Math.max(...tried.map((p) => p.t)), p: tried[0]?.p ?? KDF_PARALLELISM };
}

export interface RewrapChoice {
  readonly kind: RewrapKind;
  /** `change-passphrase`: absent keeps the current cost. `increase-cost`: required. */
  readonly cost: KdfParams | undefined;
}

export function planRewrapCost(keySlots: Bytes, choice: RewrapChoice): RewrapCostPlan {
  const current = costFloorOf(keySlots);
  if (choice.kind === "increase-cost" && choice.cost === undefined) {
    throw new KeyManagementError("cost-missing", "increase-cost needs the cost to raise to: --cost standard or --cost high");
  }
  const next = choice.cost ?? current;
  assertKdfParams(next);
  const raises = next.m > current.m || next.t > current.t;
  const downgrade = next.m < current.m || next.t < current.t;
  if (choice.kind === "increase-cost" && (!raises || downgrade)) {
    throw new KeyManagementError(
      "cost-not-higher",
      `the requested cost (${describeKdfCost(next)}) is not higher than the current cost (${describeKdfCost(current)}); increase-cost only raises the cost, and nothing was changed`,
    );
  }
  return { current, next: { m: next.m, t: next.t, p: next.p }, raises, downgrade };
}

/* ---------- pending journals ---------- */

/** The maintenance journal this device holds, if any. A file that cannot be read is refused with the ways out. */
export async function pendingMaintenance(deps: Pick<KeyManagementDeps, "kv">, mfsRoot: string): Promise<MaintenanceJournal | undefined> {
  const read = await readMaintenanceJournal(deps.kv, mfsRoot);
  if (read.kind === "damaged") throw maintenancePending("damaged");
  return read.kind === "ok" ? read.journal : undefined;
}

/* ---------- prepare ---------- */

export interface PreparedRewrap {
  /** The vault as the local copy opens it; `keySlots` are the exact current bytes. */
  readonly vault: OpenedVault;
  readonly start: MaintenanceStart;
  readonly currentCost: KdfParams;
}

function assertRewrappable(keySlots: Bytes): void {
  if (parseKeySlots(keySlots).slots.some((slot) => !isPassphraseSlot(slot))) {
    throw new KeyManagementError("unknown-slot-type", "cannot rewrap a file with slot types this version does not know; nothing was derived or changed");
  }
}

async function readCopy(deps: Pick<KeyManagementDeps, "fs">, mfsRoot: string): Promise<Bytes> {
  const path = await keySlotsCopyPath(mfsRoot);
  if ((await deps.fs.stat(path))?.kind !== "file") {
    throw new KeyManagementError(
      "no-key-slot-copy",
      "this device holds no key-slot copy for this MFS root, so it has neither published nor pulled this vault; there is nothing to change here. Nothing was changed.",
    );
  }
  return deps.fs.read(path);
}

/**
 * Open the vault from the local copy (a wrong passphrase fails before any request), checking the copy against the record. A fresh rewrap also compares
 * the node's file with the copy (`openVault`); a resume does not (`localOnly`): the node's file may already be the rewrap's new bytes, and the journal's
 * old-or-new rule in `driveMaintenance` is what judges it. A prune (`prune-history.ts`) opens the vault the same way and passes `rewrap: false`: it changes no
 * key slot, so a slot type this version does not know is not its concern.
 */
export async function openCurrentVault(
  deps: Pick<KeyManagementDeps, "fs" | "kv" | "node">,
  input: KeyManagementInput,
  options: { readonly localOnly?: boolean; readonly rewrap?: boolean } = {},
) {
  const localOnly = options.localOnly === true;
  const copy = await readCopy(deps, input.mfsRoot);
  const state = await readRootState(deps.kv, input.mfsRoot);
  if (state === undefined) {
    throw new KeyManagementError("no-record", "this device has no record of a publish or pull to this MFS root, so it cannot tell whether it is up to date; nothing was changed");
  }
  if (options.rewrap !== false) assertRewrappable(copy);
  if (input.passphrase === undefined && input.unlocked === undefined) throw passphraseRequired();
  const vault = await openVault({
    fs: deps.fs,
    mfsRoot: input.mfsRoot,
    ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
    ...(input.unlocked === undefined ? {} : { unlocked: input.unlocked }),
    local: { hasState: true, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256 },
    node: localOnly
      ? { fetchKeySlots: async () => copy, manifestPresent: async () => true }
      : { fetchKeySlots: () => deps.node.readKeySlotsFile(), manifestPresent: async () => (await deps.node.readManifestFile()) !== undefined },
    ...(input.costPolicy === undefined ? {} : { costPolicy: input.costPolicy }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  return { vault, state, copy };
}

/**
 * Everything a rewrap checks before it asks anything: reads only, one derivation (opening the local copy), no write. Refuses while a publish
 * journal or any maintenance journal is pending, when the device is behind or below its floor, when the key does not exist and when the file holds a
 * slot type this version does not know.
 */
export async function prepareRewrap(deps: KeyManagementDeps, input: KeyManagementInput): Promise<PreparedRewrap> {
  const pending = await pendingMaintenance(deps, input.mfsRoot);
  if (pending !== undefined) throw maintenancePending(pending.type);
  await assertNoPublishJournal(deps.kv, input.mfsRoot);
  const { vault, state } = await openCurrentVault(deps, input);
  const floor = deps.deviceStore === undefined ? undefined : await readFloor(deps.deviceStore, state.vaultId);
  const start = await beginMaintenance(
    { node: deps.node, decodeManifest: (bytes) => decodeManifestFile(vault.keys, bytes) },
    {
      target: { mfsRoot: input.mfsRoot, key: input.keyName, vaultId: vault.vaultId, keyslotsSha256: vault.keySlotsSha256 },
      state,
      floor,
      key: input.key,
      startedAt: deps.now(),
    },
  );
  return { vault, start, currentCost: costFloorOf(vault.keySlots) };
}

/* ---------- execute ---------- */

export interface RewrapExecuteInput {
  /** The current passphrase: derived a second time inside the rewrap. */
  readonly passphrase: CanonicalPassphrase;
  /** A generated passphrase (change-passphrase), or `reuse` (increase-cost). */
  readonly next: RewrapSecret;
  /** Cost of the new slot; within the ceilings. */
  readonly params: KdfParams;
  /** The caller showed both costs and the person confirmed the lower one. */
  readonly allowDowngrade?: boolean;
  readonly costPolicy?: CostPolicy;
  readonly onProgress?: KdfProgress;
}

export interface RewrapOutcome {
  readonly kind: "rewrapped";
  readonly slotId: string;
  readonly params: KdfParams;
  /** The root CID that was read back, pinned and published (`state.rootCid`). */
  readonly snapshotRoot: string;
  /** The new passphrase opened the published file and `manifest.enc` of that root authenticated under the key it gave. */
  readonly testUnlock: "verified";
}

const TEST_UNLOCK_FAILED =
  "The new passphrase could not be verified against the published key-slot file: another device's rewrap may have won, or the file on the node is not the one this device wrote, so the new passphrase may not open the vault. " +
  "This device's key-slot copy and record were NOT changed, and the old passphrase still opens this device's copy. Do not discard the old passphrase.";

function republishDeps(deps: KeyManagementDeps, kv: HostKv, keys: Parameters<typeof decodeManifestFile>[0], newKeySlots: Bytes): RepublishDeps {
  return { node: deps.node, kv, decodeManifest: (bytes) => decodeManifestFile(keys, bytes), verifySnapshot: deps.snapshotVerifier(newKeySlots) };
}

/** The root the publication name points at now and the key-slot file and manifest inside it. */
async function publishedFiles(deps: Pick<KeyManagementDeps, "node">): Promise<{ readonly keySlots: Bytes | undefined; readonly manifestFile: Bytes | undefined }> {
  const root = rootOfReading(await deps.node.resolveName(), false);
  if (root === null) return { keySlots: undefined, manifestFile: undefined };
  return { keySlots: await deps.node.readKeySlotsFileAt(root), manifestFile: await deps.node.readManifestFileAt(root) };
}

/**
 * Open the file the name serves with the NEW passphrase and authenticate its `manifest.enc` under the key that gives: that proves the file is this
 * rewrap's (byte for byte), that the new passphrase works, and that it wraps the vault's own key. Throws `test-unlock-failed`; nothing local changed.
 */
async function testUnlock(deps: KeyManagementDeps, journal: RewrapJournal, secret: CanonicalPassphrase, onProgress: KdfProgress | undefined): Promise<void> {
  const fail = (cause?: unknown): KeyManagementError => new KeyManagementError("test-unlock-failed", TEST_UNLOCK_FAILED, cause === undefined ? {} : { cause });
  const { keySlots, manifestFile } = await publishedFiles(deps);
  const { newKeySlots } = rewrapBytes(journal);
  if (keySlots === undefined || manifestFile === undefined || !sameBytes(keySlots, newKeySlots)) throw fail();
  try {
    // The person chose and confirmed this cost in this run: a cost above the default is approved here, not asked again.
    const unlocked = await deps.ops.unlock(keySlots, secret, { costPolicy: { approveCost: async () => true }, ...(onProgress === undefined ? {} : { onProgress }) });
    const manifest = await decodeManifestFile(unlocked.keys, manifestFile);
    if (manifest.vaultId !== journal.vaultId) throw fail();
  } catch (error) {
    if (error instanceof KeyManagementError) throw error;
    if (error instanceof CryptoError || isUnreadableManifest(error)) throw fail(error);
    throw error;
  }
}

/**
 * The local steps, in an order a rerun can finish from any point: the key-slot copy (atomic replace), `keyslotsSha256` in the record, the journal at
 * `local-updated`, the journal removed. The journal exists until the last step, so publish and pull stay paused while the copy and the record could
 * disagree. Idempotent.
 */
async function finishLocally(deps: KeyManagementDeps, journal: RewrapJournal): Promise<void> {
  const kv = guardKv(deps.kv, deps.assertHeld);
  const { newKeySlots } = rewrapBytes(journal);
  const state = await readRootState(deps.kv, journal.mfsRoot);
  if (state === undefined || state.vaultId !== journal.vaultId) {
    throw new KeyManagementError("record-mismatch", "this device's record for the MFS root is missing or belongs to another vault than the pending key-slot rewrap; nothing was changed. Run `ipfs-sync keys discard`, then check the vault.");
  }
  deps.assertHeld();
  await persistKeySlotsCopy(deps.fs, journal.mfsRoot, newKeySlots);
  const sha = await sha256Hex(newKeySlots);
  if (state.keyslotsSha256 !== sha) await writeRootState(kv, buildRootState({ ...state, keyslotsSha256: sha }));
  if (!reached(journal, "local-updated")) await writeMaintenanceJournal(kv, advance(journal, "local-updated"));
  await discardMaintenanceJournal(kv, journal.mfsRoot);
}

/**
 * Run the rewrap. Derivations 2 and 3 happen before anything is written, so a wrong current passphrase, a refused downgrade or a cost above the ceiling
 * leaves no trace. After the journal exists a failure leaves it for a rerun (`resumeRewrap`).
 */
export async function executeRewrap(deps: KeyManagementDeps, prepared: PreparedRewrap, input: RewrapExecuteInput): Promise<RewrapOutcome> {
  const secret: CanonicalPassphrase = input.next.kind === "reuse" ? input.passphrase : input.next.passphrase;
  const rewrapped = await deps.ops.rewrap({
    document: parseKeySlots(prepared.vault.keySlots),
    passphrase: input.passphrase,
    next: input.next,
    params: input.params,
    ...(input.allowDowngrade === undefined ? {} : { allowDowngrade: input.allowDowngrade }),
    ...(input.costPolicy === undefined ? {} : { costPolicy: input.costPolicy }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
  });
  const kv = guardKv(deps.kv, deps.assertHeld);
  const journal = buildRewrapJournal(prepared.start.facts, { oldKeySlots: prepared.vault.keySlots, newKeySlots: rewrapped.bytes });
  await deps.beforeFirstWrite?.();
  await writeMaintenanceJournal(kv, journal);
  const driven = await driveMaintenance(republishDeps(deps, kv, prepared.vault.keys, rewrapped.bytes), journal);
  const published = driven.journal as RewrapJournal;
  await testUnlock(deps, published, secret, input.onProgress);
  await finishLocally(deps, published);
  return { kind: "rewrapped", slotId: rewrapped.slotId, params: rewrapped.params, snapshotRoot: driven.snapshotRoot, testUnlock: "verified" };
}

/* ---------- resume ---------- */

export interface ResumeOutcome {
  readonly kind: "finished";
  /** The phase the journal was in when the rerun started. */
  readonly phaseFound: MaintenancePhase;
  readonly snapshotRoot: string;
  /** A rerun has no new passphrase to test with; the file on the node was checked against the journal's bytes instead. */
  readonly testUnlock: "not-run";
}

/** The published root must still hold exactly this rewrap's file; anything else is a lost race, with the two ways out named. */
async function assertPublishedIsOurs(deps: KeyManagementDeps, journal: RewrapJournal): Promise<void> {
  const { keySlots } = await publishedFiles(deps);
  if (keySlots === undefined || !sameBytes(keySlots, rewrapBytes(journal).newKeySlots)) throw maintenanceLostRace("rewrap", { withdrawn: false });
}

/**
 * Finish a rewrap this device started and did not complete. Before `published` it needs the CURRENT passphrase (or a held vault) to check the manifest and
 * republish; from `published` on it needs nothing. The journal's phase and the node decide; the rewrap itself is never called again.
 */
export async function resumeRewrap(deps: KeyManagementDeps, journal: MaintenanceJournal, input: KeyManagementInput): Promise<ResumeOutcome> {
  if (journal.type !== "rewrap") throw maintenancePending(journal.type);
  await assertNoPublishJournal(deps.kv, input.mfsRoot);
  let current: RewrapJournal = journal;
  if (!reached(journal, "published")) {
    const { vault } = await openCurrentVault(deps, input, { localOnly: true });
    if (!sameBytes(vault.keySlots, rewrapBytes(journal).oldKeySlots)) {
      throw new KeyManagementError("copy-changed", "this device's key-slot copy is no longer the one the pending rewrap started from; nothing was changed. Run `ipfs-sync keys discard` to drop the pending rewrap.");
    }
    if (input.key.absent) throw publicationKeyMissing(input.keyName);
    const kv = guardKv(deps.kv, deps.assertHeld);
    await deps.beforeFirstWrite?.();
    current = (await driveMaintenance(republishDeps(deps, kv, vault.keys, rewrapBytes(journal).newKeySlots), journal)).journal as RewrapJournal;
  } else {
    await deps.beforeFirstWrite?.();
  }
  await assertPublishedIsOurs(deps, current);
  await finishLocally(deps, current);
  return { kind: "finished", phaseFound: journal.phase, snapshotRoot: current.snapshotRoot as string, testUnlock: "not-run" };
}

/* ---------- discard and accept-slots (task 1.5) ---------- */

/**
 * `discard` and `accept-slots` are the two ways out of a maintenance journal that cannot finish. Both end the same way for the journal: if it is a
 * rewrap that did not reach `published`, the key-slot file it wrote into the shared tree is taken back out (`withdrawMaintenanceWrite`, which writes
 * only when the tree still holds exactly the journal's pending bytes), and only then is the journal removed. A failing withdrawal keeps the journal,
 * so a rerun can do it again; a rerun after the withdrawal found nothing to withdraw and removes the journal.
 *
 * `accept-slots` (design 3, spec "Other devices accept changed key slots"):
 *
 *   prepare  (reads, one derivation)  the host resolved the name ONCE to `target.rootCid` (or the person named a root); both files are read from
 *                                     that one root; `evaluateSlotAcceptance` judges them (vault id, manifest authentication, sequence verdict,
 *                                     cost comparison). Nothing is written. The caller shows the downgrade costs and asks.
 *   commit                            `acceptedSlotBytes` (a downgrade without its confirmation throws before anything is written), the first-write
 *                                     check, the withdrawal, then the local steps in an order a rerun can finish from any point: key-slot copy,
 *                                     `keyslotsSha256` in the record, in a pending publish journal, and last the maintenance journal. Each step is
 *                                     idempotent and decided from what is on disk, not from `changed`, so a run killed between two of them is
 *                                     finished by running accept again.
 *
 * The caller holds `publish.lock`. Acceptance does not raise the sequence floor and pulls no file.
 */

export interface AcceptDeps {
  /** Reads of a root and, for a withdrawal, the shared tree. Its `beforeWrite` is the caller's `assertHeld`. */
  readonly node: MaintenanceNode;
  readonly fs: Pick<HostFs, "read" | "write" | "stat">;
  readonly kv: HostKv;
  /** The sequence floor. Required: a damaged floor is a refusal, so an absent store would hide it. */
  readonly deviceStore: DeviceStore;
  readonly assertHeld: () => void;
  readonly beforeFirstWrite?: () => Promise<void>;
}

/** How the root was named. `name`: the host resolved the name once and passes the root. `root-cid`: the person named it. */
export interface AcceptTarget {
  readonly kind: "name" | "root-cid";
  readonly rootCid: string;
}

export interface AcceptInput {
  readonly mfsRoot: string;
  readonly passphrase: CanonicalPassphrase;
  readonly target: AcceptTarget;
  readonly flags?: SlotAcceptanceFlags;
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
  /** Keys a session already holds for the vault: the manifest must authenticate under them too. A cold command-line run has none. */
  readonly heldVault?: UnlockedVault;
}

/** What `commitAcceptance` would change; all false means a rerun with nothing to do. */
export interface AcceptWork {
  readonly copy: boolean;
  readonly state: boolean;
  readonly publishJournal: boolean;
  readonly maintenance: boolean;
}

export interface PreparedAcceptance {
  readonly mfsRoot: string;
  readonly target: AcceptTarget;
  readonly acceptance: SlotAcceptance;
  /** The maintenance journal found at preparation (readable or not). */
  readonly maintenance: MaintenanceRead;
  readonly work: AcceptWork;
}

export interface AcceptOutcome {
  readonly kind: "accepted" | "unchanged";
  readonly copyReplaced: boolean;
  readonly stateUpdated: boolean;
  readonly publishJournalUpdated: boolean;
  readonly maintenanceCleared: "removed" | "none";
  /** A key-slot file this device wrote into the shared tree was taken back out. */
  readonly withdrawn: boolean;
}

const ROOT_INCOMPLETE =
  "the root does not hold both keyslots.json and manifest.enc (or its name is not a CID): there is nothing to accept from it; nothing was changed";

async function readOptionalCopy(deps: Pick<AcceptDeps, "fs">, mfsRoot: string): Promise<Bytes | undefined> {
  const path = await keySlotsCopyPath(mfsRoot);
  return (await deps.fs.stat(path))?.kind === "file" ? deps.fs.read(path) : undefined;
}

/**
 * The record after an accept, or `undefined` when it already is that. The recorded hash follows the copy. The recorded root follows the name only
 * when the name was resolved and its manifest is the one the record already holds (verdict `same`): then the root holds exactly what this device
 * recorded, and leaving the old root would make the next publish see "a root that is not the recorded one" and write a no-change manifest and a
 * history file (`hasWork`, `unpublished`). A newer manifest, an explicit root and a restore never move it.
 */
function acceptedState(state: RootState | undefined, acceptance: SlotAcceptance, target: AcceptTarget): RootState | undefined {
  if (state === undefined) return undefined;
  const rootCid = target.kind === "name" && acceptance.verdict.kind === "same" ? target.rootCid : state.rootCid;
  if (state.keyslotsSha256 === acceptance.keySlotsSha256 && state.rootCid === rootCid) return undefined;
  return buildRootState({ ...state, keyslotsSha256: acceptance.keySlotsSha256, rootCid });
}

/** The publish journal when it can be read and belongs to this vault; an unreadable one is the publisher's to handle and is never touched. */
async function publishJournalOf(kv: Pick<HostKv, "get">, mfsRoot: string, vaultId: string): Promise<PublishJournal | undefined> {
  const read = await readJournal(kv, mfsRoot);
  return read.kind === "ok" && read.journal.vaultId === vaultId ? read.journal : undefined;
}

/**
 * Read both files from the one root, unlock and judge them. Reads only. Errors: `KeyManagementError` (`root-incomplete`), `PullUnlockError`,
 * `SequenceFloorError`, `SlotAcceptanceError`, `VaultKeysError`, `CryptoError`, `RootStateError`, and the node's read refusals.
 */
export async function prepareAcceptance(deps: AcceptDeps, input: AcceptInput): Promise<PreparedAcceptance> {
  const { rootCid } = input.target;
  if (!isCidToken(rootCid)) throw new KeyManagementError("root-incomplete", ROOT_INCOMPLETE);
  const keySlots = await deps.node.readKeySlotsFileAt(rootCid);
  const manifestFile = await deps.node.readManifestFileAt(rootCid);
  if (keySlots === undefined || manifestFile === undefined) throw new KeyManagementError("root-incomplete", ROOT_INCOMPLETE);
  const state = await readRootState(deps.kv, input.mfsRoot);
  const floor = state === undefined ? undefined : await readFloor(deps.deviceStore, state.vaultId);
  const currentCopy = await readOptionalCopy(deps, input.mfsRoot);
  const acceptance = await evaluateSlotAcceptance({
    keySlots,
    manifestFile,
    passphrase: input.passphrase,
    mfsRoot: input.mfsRoot,
    currentCopy,
    state: stateRecordOf(state, floor, rootCid),
    deviceStore: deps.deviceStore,
    target: input.target.kind,
    ...(input.flags === undefined ? {} : { flags: input.flags }),
    ...(input.confirmCost === undefined ? {} : { confirmCost: input.confirmCost }),
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.heldVault === undefined ? {} : { heldVault: input.heldVault }),
  });
  const maintenance = await readMaintenanceJournal(deps.kv, input.mfsRoot);
  const publishJournal = await publishJournalOf(deps.kv, input.mfsRoot, acceptance.vaultId);
  return {
    mfsRoot: input.mfsRoot,
    target: input.target,
    acceptance,
    maintenance,
    work: {
      copy: acceptance.changed,
      state: acceptedState(state, acceptance, input.target) !== undefined,
      publishJournal: publishJournal !== undefined && publishJournal.keyslotsSha256 !== acceptance.keySlotsSha256,
      maintenance: maintenance.kind !== "none",
    },
  };
}

/** Take a pending rewrap's key-slot file back out of the shared tree, when that applies. The lock is checked first; the node's own write check is the caller's. */
async function withdrawPending(deps: Pick<AcceptDeps, "node" | "assertHeld">, read: MaintenanceRead): Promise<boolean> {
  if (read.kind !== "ok") return false;
  deps.assertHeld();
  return withdrawMaintenanceWrite(deps, read.journal);
}

/**
 * Store what `prepareAcceptance` judged. A downgrade without `downgradeConfirmed` throws `downgrade-unconfirmed` before anything is written. A run that
 * has nothing to change returns `unchanged` and writes nothing. Errors: `SlotAcceptanceError`, `PublishRefusedError` (`lock-lost`), `VaultKeysError`
 * and whatever the node or the host throws.
 */
export async function commitAcceptance(deps: AcceptDeps, prepared: PreparedAcceptance, confirmation: { readonly downgradeConfirmed?: boolean }): Promise<AcceptOutcome> {
  const bytes = acceptedSlotBytes(prepared.acceptance, confirmation);
  const { acceptance, work } = prepared;
  if (!work.copy && !work.state && !work.publishJournal && !work.maintenance) {
    return { kind: "unchanged", copyReplaced: false, stateUpdated: false, publishJournalUpdated: false, maintenanceCleared: "none", withdrawn: false };
  }
  const { mfsRoot } = prepared;
  await deps.beforeFirstWrite?.();
  const kv = guardKv(deps.kv, deps.assertHeld);
  // The shared tree first: if the node cannot be reached nothing local has changed and the journal is still there for a rerun.
  const withdrawn = await withdrawPending(deps, prepared.maintenance);
  if (work.copy) {
    deps.assertHeld();
    await persistKeySlotsCopy(deps.fs, mfsRoot, bytes);
  }
  const recorded = acceptedState(await readRootState(deps.kv, mfsRoot), acceptance, prepared.target);
  if (recorded !== undefined) await writeRootState(kv, recorded);
  const stateUpdated = recorded !== undefined;
  const pending = await publishJournalOf(deps.kv, mfsRoot, acceptance.vaultId);
  let publishJournalUpdated = false;
  if (pending !== undefined && pending.keyslotsSha256 !== acceptance.keySlotsSha256) {
    await writeJournal(kv, buildJournal({ ...pending, keyslotsSha256: acceptance.keySlotsSha256 }));
    publishJournalUpdated = true;
  }
  const removed = (await discardMaintenanceJournal(kv, mfsRoot)) === "removed";
  return { kind: "accepted", copyReplaced: work.copy, stateUpdated, publishJournalUpdated, maintenanceCleared: removed ? "removed" : "none", withdrawn };
}

export interface DiscardOutcome {
  readonly kind: "discarded" | "none";
  readonly type: "rewrap" | "prune" | "damaged" | undefined;
  /** The phase the journal was in; `undefined` for a journal that could not be read. */
  readonly phase: MaintenancePhase | undefined;
  /** A key-slot file this device wrote into the shared tree was taken back out (the only thing `discard` can do to the node). */
  readonly withdrawn: boolean;
}

/**
 * `keys discard`: drop the maintenance journal. The caller showed `discardStatements` and asked. With no journal nothing is written. Errors: whatever the
 * node throws for the withdrawal (the journal is kept), and `PublishRefusedError` (`lock-lost`).
 */
export async function discardMaintenance(deps: Pick<AcceptDeps, "node" | "kv" | "assertHeld" | "beforeFirstWrite">, mfsRoot: string): Promise<DiscardOutcome> {
  const read = await readMaintenanceJournal(deps.kv, mfsRoot);
  if (read.kind === "none") return { kind: "none", type: undefined, phase: undefined, withdrawn: false };
  await deps.beforeFirstWrite?.();
  const withdrawn = await withdrawPending(deps, read);
  await discardMaintenanceJournal(guardKv(deps.kv, deps.assertHeld), mfsRoot);
  return read.kind === "ok"
    ? { kind: "discarded", type: read.journal.type, phase: read.journal.phase, withdrawn }
    : { kind: "discarded", type: "damaged", phase: undefined, withdrawn };
}
