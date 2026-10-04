import type { Bytes, HostKv } from "../core/host-bridge";
import { parseKeySlots } from "../crypto";
import type { NameStart, PublishTarget, SnapshotExpectation } from "./commit-ports";
import type { EncryptedManifest } from "./encrypted-manifest";
import { sha256Hex } from "./hash";
import {
  advance,
  reached,
  rewrapBytes,
  writeMaintenanceJournal,
  type MaintenanceFacts,
  type MaintenanceJournal,
  type PruneJournal,
  type RewrapJournal,
} from "./maintenance-journal";
import type { MaintenanceNode } from "./maintenance-node";
import { NameMovedError, assertNameUnmoved, readNameStart, rootOfReading } from "./name-recheck";
import { PublishRefusedError, maintenanceLostRace, overlappingPublish, publicationKeyMissing } from "./publish-refusals";
import type { PublicationKey } from "./publish-key";
import { buildRootState, readRootState, writeRootState, type RootState } from "./root-state";
import { sameBytes } from "./same-bytes";
import type { FloorEntry } from "./sequence-floor";
import { assertUpToDate } from "./up-to-date-check";

/**
 * The republish primitive of key management (mvp-07b design decision 4): the one implementation of "change the shared MFS tree, then publish
 * the result under the same sequence". A rewrap changes `keyslots.json`; a prune removes history files. `manifest.enc` and the sequence are never
 * touched, so there is no new manifest, no history file and no floor raise: only the root CID changes.
 *
 * The caller (a command) takes `publish.lock`, runs `beginMaintenance`, writes the journal at `journaled` and calls `driveMaintenance`. The
 * primitive then performs, each step recorded as a phase in `maintenance.<h>.json` BEFORE the next one starts:
 *
 *   rewrap: journaled -> file-written    (keyslots.json written)
 *   prune:  journaled -> removing        (the named history files removed, one segment at a time)
 *   both:   -> snapshotted (root CID of the MFS tree) -> read-back through /ipfs/<root>, pin, name re-check, name/publish
 *           -> state.rootCid written -> published
 *
 * The caller finishes: a rewrap writes its local copy and `keyslotsSha256` (phase `local-updated`) and removes the journal; a prune removes it.
 *
 * A rerun reads the phase. Before `snapshotted` it requires that the name still points where the operation started and that `manifest.enc` is
 * still the file it was based on (the 07a A-01 guards), and that the node's `keyslots.json` is the old or the new bytes; anything else is a lost race,
 * refused with `maintenance-lost-race` (it names `keys discard` and `keys accept-slots`). From `snapshotted` it works on the recorded snapshot
 * root only: the root is read back and pinned again (idempotent), and a name that already points at it means `name/publish` happened, so nothing is
 * published twice.
 *
 * Lost race (`NameMovedError`): the loser has already changed the shared tree. 07a withdrew its `manifest.enc` write (D-1); the same is done here for a
 * rewrap's `keyslots.json`: when the tree still holds exactly this rewrap's pending bytes, the file inside the root the name now points at is written
 * back (a valid key-slot file of the same vault only), so the winner's next publish does not find a file that is not its copy. A prune adds nothing
 * back: the history files it removed are in the earlier pinned roots, and the next publish from any device will publish without them. The refusal says so.
 * A failing withdrawal never replaces the refusal. This is not a compare-and-swap: kubo has none, and a write race on the shared tree is not detected at all.
 */

export interface RepublishDeps {
  readonly node: MaintenanceNode;
  /** The device-local record store. The caller wraps it with the lock check (`guardLocalWrites`) the way a publish does. */
  readonly kv: Pick<HostKv, "get" | "set" | "delete">;
  /** Authenticate and decode `manifest.enc` under the unlocked vault keys; throws when it does not authenticate. */
  readonly decodeManifest: (bytes: Bytes) => Promise<EncryptedManifest>;
  /**
   * Read the snapshot back through the immutable root and throw `ReadBackError` on any mismatch: `createSnapshotVerifier` with the `keyslots.json` the
   * snapshot must hold (the NEW bytes for a rewrap, the current copy for a prune). A prune composes it with its own check of the names it removed.
   */
  readonly verifySnapshot: (rootCid: string, expected: SnapshotExpectation) => Promise<void>;
}

export interface BeginInput {
  readonly target: PublishTarget;
  /** This device's record of the root (`readRootState`). */
  readonly state: RootState | undefined;
  /** The device's floor for the vault (`readFloor`); undefined when the host keeps none. */
  readonly floor: FloorEntry | undefined;
  /** From `openPublicationKey`; an absent key refuses (its `ensure()` would create one, which a rewrap or a prune never does). */
  readonly key: Pick<PublicationKey, "absent">;
  /** ISO-8601 UTC time for the journal. */
  readonly startedAt: string;
}

export interface MaintenanceStart {
  /** What the journal of either operation records; give it to `buildRewrapJournal` or `buildPruneJournal`. */
  readonly facts: MaintenanceFacts;
  readonly manifest: EncryptedManifest;
  /** The exact `manifest.enc` the operation is based on. */
  readonly manifestFile: Bytes;
  readonly state: RootState;
}

