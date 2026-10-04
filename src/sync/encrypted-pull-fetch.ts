/**
 * Fetch and commit of one file in the decrypting pull (mvp-07a task 4.6b; design decision 6 step 7, decision 14; specs
 * encrypted-pull "Fetch and verify every file", path-hardening "Containment on the file system"). WebView-safe: no Node imports.
 *
 * Where the bytes come from. Blobs are listed and read from `/ipfs/<manifest.rootCID>/<xx>/<name>`, the immutable tree the
 * AUTHENTICATED manifest names. They are never read from the resolved root's `current/`: that is the node's mutable tree, and
 * whoever can write to the node can change it after the manifest was signed. A blob that is not in the authenticated tree is
 * a fetch error for that file (the other files go on); the node cannot make this pull take a byte from anywhere else.
 *
 * What one file goes through, in this order (nothing reaches a destination path before the last step):
 *   1. a free-space check, only where the host provided a `freeBytes` port;
 *   2. `fetchBlobToTemp`: decrypt and verify into `.ipfs-sync/tmp/<id>.part` (every segment authenticated, identifier, size and
 *      sha256 equal to the manifest entry); any failure removes the part file;
 *   3. the write-time path check (`refusePath`, the same policy as the plan) and the symbolic-link prefix walk;
 *   4. a conflict copy of the local file where the pull would otherwise replace an edit (made first; when it cannot be written
 *      the replace is aborted and the local file stays as it was);
 *   5. the rename onto the destination, then a `stat` for the modification time the next pull trusts.
 *
 * Classes: a ranged-source refusal (the host cannot take the file), a failed write and a missing free space are `unfetched`;
 * every other fetch or verification failure is `integrity-failed`; a `HostPathError` (the host refused the path as outside
 * the vault) is an `unsafe` skip, not a failure. An error that belongs to the environment (no WebCrypto, a lost lock) is
 * rethrown, never blamed on the file.
 *
 * Messages are fixed text; none carries a path, node text, a key or a passphrase.
 */
import type { HostFs } from "../core/host-bridge";
import { blobTreePath, type VaultKeys } from "../crypto";
import { KuboError, type KuboClient } from "../kubo";
import { BlobFetchError, fetchBlobToTemp } from "./blob-fetch";
import { rangedRefusalOf, type BlobSource, type GatewayBlobLocation } from "./blob-source";
import type { FetchResult, PolicySkip, WritablePath } from "./encrypted-pull-plan";
import { hashFile } from "./hash";
import { FileChangedDuringReadError, HostPathError, HostReadCapError } from "./host-errors";
import { refusePath, type PathPolicyOptions } from "./path-policy";
import { tryPreserveLocalCopy, type ConflictReservations } from "./pull-conflict";
import { findSymlink } from "./symlink-guard";
import { discardTemp } from "./temp-files";

/** Where blob bytes come from. The ranged plugin source (`createRangedBlobSources`) fits this; the CLI wraps `gatewayBlobSource`. */
export interface BlobSources {
  source(location: GatewayBlobLocation): BlobSource;
  /** Plugin only: send the header request of a blob alone, before any other ranged request (design decision 14). */
  probe?(location: GatewayBlobLocation): Promise<unknown>;
  /** Plugin only: what the probes showed. With it the pull probes every size class and stops at the first Range-ignoring answer. */
  state?(): "unprobed" | "honoured" | "ignored";
}

export type FetchTreeClient = Pick<KuboClient, "ipfsLs">;

export type PullFetchFs = Pick<HostFs, "stat" | "lstat" | "read" | "readRange" | "write" | "append" | "rename" | "remove">;

// ---- the authenticated tree ----------------------------------------------------------------------------------------

/**
 * The length of each wanted blob as the AUTHENTICATED tree lists it, by blob name. One listing per two-character prefix
 * folder, `/ipfs/<rootCid>/<xx>`. The length is the node's claim and is not trusted: the fetch core re-checks it against
 * `22 + 28 n + the manifest's size`. A prefix that cannot be listed, a name that is listed twice or is not a file is absent
 * from the result, so the file fails as a fetch error; a listing never reads another tree.
 */
