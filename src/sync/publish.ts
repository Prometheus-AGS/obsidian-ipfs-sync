import type { SyncEventBus } from "../core/events";
import type { Bytes } from "../core/host-bridge";
import type { NameStart } from "./commit-ports";
import type { SkippedFile } from "./diff";
import { encodeManifestFile, type EncryptedManifest } from "./encrypted-manifest";
import { removeBlobPaths, writeEncryptedBlobs, writeKeySlotsFile, type TransferContext, type WrittenBlob } from "./encrypted-transfer";
import { createExclusionMatcher, excludesHash } from "./exclusions";
import { idlePublishResult } from "./idle-check";
import { pathLimitViolation } from "./path-limits";
import { adviseUnrestorablePaths, hasBidiControl } from "./path-policy";
import { assertHistoryReady } from "./history-gate";
import { assertRootLayout, statIfPresent, type RootView } from "./node-reader";
import { deleteJournal } from "./journal";
import { readNameStart } from "./name-recheck";
import { guardLocalWrites } from "./guarded-kv";
import { isUnreadableManifest } from "./manifest-auth";
import { EmptyVaultError } from "./publish-errors";
import { commitPublish } from "./publish-commit";
import { finalManifest, provisionalManifest, sanitizeDevice, type ManifestFrame } from "./publish-manifest";
import { buildPublishPlan, type PublishPlan } from "./publish-plan";
import { largeReupload, massRemoval, overlappingPublish, pathOverLimit, pathWithBidiControl, remoteObjectInvalid, rootCidNotV1 } from "./publish-refusals";
import { assessRemovals } from "./removal-guard";
import { checkTarget, openSession, type PublishSession } from "./publish-session";
import { decideSequence, type SequenceDecision, type SequenceInput } from "./publish-sequence";
import type { PublishDeps, PublishOptions, PublishResult } from "./publish-types";
import { rootFileNames } from "./root-files";
import { buildRootState, writeRootState } from "./root-state";
import { sameBytes } from "./same-bytes";
import { scanVault } from "./scan";
import { readFloor, type FloorEntry } from "./sequence-floor";

export type { PublishClient, PublishDeps, PublishOptions, PublishResult } from "./publish-types";

const DEVICE_ENV = "IPFS_SYNC_DEVICE";
/** Lost files above this size are not uploaded again without an explicit go-ahead. */
export const FULL_REUPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;
const ROOT_CID_V1 = /^b[a-z2-7]{10,127}$/;
const UNKNOWN_SHA256 = "0".repeat(64);

interface NodeAssessment {
  readonly warnings: readonly string[];
  readonly decision: SequenceDecision;
  readonly view: RootView;
  /** The node has a `manifest.enc` at this root (readable or not). With no local state either, this is the first publish of the vault. */
  readonly nodeHasManifest: boolean;
  /** The `device` of the node's authenticated manifest; undefined when the node has none or it is unreadable. */
  readonly nodeDevice: string | undefined;
  /** The bytes of the node's `manifest.enc` that the sequence decision was taken from (undefined when it had none). */
  readonly manifestFile: Bytes | undefined;
}

/** The node's `manifest.enc`: absent, present and authentic, or present and unreadable (does not authenticate, or cut short). `raw` is what was read, kept for the re-read before the transfer. */
async function readNodeManifest(
  session: PublishSession,
): Promise<{ readonly manifest: EncryptedManifest | undefined; readonly unreadable: boolean; readonly raw: Bytes | undefined }> {
  const raw = await session.commit.node.readManifestFile();
  if (raw === undefined) return { manifest: undefined, unreadable: false, raw };
  try {
    return { manifest: await session.commit.decodeManifest(raw), unreadable: false, raw };
  } catch (error) {
    if (isUnreadableManifest(error)) return { manifest: undefined, unreadable: true, raw };
    throw error;
  }
}

/**
 * The highest sequence this device knows it may have published to this root: its state and the journal `--repair` set aside,
 * whichever is higher. The journal counts even when a state exists: its `name/publish` may have happened, so a rebuild must not reuse it.
 */
