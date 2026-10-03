/**
 * The planner and the outcome merge of the encrypted pull (mvp-07a task 4.5; design decisions 7, 8 and 11).
 *
 * `planEncryptedPull` decides, for every path of the authenticated manifest, what the pull does with it: the path policy
 * first (a refused path is never read or written), then the symlink prefix walk, then the three-way rule on plaintext
 * sha256 with the size-and-mtime shortcut (bypassed by `forceVerify` when the exclusion lists differ). Nothing is written.
 * A path that is in `unmaterialized` is planned with `B` absent: this device does not hold the content the baseline
 * entry describes, so a missing file is fetched, an equal file is a restored path, and a differing file becomes a dated
 * conflict copy while the node's text takes the path.
 *
 * `settlePull` merges the plan with what the fetch step reported into the new baseline: every path that is in sync, was
 * left alone as a local edit, failed (`integrity-failed`, `unfetched`) or was skipped for a platform reason takes the
 * node's entry; the last three also join `unmaterialized`, so the next publish carries them unchanged. A skip that is
 * `expected` (configuration folder, exclusion list) or `unsafe`/`shape` is absent from the baseline. `complete` is false
 * iff a path is `integrity-failed` or `unfetched`.
 *
 * Pure apart from the reads the planner makes (`stat`, `lstat`, `read`, `readRange`). Reasons are fixed sentences that
 * never echo a path, node text, a key or a passphrase.
 */
import type { HostFs } from "../core/host-bridge";
import { createFilesMap, type EncryptedManifest, type EncryptedManifestFile } from "./encrypted-manifest";
import { hashFile } from "./hash";
import { FileChangedDuringReadError, HostReadCapError } from "./host-errors";
import { evaluatePathPolicy, type PathPolicyOptions, type PolicyCode, type PolicyRefusal } from "./path-policy";
import { createConflictReservations, type ConflictReservations } from "./pull-conflict";
import { findSymlink, type SymlinkCache } from "./symlink-guard";
import { decideThreeWay } from "./three-way";

/** What the three-way rule needs of a baseline entry. */
export type BaseEntry = Pick<EncryptedManifestFile, "sha256" | "size">;

/** The baseline the plan compares with: the state's manifest entries and mtimes, or a fork's ancestor (no mtimes). */
export interface PullBase {
  readonly files: Readonly<Record<string, BaseEntry>>;
  readonly mtimes: Readonly<Record<string, number>>;
}

/** Why a path is skipped for a reason that belongs to this device rather than to the path policy. */
export type LocalObstacleCode = "symlink" | "directory-at-path";

interface SkipBase {
  readonly path: string;
  readonly code: PolicyCode | LocalObstacleCode;
  /** A fixed sentence about the rule; it does not contain the path. */
  readonly reason: string;
  /** For the two group rules of the policy: every member of the group (sorted). */
  readonly group?: readonly string[];
}

/**
 * A `policy-skipped` outcome. `expected`: the configuration folder or the exclusion list (what an older build's manifest
 * holds). `unsafe`: a path shape an honest publisher never produces (`shape`), or a path another platform can produce or
 * that this device cannot take (`platform`: Windows forms, reserved names, 8.3 shapes, collision groups, and a symlink or a
 * directory in the way on this device).
 */
export type PolicySkip =
  | (SkipBase & { readonly severity: "expected" })
  | (SkipBase & { readonly severity: "unsafe"; readonly class: "shape" | "platform" });

export type PlannedPath =
  | { readonly kind: "unchanged"; readonly path: string; readonly entry: EncryptedManifestFile; readonly mtimeMs: number; readonly restored: boolean }
  | { readonly kind: "fetch"; readonly path: string; readonly entry: EncryptedManifestFile }
  | { readonly kind: "replace"; readonly path: string; readonly entry: EncryptedManifestFile }
  | { readonly kind: "conflict"; readonly path: string; readonly entry: EncryptedManifestFile; readonly localSha256: string }
  | { readonly kind: "locally-modified"; readonly path: string; readonly entry: EncryptedManifestFile }
  | { readonly kind: "policy-skipped"; readonly path: string; readonly entry: EncryptedManifestFile; readonly skip: PolicySkip }
  /** The local file could not be compared (above the host's read cap, or changed while it was read): left as it is. */
  | { readonly kind: "unfetched"; readonly path: string; readonly entry: EncryptedManifestFile; readonly reason: string };

