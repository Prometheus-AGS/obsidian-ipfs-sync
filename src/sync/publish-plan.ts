import type { HostFs } from "../core/host-bridge";
import { BLOB_WRITER_EXPONENT, blobMfsPath, blobNameFor, type VaultKeys } from "../crypto";
import { planDelta, type DeltaBaseline, type PendingWrite, type SkippedFile } from "./diff";
import { diagnose, listCurrentBlobs, type DeviceGuard, type Diagnosis } from "./drift";
import type { BlobJob } from "./encrypted-transfer";
import type { EncryptedManifest, EncryptedManifestFile } from "./encrypted-manifest";
import type { NodeReadClient, RootView } from "./node-reader";
import { untrustedPathReason } from "./manifest-paths";
import type { ScannedFile } from "./scan";

/**
 * Turning the scanned vault, the baseline manifest and the node's actual `current/` into the list of things to
 * send: changed and new files (by plaintext hash, so an unchanged file is neither read for encryption nor
 * rewritten), blobs the node lost or altered (found by the diagnosis, rewritten alone), and the blobs to remove.
 */

/** The manifest to compare the vault and the node with, and the modification times that go with it. */
export interface Baseline extends DeltaBaseline<EncryptedManifestFile> {
  readonly manifest: EncryptedManifest;
}

/** A carried entry that does not go into the new manifest: this device's exclusion list matches it, or its path has a shape no honest publisher produces. */
export interface DroppedEntry {
  readonly path: string;
  readonly reason: string;
}

export interface PublishPlan {
  /** New or changed files: they become file.changed events. */
  readonly writes: readonly PendingWrite[];
  /** Files whose content is unchanged but whose blob is missing or altered on the node: rewritten, no event. */
  readonly repairs: readonly BlobJob[];
  /** Bytes the repairs would upload. */
  readonly repairBytes: number;
  /** Entries carried into the new manifest as they are: unchanged files and the carried paths below. */
  readonly kept: Readonly<Record<string, EncryptedManifestFile>>;
  /**
   * Paths this device could not restore (the state's `unmaterialized`), sorted. Their entries are in `kept` unchanged;
   * a local file at such a path is neither compared nor published; they are the new state's `unmaterialized`.
   */
  readonly carried: readonly string[];
  /** Carried entries left out of the new manifest (excluded here, or an unsafe path shape); their blobs are removed with the other removals. */
  readonly dropped: readonly DroppedEntry[];
  /** Vault paths that were in the baseline and are gone or now excluded: file.changed events. */
  readonly removedPaths: readonly string[];
  /** `current/<xx>/<name>` of blobs to delete: recorded blobs of removed files and stray blob-shaped names. */
  readonly blobRemovals: readonly string[];
  readonly mtimes: Readonly<Record<string, number>>;
  readonly hashed: number;
  readonly skipped: readonly SkippedFile[];
  /** Entries in `current/` that are not this tool's blobs, and the `heldBack` blobs; reported, left in place. */
  readonly anomalies: readonly string[];
  /** `xx/<name>` of blob-shaped files the new manifest does not name, left alone because another device may own them. */
  readonly heldBack: readonly string[];
}

export interface PlanInput {
  readonly keys: VaultKeys;
  readonly fs: Pick<HostFs, "read" | "readRange">;
  readonly client: NodeReadClient;
  readonly mfsRoot: string;
  readonly scanned: readonly ScannedFile[];
  readonly baseline: Baseline | undefined;
  readonly view: RootView;
  readonly concurrency?: number;
  /** The baseline's `unmaterialized` paths. Only the baseline's own record carries any; callers pass none for a baseline taken from the node. */
  readonly carried?: readonly string[];
  /** This device's exclusion matcher; a carried path it matches is dropped. Without it no carried path is dropped for being excluded. */
  readonly excluded?: (path: string) => boolean;
  /**
   * What is known about other publishers (task 2.6). Without it every unnamed blob is removed, as in the single-publisher
   * flow; the publisher passes it so another device's in-flight blobs survive. Concurrent publishes stay detected only at
   * a later pull.
   */
  readonly deviceGuard?: DeviceGuard;
}

/** Is the node's `current/` something other than the tree the baseline recorded? Without a baseline, any content counts. */
function driftSuspected(view: RootView, baseline: Baseline | undefined): boolean {
  if (!view.exists) return false;
  if (baseline === undefined) return view.folders.length > 0;
  return view.entries.get("current")?.cid !== baseline.manifest.rootCID;
}

