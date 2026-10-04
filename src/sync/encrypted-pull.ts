import type { Bytes, HostBridge } from "../core/host-bridge";
import { CryptoError, KdfCostRefusedError, OversizeInputError, type CanonicalPassphrase, type KdfParams, type KdfProgress } from "../crypto";
import { KuboHttpError, type KuboClient, type MfsEntry } from "../kubo";
import { sweepStaleParts } from "./blob-fetch";
import type { DeviceStore } from "./device-store";
import { ManifestFormatError, decodeManifestFile, type EncryptedManifest } from "./encrypted-manifest";
import { parseHistoryName } from "./history-names";
import { assertNoMaintenanceJournal } from "./maintenance-journal";
import { isUnreadableManifest } from "./manifest-auth";
import { manifestIdentity } from "./manifest-identity";
import { KEYSLOTS_READ_CAP, MANIFEST_READ_CAP, readRemoteFile } from "./node-reader";
import { escapeForDisplay, evaluatePathPolicy, summarizeRefusals, type PathPolicyResult } from "./path-policy";
import { PullSourceError, PullStopError, PullTargetError, type PullStopReason } from "./pull-errors";
import { assertPullDestination, type GuardFs } from "./pull-guard";
import { assertStateFolderSafe } from "./state-folder-guard";
import {
  checkPullFlags,
  effectiveRecord,
  evaluatePullVerdict,
  recordAfterVerdict,
  type EffectiveRecord,
  type PullCandidate,
  type PullFlags,
  type PullTargetKind,
  type PullVerdict,
  type RecordPoint,
  type StateRecord,
} from "./pull-sequence";
import { PullUnlockError, assertManifestVault, recordLookup, storeKeySlotsCopy, unlockForPull, type PullUnlock } from "./pull-unlock";
import { acquirePublishLock, type LockContext, type LockFile, type PublishLock } from "./publish-lock";
import { PublishRefusedError, lockHeld, lockLost, remoteObjectInvalid } from "./publish-refusals";
import { withTokenCheck } from "./lock-token-check";
import { RootStateError, readRootState, type RootState } from "./root-state";
import { SequenceFloorError, raiseFloor, readFloor, type FloorEntry } from "./sequence-floor";
import { chooseIpnsName, isCid, isIpnsName, resolveRootCid } from "./target-resolution";
import { VaultKeysError, type NodeAccess, type UnlockedVault } from "./vault-keys";

/*
 * The decrypting pull, part 1 (mvp-07a task 4.6a; design decision 6 steps 1 to 6; specs encrypted-pull,
 * rollback-detection, path-hardening). WebView-safe: no Node imports.
 *
 * What runs, in order, and what each step may do:
 *   0. Flag combinations that are never valid (`checkPullFlags`) are refused. No I/O.
 *   1. The destination guard (fixture marker rule, state folder not a symbolic link) runs before any request. A refusal
 *      is the guard's own `PullGuardError`, thrown, as for the plaintext reader.
 *   2. The in-process lock (optional port) and `publish.lock` are taken; a held lock is a refusal with publish's own text.
 *      `.ipfs-sync/tmp/` is swept while the lock is held. The local state is read (a damaged file is a refusal).
 *   3. The target is resolved (name with nocache, `--root-cid`, `--manifest`), the root is listed once, and `keyslots.json`
 *      and `manifest.enc` are read from it by the CID of their listing entry, each refused above its cap before any byte
 *      is read. Nothing is requested before it is needed: with a local key-slot copy a wrong passphrase makes no request.
 *      `manifest.json` is never requested.
 *   4. Unlock (`pull-unlock.ts`): `--expect-vault-id` and the record's vault are compared with the slot file's vaultId
 *      before any derivation; one outcome and one message for a wrong passphrase, a damaged slot and a failed commitment.
 *   5. `manifest.enc` (or the `--manifest` history entry) is authenticated and decoded under the unlocked key; its vaultId
 *      must equal the slot file's; for `--manifest` its inner `rootCID` must equal the named CID. The path policy runs over
 *      the whole manifest (per-path refusals are carried for the plan, they do not stop the pull). The verdict is decided
 *      against the effective record (directory state and sequence floor).
 *   6. A first pull is shown and confirmed. Only then are the key-slot copy stored and the floor raised (floor and copy are
 *      the only things this part writes; the state, the marker and every vault file belong to the steps after it).
 *
 * Every step up to and including the confirmation writes nothing, and no blob is requested. The rest of the pull is the
 * injected `stage`: it receives a `VerifiedPull` with the locks still held. Nothing in this module emits an event.
 *
 * Messages are fixed text. Text that comes from a lower layer or from the node is escaped (`escapeForDisplay`) before it
 * reaches a message; no message, detail or result carries a passphrase, a key or file bytes.
 */

