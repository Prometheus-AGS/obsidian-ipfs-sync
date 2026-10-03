import type { Bytes } from "../core/host-bridge";
import { CryptoError, type CryptoErrorCode } from "../crypto";
import type { CommitDeps, NameStart, PublishTarget } from "./commit-ports";
import type { EncryptedManifest } from "./encrypted-manifest";
import { sha256Hex } from "./hash";
import { buildJournal, deleteJournal, writeJournal } from "./journal";
import { RootStateError } from "./local-record";
import { manifestIdentity } from "./manifest-identity";
import { NameMovedError, assertNoLaterPublication } from "./name-recheck";
import { PublishRefusedError, floorNotRecorded, historyConflict } from "./publish-refusals";
import { buildRootState, publishedFields, readRootState, writeRootState, type RootState } from "./root-state";
import { sameBytes } from "./same-bytes";

/**
 * The commit tail of an encrypted publish, from the journal to the local state. The order is fixed and every
 * step is one call on a port, so a failure (or a kill) after any step leaves a state that `resumeJournal` can
 * finish or reconcile:
 *
 *   journal, manifest.enc, history file, root CID, read-back, pin, name re-check and name publish, sequence floor, local state, journal removal.
 *
 * Before `manifest.enc` is written, the file already there is read and decoded: if it authenticates for this vault at this
 * publish's sequence or a later one and is not this publish's own manifest, another publisher completed since this publish took its
 * decision, and the publish stops with `overlapping-publish` without writing to the node (review-final A-01). The journal, written
 * first, stays; the next pull sets it aside.
 *
 * A refused name re-check (`overlapping-publish`) can still undo a step: a `manifest.enc` this publish overwrote is put back, but only
 * when it is byte-equal to the `manifest.enc` inside the root the failed check resolved (review-final A-03); the publisher classifies the
 * node by that file and a winner's publication must stay recognisable. A failing withdrawal never replaces the refusal.
 * The journal and the history file stay; the next pull sets the journal aside.
 *
 * `manifest.enc` is written BEFORE its history file: a history file for a manifest that is not on the node
 * would be a claim the node does not back. The pin and the name publication use exactly the root CID that was
 * read back, never the MFS path. Any failure before the name publication leaves the IPNS record unchanged.
 */

export interface PendingPublish {
  readonly target: PublishTarget;
  readonly manifest: EncryptedManifest;
  /** The exact bytes of the encrypted manifest. */
  readonly manifestFile: Bytes;
  readonly mtimes: Readonly<Record<string, number>>;
  /** The root last published by this device, kept in the state written when the publish completes. */
  readonly previousRootCid: string | null;
  /** Paths of `manifest.files` copied unchanged from the node (this device holds no current copy). Empty until the carry-forward plan supplies it. */
  readonly unmaterialized?: readonly string[];
  /**
   * What the publication name pointed at when this publish started (see `name-recheck.ts`). It goes into the journal as
   * `startRoot` and is checked again right before `name/publish`. Left out only by callers that exercise the commit
   * protocol alone: the journal then records "no record" and the node port reads nothing.
   */
  readonly nameStart?: NameStart;
}

/** Crypto failures that mean "this file is not an authentic manifest of ours" (as opposed to a platform failure to be retried). */
const NOT_AUTHENTIC: ReadonlySet<CryptoErrorCode> = new Set([
  "authentication-failed",
  "malformed-input",
  "unsupported-format",
  "vault-mismatch",
  "oversize-input",
]);

/**
 * Is `existing` a manifest that authenticates under our key and is this one in everything the history file claims: the
 * same vault, the same sequence and the same manifest identity? Only a resume that encrypted the same manifest again
 * produces such a file with other bytes.
 */
async function isSameOwnManifest(deps: CommitDeps, existing: Bytes, manifest: EncryptedManifest): Promise<boolean> {
  try {
    const found = await deps.decodeManifest(existing);
    return found.vaultId === manifest.vaultId && found.sequence === manifest.sequence && manifestIdentity(found) === manifestIdentity(manifest);
  } catch (error) {
    if (error instanceof CryptoError && NOT_AUTHENTIC.has(error.code)) return false;
    throw error;
  }
}

