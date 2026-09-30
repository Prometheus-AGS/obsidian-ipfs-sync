import type { HostBridge } from "../core/host-bridge";
import type { SyncEventBus } from "../core/events";
import type { KuboClient } from "../kubo";
import { localDateStamp } from "./conflict-name";
import { excludesHash } from "./exclusions";
import type { Manifest } from "./manifest";
import { runPool } from "./pool";
import { preserveLocalCopy } from "./pull-conflict";
import { PullSourceError, PullTargetError } from "./pull-errors";
import { commitStaged, stageVerified, sweepTemp, type FetchContext } from "./pull-fetch";
import { assertPullDestination, writeFixtureMarker, type GuardFs } from "./pull-guard";
import { planPull, type PullDecision, type PullPlan } from "./pull-plan";
import { mergeRecord } from "./pull-record";
import { chooseIpnsName, isCid, isIpnsName, loadManifest, resolveRootCid, type ManifestSelector } from "./pull-target";
import { encodeState, readState, writeState, type LocalState } from "./state";

/** The kubo operations a pull uses. Note what is absent: every write, pin, key and publish operation. */
export type PullClient = Pick<KuboClient, "nameResolve" | "keyList" | "gatewayFetch" | "gatewayStream">;

/** Where a pull is, for a host that shows progress. Added in mvp-05; the CLI ignores it. */
export type PullPhase =
  | { readonly kind: "resolving" }
  | { readonly kind: "reading-manifest" }
  | { readonly kind: "comparing"; readonly files: number }
  | { readonly kind: "fetching"; readonly total: number };

export interface PullDeps {
  readonly client: PullClient;
  readonly host: HostBridge;
  readonly bus: SyncEventBus;
  /** Receives warnings for the operator (the CLI prints them on stderr). */
  readonly warn: (message: string) => void;
  /** Unique temp file names; defaults to a random UUID. */
  readonly newId?: () => string;
  /**
   * The destination rule. Defaults to `assertPullDestination` (absent, empty or marked). A host whose root
   * always holds application folders, such as an Obsidian vault, passes its own; it must fail before any request.
   */
  readonly assertDestination?: (fs: GuardFs) => Promise<{ readonly needsMarker: boolean }>;
  /** Called as the pull moves from phase to phase. */
  readonly onPhase?: (phase: PullPhase) => void;
}

export interface PullOptions {
  readonly mfsRoot: string;
  readonly keyName: string;
  readonly ownedKeys: readonly string[];
  /** `--name`: pull from this IPNS name instead of the owned publication key. */
  readonly name?: string;
  readonly selector: ManifestSelector;
  readonly extraExclusions?: readonly string[];
  readonly concurrency?: number;
}

export interface FileFailure {
  readonly path: string;
  readonly reason: string;
}

export interface PullResult {
  readonly rootCid: string;
  readonly manifestCid: string;
  readonly fetched: number;
  readonly unchanged: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly remoteDeleted: number;
  readonly locallyModified: number;
  readonly forcedReverify: boolean;
  readonly durationMs: number;
  readonly failures: readonly FileFailure[];
  readonly conflicts: readonly { readonly path: string; readonly conflictPath: string }[];
  readonly remoteDeletedPaths: readonly string[];
  readonly locallyModifiedPaths: readonly string[];
}

type Applied =
  | { readonly ok: true; readonly path: string; readonly mtimeMs: number; readonly conflictPath: string | undefined }
  | { readonly ok: false; readonly path: string; readonly reason: string };

type Writable = Extract<PullDecision, { kind: "fetch" | "replace" | "conflict" }>;