/** Node operations of a pull. Every one is a read: name resolve, key list, a listing, a gateway GET. */
export type PullNodeClient = Pick<KuboClient, "keyList" | "nameResolve" | "ipfsLs" | "gatewayStream">;

export type PullTarget =
  | { readonly kind: "name"; /** `--name`: an IPNS key ID; omitted: the owned publication key. */ readonly name?: string }
  | { readonly kind: "root-cid"; readonly cid: string }
  | { readonly kind: "manifest"; /** The tree CID (the manifest's `rootCID`) of the history entry; either naming form is found. */ readonly cid: string; readonly name?: string };

/** Another operation in this process (the plugin's `SyncLock`) can be asked through this; `undefined` means it is held. */
export interface ProcessLock {
  tryAcquire(): (() => void) | undefined;
}

/** What a host shows before a first pull, all of it safe to print or to set as text. */
export interface FirstPullDetails {
  readonly target: PullTargetKind;
  readonly sequence: number;
  /** ISO-8601 UTC; format-checked by the manifest decoder. */
  readonly publishedAt: string;
  /** The manifest's `device`, chosen by a vault-key holder, with control and bidirectional characters escaped. */
  readonly device: string;
  readonly fileCount: number;
  /** Manifest paths the path policy will skip (expected and unsafe together). */
  readonly pathsRefused: number;
  /** At most three of them, escaped, and a count; `undefined` when none. */
  readonly pathsSummary: string | undefined;
  /** The fixed statements the host must show next to these values. */
  readonly statements: readonly string[];
}

export const FIRST_PULL_KEY_HOLDER_STATEMENT = "The sequence, date and device shown here were chosen by whoever holds the vault key; nothing in this pull can confirm them.";
export const FIRST_PULL_NO_BASELINE_STATEMENT =
  "This directory has no record of this vault, so this first pull has no baseline and trusts what the node serves; later pulls are checked against the sequence recorded now.";
export const FIRST_PULL_GATEWAY_STATEMENT =
  "An explicit root CID names what the gateway serves; the client does not verify the returned bytes against it, so authenticity rests on the vault key.";

export interface EncryptedPullDeps<R> {
  readonly client: PullNodeClient;
  readonly host: Pick<HostBridge, "fs" | "kv">;
  /** Holds the sequence floor. */
  readonly deviceStore: DeviceStore;
  /** `publish.lock`, however the host stores it (CLI: `createNodeLockFile`; plugin: the adapter lock file). */
  readonly lockFile: LockFile;
  readonly lockContext: LockContext;
  readonly processLock?: ProcessLock;
  readonly now: () => number;
  /** Defaults to `assertPullDestination`; a host whose root always holds application folders passes `assertVaultPullDestination`. */
  readonly assertDestination?: (fs: GuardFs) => Promise<{ readonly needsMarker: boolean }>;
  /** Interactive hosts only. Absent: a first pull needs `acceptFirstPull`. A callback that throws counts as a refusal. */
  readonly confirmFirstPull?: (details: FirstPullDetails) => Promise<boolean>;
  /** Interactive hosts only: shows the cost of slots above the default and asks. Absent: such a slot file is refused. */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
  readonly onProgress?: KdfProgress;
  /** Everything after step 6. Called with the locks held; its result is returned. */
  readonly stage: (verified: VerifiedPull) => Promise<R>;
}

