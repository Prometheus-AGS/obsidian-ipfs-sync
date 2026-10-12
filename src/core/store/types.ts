/**
 * Device-local sync history records (mvp-08). These types are the persisted
 * schema of the operation log; adapters store and return them as-is.
 *
 * The no-plaintext rule is structural: no type in this module has a field
 * that can hold a vault path, a vault directory or a file name. Records
 * carry CIDs, hashes, counts and timings only. The mapping from events
 * (`map-event.ts`) drops `ConflictEvent.path` / `conflictPath` by
 * construction; nothing here could receive them.
 */

export type OperationKind = "publish" | "pull" | "conflict";

/** Fields every history record shares. */
interface HistoryRecordBase {
  readonly kind: OperationKind;
  /** Epoch milliseconds when the operation finished (for a conflict row: when it was recorded). */
  readonly occurredAtMs: number;
}

/** Derived from `PublishCompleteEvent`; every field of the event is kept. */
export interface PublishRecord extends HistoryRecordBase {
  readonly kind: "publish";
  /** CID of the MFS root that was published to the IPNS key. */
  readonly rootCid: string;
  /** CID of the `current/` vault tree, also the manifest's `rootCID`. */
  readonly manifestCid: string;
  readonly written: number;
  readonly removed: number;
  readonly durationMs: number;
}

/**
 * Derived from `PullCompleteEvent`. `forcedReverify` from the event is not
 * persisted (design decision 3 lists the counters to keep). The optional
 * mvp-07a counters stay optional: the plaintext pull path never sets them.
 */
export interface PullRecord extends HistoryRecordBase {
  readonly kind: "pull";
  /** CID of the published root the IPNS name resolved to. */
  readonly rootCid: string;
  /** CID of the tree the selected manifest describes (its `rootCID`). */
  readonly manifestCid: string;
  /** Files written (new, replaced, and replaced after a conflict). */
  readonly fetched: number;
  readonly unchanged: number;
  /** Files that had a conflict copy made; each is also counted in `fetched`. */
  readonly conflicted: number;
  /** Files that could not be written, including refused paths. */
  readonly failed: number;
  readonly remoteDeleted: number;
  readonly locallyModified: number;
  readonly durationMs: number;
  /** Sequence of the authenticated manifest the pull settled on. */
  readonly sequence?: number;
  /** False when a non-restore pull left a path `integrity-failed` or `unfetched`. */
  readonly complete?: boolean;
  /** Paths whose blob failed a check (tampered, replayed, wrong name, wrong size or hash). */
  readonly integrityFailed?: number;
  /** Paths this host could not take (ceiling declined, Range refused, could not write, not reached). */
  readonly unfetched?: number;
  /** Paths skipped by the path policy, `expected` and `unsafe` together. */
  readonly policySkipped?: number;
  /** Paths the previous pull left unmaterialized that this pull fetched or found equal. */
  readonly restored?: number;
}

/**
 * One conflict copy made during a publish or pull. The record keeps the
 * sha256 pair and the parent operation's root CID only; the source event's
 * `path` and `conflictPath` are never read into it.
 */
export interface ConflictRecord extends HistoryRecordBase {
  readonly kind: "conflict";
  /** Root CID of the publish or pull operation this conflict belongs to. */
  readonly rootCid: string;
  /** Lowercase hex sha256 of the local text that was preserved. */
  readonly localSha256: string;
  /** Lowercase hex sha256 of the remote version that replaced it. */
  readonly remoteSha256: string;
}

export type HistoryRecord = PublishRecord | PullRecord | ConflictRecord;

/** The last manifest this device published or pulled, updated on `publish.complete`. */
export interface LastManifestPointer {
  /** CID of the tree the manifest describes (its `rootCID`). */
  readonly manifestCid: string;
  /** CID of the published root the IPNS name resolved to. */
  readonly rootCid: string;
  /** Epoch milliseconds of the operation that set the pointer. */
  readonly updatedAtMs: number;
}