export async function listBlobLengths(client: FetchTreeClient, rootCid: string, blobNames: Iterable<string>): Promise<ReadonlyMap<string, number>> {
  const prefixes = new Set<string>();
  for (const name of blobNames) {
    const prefix = prefixOf(name);
    if (prefix !== undefined) prefixes.add(prefix);
  }
  const lengths = new Map<string, number>();
  for (const prefix of [...prefixes].sort()) {
    try {
      const listed = await client.ipfsLs(`/ipfs/${rootCid}/${prefix}`);
      const seen = new Set<string>();
      const twice = new Set<string>();
      for (const entry of listed) {
        if (seen.has(entry.name)) twice.add(entry.name);
        seen.add(entry.name);
      }
      for (const entry of listed) {
        if (entry.type === "file" && !twice.has(entry.name)) lengths.set(entry.name, entry.size);
      }
    } catch (error) {
      // A prefix folder the node cannot list is a fetch error for the files in it; an error of this program is not.
      if (!(error instanceof KuboError)) throw error;
    }
  }
  return lengths;
}

function prefixOf(blobName: string): string | undefined {
  try {
    return blobTreePath(blobName).split("/")[0];
  } catch {
    return undefined;
  }
}

/** The gateway location of a blob below the authenticated root, or `undefined` when the tree does not list it. */
export function blobLocation(rootCid: string, blobName: string, lengths: ReadonlyMap<string, number>): GatewayBlobLocation | undefined {
  const totalLength = lengths.get(blobName);
  if (totalLength === undefined) return undefined;
  try {
    return { cid: rootCid, path: blobTreePath(blobName), totalLength };
  } catch {
    return undefined;
  }
}

// ---- free space ------------------------------------------------------------------------------------------------------

/** Free bytes of the volume the vault is on, or `undefined` when unknown. The CLI builds it on Node `statfs`; the plugin provides none. */
export type FreeBytes = () => Promise<number | undefined>;

export interface SpaceGuard {
  /** False when the volume does not have `size` free bytes beyond what files already in flight reserved. */
  reserve(size: number): Promise<boolean>;
  release(size: number): void;
}

/** Counts the bytes of files in flight, so concurrent files cannot each claim the same free space. */
export function createSpaceGuard(freeBytes: FreeBytes): SpaceGuard {
  let reserved = 0;
  return {
    async reserve(size) {
      const free = await freeBytes();
      if (free !== undefined && free - reserved < size) return false;
      reserved += size;
      return true;
    },
    release(size) {
      reserved -= size;
    },
  };
}

// ---- one file --------------------------------------------------------------------------------------------------------

export type FileOutcome =
  | { readonly kind: "result"; readonly result: FetchResult }
  /** The path may not be written on this device. It is not a failure of the file. */
  | { readonly kind: "skipped"; readonly skip: PolicySkip };

export interface FileFetchContext {
  readonly fs: PullFetchFs;
  readonly keys: VaultKeys;
  readonly sources: BlobSources;
  /** The authenticated manifest's `rootCID`. */
  readonly rootCid: string;
  /** Blob lengths from the authenticated tree (`listBlobLengths`). */
  readonly lengths: ReadonlyMap<string, number>;
  readonly policy: PathPolicyOptions;
  readonly reserved: ConflictReservations;
  /** `YYYY-MM-DD`, the pulling machine's local date, for conflict copy names. */
  readonly dateStamp: string;
  readonly newId: () => string;
  /** The baseline's sha256 of a path (the state's entry), for the replace re-check; `undefined` where there is none. */
  readonly baseSha256: (path: string) => string | undefined;
  readonly space?: SpaceGuard;
  /** Throws `lock-lost` when `publish.lock` is no longer this pull's. Called before every rename. */
  readonly assertLockHeld: () => void;
}

const ABSENT_REASON = "the blob could not be read from the node: the tree the manifest names does not list it";
const NO_SPACE_REASON = "not enough free disk space for this file";
const COULD_NOT_WRITE_REASON = "could not write";
const OUTSIDE_VAULT_REASON = "the host refused this path because it resolves outside the vault";
const SYMLINK_REASON = "a symbolic link lies on the way to this path on this device";

const unfetched = (reason: string): FileOutcome => ({ kind: "result", result: { ok: false, outcome: "unfetched", reason } });
const failedWith = (outcome: "integrity-failed" | "unfetched", reason: string): FileOutcome => ({ kind: "result", result: { ok: false, outcome, reason } });

/** A local obstacle on this device: a platform skip, so the node's entry is carried and the next publish does not drop the path. */
function obstacleSkip(path: string, reason: string): FileOutcome {
  return { kind: "skipped", skip: { path, severity: "unsafe", class: "platform", code: "symlink", reason } };
}