export interface EncryptedPullOptions {
  readonly mfsRoot: string;
  /** The configured publication key name (the state records it; the owned key's ID names the pull target). */
  readonly keyName: string;
  readonly ownedKeys: readonly string[];
  readonly target: PullTarget;
  readonly flags: PullFlags;
  /** Required unless `unlocked` covers the slots being opened; never logged or stored. */
  readonly passphrase?: CanonicalPassphrase;
  readonly unlocked?: UnlockedVault;
  /** `--accept-first-pull`: the non-interactive yes. */
  readonly acceptFirstPull?: boolean;
  /** The host's configuration folder (`vault.configDir`), for the path policy. */
  readonly configDir?: string;
  /** This device's additions to the default exclusion list, for the path policy. */
  readonly extraExclusions?: readonly string[];
}

/** The resolved target, as the state records it. */
export interface ResolvedPullTarget {
  readonly kind: PullTargetKind;
  /** The immutable root the target resolved to (the named root for `--root-cid`; the name's current root otherwise). */
  readonly rootCid: string;
  /** The IPNS name resolved (name and `--manifest` targets); `undefined` for `--root-cid`. */
  readonly ipnsName: string | undefined;
  /** The history file read, for a `--manifest` target. */
  readonly historyName: string | undefined;
}

/** A verdict that lets the pull go on. */
export type AllowedVerdict = Exclude<PullVerdict, { readonly kind: "refused" }>;

/** What steps 1 to 6 hand to the rest of the pull: authenticated, authorised, with the locks still held. */
export interface VerifiedPull {
  readonly target: ResolvedPullTarget;
  readonly unlock: PullUnlock;
  /** The authenticated node manifest (or history entry). */
  readonly manifest: EncryptedManifest;
  /** `manifestIdentity(manifest)`. */
  readonly identity: string;
  readonly verdict: AllowedVerdict;
  /** The effective record before this pull; `undefined` for a first pull. */
  readonly record: EffectiveRecord | undefined;
  /** The directory's state (the baseline for the plan); `undefined` for a fresh directory. */
  readonly state: RootState | undefined;
  /** The path policy over the whole manifest. Per-path refusals are skips, not stops. */
  readonly policy: PathPolicyResult;
  /** The destination is absent or empty: the stage writes the `pulled-fixture` marker when it populates it. */
  readonly needsMarker: boolean;
  /** A first pull was confirmed (always false for any other verdict). */
  readonly firstPullConfirmed: boolean;
  /** The key-slot copy was written by this pull. */
  readonly keySlotsStored: boolean;
  /** The floor was written by this pull (raised, or healed from the state). `fork-resolution` raises it later. */
  readonly floorWritten: boolean;
  /** Stale `.part` files removed at the start. */
  readonly sweptParts: number;
  /** Throws `lock-lost` when `publish.lock` changed hands or its heartbeat lapsed; call it before a long write. */
  readonly assertLockHeld: () => void;
}

export interface PullStop {
  readonly reason: PullStopReason;
  readonly message: string;
  /** For `kdf-cost-refused`: the public parameters of the refused slots. */
  readonly costs?: readonly { readonly m: number; readonly t: number; readonly p: number }[];
}

export type EncryptedPullOutcome<R> =
  | { readonly kind: "completed"; readonly verified: VerifiedPull; readonly result: R }
  /** Steps 1 to 6 stopped at a check. Nothing was written in the vault; the key-slot copy and the floor are written only when they pass. */
  | { readonly kind: "stopped"; readonly stop: PullStop };

// ---- error mapping ----------------------------------------------------------------------------------------------

const WITHHELD_MESSAGE =
  "the root holds key slots but manifest.enc is absent or unreadable on the node: the manifest is withheld or not yet published; the vault was treated as neither empty nor creatable, and nothing was written";

function shown(text: string): string {
  return escapeForDisplay(text);
}

function asStop(error: unknown): PullStopError | undefined {
  if (error instanceof PullStopError) return error;
  if (error instanceof PullUnlockError) return new PullStopError(error.reason, shown(error.message));
  if (error instanceof PullTargetError || error instanceof PullSourceError) return new PullStopError("target-unresolved", shown(error.message), { cause: error });
  if (error instanceof RootStateError) {
    return new PullStopError("state-unreadable", shown(`the local state file for this root cannot be read (${error.message}); nothing was changed`), { cause: error });
  }
  if (error instanceof SequenceFloorError) return new PullStopError("state-unreadable", shown(error.message), { cause: error });
  if (error instanceof PublishRefusedError && (error.code === "remote-object-too-large" || error.code === "remote-object-invalid")) {
    return new PullStopError("remote-object", shown(error.message), { cause: error });
  }
  if (error instanceof PublishRefusedError && error.code === "maintenance-pending") return new PullStopError("maintenance-pending", shown(error.message), { cause: error });
  if (error instanceof VaultKeysError) return new PullStopError(vaultKeysReason(error), shown(error.message), { cause: error });
  if (error instanceof CryptoError) return cryptoStop(error);
  return undefined;
}

