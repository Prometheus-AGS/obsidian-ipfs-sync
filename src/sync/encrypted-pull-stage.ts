/**
 * The decrypting pull, part 2 (mvp-07a task 4.6b; design decision 6 steps 7 and 8, decisions 2, 7 and 14; specs
 * encrypted-pull and rollback-detection). WebView-safe: no Node imports. This is the `stage` that `encryptedPull`
 * (`encrypted-pull.ts`, steps 1 to 6) calls with the locks held; it is split from that file so neither passes the size limit.
 *
 * What runs, in order:
 *   7a. The plan (`planEncryptedPull`): the path policy first, then the three-way rule on plaintext sha256, per manifest path.
 *       The size-and-mtime shortcut is bypassed (`forceVerify`) when this device's exclusion list differs from the manifest's.
 *   7b. The total bytes to fetch are computed from the manifest. Above the ceiling the large-pull port (or `acceptLarge`)
 *       must say yes; otherwise nothing is fetched and every file to fetch is `unfetched`.
 *   7c. The `pulled-fixture` marker is written when the destination was empty, before the first vault file, so a pull that
 *       is interrupted can be resumed (a populated directory without a marker would be refused).
 *   7d. Blobs are listed from the AUTHENTICATED tree `/ipfs/<manifest.rootCID>/` (never the root's mutable `current/`), the
 *       smallest blob's header request is sent alone through the optional probe, and the files are fetched, verified and
 *       renamed by a bounded pool (`encrypted-pull-fetch.ts`). A failure of one file never stops the others.
 *   8.  The outcomes are merged into the baseline (`settlePull`), a publish journal at or below the pulled sequence is moved
 *       aside, and the state is written last. A state therefore exists only for a pull that ran to its end; an interrupted
 *       pull leaves whole files (each one verified before its rename) and the old state, and the next pull re-checks them.
 *
 * The state records what the design says (decision 6 step 8): `rootCid` is the immutable root the target resolved to, `key`
 * and `mfsRoot` are the configured ones, `previousIdentity` is null, `highest*` come from the verdict (the record is never
 * lowered), `devicesSeen` gains the manifest's device, and `unmaterialized`/`complete` come from the settlement. With
 * `rootCid` equal to the node's MFS root, the next publish does not count the state as unpublished work.
 *
 * This stage handles every allowed verdict: `first-pull`, `same`, `newer`, `restore` (4.6c) and `fork-resolution` (4.7).
 *
 * A fork resolution (design decision 9, `fork-resolution.ts`) runs steps 7a to 7d with a different base: `B` is the common
 * ancestor from the node's history (or absent), never the state's own baseline, so a file only this device edited stays and a file
 * both edited gets a conflict copy. Step 8 is the ordinary state (the node manifest's baseline, `previousIdentity` null, `highest*`
 * at the same sequence with the node manifest's identity), and the floor is rewritten with that identity after the fetch and
 * before the state. The publish journal is not touched.
 *
 * A restore (design decision 8) runs steps 7a to 7d unchanged: the explicit older manifest is the target, the existing baseline
 * is `B`, and the files differ from the baseline afterwards, so the next publish sees them as edits and publishes them as a new,
 * higher sequence. Only step 8 differs. The state is touched only for `restoredFrom` (the lowest sequence a restore accepted),
 * `devicesSeen`, the dropped `mtimes` of the paths the restore wrote and the removal of those paths (and of equal local files)
 * from `unmaterialized`, so the next publish reads them; the manifest, sequence, identities, `highest*`,
 * `complete` and `rootCid` stay, so a file that fails is reported (`settlement.needsAttention`, the CLI's
 * exit 1) without making the state incomplete. A directory with no state (the floor was the record) gets a state whose
 * baseline is the restored manifest. The publish journal is not touched: a restore adopts nothing.
 *
 * `pull.complete` and `conflict` events are emitted last, after the state is written, when the host passes a bus.
 *
 * Messages are fixed text. Nothing here carries a passphrase, a key or file bytes; paths appear only in the result lists.
 */