/**
 * Everything a rewrap or a prune checks before it writes a journal, in the order that matters: the publication key exists; the device is up to
 * date and not below its floor (`assertUpToDate`); the publication name is read; and `manifest.enc` is read AGAIN and compared byte for byte with
 * the first read. Without the second read, a publisher that completed between the first read and the name start would be republished under this
 * device's pin (07a review-final A-01). Writes nothing.
 */
export async function beginMaintenance(deps: Pick<RepublishDeps, "node" | "decodeManifest">, input: BeginInput): Promise<MaintenanceStart> {
  if (input.key.absent) throw publicationKeyMissing(input.target.key);
  const upToDate = await assertUpToDate({ node: deps.node, decodeManifest: deps.decodeManifest, state: input.state, floor: input.floor });
  const nameStart = await readNameStart(deps.node, false);
  const again = await deps.node.readManifestFile();
  if (again === undefined || !sameBytes(again, upToDate.manifestFile)) throw overlappingPublish();
  const facts: MaintenanceFacts = {
    mfsRoot: input.target.mfsRoot,
    key: input.target.key,
    vaultId: input.target.vaultId,
    keyslotsSha256: input.target.keyslotsSha256,
    startRoot: nameStart.root,
    nodeSequence: upToDate.manifest.sequence,
    manifestSha256: await sha256Hex(upToDate.manifestFile),
    startedAt: input.startedAt,
  };
  return { facts, manifest: upToDate.manifest, manifestFile: upToDate.manifestFile, state: upToDate.state };
}

export interface DriveOutcome {
  readonly kind: "published";
  /** The journal at phase `published`. */
  readonly journal: MaintenanceJournal;
  /** The root CID that was read back, pinned and published; `state.rootCid` is this value. */
  readonly snapshotRoot: string;
}

async function persist(deps: Pick<RepublishDeps, "kv">, journal: MaintenanceJournal): Promise<MaintenanceJournal> {
  await writeMaintenanceJournal(deps.kv, journal);
  return journal;
}

/** The root the publication name points at now (`null` for no record). Throws the routing refusal when the name cannot be read. */
async function currentName(deps: Pick<RepublishDeps, "node">): Promise<string | null> {
  return rootOfReading(await deps.node.resolveName(), false);
}

function isKeySlotsOfVault(bytes: Bytes, vaultId: string): boolean {
  try {
    return parseKeySlots(bytes).vaultId === vaultId;
  } catch {
    return false;
  }
}

/**
 * Put the shared tree's `keyslots.json` back to the file inside `publishedRoot` (the root the name points at), but only when the tree still holds
 * exactly this rewrap's pending bytes and the published file is a different, valid key-slot file of the same vault. Returns whether a file was
 * written. A prune has nothing to put back. This device's own snapshot is never a reason to withdraw.
 */
async function withdrawTo(deps: Pick<RepublishDeps, "node">, journal: MaintenanceJournal, publishedRoot: string | null): Promise<boolean> {
  if (journal.type !== "rewrap" || publishedRoot === null || publishedRoot === journal.snapshotRoot) return false;
  const { newKeySlots } = rewrapBytes(journal);
  const now = await deps.node.readKeySlotsFile();
  if (now === undefined || !sameBytes(now, newKeySlots)) return false;
  const published = await deps.node.readKeySlotsFileAt(publishedRoot);
  if (published === undefined || sameBytes(published, newKeySlots) || !isKeySlotsOfVault(published, journal.vaultId)) return false;
  await deps.node.writeKeySlotsFile(published);
  return true;
}

/**
 * What `keys discard` calls before it removes a rewrap journal: take this rewrap's pending `keyslots.json` back out of the shared tree when it is
 * still there and the operation did not publish. Returns whether a file was written; `false` also for a prune and for a journal at `published` or later
 * (that file is the published one). It reads the name; errors from the node propagate.
 */
export async function withdrawMaintenanceWrite(deps: Pick<RepublishDeps, "node">, journal: MaintenanceJournal): Promise<boolean> {
  if (journal.type !== "rewrap" || reached(journal, "published")) return false;
  return withdrawTo(deps, journal, await currentName(deps));
}

/** The refusal for a lost race, after a best-effort withdrawal that can never replace it. */
async function lost(deps: Pick<RepublishDeps, "node">, journal: MaintenanceJournal, publishedRoot: string | null, cause?: unknown): Promise<PublishRefusedError> {
  const withdrawn = await withdrawTo(deps, journal, publishedRoot).catch(() => false);
  return maintenanceLostRace(journal.type, { withdrawn, ...(cause === undefined ? {} : { cause }) });
}

/** Before the first change (and on every rerun before `snapshotted`): the name is where the operation started, and `manifest.enc` is the file it was based on. */
async function assertStillBased(deps: RepublishDeps, journal: MaintenanceJournal): Promise<void> {
  const now = await currentName(deps);
  if (now !== journal.startRoot) throw await lost(deps, journal, now);
  const file = await deps.node.readManifestFile();
  if (file === undefined || (await sha256Hex(file)) !== journal.manifestSha256) throw await lost(deps, journal, now);
}