function vaultKeysReason(error: VaultKeysError): PullStopReason {
  switch (error.code) {
    case "vault-mismatch":
    case "slots-without-manifest":
    case "no-key-slots":
    case "plaintext-root":
    case "locked":
      return error.code;
    default:
      return "key-slots-invalid";
  }
}

/** Failures of the crypto layer that belong to the data (not to the platform); an environment failure is not mapped. */
function cryptoStop(error: CryptoError): PullStopError | undefined {
  switch (error.code) {
    case "wrong-passphrase-or-damaged-slot":
      return new PullStopError("wrong-passphrase", error.message, { cause: error });
    case "passphrase-format":
      return new PullStopError("passphrase-format", error.message, { cause: error });
    case "kdf-cost-refused":
      return new PullStopError("kdf-cost-refused", shown(error.message), { costs: error instanceof KdfCostRefusedError ? error.slots : undefined, cause: error });
    case "kdf-unaffordable":
      return new PullStopError("kdf-unaffordable", shown(error.message), { cause: error });
    case "kdf-params-out-of-bounds":
    case "unsupported-format":
    case "malformed-input":
    case "oversize-input":
    case "no-usable-slot":
      return new PullStopError("key-slots-invalid", shown(error.message), { cause: error });
    default:
      return undefined;
  }
}

/**
 * A refusal that tells a person to accept the changed key slots names, for an explicit `--root-cid` root, that root and the rollback flag as well
 * (mvp-07b task 1.5): restoring an older root across a rewrap goes through `keys accept-slots --root-cid <root> --allow-rollback`. `--manifest` reads
 * the current root's key slots and needs no accept on a device that holds the current copy, so it gets no such suffix. The CID is the one the reader
 * accepted as a token, and is escaped anyway.
 */
function withRestoreHint(stop: PullStopError, target: PullTarget): PullStopError {
  if (target.kind !== "root-cid" || stop.reason !== "vault-mismatch" || !stop.message.includes("keys accept-slots")) return stop;
  const hint = `for this explicit root, name it and allow the rollback: ipfs-sync keys accept-slots <vault> --root-cid ${shown(target.cid)} --allow-rollback (with the passphrase of that root)`;
  return new PullStopError(stop.reason, `${stop.message}; ${hint}`, { ...(stop.costs === undefined ? {} : { costs: stop.costs }), cause: stop.cause });
}

function toStop(error: PullStopError): PullStop {
  return error.costs === undefined ? { reason: error.reason, message: error.message } : { reason: error.reason, message: error.message, costs: error.costs };
}

// ---- reading the target -------------------------------------------------------------------------------------------

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}

interface RootReader {
  readonly resolved: () => Promise<{ readonly rootCid: string; readonly ipnsName: string | undefined }>;
  /** The listing of the root, once. */
  readonly entries: () => Promise<readonly MfsEntry[]>;
}

function createRootReader(client: PullNodeClient, options: EncryptedPullOptions): RootReader {
  const { target } = options;
  const resolved = once(async () => {
    if (target.kind === "root-cid") {
      if (!isCid(target.cid)) throw new PullTargetError("--root-cid needs a CID");
      return { rootCid: target.cid, ipnsName: undefined };
    }
    if (target.kind === "manifest" && !isCid(target.cid)) throw new PullTargetError("--manifest needs the tree CID of a history entry");
    if (target.name !== undefined && !isIpnsName(target.name)) throw new PullTargetError("--name needs an IPNS key ID");
    const ipnsName = await chooseIpnsName(client, { name: target.name, keyName: options.keyName, ownedKeys: options.ownedKeys });
    return { rootCid: await resolveRootCid(client, ipnsName), ipnsName };
  });
  const entries = once(async () => client.ipfsLs(`/ipfs/${(await resolved()).rootCid}`));
  return { resolved, entries };
}