import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import { BLOB_READER_MAX_EXPONENT, BLOB_WRITER_EXPONENT } from "../crypto";
import { probeSizeClasses, type GatewayBlobLocation } from "./blob-source";
import type { DeviceStore } from "./device-store";
import { encryptedPull, type AllowedVerdict, type EncryptedPullDeps, type EncryptedPullOptions, type EncryptedPullOutcome, type VerifiedPull } from "./encrypted-pull";
import {
  blobLocation,
  createSpaceGuard,
  fetchFile,
  listBlobLengths,
  type BlobSources,
  type FetchTreeClient,
  type FreeBytes,
  type PullFetchFs,
} from "./encrypted-pull-fetch";
import { isWritable, planEncryptedPull, settlePull, type EncryptedPullPlan, type FetchResult, type PlannedPath, type PolicySkip, type PullBase, type PullSettlement, type WritablePath } from "./encrypted-pull-plan";
import { localDateStamp } from "./conflict-name";
import { emitPullEvents } from "./encrypted-pull-events";
import { excludesHash } from "./exclusions";
import { raiseForkFloor, resolveForkBase, type ForkClient, type ForkResolutionReport } from "./fork-resolution";
import { readJournal, setAsideJournal } from "./journal";
import type { PathPolicyOptions } from "./path-policy";
import { pullConcurrency, exceedsPullCeiling, smallestBlob, totalBytesToFetch, PULL_CONFIRM_ABOVE_DEFAULT } from "./pull-budget";
import { writeFixtureMarker } from "./pull-guard";
import { recordAfterVerdict } from "./pull-sequence";
import { runPool } from "./pool";
import { addDeviceSeen, buildRootState, writeRootState, type RootState } from "./root-state";

/** What a host shows before a pull larger than the ceiling. All of it is safe to print. */
export interface LargePullDetails {
  /** Plaintext bytes of the files this pull would fetch. */
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly ceilingBytes: number;
}

/** The large-pull decision a result reports; absent when the pull was at or below the ceiling. */
export interface LargePullOutcome extends LargePullDetails {
  readonly confirmed: boolean;
}

export interface PullStageExtras {
  /** Where blob bytes come from: `gatewayBlobSource` for the CLI, `createRangedBlobSources(client)` for the plugin. */
  readonly sources: BlobSources;
  /** Interactive hosts only. Absent: a pull above the ceiling needs `acceptLarge`. A callback that throws is a refusal. */
  readonly confirmLargePull?: (details: LargePullDetails) => Promise<boolean>;
  /** The CLI passes one built on Node `statfs`; the plugin passes none and performs no free-space check. */
  readonly freeBytes?: FreeBytes;
  /** Unique part-file and copy names. Defaults to a random UUID. */
  readonly newId?: () => string;
  /** Where `pull.complete` and `conflict` go. Absent: no event is emitted. */
  readonly bus?: Pick<SyncEventBus, "emit">;
}

export interface PullStageOptions {
  /** Plaintext bytes above which the pull asks. Default `PULL_CONFIRM_ABOVE_DEFAULT` (512 MiB). */
  readonly confirmAboveBytes?: number;
  /** `--accept-large`: the non-interactive yes. */
  readonly acceptLarge?: boolean;
  /** Files in flight. Default from the largest file: `pullConcurrency(23)` (6), or `pullConcurrency(24)` (4) when a file is above 8 MiB. */
  readonly concurrency?: number;
}

/** The deps the stage needs; `encryptedPull`'s own deps carry the same client, host and clock. */
export interface PullStageDeps extends PullStageExtras {
  readonly client: FetchTreeClient & ForkClient;
  readonly host: { readonly fs: PullFetchFs; readonly kv: HostBridge["kv"] };
  /** Holds the sequence floor; a fork resolution rewrites it. */
  readonly deviceStore: DeviceStore;
  readonly now: () => number;
}

export type PullStageIdentity = Pick<EncryptedPullOptions, "mfsRoot" | "keyName" | "configDir" | "extraExclusions">;

export interface PullStageResult {
  /** The verdict this pull ran under. */
  readonly verdict: AllowedVerdict["kind"];
  /** The sequence of the manifest the pull worked from (for a restore, the older one). */
  readonly sequence: number;
  /**
   * The merged outcome: the new baseline, `unmaterialized`, `complete`, `mtimes` and every list the host reports. `needsAttention`
   * is the CLI's exit 1. For a restore this describes what the restore did, not the state: `settlement.complete` is false when a
   * file failed, while `state.complete` is what it was before.
   */
  readonly settlement: PullSettlement;
  /** The state as written. */
  readonly state: RootState;
  /** Local files that had to be hashed. */
  readonly hashedLocalFiles: number;
  /** Plaintext bytes the plan asked for (writable paths only). */
  readonly bytesToFetch: number;
  /** One warning for the host to print when this device's exclusion list differs from the manifest's; every local file was then verified by content. */
  readonly exclusionWarning: string | undefined;
  readonly large: LargePullOutcome | undefined;
  /** A publish journal that lost to the pulled manifest, moved aside. */
  readonly journalSetAside: { readonly name: string; readonly sequence: number } | undefined;
  readonly markerWritten: boolean;
  /** For a fork resolution: whether the common ancestor was the base, and why not when it was not (fixed text to show). Absent for every other verdict. */
  readonly forkResolution: ForkResolutionReport | undefined;
}

