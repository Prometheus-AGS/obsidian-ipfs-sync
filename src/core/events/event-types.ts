/** Event payloads. They carry paths, hashes, CIDs and counts only: never credentials or file bytes. */

export type FileChangeKind = "added" | "modified" | "removed";

export interface FileChangedEvent {
  /** Vault-relative path with `/` separators. */
  readonly path: string;
  readonly kind: FileChangeKind;
  /** Lowercase hex; present when the content was hashed (not for removals). */
  readonly sha256?: string;
}

export interface PublishCompleteEvent {
  /** CID of the MFS root that was published to the IPNS key. */
  readonly rootCid: string;
  /** CID of the `current/` vault tree, also the manifest's `rootCID`. */
  readonly manifestCid: string;
  readonly written: number;
  readonly removed: number;
  readonly durationMs: number;
}

/** A pull finished processing, with or without failed files (added in mvp-03). */
export interface PullCompleteEvent {
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
  /** True when a mismatch of exclusion lists forced every local file to be re-hashed. */
  readonly forcedReverify: boolean;
  readonly durationMs: number;
}

/** Local text was preserved as a conflict copy and the remote version now sits at `path` (added in mvp-03). */
export interface ConflictEvent {
  readonly path: string;
  readonly conflictPath: string;
  readonly localSha256: string;
  readonly remoteSha256: string;
}

/** Every event this build knows. Later features add theirs in their own module. */
export interface SyncEventMap {
  readonly "file.changed": FileChangedEvent;
  readonly "publish.complete": PublishCompleteEvent;
  readonly "pull.complete": PullCompleteEvent;
  readonly conflict: ConflictEvent;
}