/** The one entry of this name, or `undefined`. A listing that names it twice is not a layout this tool wrote. */
function uniqueEntry(entries: readonly MfsEntry[], name: string): MfsEntry | undefined {
  const found = entries.filter((entry) => entry.name === name);
  if (found.length > 1) throw remoteObjectInvalid("the root listing (an entry is listed twice)");
  return found[0];
}

function nodeAccess(client: PullNodeClient, reader: RootReader): NodeAccess {
  return {
    fetchKeySlots: async () => {
      const entry = uniqueEntry(await reader.entries(), "keyslots.json");
      return entry === undefined ? undefined : readRemoteFile(client, entry, "keyslots.json", KEYSLOTS_READ_CAP);
    },
    manifestPresent: async () => uniqueEntry(await reader.entries(), "manifest.enc")?.type === "file",
    // A listing check only: `manifest.json` is never requested, so a planted one is not read.
    plaintextManifestPresent: async () => (await reader.entries()).some((entry) => entry.name === "manifest.json"),
  };
}

const withheld = (): PullStopError => new PullStopError("slots-without-manifest", WITHHELD_MESSAGE);

/** A node that lists a file and then answers 404 for it is withholding it. */
async function readOrNotFound(client: PullNodeClient, entry: MfsEntry, what: string, onMissing: () => PullStopError): Promise<Bytes> {
  try {
    return await readRemoteFile(client, entry, what, MANIFEST_READ_CAP);
  } catch (error) {
    if (error instanceof KuboHttpError && error.status === 404) throw onMissing();
    throw error;
  }
}

interface ManifestSource {
  readonly bytes: Bytes;
  readonly historyName: string | undefined;
}

const historyNotFound = (): PullStopError =>
  new PullStopError("history-entry-not-found", "no history entry under the root names that tree CID (either naming form is looked for); nothing was written");

/** The history file whose name carries the tree CID, in either naming form. Zero or several is a stop. */
async function readHistoryEntry(client: PullNodeClient, reader: RootReader, cid: string): Promise<ManifestSource> {
  const { rootCid } = await reader.resolved();
  const folder = uniqueEntry(await reader.entries(), "manifests");
  if (folder === undefined || folder.type !== "directory") throw historyNotFound();
  const matches = (await client.ipfsLs(`/ipfs/${rootCid}/manifests`)).filter((entry) => parseHistoryName(entry.name)?.cid === cid);
  if (matches.length === 0) throw historyNotFound();
  const [entry] = matches;
  if (matches.length > 1 || entry === undefined) {
    throw new PullStopError("history-entry-ambiguous", "more than one history entry names that tree CID; nothing was written. Pull the root by --root-cid instead");
  }
  return { bytes: await readOrNotFound(client, entry, "the history entry", historyNotFound), historyName: entry.name };
}

async function readManifestSource(client: PullNodeClient, reader: RootReader, target: PullTarget): Promise<ManifestSource> {
  if (target.kind === "manifest") return readHistoryEntry(client, reader, target.cid);
  const entry = uniqueEntry(await reader.entries(), "manifest.enc");
  if (entry === undefined) throw withheld();
  return { bytes: await readOrNotFound(client, entry, "manifest.enc", withheld), historyName: undefined };
}

/** Authenticate and decode. After a successful unlock, a file that does not authenticate is forged or damaged: a distinct, non-oracle stop. */
async function authenticate(unlock: PullUnlock, bytes: Bytes): Promise<EncryptedManifest> {
  try {
    return await decodeManifestFile(unlock.keys, bytes);
  } catch (error) {
    if (error instanceof ManifestFormatError || error instanceof OversizeInputError) {
      throw new PullStopError("manifest-unsupported", shown(`manifest.enc authenticated but holds something this build does not read (${error.message}); nothing was written`), { cause: error });
    }
    if (error instanceof CryptoError && error.code === "unsupported-format") {
      throw new PullStopError("manifest-unsupported", shown("manifest.enc authenticated but is in a format this build does not read; nothing was written"), { cause: error });
    }
    if (isUnreadableManifest(error)) {
      throw new PullStopError(
        "manifest-not-authentic",
        "manifest.enc on the node does not authenticate under this vault's key: it was forged or damaged, or written for another vault; no file was requested and nothing was written",
        { cause: error },
      );
    }
    if (error instanceof CryptoError && error.code === "vault-mismatch") {
      throw new PullStopError("vault-mismatch", "the manifest belongs to a different vault than the key slots; nothing was written and no key-slot copy was stored", { cause: error });
    }
    throw error;
  }
}