const LARGE_DECLINED_REASON = "the pull is larger than the confirmation ceiling and was not confirmed, so this file was not fetched";

// ---- helpers ---------------------------------------------------------------------------------------------------------

/** The segment exponent the memory budget has to assume: a file above 8 MiB may carry segments up to the reader's maximum. */
function concurrencyFor(entries: readonly { readonly size: number }[]): number {
  const bigSegments = entries.some((entry) => entry.size > 2 ** BLOB_WRITER_EXPONENT);
  return pullConcurrency(bigSegments ? BLOB_READER_MAX_EXPONENT : BLOB_WRITER_EXPONENT);
}

function baseOf(state: RootState | undefined): PullBase | undefined {
  return state === undefined ? undefined : { files: state.manifest.files, mtimes: state.mtimes };
}

async function exclusionDifference(manifestHash: string, extra: readonly string[] | undefined): Promise<string | undefined> {
  const local = await excludesHash(extra);
  if (local === manifestHash) return undefined;
  return `the exclusion lists differ: this device ${local}, manifest ${manifestHash}. Every local file was re-verified by content; nothing was deleted.`;
}

async function askLarge(stage: PullStageDeps, options: PullStageOptions, details: LargePullDetails): Promise<boolean> {
  if (options.acceptLarge === true) return true;
  if (stage.confirmLargePull === undefined) return false;
  try {
    return (await stage.confirmLargePull(details)) === true;
  } catch {
    return false; // a callback that throws is a refusal, never an approval
  }
}

/** Every writable path becomes `unfetched`: the pull was not confirmed, nothing is requested. */
function declinedResults(writable: readonly WritablePath[]): Map<string, FetchResult> {
  return new Map(writable.map((decision) => [decision.path, { ok: false, outcome: "unfetched", reason: LARGE_DECLINED_REASON } satisfies FetchResult]));
}

/** The plan with every write-time skip in place of its writable decision, so the settlement treats the path as skipped. */
function withSkips(plan: EncryptedPullPlan, skips: ReadonlyMap<string, PolicySkip>): EncryptedPullPlan {
  if (skips.size === 0) return plan;
  const paths: PlannedPath[] = plan.paths.map((decision) => {
    const skip = skips.get(decision.path);
    return skip === undefined ? decision : { kind: "policy-skipped", path: decision.path, entry: decision.entry, skip };
  });
  return { ...plan, paths };
}

interface Fetched {
  readonly results: Map<string, FetchResult>;
  readonly skips: Map<string, PolicySkip>;
}

async function fetchAll(
  stage: PullStageDeps,
  options: PullStageOptions,
  verified: VerifiedPull,
  policy: PathPolicyOptions,
  plan: EncryptedPullPlan,
  writable: readonly WritablePath[],
  base: PullBase | undefined,
): Promise<Fetched> {
  const results = new Map<string, FetchResult>();
  const skips = new Map<string, PolicySkip>();
  if (writable.length === 0) return { results, skips };
  const rootCid = verified.manifest.rootCID;
  const lengths = await listBlobLengths(stage.client, rootCid, writable.map((decision) => decision.entry.blob));
  const located = writable.flatMap((decision): GatewayBlobLocation[] => {
    const location = blobLocation(rootCid, decision.entry.blob, lengths);
    return location === undefined ? [] : [location];
  });
  const { probe, state } = stage.sources;
  if (probe !== undefined && state !== undefined) await probeSizeClasses({ probe: (blob) => probe.call(stage.sources, blob), state: () => state.call(stage.sources) }, located);
  else {
    const smallest = smallestBlob(located);
    if (smallest !== undefined && probe !== undefined) await probe.call(stage.sources, smallest);
  }

  const baseFiles = base?.files;
  const context = {
    fs: stage.host.fs,
    keys: verified.unlock.keys,
    sources: stage.sources,
    rootCid,
    lengths,
    policy,
    reserved: plan.reservations,
    dateStamp: localDateStamp(stage.now()),
    newId: stage.newId ?? ((): string => crypto.randomUUID()),
    baseSha256: (path: string): string | undefined => (baseFiles !== undefined && Object.hasOwn(baseFiles, path) ? baseFiles[path]?.sha256 : undefined),
    ...(stage.freeBytes === undefined ? {} : { space: createSpaceGuard(stage.freeBytes) }),
    assertLockHeld: verified.assertLockHeld,
  };
  const pool = await runPool(
    writable,
    async (decision) => {
      const outcome = await fetchFile(context, decision);
      if (outcome.kind === "skipped") skips.set(decision.path, outcome.skip);
      else results.set(decision.path, outcome.result);
    },
    options.concurrency ?? concurrencyFor(writable.map((decision) => decision.entry)),
  );
  // A file's own problem is a result. What the pool reports is an error that is not about a file (a lost lock, no WebCrypto):
  // the pull stops, no state is written, and the files already renamed are whole.
  const [failure] = pool.failures;
  if (failure !== undefined) throw failure.error;
  return { results, skips };
}