/** The `HostPathError` behind an error, if there is one (the fetch core wraps a failed temp write). */
function hostPathErrorOf(error: unknown): HostPathError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current instanceof HostPathError) return current;
    current = current.cause;
  }
  return undefined;
}

type Staged = { readonly kind: "staged"; readonly temp: string } | { readonly kind: "done"; readonly outcome: FileOutcome };

async function stage(ctx: FileFetchContext, decision: WritablePath, location: GatewayBlobLocation): Promise<Staged> {
  const { entry, path } = decision;
  try {
    const staged = await fetchBlobToTemp(
      { fs: ctx.fs, newId: ctx.newId },
      { keys: ctx.keys, nodeName: entry.blob, entry: { fileId: entry.fileId, sha256: entry.sha256, size: entry.size }, source: ctx.sources.source(location) },
    );
    return { kind: "staged", temp: staged.temp };
  } catch (error) {
    const refusal = rangedRefusalOf(error);
    if (refusal !== undefined) return { kind: "done", outcome: unfetched(refusal.message) };
    if (hostPathErrorOf(error) !== undefined) return { kind: "done", outcome: obstacleSkip(path, OUTSIDE_VAULT_REASON) };
    if (error instanceof BlobFetchError) return { kind: "done", outcome: failedWith(error.outcome, error.message) };
    throw error;
  }
}

/**
 * Whether the local file at `path` must be copied aside before the destination is replaced: a conflict always, a replace only
 * when the file no longer equals the baseline (the user edited it while the pull was fetching). A file that cannot be
 * compared counts as edited.
 */
async function needsCopy(ctx: FileFetchContext, decision: WritablePath): Promise<boolean> {
  const info = await ctx.fs.stat(decision.path);
  if (info?.kind !== "file") return false;
  if (decision.kind === "conflict") return true;
  const base = ctx.baseSha256(decision.path);
  if (base === undefined) return true;
  try {
    return (await hashFile(ctx.fs, decision.path, info.size)) !== base;
  } catch (error) {
    if (error instanceof HostReadCapError || error instanceof FileChangedDuringReadError) return true;
    throw error;
  }
}

async function commit(ctx: FileFetchContext, decision: WritablePath, temp: string): Promise<FileOutcome> {
  const { path } = decision;
  ctx.assertLockHeld();
  const refusal = refusePath(path, ctx.policy);
  if (refusal !== undefined) return { kind: "skipped", skip: refusal };
  if ((await findSymlink(ctx.fs, path)) !== undefined) return obstacleSkip(path, SYMLINK_REASON);
  let conflictPath: string | undefined;
  if (await needsCopy(ctx, decision)) {
    const preserved = await tryPreserveLocalCopy({ fs: ctx.fs, newId: ctx.newId, dateStamp: ctx.dateStamp, reserved: ctx.reserved }, path);
    if (!preserved.ok) return unfetched(preserved.reason);
    conflictPath = preserved.copyPath;
  }
  try {
    await ctx.fs.rename(temp, path);
  } catch (error) {
    if (hostPathErrorOf(error) !== undefined) return obstacleSkip(path, OUTSIDE_VAULT_REASON);
    return unfetched(COULD_NOT_WRITE_REASON);
  }
  const mtimeMs = (await ctx.fs.stat(path))?.mtimeMs ?? 0;
  return { kind: "result", result: { ok: true, mtimeMs, ...(conflictPath === undefined ? {} : { conflictPath }) } };
}

/**
 * Fetch, verify and place one file. Returns a classified outcome; throws only for an error that is not about this file
 * (a lost lock, no WebCrypto). The destination is written only by the last rename, after full verification, and the
 * verified part file is removed on every path that does not rename it.
 */
export async function fetchFile(ctx: FileFetchContext, decision: WritablePath): Promise<FileOutcome> {
  const { entry } = decision;
  const location = blobLocation(ctx.rootCid, entry.blob, ctx.lengths);
  if (location === undefined) return failedWith("integrity-failed", ABSENT_REASON);
  if (ctx.space !== undefined && !(await ctx.space.reserve(entry.size))) return unfetched(NO_SPACE_REASON);
  try {
    const staged = await stage(ctx, decision, location);
    if (staged.kind === "done") return staged.outcome;
    let renamed = false;
    try {
      const outcome = await commit(ctx, decision, staged.temp);
      renamed = outcome.kind === "result" && outcome.result.ok;
      return outcome;
    } finally {
      if (!renamed) await discardTemp(ctx.fs, staged.temp);
    }
  } finally {
    ctx.space?.release(entry.size);
  }
}