// ---- the record and the verdict ------------------------------------------------------------------------------------

/**
 * The state as a record. `pendingPublish` is true only for a state that an interrupted publish adopted: the state is above
 * the floor (an adopt does not raise it) and its `rootCid` is the root the name still points at (an adopt keeps the root of
 * the publish before it, or `null` for a first publish), so a lower manifest on that same root is this device's own
 * unfinished publish and not a rollback. "State above the floor" alone would also describe a format 2 upgrade and a lost
 * floor, where a lower manifest is a rollback; a finished publish records the root it published, which a rolled-back name
 * does not equal.
 */
export function stateRecordOf(state: RootState | undefined, floor: FloorEntry | undefined, resolvedRoot: string | undefined): StateRecord | undefined {
  if (state === undefined) return undefined;
  const aboveFloor = state.highestSequence > (floor?.sequence ?? 0);
  const sameRoot = resolvedRoot !== undefined && (state.rootCid === null || state.rootCid === resolvedRoot);
  return { vaultId: state.vaultId, sequence: state.highestSequence, identity: state.highestIdentity, pendingPublish: aboveFloor && sameRoot };
}

function localKnowledge(state: RootState | undefined): { readonly hasState: boolean; readonly vaultId?: string; readonly keyslotsSha256?: string } {
  return state === undefined ? { hasState: false } : { hasState: true, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256 };
}

/** The floor point this pull writes, if any: a first pull and a newer manifest raise it; `same` and `restore` only heal a floor the state is ahead of. */
function floorPointFor(verdict: AllowedVerdict, record: EffectiveRecord | undefined, candidate: PullCandidate): RecordPoint | undefined {
  if (verdict.kind === "fork-resolution") return undefined; // the only operation that changes an identity at a sequence: fork resolution writes it after its fetch
  const point = recordAfterVerdict(record, candidate, verdict);
  const raises = verdict.kind === "first-pull" || verdict.kind === "newer";
  const heals = (verdict.kind === "same" || verdict.kind === "restore") && record?.source === "state";
  return point !== undefined && (raises || heals) ? point : undefined;
}

// ---- first pull ----------------------------------------------------------------------------------------------------

function firstPullDetails(kind: PullTargetKind, manifest: EncryptedManifest, policy: PathPolicyResult): FirstPullDetails {
  const statements = [FIRST_PULL_KEY_HOLDER_STATEMENT, FIRST_PULL_NO_BASELINE_STATEMENT, ...(kind === "name" ? [] : [FIRST_PULL_GATEWAY_STATEMENT])];
  return {
    target: kind,
    sequence: manifest.sequence,
    publishedAt: manifest.publishedAt,
    device: shown(manifest.device),
    fileCount: Object.keys(manifest.files).length,
    pathsRefused: policy.refusals.length,
    pathsSummary: policy.refusals.length === 0 ? undefined : summarizeRefusals(policy.refusals),
    statements,
  };
}

async function confirmFirstPull<R>(deps: EncryptedPullDeps<R>, options: EncryptedPullOptions, details: FirstPullDetails): Promise<void> {
  if (options.acceptFirstPull === true) return;
  if (deps.confirmFirstPull === undefined) {
    throw new PullStopError(
      "first-pull-not-confirmed",
      "this directory has no record of this vault and this run cannot ask: confirm the first pull at the prompt, or pass --accept-first-pull; nothing was written",
    );
  }
  let accepted = false;
  try {
    accepted = (await deps.confirmFirstPull(details)) === true;
  } catch {
    accepted = false; // a callback that throws is a refusal, never an approval
  }
  if (!accepted) throw new PullStopError("first-pull-declined", "the first pull was declined; nothing was written");
}

// ---- steps 3 to 6 --------------------------------------------------------------------------------------------------

interface RunContext<R> {
  readonly deps: EncryptedPullDeps<R>;
  readonly options: EncryptedPullOptions;
  readonly state: RootState | undefined;
  readonly needsMarker: boolean;
  readonly sweptParts: number;
  readonly lock: PublishLock;
  readonly verifyHeld: () => Promise<boolean>;
}