// ---- step 8 ----------------------------------------------------------------------------------------------------------

function nextState(verified: VerifiedPull, identity: PullStageIdentity, settlement: PullSettlement): RootState {
  const { manifest } = verified;
  const candidate = { vaultId: manifest.vaultId, sequence: manifest.sequence, identity: verified.identity };
  const point = recordAfterVerdict(verified.record, candidate, verified.verdict) ?? candidate;
  return buildRootState({
    mfsRoot: identity.mfsRoot,
    key: identity.keyName,
    rootCid: verified.target.rootCid,
    vaultId: manifest.vaultId,
    keyslotsSha256: verified.unlock.keySlotsSha256,
    sequence: manifest.sequence,
    manifest: settlement.manifest,
    manifestIdentity: verified.identity,
    previousIdentity: null,
    highestSequence: point.sequence,
    highestIdentity: point.identity,
    complete: settlement.complete,
    unmaterialized: settlement.unmaterialized,
    devicesSeen: addDeviceSeen(verified.state?.devicesSeen ?? [], manifest.device),
    mtimes: settlement.mtimes,
  });
}

/**
 * The state after a restore (design decision 8): the existing state with `restoredFrom` lowered to this restore's sequence,
 * the manifest's device added, and the `mtimes` of the paths this restore wrote dropped (the next publish hashes them). A
 * directory with no state gets the state a pull would write, with `restoredFrom`.
 */
function restoredState(verified: VerifiedPull, identity: PullStageIdentity, settlement: PullSettlement): RootState {
  const { manifest, state } = verified;
  if (state === undefined) return { ...nextState(verified, identity, settlement), restoredFrom: manifest.sequence };
  const written = new Set(settlement.fetched);
  // A path this restore wrote (or found already equal) is no longer a path this device lacks: left in `unmaterialized` it would
  // be carried by the next publish at the node's entry and its restored content never read (final review A-06). The paths that
  // failed stay. Only paths the settlement names are touched; a carried path outside the restored manifest is kept.
  const restored = new Set(settlement.restored);
  return {
    ...state,
    restoredFrom: Math.min(state.restoredFrom ?? manifest.sequence, manifest.sequence),
    unmaterialized: state.unmaterialized.filter((path) => !restored.has(path)),
    devicesSeen: addDeviceSeen(state.devicesSeen, manifest.device),
    mtimes: Object.fromEntries(Object.entries(state.mtimes).filter(([path]) => !written.has(path))),
  };
}

/**
 * A publish journal for this root and vault whose sequence is not above the pulled manifest's lost to it: move it aside, so
 * publish does not try to resume it. A journal above the pulled sequence is left for publish; a damaged one has no sequence
 * and is left to the publisher's own handling.
 */
async function settleJournal(kv: HostBridge["kv"], identity: PullStageIdentity, verified: VerifiedPull): Promise<PullStageResult["journalSetAside"]> {
  const read = await readJournal(kv, identity.mfsRoot);
  if (read.kind !== "ok") return undefined;
  const { journal } = read;
  if (journal.vaultId !== verified.manifest.vaultId || journal.sequence > verified.manifest.sequence) return undefined;
  const name = await setAsideJournal(kv, identity.mfsRoot, journal.sequence);
  return name === undefined ? undefined : { name, sequence: journal.sequence };
}

// ---- the stage -------------------------------------------------------------------------------------------------------

/**
 * Steps 7 and 8 as an `encryptedPull` stage. `identity` is the same `mfsRoot`, `keyName`, `configDir` and `extraExclusions`
 * the pull was started with.
 */