/** The decisions that write to the vault: the caller fetches these. */
export type WritablePath = Extract<PlannedPath, { kind: "fetch" | "replace" | "conflict" }>;

export interface EncryptedPullPlan {
  /** One decision per manifest path, sorted by path. */
  readonly paths: readonly PlannedPath[];
  /** Paths of the baseline that the manifest no longer lists (reported, never deleted). */
  readonly remoteDeleted: readonly string[];
  /** How many local files had to be hashed. */
  readonly hashed: number;
  /** Conflict copy names this pull must not take: every manifest path by fold key, plus the copies handed out later. */
  readonly reservations: ConflictReservations;
  /** The paths that were planned with `B` absent (the input's `unmaterialized`), sorted. */
  readonly unmaterialized: readonly string[];
}

export interface EncryptedPlanInput {
  readonly fs: Pick<HostFs, "stat" | "lstat" | "read" | "readRange">;
  /** The authenticated node manifest. */
  readonly manifest: EncryptedManifest;
  /** The baseline (`B`); undefined when there is none. */
  readonly base: PullBase | undefined;
  /** Paths whose baseline entry is the node's and whose content this device does not hold; planned with `B` absent. */
  readonly unmaterialized: Iterable<string>;
  /** Hash every local file instead of trusting size and mtime (the exclusion lists differ). */
  readonly forceVerify: boolean;
  /** The configuration folder and this device's extra exclusions, for the path policy. */
  readonly policy?: PathPolicyOptions;
}

const compareUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Own-property lookup, so a manifest path such as `constructor` cannot match an inherited member. */
function lookup<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

const UNREADABLE_REASON = "the local file is above this host's read cap, so it cannot be compared with the node's";
const CHANGED_REASON = "the local file changed while it was being read, so it was not compared";

interface Local {
  readonly sha256: string | undefined;
  readonly mtimeMs: number;
  readonly hashed: boolean;
}

type Inspected = Local | { readonly obstacle: PolicySkip } | { readonly unreadable: string };

function platformObstacle(path: string, code: LocalObstacleCode, reason: string): PolicySkip {
  return { path, severity: "unsafe", class: "platform", code, reason };
}

/** The local sha256 of `path`, or undefined when missing; trusts the baseline when size and recorded mtime still match. */
async function inspectLocal(input: EncryptedPlanInput, path: string, base: BaseEntry | undefined): Promise<Inspected> {
  const info = await input.fs.stat(path);
  if (info === undefined) return { sha256: undefined, mtimeMs: 0, hashed: false };
  if (info.kind !== "file") return { obstacle: platformObstacle(path, "directory-at-path", "a directory exists at this path on this device") };
  const recorded = lookup(input.base?.mtimes, path);
  if (!input.forceVerify && base !== undefined && base.size === info.size && recorded === info.mtimeMs) {
    return { sha256: base.sha256, mtimeMs: info.mtimeMs, hashed: false };
  }
  try {
    return { sha256: await hashFile(input.fs, path, info.size), mtimeMs: info.mtimeMs, hashed: true };
  } catch (error) {
    // A host with a read cap (Obsidian) refuses a file it cannot load, and a plugin read can see the file change: that file is left, the others go on.
    if (error instanceof HostReadCapError) return { unreadable: UNREADABLE_REASON };
    if (error instanceof FileChangedDuringReadError) return { unreadable: CHANGED_REASON };
    throw error;
  }
}

interface Planned {
  readonly decision: PlannedPath;
  readonly hashed: boolean;
}