/** What steps 3 to 5 establish. */
type Authenticated = Pick<VerifiedPull, "target" | "unlock" | "manifest" | "identity" | "verdict" | "record" | "policy">;

async function resolveTarget(reader: RootReader, kind: PullTargetKind, historyName: string | undefined): Promise<ResolvedPullTarget> {
  const { rootCid, ipnsName } = await reader.resolved();
  return { kind, rootCid, ipnsName, historyName };
}

/** Steps 3 to 5: read, unlock, authenticate, policy, verdict. Writes nothing. */
async function authenticateTarget<R>(run: RunContext<R>): Promise<Authenticated> {
  const { deps, options, state } = run;
  const reader = createRootReader(deps.client, options);
  const unlock = await unlockForPull({
    fs: deps.host.fs,
    mfsRoot: options.mfsRoot,
    passphrase: options.passphrase,
    unlocked: options.unlocked,
    local: localKnowledge(state),
    node: nodeAccess(deps.client, reader),
    // Before any derivation only the slot file's vaultId is known; the sequence verdict comes after authentication.
    recordFor: recordLookup({ state: stateRecordOf(state, undefined, undefined), deviceStore: deps.deviceStore }),
    expectVaultId: options.flags.expectVaultId,
    confirmCost: deps.confirmCost,
    onProgress: deps.onProgress,
  });
  const source = await readManifestSource(deps.client, reader, options.target);
  const manifest = await authenticate(unlock, source.bytes);
  assertManifestVault(unlock, manifest.vaultId);
  if (options.target.kind === "manifest" && manifest.rootCID !== options.target.cid) {
    throw new PullStopError("history-entry-mismatch", "the history entry holds a manifest whose rootCID is not the CID it is named for; it was refused and nothing was written");
  }
  const policy = evaluatePathPolicy(Object.keys(manifest.files), { configDir: options.configDir, extraExclusions: options.extraExclusions });
  const target = await resolveTarget(reader, options.target.kind, source.historyName);
  const floor = await readFloor(deps.deviceStore, manifest.vaultId);
  const floorRecord = floor === undefined ? undefined : { vaultId: manifest.vaultId, sequence: floor.sequence, identity: floor.identity };
  const record = effectiveRecord(stateRecordOf(state, floor, target.rootCid), floorRecord);
  const identity = manifestIdentity(manifest);
  const verdict = evaluatePullVerdict({
    record,
    candidate: { vaultId: manifest.vaultId, sequence: manifest.sequence, identity },
    target: options.target.kind,
    flags: options.flags,
  });
  if (verdict.kind === "refused") throw new PullStopError(verdict.reason, verdict.message);
  return { target, unlock, manifest, identity, verdict, record, policy };
}

/** Step 6: the first-pull confirmation, then the key-slot copy, then the floor. The only writes of this part. */
async function authorize<R>(run: RunContext<R>, found: Authenticated): Promise<VerifiedPull> {
  const { deps, options } = run;
  const { manifest, unlock, verdict, record, identity } = found;
  const isFirst = verdict.kind === "first-pull";
  if (isFirst) await confirmFirstPull(deps, options, firstPullDetails(options.target.kind, manifest, found.policy));
  run.lock.assertHeld();
  // The dialog above can stay open for minutes and no heartbeat ran in between: look at the file itself before the first write.
  if (!(await run.verifyHeld())) throw new PullStopError("lock-lost", shown(lockLost().message));
  const keySlotsStored = await storeKeySlotsCopy(unlock, deps.host.fs, { manifestAuthenticated: true, confirmationGiven: true });
  const point = floorPointFor(verdict, record, { vaultId: manifest.vaultId, sequence: manifest.sequence, identity });
  if (point !== undefined) await raiseFloor(deps.deviceStore, point.vaultId, { sequence: point.sequence, identity: point.identity, at: deps.now() });
  return {
    ...found,
    verdict,
    state: run.state,
    needsMarker: run.needsMarker,
    firstPullConfirmed: isFirst,
    keySlotsStored,
    floorWritten: point !== undefined,
    sweptParts: run.sweptParts,
    assertLockHeld: () => run.lock.assertHeld(),
  };
}