/**
 * Make sure the history file for this snapshot holds these bytes. The name carries the sequence, so two sequences
 * over one tree have two files. Absent: write it. Equal: done. Different bytes are replaced only when the existing
 * file authenticates under our key and has the same vault, sequence and manifest identity (a resume that encrypted
 * the same manifest again); anything else is refused, so a planted file can never be replaced by, or replace, a
 * manifest that is not ours.
 */
export async function ensureHistoryFile(deps: CommitDeps, manifest: EncryptedManifest, bytes: Bytes): Promise<void> {
  const existing = await deps.node.readHistoryFile(manifest.sequence, manifest.rootCID);
  if (existing !== undefined && sameBytes(existing, bytes)) return;
  if (existing !== undefined && !(await isSameOwnManifest(deps, existing, manifest))) throw historyConflict();
  await deps.node.writeHistoryFile(manifest.sequence, manifest.rootCID, bytes);
}

/**
 * The state this publish builds on: whatever the state file holds for this root and vault right now. A state that
 * does not decode is treated as absent: that happens under `--repair`, which continues without the unusable record
 * (the publish session does the same), and the new state then starts with no previous identity.
 */
async function baselineOf(deps: CommitDeps, target: PublishTarget): Promise<RootState | undefined> {
  try {
    const state = await readRootState(deps.kv, target.mfsRoot);
    return state?.vaultId === target.vaultId ? state : undefined;
  } catch (error) {
    if (error instanceof RootStateError) return undefined;
    throw error;
  }
}

/**
 * Raise the sequence floor after the name was published. A failure here (a device-store lock wait that timed out, a write that failed)
 * must not be reported as "nothing was written": the publication happened. It is mapped to `floor-not-recorded`, which says so and says
 * that the next run completes it; the raise is not moved ahead of the publication (review-final N-04). The state is unwritten and the
 * journal stays, so the next run finishes this same record.
 */
async function raiseFloorAfterPublish(deps: CommitDeps, state: RootState): Promise<void> {
  try {
    await deps.floor?.raise(state.vaultId, state.highestSequence, state.highestIdentity);
  } catch (error) {
    if (error instanceof PublishRefusedError) throw error;
    throw floorNotRecorded(state.sequence, error instanceof Error ? error.message : "the floor write failed", error);
  }
}

/**
 * Read back, pin, publish, then record the local state and drop the journal. Used by a fresh publish and by a
 * resumed one. The journal is removed only after the state is written, so a kill between the two leaves a
 * journal whose sequence equals the state's, which resume recognises as finished.
 */
export async function finishPublish(deps: CommitDeps, pending: PendingPublish): Promise<RootState> {
  const rootCid = await deps.node.rootCid();
  await deps.verifySnapshot(rootCid, { manifest: pending.manifest, manifestFile: pending.manifestFile });
  await deps.node.pinRoot(rootCid);
  await deps.node.publishRoot(rootCid, pending.nameStart);
  const baseline = await baselineOf(deps, pending.target);
  const state = buildRootState({
    mfsRoot: pending.target.mfsRoot,
    key: pending.target.key,
    rootCid,
    vaultId: pending.target.vaultId,
    keyslotsSha256: pending.target.keyslotsSha256,
    sequence: pending.manifest.sequence,
    manifest: pending.manifest,
    ...publishedFields(baseline, pending.manifest, pending.unmaterialized ?? []),
    mtimes: pending.mtimes,
  });
  // The floor first, then the state: a crash between the two leaves the floor ahead of the state, the direction that only makes a later pull stricter.
  // This is the one place that raises it for a publication, so a fresh and a resumed publish both do; `adopt` (publish-resume.ts) does not.
  await raiseFloorAfterPublish(deps, state);
  await writeRootState(deps.kv, state);
  await deleteJournal(deps.kv, pending.target.mfsRoot);
  return state;
}