export function createPullStage(stage: PullStageDeps, identity: PullStageIdentity, options: PullStageOptions = {}): (verified: VerifiedPull) => Promise<PullStageResult> {
  return async (verified) => {
    const verdict = verified.verdict.kind;
    const startedAt = stage.now();
    const policy: PathPolicyOptions = { configDir: identity.configDir, extraExclusions: identity.extraExclusions };
    const { fs, kv } = stage.host;
    const { manifest, state } = verified;

    const forking = verdict === "fork-resolution";
    // A fork's base is the common ancestor (or none), never this device's own losing baseline.
    const fork = forking
      ? await resolveForkBase({ client: stage.client, keys: verified.unlock.keys, node: manifest, rootCid: verified.target.rootCid, previousIdentity: state?.previousIdentity ?? null })
      : undefined;
    const base = fork === undefined ? baseOf(state) : fork.base;

    const exclusionWarning = await exclusionDifference(manifest.excludesHash, identity.extraExclusions);
    const plan = await planEncryptedPull({
      fs,
      manifest,
      base,
      unmaterialized: state?.unmaterialized ?? [],
      forceVerify: exclusionWarning !== undefined,
      policy,
    });
    const writable = plan.paths.filter(isWritable);
    const bytesToFetch = totalBytesToFetch(writable.map((decision) => decision.entry));
    const ceilingBytes = options.confirmAboveBytes ?? PULL_CONFIRM_ABOVE_DEFAULT;
    let large: LargePullOutcome | undefined;
    if (writable.length > 0 && exceedsPullCeiling(bytesToFetch, ceilingBytes)) {
      const details = { totalBytes: bytesToFetch, fileCount: writable.length, ceilingBytes };
      large = { ...details, confirmed: await askLarge(stage, options, details) };
    }

    verified.assertLockHeld();
    if (verified.needsMarker) await writeFixtureMarker(fs);

    const fetched = large?.confirmed === false ? { results: declinedResults(writable), skips: new Map<string, PolicySkip>() } : await fetchAll(stage, options, verified, policy, plan, writable, base);
    const settlement = settlePull({ manifest, plan: withSkips(plan, fetched.skips), results: fetched.results });

    verified.assertLockHeld();
    const restoring = verdict === "restore";
    // A restore adopts nothing and a fork resolution does not touch the publish journal.
    const journalSetAside = restoring || forking ? undefined : await settleJournal(kv, identity, verified);
    // Floor first, then state: a crash between them leaves the floor with the node's identity and the state with ours, which is a fork again and resolves again.
    if (forking) await raiseForkFloor(stage.deviceStore, manifest, verified.identity, stage.now());
    const written = restoring ? restoredState(verified, identity, settlement) : nextState(verified, identity, settlement);
    await writeRootState(kv, written);
    if (stage.bus !== undefined) {
      await emitPullEvents({
        bus: stage.bus,
        fs,
        rootCid: verified.target.rootCid,
        manifestCid: manifest.rootCID,
        sequence: manifest.sequence,
        plan,
        settlement,
        complete: written.complete,
        forcedReverify: exclusionWarning !== undefined,
        durationMs: stage.now() - startedAt,
      });
    }
    return {
      verdict,
      sequence: manifest.sequence,
      settlement,
      state: written,
      hashedLocalFiles: plan.hashed,
      bytesToFetch,
      exclusionWarning,
      large,
      journalSetAside,
      markerWritten: verified.needsMarker,
      forkResolution: fork?.report,
    };
  };
}

export type PullVaultDeps = Omit<EncryptedPullDeps<PullStageResult>, "stage"> & PullStageExtras;
export type PullVaultOptions = EncryptedPullOptions & PullStageOptions;

/**
 * The whole decrypting pull: steps 1 to 6 (`encryptedPull`) and the stage above. A stop is data (`{ kind: "stopped" }`,
 * nothing written in the vault); a completed pull carries the `PullStageResult`. This is what the CLI and the plugin call.
 */
export function pullEncryptedVault(deps: PullVaultDeps, options: PullVaultOptions): Promise<EncryptedPullOutcome<PullStageResult>> {
  const { sources, confirmLargePull, freeBytes, newId, bus, ...pullDeps } = deps;
  const extras: PullStageExtras = {
    sources,
    ...(confirmLargePull === undefined ? {} : { confirmLargePull }),
    ...(freeBytes === undefined ? {} : { freeBytes }),
    ...(newId === undefined ? {} : { newId }),
    ...(bus === undefined ? {} : { bus }),
  };
  const stage = createPullStage({ ...extras, client: pullDeps.client, host: pullDeps.host, deviceStore: pullDeps.deviceStore, now: pullDeps.now }, options, options);
  return encryptedPull<PullStageResult>({ ...pullDeps, stage }, options);
}
