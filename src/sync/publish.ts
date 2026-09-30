import type { SyncEventBus } from "../core/events";
import { encodeManifestFile, type EncryptedManifest } from "./encrypted-manifest";
import { removeBlobPaths, writeEncryptedBlobs, writeKeySlotsFile, type TransferContext, type WrittenBlob } from "./encrypted-transfer";
import { createExclusionMatcher, excludesHash } from "./exclusions";
import { idlePublishResult } from "./idle-check";
import { assertHistoryReady } from "./history-gate";
import { assertRootLayout, statIfPresent, type RootView } from "./node-reader";
import { deleteJournal } from "./journal";
import { guardLocalWrites } from "./guarded-kv";
import { isUnreadableManifest } from "./manifest-auth";
import { EmptyVaultError } from "./publish-errors";
import { commitPublish } from "./publish-commit";
import { finalManifest, provisionalManifest, sanitizeDevice, type ManifestFrame } from "./publish-manifest";
import { buildPublishPlan, type PublishPlan } from "./publish-plan";
import { largeReupload, remoteObjectInvalid, rootCidNotV1 } from "./publish-refusals";
import { checkTarget, openSession, type PublishSession } from "./publish-session";
import { decideSequence, type SequenceDecision } from "./publish-sequence";
import type { PublishDeps, PublishOptions, PublishResult } from "./publish-types";
import { buildRootState, writeRootState } from "./root-state";
import { scanVault } from "./scan";

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
}

/** The node's `manifest.enc`: absent, present and authentic, or present and unreadable (does not authenticate, or cut short). */
async function readNodeManifest(session: PublishSession): Promise<{ readonly manifest: EncryptedManifest | undefined; readonly unreadable: boolean }> {
  const raw = await session.commit.node.readManifestFile();
  if (raw === undefined) return { manifest: undefined, unreadable: false };
  try {
    return { manifest: await session.commit.decodeManifest(raw), unreadable: false };
  } catch (error) {
    if (isUnreadableManifest(error)) return { manifest: undefined, unreadable: true };
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

/** Read the node's manifest and layout, then decide where the publish starts (sequence rules, --repair). */
async function assessNode(deps: PublishDeps, options: PublishOptions, session: PublishSession): Promise<NodeAssessment> {
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
  });
  // A journal that --repair set aside and that no repair then took over is obsolete (the record moved on): drop it.
  if (session.journalDeferred && !decision.repaired) await deleteJournal(deps.host.kv, session.target.mfsRoot);
  const warnings = await assertHistoryReady(deps.client, options, session);
  return { decision, view, warnings };
}

/**
 * Is there anything to send? Changes are one reason. The others are states this device must not leave as they are: a
 * repair, a new key, a root never published, and a root whose CID is not the one this device last published (an
 * interrupted publish whose pending state was adopted, or anything else that changed the snapshot without a publication).
 */
function hasWork(plan: PublishPlan, session: PublishSession, decision: SequenceDecision, view: RootView): boolean {
  const changed = plan.writes.length + plan.repairs.length + plan.blobRemovals.length + plan.removedPaths.length > 0;
  const unpublished = session.state === undefined || session.state.rootCid === null || session.state.rootCid !== view.rootCid;
  return changed || decision.repaired || session.key.absent || unpublished;
}

async function guardReupload(options: PublishOptions, plan: PublishPlan): Promise<void> {
  if (plan.repairBytes <= FULL_REUPLOAD_LIMIT_BYTES || options.allowFullReupload === true) return;
  if (options.confirmFullReupload !== undefined && (await options.confirmFullReupload(plan.repairBytes))) return;
  throw largeReupload(plan.repairBytes);
}

async function manifestFrame(deps: PublishDeps, options: PublishOptions, session: PublishSession, sequence: number): Promise<ManifestFrame> {
  return {
    vaultId: session.opened.vaultId,
    sequence,
    publishedAt: new Date(deps.host.timeNow()).toISOString(),
    device: sanitizeDevice(deps.host.envRead(DEVICE_ENV)),
    excludesHash: await excludesHash(options.extraExclusions ?? []),
  };
}

/**
 * Serialise and encrypt the manifest the publish will write, with placeholders for what only exists after the
 * uploads, and refuse (a typed error naming the cap or the format) before ANY blob is written.
 */
async function checkWriterCaps(session: PublishSession, plan: PublishPlan, frame: ManifestFrame): Promise<void> {
  const planned = [...plan.writes, ...plan.repairs.map((job) => ({ path: job.path, size: job.size, sha256: UNKNOWN_SHA256 }))];
  await encodeManifestFile(session.opened.keys, await provisionalManifest(session.opened.keys, frame, plan.kept, planned));
}