// ---- steps 0 to 2 and the run -----------------------------------------------------------------------------------------

interface HeldLocks {
  readonly lock: PublishLock;
  /** Whether the lock file on disk still carries this run's token (`withTokenCheck`); `assertHeld` only knows the last heartbeat. */
  readonly verifyHeld: () => Promise<boolean>;
  readonly release: () => Promise<void>;
}

/**
 * Take the in-process lock, then `publish.lock`. A held lock is a stop with publish's own text. Returns what to release.
 * Like publish (`publish-runner.ts`), the lock file is read back right after it is taken (final review A-07): on an adapter
 * whose rename can replace an existing file, two starters that take over a stale lock both believe they hold it until the
 * first heartbeat 60 seconds later, and the loser would sweep the winner's part files and write beside it.
 */
async function takeLocks(deps: Pick<EncryptedPullDeps<unknown>, "processLock" | "lockFile" | "lockContext">): Promise<HeldLocks> {
  const releaseProcess = deps.processLock?.tryAcquire();
  if (deps.processLock !== undefined && releaseProcess === undefined) {
    throw new PullStopError("busy", "another sync operation is already running in this vault; wait for it to finish; nothing was written");
  }
  try {
    const checked = withTokenCheck(deps.lockFile);
    const lock = await acquirePublishLock(checked.file, deps.lockContext);
    if (!(await checked.verifyHeld())) {
      await lock.release();
      throw lockHeld("the lock file changed hands right after it was taken");
    }
    return {
      lock,
      verifyHeld: checked.verifyHeld,
      release: async () => {
        try {
          await lock.release();
        } finally {
          releaseProcess?.();
        }
      },
    };
  } catch (error) {
    releaseProcess?.();
    if (error instanceof PublishRefusedError && (error.code === "lock-held" || error.code === "lock-unreadable")) {
      throw new PullStopError(error.code, shown(error.message), { cause: error });
    }
    throw error;
  }
}

/** `lock-lost` out of `assertHeld` is publish's own refusal; show it as a stop. */
function lockLostStop(error: unknown): PullStopError | undefined {
  return error instanceof PublishRefusedError && error.code === "lock-lost" ? new PullStopError("lock-lost", shown(error.message), { cause: error }) : undefined;
}

/**
 * Steps 0 to 6, then the injected `stage` with the locks held. A stop is data, not an exception: `{ kind: "stopped" }`
 * with a reason and a fixed message, and nothing written in the vault. The destination guard throws its own
 * `PullGuardError`; host and node failures (network, disk) throw as they do elsewhere.
 */
export async function encryptedPull<R>(deps: EncryptedPullDeps<R>, options: EncryptedPullOptions): Promise<EncryptedPullOutcome<R>> {
  const badFlags = checkPullFlags(options.target.kind, options.flags);
  if (badFlags !== undefined) return { kind: "stopped", stop: { reason: badFlags.reason, message: badFlags.message } };
  await assertStateFolderSafe(deps.host.fs);
  const { needsMarker } = await (deps.assertDestination ?? assertPullDestination)(deps.host.fs);

  let locks: HeldLocks;
  try {
    locks = await takeLocks(deps);
  } catch (error) {
    if (error instanceof PullStopError) return { kind: "stopped", stop: toStop(error) };
    throw error;
  }
  try {
    let verified: VerifiedPull;
    try {
      // A pending key-management operation pauses the pull before anything is swept or read: the shared tree may hold its half-finished write.
      await assertNoMaintenanceJournal(deps.host.kv, options.mfsRoot);
      const sweptParts = (await sweepStaleParts(deps.host.fs)).removed;
      const state = await readRootState(deps.host.kv, options.mfsRoot);
      const run: RunContext<R> = { deps, options, state, needsMarker, sweptParts, lock: locks.lock, verifyHeld: locks.verifyHeld };
      verified = await authorize(run, await authenticateTarget(run));
    } catch (error) {
      const stop = asStop(error) ?? lockLostStop(error);
      if (stop === undefined) throw error;
      return { kind: "stopped", stop: toStop(withRestoreHint(stop, options.target)) };
    }
    return { kind: "completed", verified, result: await deps.stage(verified) };
  } finally {
    await locks.release();
  }
}