function recordSequence(session: PublishSession): number | undefined {
  const known = [session.state?.sequence, session.deferredSequence].filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

/**
 * The sequence floor kept for the vault, read on every publish (review-final A-02): the publish refuses to start from a record below it.
 * A damaged floor file stops the run here, before the first write.
 */
async function floorOf(deps: PublishDeps, session: PublishSession): Promise<FloorEntry | undefined> {
  return deps.deviceStore === undefined ? undefined : readFloor(deps.deviceStore, session.opened.vaultId);
}

/** What `--repair` needs to judge the ahead case besides the floor: whether a state file exists that does not decode. Read only under `--repair`. */
async function undecodableStateFact(deps: PublishDeps, options: PublishOptions, session: PublishSession): Promise<Pick<SequenceInput, "stateUndecodable">> {
  if (options.repair !== true) return {};
  return { stateUndecodable: session.state === undefined && (await deps.host.kv.get(rootFileNames(session.target.mfsRoot).state)) !== undefined };
}

/** Read the node's manifest and layout, then decide where the publish starts (sequence rules, --repair). */
async function assessNode(deps: PublishDeps, options: PublishOptions, session: PublishSession): Promise<NodeAssessment> {
  const floor = await floorOf(deps, session);
  const read = await readNodeManifest(session);
  const view = await session.inspector.view();
  assertRootLayout(view);
  const decision = await decideSequence({
    kv: deps.host.kv,
    mfsRoot: session.target.mfsRoot,
    state: session.state,
    node: read.manifest,
    nodeUnreadable: read.unreadable,
    recordSequence: recordSequence(session),
    vaultId: session.opened.vaultId,
    nodeKeySlots: await session.inspector.readKeySlots(),
    localKeySlots: session.opened.keySlots,
    repair: options.repair === true,
    confirmRepair: options.confirmRepair,
    floor,
    ...(await undecodableStateFact(deps, options, session)),
  });
  // A journal that --repair set aside and that no repair then took over is obsolete (the record moved on): drop it.
  if (session.journalDeferred && !decision.repaired) await deleteJournal(deps.host.kv, session.target.mfsRoot);
  const warnings = await assertHistoryReady(deps.client, options, session, deps.beforeFirstWrite);
  return { decision, view, warnings, nodeHasManifest: read.manifest !== undefined || read.unreadable, nodeDevice: read.manifest?.device, manifestFile: read.raw };
}

/**
 * Is there anything to send? Changes are one reason. The others are states this device must not leave as they are: a
 * repair, a new key, a root never published, and a root whose CID is not the one this device last published (an
 * interrupted publish whose pending state was adopted, or anything else that changed the snapshot without a publication).
 */
function hasWork(plan: PublishPlan, session: PublishSession, decision: SequenceDecision, view: RootView): boolean {
  // A carried entry that leaves the manifest (excluded here, unsafe shape) is a change; carried entries that stay are not.
  const changed = plan.writes.length + plan.repairs.length + plan.blobRemovals.length + plan.removedPaths.length + plan.dropped.length > 0;
  const unpublished = session.state === undefined || session.state.rootCid === null || session.state.rootCid !== view.rootCid;
  return changed || decision.repaired || session.key.absent || unpublished;
}

/**
 * Stops a publish that removes every remaining entry, or more than half of them, unless the caller confirmed (the flag, or the
 * confirm port). With neither, as on a timer publish, it refuses. Runs after the diff and before any write; the first publish
 * of a vault has no baseline and nothing to remove.
 */
async function guardMassRemoval(options: PublishOptions, assessed: NodeAssessment, plan: PublishPlan): Promise<void> {
  const baseline = assessed.decision.baseline;
  if (baseline === undefined) return;
  const excluded = createExclusionMatcher(options.extraExclusions);
  const assessment = assessRemovals({ before: Object.keys(baseline.manifest.files), removed: plan.removedPaths, dropped: plan.dropped, excluded: (path) => excluded(path) });
  if (!assessment.stop || options.allowMassRemoval === true) return;
  const counts = { removing: assessment.others.length, remaining: assessment.remaining, exclusionDriven: assessment.exclusionDriven.length };
  if (options.confirmMassRemoval !== undefined && (await options.confirmMassRemoval(counts))) return;
  throw massRemoval(counts);
}

async function guardReupload(options: PublishOptions, plan: PublishPlan): Promise<void> {
  if (plan.repairBytes <= FULL_REUPLOAD_LIMIT_BYTES || options.allowFullReupload === true) return;
  if (options.confirmFullReupload !== undefined && (await options.confirmFullReupload(plan.repairBytes))) return;
  throw largeReupload(plan.repairBytes);
}

/** The manifest `device` this installation writes; the drift guard and the manifest frame must agree on it. */
async function deviceOf(deps: PublishDeps): Promise<string> {
  return sanitizeDevice(deps.host.envRead(DEVICE_ENV), await deps.deviceId?.());
}

async function manifestFrame(deps: PublishDeps, options: PublishOptions, session: PublishSession, sequence: number): Promise<ManifestFrame> {
  return {
    vaultId: session.opened.vaultId,
    sequence,
    publishedAt: new Date(deps.host.timeNow()).toISOString(),
    device: await deviceOf(deps),
    excludesHash: await excludesHash(options.extraExclusions ?? []),
  };
}

/**
 * Serialise and encrypt the manifest the publish will write, with placeholders for what only exists after the
 * uploads, and refuse (a typed error naming the cap or the format) before ANY blob is written.
 */
async function checkWriterCaps(session: PublishSession, plan: PublishPlan, frame: ManifestFrame): Promise<void> {
  const planned = [...plan.writes, ...plan.repairs.map((job) => ({ path: job.path, size: job.size, sha256: UNKNOWN_SHA256 }))];
  // Local paths over a limit are named here, before the manifest encoder would refuse them without a path (review-final N-01).
  const offenders = planned.flatMap((item) => {
    const limit = pathLimitViolation(item.path);
    return limit === undefined ? [] : [{ path: item.path, limit }];
  });
  if (offenders.length > 0) throw pathOverLimit(offenders);
  // A bidirectional override or isolate in a local name is refused the same way (mvp-07b 7.6): the pull refuses it on every device.
  const spoofable = planned.filter((item) => hasBidiControl(item.path)).map((item) => item.path);
  if (spoofable.length > 0) throw pathWithBidiControl(spoofable);
  await encodeManifestFile(session.opened.keys, await provisionalManifest(session.opened.keys, frame, plan.kept, planned));
}

/** What the transfer left on the node, and the files it left out because they changed while they were being read. */
interface Transferred {
  readonly blobs: readonly WrittenBlob[];
  readonly skipped: readonly SkippedFile[];
}

/** Upload, verify and remove; returns the blobs written and the files that changed during their read (left out of this publish). */
async function transfer(deps: PublishDeps, options: PublishOptions, session: PublishSession, plan: PublishPlan): Promise<Transferred> {
  const skipped: SkippedFile[] = [];
  const ctx: TransferContext = {
    client: deps.client,
    fs: deps.host.fs,
    keys: session.opened.keys,
    mfsRoot: session.target.mfsRoot,
    concurrency: options.concurrency,
    beforeWrite: session.beforeWrite,
    onSkipped: (file) => {
      skipped.push(file);
    },
  };
  session.beforeWrite();
  await deps.beforeFirstWrite?.();
  await session.key.ensure();
  if (session.opened.writeKeySlotsToNode) await writeKeySlotsFile(ctx, session.opened.keySlots);
  const jobs = [...plan.writes.map((write) => ({ path: write.path, size: write.size })), ...plan.repairs];
  const blobs = await writeEncryptedBlobs(ctx, jobs);
  for (const blob of blobs) session.written.set(blob.blob, blob.cid);
  await removeBlobPaths(ctx, plan.blobRemovals);
  return { blobs, skipped: skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/**
 * The plan as it stands after the transfer: a file that changed while it was read is not a write of this publish (no
 * `file.changed` event, no recorded mtime, so the next run hashes it again) and is reported with the other skipped files.
 */
function withoutTransferSkips(plan: PublishPlan, skipped: readonly SkippedFile[]): PublishPlan {
  if (skipped.length === 0) return plan;
  const left = new Set(skipped.map((file) => file.path));
  return {
    ...plan,
    writes: plan.writes.filter((write) => !left.has(write.path)),
    skipped: [...plan.skipped, ...skipped],
    mtimes: Object.fromEntries(Object.entries(plan.mtimes).filter(([path]) => !left.has(path))),
  };
}

async function currentTreeCid(deps: PublishDeps, session: PublishSession): Promise<string> {
  const stat = await statIfPresent(deps.client, `${session.target.mfsRoot}/current`);
  if (stat === undefined) throw remoteObjectInvalid("current/");
  if (!ROOT_CID_V1.test(stat.cid)) throw rootCidNotV1();
  return stat.cid;
}

/** Every path the new manifest will list that this device holds: new and changed files plus the unchanged ones. Carried paths are the node's, not this device's. */
function pathsToAdvise(plan: PublishPlan): readonly string[] {
  const carried = new Set(plan.carried);
  return [...plan.writes.map((write) => write.path), ...Object.keys(plan.kept).filter((path) => !carried.has(path))];
}

function emitChanges(bus: SyncEventBus, plan: PublishPlan): void {
  for (const write of plan.writes) bus.emit("file.changed", { path: write.path, kind: write.kind, sha256: write.sha256 });
  for (const path of plan.removedPaths) bus.emit("file.changed", { path, kind: "removed" });
}

function summary(
  session: PublishSession,
  plan: PublishPlan,
  written: number,
  warnings: readonly string[],
): Pick<PublishResult, "written" | "removed" | "skipped" | "carried" | "dropped" | "exclusionRemoved" | "keyId" | "keyCreated" | "anomalies" | "warnings"> {
  return {
    warnings,
    exclusionRemoved: plan.exclusionRemoved,
    written,
    removed: plan.removedPaths.length,
    skipped: plan.skipped,
    carried: plan.carried,
    dropped: plan.dropped,
    keyId: session.key.id(),
    keyCreated: session.key.created(),
    anomalies: plan.anomalies.length,
  };
}

/** Nothing to send. New modification times of touched-but-identical files are remembered so the next run skips hashing them. */
async function finishUnchanged(deps: PublishDeps, session: PublishSession, plan: PublishPlan, warnings: readonly string[]): Promise<PublishResult> {
  if (plan.hashed > 0 && session.state !== undefined) await writeRootState(deps.host.kv, buildRootState({ ...session.state, mtimes: plan.mtimes }));
  return { ...summary(session, plan, 0, warnings), published: false };
}

async function planFor(deps: PublishDeps, options: PublishOptions, session: PublishSession, assessed: NodeAssessment): Promise<PublishPlan> {
  const excluded = createExclusionMatcher(options.extraExclusions);
  const scanned = await scanVault(deps.host.fs, excluded);
  // Only this device's own record carries paths it could not restore; a baseline taken from the node (an ahead repair) has none.
  const own = session.state !== undefined && assessed.decision.baseline?.manifest === session.state.manifest;
  return buildPublishPlan({
    carried: own ? session.state?.unmaterialized : undefined,
    excluded: (path) => excluded(path),
    keys: session.opened.keys,
    fs: deps.host.fs,
    client: deps.client,
    mfsRoot: session.target.mfsRoot,
    scanned,
    baseline: assessed.decision.baseline,
    view: assessed.view,
    concurrency: options.concurrency,
    deviceGuard: { device: await deviceOf(deps), devicesSeen: session.state?.devicesSeen ?? [], nodeDevice: assessed.nodeDevice },
  });
}

/**
 * What the publication name points at, read once before the run's first write and remembered as the journal's `startRoot`.
 * A key this run has to create has no name yet, so nothing is read now and nothing is read before `name/publish` either.
 * Throws the routing refusal when the name cannot be read.
 */
async function recordNameStart(session: PublishSession, firstPublish: boolean): Promise<NameStart> {
  if (session.key.absent) return { root: null, firstPublish };
  return readNameStart(session.commit.node, firstPublish);
}

/**
 * The node's `manifest.enc` must still be the file the sequence decision was taken from (review-final A-01). It is read again AFTER the
 * name start: a publisher that completed between the first read and the name start is then visible here (its `manifest.enc` is written
 * before its name), and one that completes later moves the name, which the check right before `name/publish` sees. Without this read the
 * name start of a slow run could already show the other publisher's root and the end check would compare it with itself.
 */
async function assertManifestUnchanged(session: PublishSession, assessed: NodeAssessment): Promise<void> {
  const now: Bytes | undefined = await session.commit.node.readManifestFile();
  const before = assessed.manifestFile;
  const same = now === undefined || before === undefined ? now === before : sameBytes(now, before);
  if (!same) throw overlappingPublish();
}

/** Journal, manifest.enc, history file, read-back, pin, name publication and the local record; then the events. */
async function commitAndAnnounce(deps: PublishDeps, session: PublishSession, plan: PublishPlan, manifest: EncryptedManifest, written: number, startedAt: number, warnings: readonly string[], nameStart: NameStart): Promise<PublishResult> {
  const { file } = await encodeManifestFile(session.opened.keys, manifest);
  const state = await commitPublish(session.commit, {
    target: session.target,
    manifest,
    manifestFile: file,
    mtimes: plan.mtimes,
    previousRootCid: session.state?.rootCid ?? null,
    unmaterialized: plan.carried,
    nameStart,
  });
  const rootCid = state.rootCid ?? "";
  emitChanges(deps.bus, plan);
  deps.bus.emit("publish.complete", { rootCid, manifestCid: manifest.rootCID, written, removed: plan.removedPaths.length, durationMs: deps.host.timeNow() - startedAt });
  return { ...summary(session, plan, written, warnings), published: true, rootCid, currentCid: manifest.rootCID, sequence: manifest.sequence };
}

/**
 * Delta publish of the vault behind `deps.host`, always encrypted. Order: fixture marker, passphrase, local record,
 * unlock, publication key lookup, interrupted-publish resume, node manifest and layout, sequence rules, scan and
 * diff, diagnosis of the node's `current/`, writer-side cap check, name start and a second read of `manifest.enc` (compared with the
 * first), publication key creation and key slots (first publish), blob writes (verified), blob removals, tree CID, manifest, journal, `manifest.enc`, history file,
 * read-back, pin, `name/publish`, local state, journal removal, events. Any failure before `name/publish` leaves the
 * IPNS record as it was, and a rerun reconciles whatever was left on the node.
 */
async function runEncryptedPublish(deps: PublishDeps, options: PublishOptions): Promise<PublishResult> {
  const startedAt = deps.host.timeNow();
  const checked = await checkTarget(deps, options);
  const idle = await idlePublishResult(deps, options, checked);
  if (idle !== undefined) return idle;
  const session = await openSession(deps, options, checked);
  const assessed = await assessNode(deps, options, session);
  const plan = await planFor(deps, options, session, assessed);
  // Advisory (mvp-07a 3.1b): names this publish sends that another device's pull would refuse. It warns and never refuses.
  const warnings = [...assessed.warnings, ...adviseUnrestorablePaths(pathsToAdvise(plan), { extraExclusions: options.extraExclusions })];
  const nothingAtAll = plan.writes.length + plan.repairs.length + Object.keys(plan.kept).length === 0;
  if (nothingAtAll && (session.state === undefined || assessed.decision.repaired)) throw new EmptyVaultError();
  if (!hasWork(plan, session, assessed.decision, assessed.view)) return finishUnchanged(deps, session, plan, warnings);

  await guardMassRemoval(options, assessed, plan);
  await guardReupload(options, plan);
  const frame = await manifestFrame(deps, options, session, assessed.decision.nextSequence);
  await checkWriterCaps(session, plan, frame);
  // The run has work and nothing has been written yet: remember where the name stands, to compare right before `name/publish`.
  const nameStart = await recordNameStart(session, session.state === undefined && !assessed.nodeHasManifest);
  await assertManifestUnchanged(session, assessed);
  const sent = await transfer(deps, options, session, plan);
  const manifest = finalManifest(frame, await currentTreeCid(deps, session), plan.kept, sent.blobs);
  return commitAndAnnounce(deps, session, withoutTransferSkips(plan, sent.skipped), manifest, sent.blobs.length, startedAt, warnings, nameStart);
}

export function publishVault(deps: PublishDeps, options: PublishOptions): Promise<PublishResult> {
  return runEncryptedPublish(guardLocalWrites(deps, options.assertHeld), options);
}