async function planOne(
  input: EncryptedPlanInput,
  path: string,
  entry: EncryptedManifestFile,
  carried: boolean,
  cache: SymlinkCache,
): Promise<Planned> {
  const link = await findSymlink(input.fs, path, cache);
  if (link !== undefined) {
    return { decision: { kind: "policy-skipped", path, entry, skip: platformObstacle(path, "symlink", "a symbolic link lies on the way to this path on this device") }, hashed: false };
  }
  // B absent for an unmaterialized path: its baseline entry is the node's, not what this device holds.
  const base = carried ? undefined : lookup(input.base?.files, path);
  const local = await inspectLocal(input, path, base);
  if ("obstacle" in local) return { decision: { kind: "policy-skipped", path, entry, skip: local.obstacle }, hashed: false };
  if ("unreadable" in local) return { decision: { kind: "unfetched", path, entry, reason: local.unreadable }, hashed: false };
  const outcome = decideThreeWay(local.sha256, base?.sha256, entry.sha256);
  switch (outcome) {
    case "unchanged":
      return { decision: { kind: "unchanged", path, entry, mtimeMs: local.mtimeMs, restored: carried }, hashed: local.hashed };
    case "conflict":
      // A conflict needs a local file, so `sha256` is set; the table returns "fetch" for a missing one.
      return { decision: { kind: "conflict", path, entry, localSha256: local.sha256 ?? "" }, hashed: local.hashed };
    default:
      return { decision: { kind: outcome, path, entry }, hashed: local.hashed };
  }
}

function skipped(refusal: PolicyRefusal, entry: EncryptedManifestFile): PlannedPath {
  return { kind: "policy-skipped", path: refusal.path, entry, skip: refusal };
}

/**
 * Decide, for every manifest path, what the pull does with it. Files are inspected one at a time so memory stays bounded.
 * Nothing is written; a refusal (policy, symlink, directory, unreadable file) is a decision, not an exception.
 */
export async function planEncryptedPull(input: EncryptedPlanInput): Promise<EncryptedPullPlan> {
  const { manifest } = input;
  const paths = Object.keys(manifest.files).sort(compareUnits);
  const refusals = new Map(evaluatePathPolicy(paths, input.policy).refusals.map((refusal) => [refusal.path, refusal] as const));
  const carried = new Set(input.unmaterialized);
  const cache: SymlinkCache = new Map();
  const planned: PlannedPath[] = [];
  let hashed = 0;
  for (const path of paths) {
    const entry = manifest.files[path] as EncryptedManifestFile;
    const refusal = refusals.get(path);
    if (refusal !== undefined) {
      planned.push(skipped(refusal, entry));
      continue;
    }
    const result = await planOne(input, path, entry, carried.has(path), cache);
    planned.push(result.decision);
    if (result.hashed) hashed += 1;
  }
  const remoteDeleted = Object.keys(input.base?.files ?? {})
    .filter((path) => !Object.hasOwn(manifest.files, path))
    .sort(compareUnits);
  return { paths: planned, remoteDeleted, hashed, reservations: createConflictReservations(paths), unmaterialized: [...carried].sort(compareUnits) };
}

export function isWritable(decision: PlannedPath): decision is WritablePath {
  return decision.kind === "fetch" || decision.kind === "replace" || decision.kind === "conflict";
}

// ---- outcomes and the baseline merge ----------------------------------------------------------------------------

/** What the fetch step reports for one writable path. */
export type FetchResult =
  | { readonly ok: true; readonly mtimeMs: number; readonly conflictPath?: string }
  | { readonly ok: false; readonly outcome: "integrity-failed" | "unfetched"; readonly reason: string };

/** Reason for a writable path that has no result: the pool stopped before the file was fetched. */
export const NOT_REACHED_REASON = "the pull stopped before this file was fetched";

export interface SettleInput {
  /** The authenticated node manifest the plan was made for. */
  readonly manifest: EncryptedManifest;
  readonly plan: EncryptedPullPlan;
  /** One result per writable path, by path. A writable path without one counts `unfetched` (the pool aborted). */
  readonly results: ReadonlyMap<string, FetchResult>;
}

export interface PathProblem {
  readonly path: string;
  readonly reason: string;
}

export interface PullSettlement {
  /** The node's manifest with the merged `files`: the baseline for the state. */
  readonly manifest: EncryptedManifest;
  /** Sorted, unique, and a subset of `manifest.files`: paths whose entry is the node's but whose content this device lacks. */
  readonly unmaterialized: readonly string[];
  /** False iff a path is `integrity-failed` or `unfetched`; a skip never makes a pull incomplete. */
  readonly complete: boolean;
  /** Modification times of the paths that are in sync (unchanged, or written by this pull). */
  readonly mtimes: Readonly<Record<string, number>>;
  readonly fetched: readonly string[];
  readonly unchanged: readonly string[];
  /** Paths of `unmaterialized` that this pull restored (an equal local file, or fetched). */
  readonly restored: readonly string[];
  readonly locallyModified: readonly string[];
  readonly conflicts: readonly { readonly path: string; readonly conflictPath: string }[];
  readonly integrityFailed: readonly PathProblem[];
  readonly unfetched: readonly PathProblem[];
  readonly skipped: readonly PolicySkip[];
  readonly remoteDeleted: readonly string[];
  /** True iff the CLI exits 1: an `integrity-failed` or `unfetched` path, or an `unsafe` skip. `expected` skips alone do not. */
  readonly needsAttention: boolean;
}