/**
 * Commit a publish whose blobs are already on the node and whose manifest is built and encrypted. Refuses
 * before writing anything when the history file for this snapshot already holds different bytes.
 */
export async function commitPublish(deps: CommitDeps, pending: PendingPublish): Promise<RootState> {
  const { target, manifest, manifestFile } = pending;
  // Refuse before anything is written when the history file cannot be written later (a planted or foreign file).
  const existing = await deps.node.readHistoryFile(manifest.sequence, manifest.rootCID);
  if (existing !== undefined && !sameBytes(existing, manifestFile) && !(await isSameOwnManifest(deps, existing, manifest))) throw historyConflict();
  await writeJournal(
    deps.kv,
    buildJournal({
      mfsRoot: target.mfsRoot,
      key: target.key,
      vaultId: target.vaultId,
      keyslotsSha256: target.keyslotsSha256,
      sequence: manifest.sequence,
      manifestSha256: await sha256Hex(manifestFile),
      pending: { manifest, mtimes: pending.mtimes },
      startedAt: new Date(deps.now()).toISOString(),
      startRoot: pending.nameStart?.root ?? null,
    }),
  );
  const previous = await deps.node.readManifestFile();
  assertNoLaterPublication(previous === undefined ? undefined : await decodeIfAuthentic(deps, previous), manifest);
  await deps.node.writeManifestFile(manifestFile);
  try {
    await ensureHistoryFile(deps, manifest, manifestFile);
    return await finishPublish(deps, pending);
  } catch (error) {
    // The name moved: another device published, and this publish stays unpublished. If its `manifest.enc` replaced a file that the moved name
    // points at, it must not stay where the publisher classifies the node, or both devices would see a fork at this sequence for good.
    // The refusal is what the caller must see: a withdrawal that fails (a write refused, a gateway that does not answer) is dropped, and the
    // next pull and the resume rules deal with whatever stayed on the node.
    if (error instanceof NameMovedError) await withdrawManifestFile(deps, manifest, manifestFile, previous, error.movedTo).catch(() => undefined);
    throw error;
  }
}


/**
 * Put back the manifest this publish overwrote, when that manifest is another publisher's: it authenticates under our key and
 * carries this publish's sequence or a later one, so the name moved because that publisher completed. Anything older (or
 * absent, or unreadable) was not a publication this one lost to, and stays as this publish left it: the interrupted-publish
 * rules (resume, name re-check) already refuse the rerun. Only a file that still holds exactly the bytes this publish wrote is
 * replaced, so a manifest written since stays. Nothing is removed; the one path is the fixed `<mfsRoot>/manifest.enc`, and the
 * bytes written are the ones read from it before this publish's own write.
 *
 * A node can serve any genuine older manifest of this vault as `previous`, so `previous` is also matched to the root the failed name
 * re-check resolved (`movedTo`): it is put back only when it is byte-equal to the `manifest.enc` inside that immutable root. The read and
 * the write below are two calls, not one atomic step: a third publisher's file written between them is replaced.
 */
async function withdrawManifestFile(deps: CommitDeps, manifest: EncryptedManifest, written: Bytes, previous: Bytes | undefined, movedTo: string | null): Promise<void> {
  if (previous === undefined || movedTo === null) return;
  const found = await decodeIfAuthentic(deps, previous);
  if (found === undefined || found.vaultId !== manifest.vaultId || found.sequence < manifest.sequence) return;
  const inMovedRoot = await deps.node.readManifestFileAt(movedTo);
  if (inMovedRoot === undefined || !sameBytes(inMovedRoot, previous)) return;
  const now = await deps.node.readManifestFile();
  if (now !== undefined && sameBytes(now, written)) await deps.node.writeManifestFile(previous);
}

async function decodeIfAuthentic(deps: CommitDeps, bytes: Bytes): Promise<EncryptedManifest | undefined> {
  try {
    return await deps.decodeManifest(bytes);
  } catch (error) {
    if (error instanceof CryptoError && NOT_AUTHENTIC.has(error.code)) return undefined;
    throw error;
  }
}