/** Upload, verify and remove; returns the blobs written. */
async function transfer(deps: PublishDeps, options: PublishOptions, session: PublishSession, plan: PublishPlan): Promise<readonly WrittenBlob[]> {
  const ctx: TransferContext = {
    client: deps.client,
    fs: deps.host.fs,
    keys: session.opened.keys,
    mfsRoot: session.target.mfsRoot,
    concurrency: options.concurrency,
    beforeWrite: session.beforeWrite,
  };
  session.beforeWrite();
  await session.key.ensure();
  if (session.opened.writeKeySlotsToNode) await writeKeySlotsFile(ctx, session.opened.keySlots);
  const jobs = [...plan.writes.map((write) => ({ path: write.path, size: write.size })), ...plan.repairs];
  const blobs = await writeEncryptedBlobs(ctx, jobs);
  for (const blob of blobs) session.written.set(blob.blob, blob.cid);
  await removeBlobPaths(ctx, plan.blobRemovals);
  return blobs;
}

async function currentTreeCid(deps: PublishDeps, session: PublishSession): Promise<string> {
  const stat = await statIfPresent(deps.client, `${session.target.mfsRoot}/current`);
  if (stat === undefined) throw remoteObjectInvalid("current/");
  if (!ROOT_CID_V1.test(stat.cid)) throw rootCidNotV1();
  return stat.cid;
}

function emitChanges(bus: SyncEventBus, plan: PublishPlan): void {
  for (const write of plan.writes) bus.emit("file.changed", { path: write.path, kind: write.kind, sha256: write.sha256 });
  for (const path of plan.removedPaths) bus.emit("file.changed", { path, kind: "removed" });
}

function summary(session: PublishSession, plan: PublishPlan, written: number, warnings: readonly string[]): Pick<PublishResult, "written" | "removed" | "skipped" | "keyId" | "keyCreated" | "anomalies" | "warnings"> {
  return {
    warnings, written, removed: plan.removedPaths.length, skipped: plan.skipped, keyId: session.key.id(), keyCreated: session.key.created(), anomalies: plan.anomalies.length };
}

/** Nothing to send. New modification times of touched-but-identical files are remembered so the next run skips hashing them. */
async function finishUnchanged(deps: PublishDeps, session: PublishSession, plan: PublishPlan, warnings: readonly string[]): Promise<PublishResult> {
  if (plan.hashed > 0 && session.state !== undefined) await writeRootState(deps.host.kv, buildRootState({ ...session.state, mtimes: plan.mtimes }));
  return { ...summary(session, plan, 0, warnings), published: false };
}

async function planFor(deps: PublishDeps, options: PublishOptions, session: PublishSession, assessed: NodeAssessment): Promise<PublishPlan> {
  const scanned = await scanVault(deps.host.fs, createExclusionMatcher(options.extraExclusions));
  return buildPublishPlan({
    keys: session.opened.keys,
    fs: deps.host.fs,
    client: deps.client,
    mfsRoot: session.target.mfsRoot,
    scanned,
    baseline: assessed.decision.baseline,
    view: assessed.view,
    concurrency: options.concurrency,
  });
}

/** Journal, manifest.enc, history file, read-back, pin, name publication and the local record; then the events. */
async function commitAndAnnounce(deps: PublishDeps, session: PublishSession, plan: PublishPlan, manifest: EncryptedManifest, written: number, startedAt: number, warnings: readonly string[]): Promise<PublishResult> {
  const { file } = await encodeManifestFile(session.opened.keys, manifest);
  const state = await commitPublish(session.commit, {
    target: session.target,
    manifest,
    manifestFile: file,
    mtimes: plan.mtimes,
    previousRootCid: session.state?.rootCid ?? null,
  });
  const rootCid = state.rootCid ?? "";
  emitChanges(deps.bus, plan);
  deps.bus.emit("publish.complete", { rootCid, manifestCid: manifest.rootCID, written, removed: plan.removedPaths.length, durationMs: deps.host.timeNow() - startedAt });
  return { ...summary(session, plan, written, warnings), published: true, rootCid, currentCid: manifest.rootCID, sequence: manifest.sequence };
}

/**
 * Delta publish of the vault behind `deps.host`, always encrypted. Order: fixture marker, passphrase, local record,
 * unlock, publication key lookup, interrupted-publish resume, node manifest and layout, sequence rules, scan and
 * diff, diagnosis of the node's `current/`, writer-side cap check, publication key creation and key slots (first
 * publish), blob writes (verified), blob removals, tree CID, manifest, journal, `manifest.enc`, history file,
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
  const nothingAtAll = plan.writes.length + plan.repairs.length + Object.keys(plan.kept).length === 0;
  if (nothingAtAll && (session.state === undefined || assessed.decision.repaired)) throw new EmptyVaultError();
  if (!hasWork(plan, session, assessed.decision, assessed.view)) return finishUnchanged(deps, session, plan, assessed.warnings);

  await guardReupload(options, plan);
  const frame = await manifestFrame(deps, options, session, assessed.decision.nextSequence);
  await checkWriterCaps(session, plan, frame);
  const blobs = await transfer(deps, options, session, plan);
  const manifest = finalManifest(frame, await currentTreeCid(deps, session), plan.kept, blobs);
  return commitAndAnnounce(deps, session, plan, manifest, blobs.length, startedAt, assessed.warnings);
}

export function publishVault(deps: PublishDeps, options: PublishOptions): Promise<PublishResult> {
  return runEncryptedPublish(guardLocalWrites(deps, options.assertHeld), options);
}
