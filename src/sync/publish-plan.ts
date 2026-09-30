import type { HostFs } from "../core/host-bridge";
import { BLOB_WRITER_EXPONENT, blobMfsPath, blobNameFor, type VaultKeys } from "../crypto";
import { planDelta, type DeltaBaseline, type PendingWrite, type SkippedFile } from "./diff";
import { diagnose, listCurrentBlobs, type Diagnosis } from "./drift";
import type { BlobJob } from "./encrypted-transfer";
import type { EncryptedManifest, EncryptedManifestFile } from "./encrypted-manifest";
import type { NodeReadClient, RootView } from "./node-reader";
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

export interface PublishPlan {
  /** New or changed files: they become file.changed events. */
  readonly writes: readonly PendingWrite[];
  /** Files whose content is unchanged but whose blob is missing or altered on the node: rewritten, no event. */
  readonly repairs: readonly BlobJob[];
  /** Bytes the repairs would upload. */
  readonly repairBytes: number;
  /** Entries carried into the new manifest as they are. */
  readonly kept: Readonly<Record<string, EncryptedManifestFile>>;
  /** Vault paths that were in the baseline and are gone or now excluded: file.changed events. */
  readonly removedPaths: readonly string[];
  /** `current/<xx>/<name>` of blobs to delete: recorded blobs of removed files and stray blob-shaped names. */
  readonly blobRemovals: readonly string[];
  readonly mtimes: Readonly<Record<string, number>>;
  readonly hashed: number;
  readonly skipped: readonly SkippedFile[];
  /** Entries in `current/` that are not this tool's blobs; reported, left in place. */
  readonly anomalies: readonly string[];
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
}

/** Is the node's `current/` something other than the tree the baseline recorded? Without a baseline, any content counts. */
function driftSuspected(view: RootView, baseline: Baseline | undefined): boolean {
  if (!view.exists) return false;
  if (baseline === undefined) return view.folders.length > 0;
  return view.entries.get("current")?.cid !== baseline.manifest.rootCID;
}

async function diagnoseNode(input: PlanInput, kept: ReadonlyMap<string, EncryptedManifestFile>, writes: readonly PendingWrite[]): Promise<Diagnosis | undefined> {
  if (!driftSuspected(input.view, input.baseline)) return undefined;
  const listing = await listCurrentBlobs(input.client, input.mfsRoot, input.view.folders, input.concurrency);
  const names = new Set([...kept.values()].map((entry) => entry.blob));
  for (const write of writes) names.add(await blobNameFor(input.keys, write.path));
  return diagnose(listing, kept, names);
}

function recordedBlobPaths(baseline: Baseline | undefined, removed: readonly string[]): readonly string[] {
  return removed.flatMap((path) => {
    const entry = baseline !== undefined && Object.hasOwn(baseline.manifest.files, path) ? baseline.manifest.files[path] : undefined;
    return entry === undefined ? [] : [blobMfsPath(entry.blob)];
  });
}

export async function buildPublishPlan(input: PlanInput): Promise<PublishPlan> {
  // Hashing reads a file whole only up to one encryption segment, so no file is ever held in memory beyond that.
  const delta = await planDelta(input.fs, input.scanned, input.baseline, { singleReadLimit: 2 ** BLOB_WRITER_EXPONENT });
  const diagnosis = await diagnoseNode(input, new Map(Object.entries(delta.unchanged)), delta.writes);
  const sizes = new Map(input.scanned.map((file) => [file.path, file.size] as const));
  const unreadable = new Set(delta.skipped.map((file) => file.path));
  const lost = new Set(diagnosis?.rewrite ?? []);
  const repairs = [...lost].filter((path) => !unreadable.has(path)).map((path) => ({ path, size: sizes.get(path) ?? 0 }));
  const kept = Object.fromEntries(Object.entries(delta.unchanged).filter(([path]) => !lost.has(path)));
  // A file the node lost and the host cannot read now leaves the manifest; its skipped reason says so instead of letting it vanish.
  const skipped = delta.skipped.map((file) => (lost.has(file.path) ? { ...file, reason: `${file.reason}; its blob is also missing or altered on the node, so it is left out of this manifest` } : file));
  const removals = new Set([...recordedBlobPaths(input.baseline, delta.removed), ...(diagnosis?.strays ?? []).map((stray) => `current/${stray}`)]);
  return {
    writes: delta.writes,
    repairs,
    repairBytes: repairs.reduce((sum, job) => sum + job.size, 0),
    kept,
    removedPaths: delta.removed,
    blobRemovals: [...removals].sort(),
    mtimes: delta.mtimes,
    hashed: delta.hashed,
    skipped,
    anomalies: diagnosis?.anomalies ?? [],
  };
}