async function applyRewrap(deps: RepublishDeps, journal: RewrapJournal): Promise<MaintenanceJournal> {
  const { oldKeySlots, newKeySlots } = rewrapBytes(journal);
  const found = await deps.node.readKeySlotsFile();
  if (found === undefined || !sameBytes(found, newKeySlots)) {
    // Only the first write may start from the old bytes; at `file-written` the file must be ours, or someone else wrote since.
    const startsFromOld = journal.phase === "journaled" && found !== undefined && sameBytes(found, oldKeySlots);
    if (!startsFromOld) throw await lost(deps, journal, journal.startRoot);
    await deps.node.writeKeySlotsFile(newKeySlots);
  }
  return journal.phase === "journaled" ? persist(deps, advance(journal, "file-written")) : journal;
}

async function applyPrune(deps: RepublishDeps, journal: PruneJournal): Promise<MaintenanceJournal> {
  const removing = journal.phase === "journaled" ? await persist(deps, advance(journal, "removing")) : journal;
  for (const name of journal.removals) await deps.node.removeHistoryFile(name);
  return removing;
}

async function takeSnapshot(deps: RepublishDeps, journal: MaintenanceJournal): Promise<MaintenanceJournal> {
  const root = await deps.node.rootCid();
  return persist(deps, advance(journal, "snapshotted", root));
}

/**
 * Read back, pin, re-check the name, publish. Works on the recorded snapshot root only. A name that already points at it means a previous attempt
 * published: nothing is published again (the read-back and the pin are repeated; both are idempotent).
 */
async function publishSnapshot(deps: RepublishDeps, journal: MaintenanceJournal): Promise<void> {
  const root = journal.snapshotRoot as string;
  const named = await currentName(deps);
  if (named !== root) {
    // Not published yet: the name must still be where the operation started, and the tree must still be the snapshot that will be published.
    if (named !== journal.startRoot || (await deps.node.rootCid()) !== root) throw await lost(deps, journal, named);
  }
  const manifestFile = await deps.node.readManifestFileAt(root);
  if (manifestFile === undefined || (await sha256Hex(manifestFile)) !== journal.manifestSha256) throw await lost(deps, journal, named);
  await deps.verifySnapshot(root, { manifest: await deps.decodeManifest(manifestFile), manifestFile });
  await deps.node.pinRoot(root);
  const start: NameStart = { root: journal.startRoot, firstPublish: false };
  try {
    const reading = await deps.node.resolveName();
    if (rootOfReading(reading, false) === root) return;
    assertNameUnmoved(start, reading, root);
    await deps.node.publishRoot(root, start);
  } catch (error) {
    if (error instanceof NameMovedError) throw await lost(deps, journal, error.movedTo, error);
    throw error;
  }
}

/**
 * The root CID of this device's record becomes the published root (07b task 1.3): `state.rootCid` is "the CID last published by this device", and
 * the idle check, the publish baseline and the pull read it. Left alone, the next publish on every device would see a root that is not the recorded
 * one, write a no-change manifest and a history file, and spend the budget the history cap protects. Sequence, `highestSequence` and identities
 * are not touched. A record that belongs to another vault is refused.
 */
async function recordRootCid(deps: Pick<RepublishDeps, "kv">, journal: MaintenanceJournal, root: string): Promise<void> {
  const state = await readRootState(deps.kv, journal.mfsRoot);
  if (state === undefined || state.vaultId !== journal.vaultId) {
    throw new PublishRefusedError(
      "journal-mismatch",
      "the local record for this root is missing or belongs to another vault than the pending key-management operation; nothing was changed. Run the keys discard action, then check the vault.",
    );
  }
  if (state.rootCid !== root) await writeRootState(deps.kv, buildRootState({ ...state, rootCid: root }));
}

async function recordPublished(deps: RepublishDeps, journal: MaintenanceJournal): Promise<DriveOutcome> {
  const root = journal.snapshotRoot as string;
  await recordRootCid(deps, journal, root);
  const done = reached(journal, "published") ? journal : await persist(deps, advance(journal, "published"));
  return { kind: "published", journal: done, snapshotRoot: root };
}

/**
 * Run a maintenance journal forward to `published`: fresh from `journaled`, or resumed at any phase. Idempotent at `published` and later (it only
 * makes sure the state records the root). Throws `maintenance-lost-race` when another device got in the way, `ReadBackError` when the snapshot is
 * not what the operation wrote (the journal stays at `snapshotted`; a rerun reads it back again), and whatever the node or the lock check throws.
 */
export async function driveMaintenance(deps: RepublishDeps, journal: MaintenanceJournal): Promise<DriveOutcome> {
  if (reached(journal, "published")) return recordPublished(deps, journal);
  let current = journal;
  if (!reached(current, "snapshotted")) {
    await assertStillBased(deps, current);
    current = current.type === "rewrap" ? await applyRewrap(deps, current) : await applyPrune(deps, current);
    current = await takeSnapshot(deps, current);
  }
  await publishSnapshot(deps, current);
  return recordPublished(deps, current);
}