/** What `settlePull` gathers while it walks the plan. */
interface Collected {
  baseline: [string, EncryptedManifestFile][];
  carried: string[];
  mtimes: [string, number][];
  fetched: string[];
  unchanged: string[];
  restored: string[];
  locallyModified: string[];
  conflicts: { path: string; conflictPath: string }[];
  integrityFailed: PathProblem[];
  unfetched: PathProblem[];
  skipped: PolicySkip[];
}

function settleWritable(decision: WritablePath, result: FetchResult | undefined, out: Collected, wasCarried: boolean): void {
  const { path, entry } = decision;
  out.baseline.push([path, entry]);
  const outcome: FetchResult = result ?? { ok: false, outcome: "unfetched", reason: NOT_REACHED_REASON };
  if (outcome.ok) {
    out.fetched.push(path);
    out.mtimes.push([path, outcome.mtimeMs]);
    if (wasCarried) out.restored.push(path);
    if (outcome.conflictPath !== undefined) out.conflicts.push({ path, conflictPath: outcome.conflictPath });
    return;
  }
  out.carried.push(path);
  (outcome.outcome === "integrity-failed" ? out.integrityFailed : out.unfetched).push({ path, reason: outcome.reason });
}

function settleOne(decision: PlannedPath, results: ReadonlyMap<string, FetchResult>, wasCarried: boolean, out: Collected): void {
  switch (decision.kind) {
    case "unchanged":
      out.baseline.push([decision.path, decision.entry]);
      out.mtimes.push([decision.path, decision.mtimeMs]);
      out.unchanged.push(decision.path);
      if (decision.restored) out.restored.push(decision.path);
      return;
    case "locally-modified":
      // B = R: the node's entry is the baseline, and the differing local file is an edit for the next publish.
      out.baseline.push([decision.path, decision.entry]);
      out.locallyModified.push(decision.path);
      return;
    case "unfetched":
      out.baseline.push([decision.path, decision.entry]);
      out.carried.push(decision.path);
      out.unfetched.push({ path: decision.path, reason: decision.reason });
      return;
    case "policy-skipped": {
      out.skipped.push(decision.skip);
      // `expected` and shape-unsafe entries leave the manifest at the next publish; a platform skip is carried.
      if (decision.skip.severity === "unsafe" && decision.skip.class === "platform") {
        out.baseline.push([decision.path, decision.entry]);
        out.carried.push(decision.path);
      }
      return;
    }
    default:
      settleWritable(decision, results.get(decision.path), out, wasCarried);
  }
}

/** Merge the plan with the fetch results into the new baseline, `unmaterialized`, `complete` and the counts. */
export function settlePull(input: SettleInput): PullSettlement {
  const wasCarried = new Set(input.plan.unmaterialized);
  const out: Collected = { baseline: [], carried: [], mtimes: [], fetched: [], unchanged: [], restored: [], locallyModified: [], conflicts: [], integrityFailed: [], unfetched: [], skipped: [] };
  for (const decision of input.plan.paths) settleOne(decision, input.results, wasCarried.has(decision.path), out);
  const complete = out.integrityFailed.length === 0 && out.unfetched.length === 0;
  return {
    manifest: { ...input.manifest, files: createFilesMap(out.baseline) },
    unmaterialized: [...new Set(out.carried)].sort(compareUnits),
    complete,
    mtimes: Object.fromEntries(out.mtimes),
    fetched: out.fetched,
    unchanged: out.unchanged,
    restored: out.restored,
    locallyModified: out.locallyModified,
    conflicts: out.conflicts,
    integrityFailed: out.integrityFailed,
    unfetched: out.unfetched,
    skipped: out.skipped,
    remoteDeleted: input.plan.remoteDeleted,
    needsAttention: !complete || out.skipped.some((skip) => skip.severity === "unsafe"),
  };
}