interface Run {
  readonly deps: PullDeps;
  readonly fetch: FetchContext;
  readonly manifest: Manifest;
  readonly dateStamp: string;
  readonly reserved: Set<string>;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The record applies only to the destination it describes (same MFS root and key), as for publish. */
function applicableState(state: LocalState | undefined, mfsRoot: string, keyName: string): LocalState | undefined {
  return state !== undefined && state.mfsRoot === mfsRoot && state.key === keyName ? state : undefined;
}

async function writeOne(run: Run, decision: Writable): Promise<Applied> {
  const { deps, manifest } = run;
  const { path, entry } = decision;
  const temp = await stageVerified(run.fetch, manifest.rootCID, path, entry);
  let conflictPath: string | undefined;
  if (decision.kind === "conflict") {
    conflictPath = await preserveOrDiscard(run, path, temp);
    deps.bus.emit("conflict", { path, conflictPath, localSha256: decision.localSha256, remoteSha256: entry.sha256 });
  }
  const mtimeMs = await commitStaged(run.fetch, temp, path);
  deps.bus.emit("file.changed", { path, kind: decision.kind === "fetch" ? "added" : "modified", sha256: entry.sha256 });
  return { ok: true, path, mtimeMs, conflictPath };
}

async function preserveOrDiscard(run: Run, path: string, temp: string): Promise<string> {
  try {
    return await preserveLocalCopy({ fs: run.deps.host.fs, newId: run.fetch.newId, dateStamp: run.dateStamp, reserved: run.reserved }, path);
  } catch (error) {
    await run.deps.host.fs.remove(temp).catch(() => undefined);
    throw error;
  }
}

/** One file, never throwing: a failure is data, so the rest of the pool keeps going. */
async function applyOne(run: Run, decision: Writable): Promise<Applied> {
  try {
    return await writeOne(run, decision);
  } catch (error) {
    return { ok: false, path: decision.path, reason: reasonOf(error) };
  }
}

function isWritable(decision: PullDecision): decision is Writable {
  return decision.kind === "fetch" || decision.kind === "replace" || decision.kind === "conflict";
}

interface Tally {
  readonly applied: readonly Applied[];
  readonly synced: Map<string, number>;
  readonly failures: readonly FileFailure[];
}

async function execute(run: Run, plan: PullPlan, concurrency: number | undefined): Promise<Tally> {
  const writable = plan.decisions.filter(isWritable);
  const outcome = await runPool(writable, (decision) => applyOne(run, decision), concurrency);
  const applied = outcome.completed.map((c) => c.value);
  const synced = new Map<string, number>();
  for (const decision of plan.decisions) if (decision.kind === "unchanged") synced.set(decision.path, decision.mtimeMs);
  for (const result of applied) if (result.ok) synced.set(result.path, result.mtimeMs);
  const refused = plan.decisions.flatMap((d) => (d.kind === "refused" ? [{ path: d.path, reason: d.reason }] : []));
  const failed = applied.flatMap((r) => (r.ok ? [] : [{ path: r.path, reason: r.reason }]));
  return { applied, synced, failures: [...refused, ...failed].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

interface Source {
  readonly rootCid: string;
  readonly manifest: Manifest;
  /** True when the manifest is the latest published one; only then may the shared record advance. */
  readonly isLatest: boolean;
}

/** `--manifest` naming the current latest snapshot counts as latest; `--manifest-file` never does. */
async function isLatestSelection(deps: PullDeps, rootCid: string, selector: ManifestSelector, manifest: Manifest): Promise<boolean> {
  if (selector.kind === "latest") return true;
  if (selector.kind === "text") return false;
  const latest = await loadManifest(deps.client, rootCid, { kind: "latest" });
  return latest.rootCID === manifest.rootCID;
}

async function locateSource(deps: PullDeps, options: PullOptions): Promise<Source> {
  if (options.name !== undefined && !isIpnsName(options.name)) throw new PullTargetError(`"${options.name}" is not an IPNS key ID`);
  deps.onPhase?.({ kind: "resolving" });
  const ipnsName = await chooseIpnsName(deps.client, options);
  const rootCid = await resolveRootCid(deps.client, ipnsName);
  deps.onPhase?.({ kind: "reading-manifest" });
  const manifest = await loadManifest(deps.client, rootCid, options.selector);
  if (!isCid(manifest.rootCID)) throw new PullSourceError(`the manifest rootCID "${manifest.rootCID}" is not a CID`);
  return { rootCid, manifest, isLatest: await isLatestSelection(deps, rootCid, options.selector, manifest) };
}

async function warnOnDivergence(deps: PullDeps, manifest: Manifest, extra: readonly string[] | undefined): Promise<boolean> {
  const local = await excludesHash(extra);
  if (local === manifest.excludesHash) return false;
  deps.warn(
    `the exclusion lists differ: this device ${local}, manifest ${manifest.excludesHash}. ` +
      "Every local file will be re-verified by content; nothing is deleted.",
  );
  return true;
}

function newRun(deps: PullDeps, manifest: Manifest): Run {
  const newId = deps.newId ?? ((): string => crypto.randomUUID());
  return {
    deps,
    fetch: { client: deps.client, fs: deps.host.fs, newId },
    manifest,
    dateStamp: localDateStamp(deps.host.timeNow()),
    // Manifest paths are reserved so a conflict copy can never take the name of a file about to be fetched.
    reserved: new Set(Object.keys(manifest.files)),
  };
}

const textOf = (state: LocalState): string => new TextDecoder().decode(encodeState(state));

/** Write the record unless it is byte-for-byte what is already there. */
async function saveRecord(deps: PullDeps, previous: LocalState | undefined, next: LocalState): Promise<void> {
  if (previous === undefined || textOf(previous) !== textOf(next)) await writeState(deps.host.kv, next);
}

function summarize(source: Source, plan: PullPlan, tally: Tally, forced: boolean, durationMs: number): PullResult {
  const written = tally.applied.flatMap((r) => (r.ok ? [r] : []));
  const conflicts = written.flatMap((r) => (r.conflictPath === undefined ? [] : [{ path: r.path, conflictPath: r.conflictPath }]));
  const modified = plan.decisions.filter((d) => d.kind === "locally-modified").map((d) => d.path);
  return {
    rootCid: source.rootCid,
    manifestCid: source.manifest.rootCID,
    fetched: written.length,
    unchanged: plan.decisions.filter((d) => d.kind === "unchanged").length,
    conflicted: conflicts.length,
    failed: tally.failures.length,
    remoteDeleted: plan.remoteDeleted.length,
    locallyModified: modified.length,
    forcedReverify: forced,
    durationMs,
    failures: tally.failures,
    conflicts,
    remoteDeletedPaths: plan.remoteDeleted,
    locallyModifiedPaths: modified,
  };
}

/**
 * Bring the vault behind `deps.host` to the selected manifest. Order: destination guard, local record,
 * target and manifest (reads only), exclusion check, marker, temp sweep, plan, fetch and verify each file,
 * record, events. Aborts before the first write on any guard, target or manifest failure; a failed file is
 * counted, never fatal. No local file is deleted.
 */
export async function pullVault(deps: PullDeps, options: PullOptions): Promise<PullResult> {
  const startedAt = deps.host.timeNow();
  const { needsMarker } = await (deps.assertDestination ?? assertPullDestination)(deps.host.fs);
  const previous = applicableState(await readState(deps.host.kv), options.mfsRoot, options.keyName);
  const source = await locateSource(deps, options);
  const forced = await warnOnDivergence(deps, source.manifest, options.extraExclusions);
  if (needsMarker) await writeFixtureMarker(deps.host.fs);
  await sweepTemp(deps.host.fs);

  deps.onPhase?.({ kind: "comparing", files: Object.keys(source.manifest.files).length });
  const plan = await planPull({ fs: deps.host.fs, manifest: source.manifest, previous, forceVerify: forced, extraExclusions: options.extraExclusions });
  deps.onPhase?.({ kind: "fetching", total: plan.decisions.filter(isWritable).length });
  const tally = await execute(newRun(deps, source.manifest), plan, options.concurrency);
  const target = { mfsRoot: options.mfsRoot, key: options.keyName, rootCid: source.rootCid };
  if (source.isLatest) {
    await saveRecord(deps, previous, mergeRecord({ previous, manifest: source.manifest, target, synced: tally.synced }));
  } else {
    // A restore is not the remote's state: leaving the record alone makes the next publish overwrite newer remote content.
    deps.warn(`restored from ${source.manifest.rootCID}; sync record not advanced (next publish will overwrite newer remote content)`);
  }

  const result = summarize(source, plan, tally, forced, deps.host.timeNow() - startedAt);
  deps.bus.emit("pull.complete", {
    rootCid: result.rootCid,
    manifestCid: result.manifestCid,
    fetched: result.fetched,
    unchanged: result.unchanged,
    conflicted: result.conflicted,
    failed: result.failed,
    remoteDeleted: result.remoteDeleted,
    locallyModified: result.locallyModified,
    forcedReverify: result.forcedReverify,
    durationMs: result.durationMs,
  });
  return result;
}