/**
 * `unchanged` are the entries whose blob must exist on the node (a lost one is rewritten from the local file). `carried`
 * are named by the new manifest but never rewritten from here: this device holds no current copy to rewrite them from.
 */
async function diagnoseNode(
  input: PlanInput,
  unchanged: ReadonlyMap<string, EncryptedManifestFile>,
  carried: readonly EncryptedManifestFile[],
  writes: readonly PendingWrite[],
): Promise<Diagnosis | undefined> {
  if (!driftSuspected(input.view, input.baseline)) return undefined;
  const listing = await listCurrentBlobs(input.client, input.mfsRoot, input.view.folders, input.concurrency);
  const names = new Set([...unchanged.values(), ...carried].map((entry) => entry.blob));
  for (const write of writes) names.add(await blobNameFor(input.keys, write.path));
  return diagnose(listing, unchanged, names, input.deviceGuard);
}

/** Why a carried entry does not go into the new manifest, or undefined when it does. */
function dropReason(path: string, excluded: PlanInput["excluded"]): string | undefined {
  if (excluded?.(path) === true) return "excluded by this device's exclusion list";
  const unsafe = untrustedPathReason(path);
  return unsafe === undefined ? undefined : `unsafe path (${unsafe})`;
}

/** The carried entries that stay, and the ones that leave the manifest (exclusion wins over the carry-forward). */
function splitCarried(carried: Readonly<Record<string, EncryptedManifestFile>>, excluded: PlanInput["excluded"]) {
  const judged = Object.entries(carried).map(([path, entry]) => ({ path, entry, reason: dropReason(path, excluded) }));
  return {
    kept: judged.flatMap(({ path, entry, reason }) => (reason === undefined ? [[path, entry] as const] : [])),
    dropped: judged.flatMap(({ path, reason }) => (reason === undefined ? [] : [{ path, reason }])),
  };
}

function recordedBlobPaths(baseline: Baseline | undefined, removed: readonly string[]): readonly string[] {
  return removed.flatMap((path) => {
    const entry = baseline !== undefined && Object.hasOwn(baseline.manifest.files, path) ? baseline.manifest.files[path] : undefined;
    return entry === undefined ? [] : [blobMfsPath(entry.blob)];
  });
}

export async function buildPublishPlan(input: PlanInput): Promise<PublishPlan> {
  // Hashing reads a file whole only up to one encryption segment, so no file is ever held in memory beyond that.
  const delta = await planDelta(input.fs, input.scanned, input.baseline, { singleReadLimit: 2 ** BLOB_WRITER_EXPONENT, carried: new Set(input.carried ?? []) });
  const carried = splitCarried(delta.carried, input.excluded);
  const diagnosis = await diagnoseNode(input, new Map(Object.entries(delta.unchanged)), carried.kept.map(([, entry]) => entry), delta.writes);
  const sizes = new Map(input.scanned.map((file) => [file.path, file.size] as const));
  const unreadable = new Set(delta.skipped.map((file) => file.path));
  const lost = new Set(diagnosis?.rewrite ?? []);
  const repairs = [...lost].filter((path) => !unreadable.has(path)).map((path) => ({ path, size: sizes.get(path) ?? 0 }));
  const kept = Object.fromEntries([...Object.entries(delta.unchanged).filter(([path]) => !lost.has(path)), ...carried.kept]);
  // A file the node lost and the host cannot read now leaves the manifest; its skipped reason says so instead of letting it vanish.
  const skipped = delta.skipped.map((file) => (lost.has(file.path) ? { ...file, reason: `${file.reason}; its blob is also missing or altered on the node, so it is left out of this manifest` } : file));
  const gone = [...delta.removed, ...carried.dropped.map((entry) => entry.path)];
  const removals = new Set([...recordedBlobPaths(input.baseline, gone), ...(diagnosis?.strays ?? []).map((stray) => `current/${stray}`)]);
  return {
    writes: delta.writes,
    repairs,
    repairBytes: repairs.reduce((sum, job) => sum + job.size, 0),
    kept,
    carried: carried.kept.map(([path]) => path).sort(),
    dropped: carried.dropped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    removedPaths: delta.removed,
    blobRemovals: [...removals].sort(),
    mtimes: delta.mtimes,
    hashed: delta.hashed,
    skipped,
    anomalies: diagnosis?.anomalies ?? [],
    heldBack: diagnosis?.held ?? [],
  };
}
