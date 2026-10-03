import type { Bytes } from "../core/host-bridge";
import type { CommitDeps, PublishTarget } from "./commit-ports";
import { sha256Hex } from "./hash";
import { deleteJournal, readJournal, writeJournal, type PublishJournal } from "./journal";
import { isUnreadableManifest } from "./manifest-auth";
import { assertNameStillAt } from "./name-recheck";
import { sameManifest } from "./local-manifest";
import { ensureHistoryFile, finishPublish } from "./publish-commit";
import {
  PublishRefusedError,
  ReadBackError,
  journalConflict,
  journalManifestMismatch,
  journalOutOfStep,
  journalMismatch,
  nodeManifestMissing,
  sequenceAhead,
} from "./publish-refusals";
import { buildRootState, publishedFields, writeRootState, type RootState } from "./root-state";

/**
 * Resume rules for an interrupted publish (spec: encrypted-publish, "Interrupted publishes resume"). The journal
 * was written before `manifest.enc`; the node tells which step the process died after.
 *
 *  - no journal                                        -> nothing to do
 *  - journal unreadable                                -> discard it (it is written before the manifest, so a
 *                                                         torn one means the manifest was not written; if the
 *                                                         node is ahead anyway, the sequence rules refuse and
 *                                                         name --repair)
 *  - local state already at the journal's sequence     -> only the journal removal was missing: remove it
 *  - node sequence is the journal's minus one          -> the manifest was never written: discard the journal
 *  - node sequence equals the journal's and the hash   -> decrypt, require vaultId, sequence, rootCID and the file
 *    of manifest.enc equals the journal's                 map to equal the journal's pending manifest, write the
 *                                                         history file from the node's bytes if absent (a file
 *                                                         with other bytes is replaced only if it authenticates
 *                                                         and has this vault, sequence and manifest identity, else
 *                                                         refused), read back, pin, publish,
 *                                                         record the state, drop the journal (completed)
 *  - ... but `current` is not the manifest's rootCID   -> adopt the pending state at the journal's sequence, drop
 *    or the read-back fails                               the journal; the caller runs the drift path at
 *                                                         sequence + 1 (adopted). Never a lockout.
 *  - node manifest.enc does not authenticate (a write   -> encrypt journal.pending.manifest again, record its hash in
 *    cut short)                                          the journal, write it, and finish as above
 *  - anything else                                     -> refuse, naming --repair
 *
 * Before any of the finishing or adopting paths above (and before the manifest is written again), the publication name is
 * read (`name-recheck.ts`) and compared with the root the interrupted publish started from (`startRoot` of a format 2
 * journal, the state's `rootCid` for a format 1 one). A name that moved is `overlapping-publish`: nothing is adopted or
 * published and the journal stays; the next pull sets it aside. A name that cannot be read is `name-routing-failed`.
 *
 * The journal names the publication key it was going to use, and it must be the one this run verified (`target.key`): a
 * pending manifest is never published under another key. The key is looked up again right before `name/publish`.
 */

export type ResumeOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "discarded"; readonly why: "never-written" | "damaged" }
  /** The state was already at the journal's sequence; the leftover journal was removed. */
  | { readonly kind: "settled"; readonly state: RootState }
  /** The interrupted publish was finished: the node holds it and it is pinned and published. */
  | { readonly kind: "completed"; readonly state: RootState }
  /** The pending state is now the local state; run the normal drift path at `state.sequence + 1`. */
  | { readonly kind: "adopted"; readonly state: RootState }
  /**
   * `--repair` was asked for and the journal cannot be reconciled by resume (one of the refusals below). The journal is
   * left where it is: the sequence rules and `authorizeRepair` decide, and only they may delete it.
   */
  | { readonly kind: "deferred"; readonly code: string; /** The sequence the journal carries. */ readonly sequence: number };

/** The refusals a repair can lift: the node and this device disagree about the interrupted publish. */
const REPAIRABLE: ReadonlySet<string> = new Set(["journal-conflict", "journal-manifest-mismatch", "sequence-ahead", "node-manifest-missing"]);

export interface ResumeInput {
  readonly target: PublishTarget;
  /** `--repair` was passed: a repairable refusal is deferred to the repair action instead of thrown. */
  readonly repair?: boolean;
  /** The local state for this root, if any. */
  readonly state: RootState | undefined;
}

function assertJournalMatches(journal: PublishJournal, target: PublishTarget): void {
  if (journal.mfsRoot !== target.mfsRoot) throw journalMismatch("root");
  if (journal.vaultId !== target.vaultId) throw journalMismatch("vault");
  if (journal.keyslotsSha256 !== target.keyslotsSha256) throw journalMismatch("key slots");
  if (journal.key !== target.key) throw journalMismatch("publication key");
}

/** Paths the baseline did not hold that the pending manifest still lists: carried entries stay carried. */
function stillUnmaterialized(baseline: RootState | undefined, pending: PublishJournal["pending"]["manifest"]): readonly string[] {
  return (baseline?.unmaterialized ?? []).filter((path) => Object.prototype.hasOwnProperty.call(pending.files, path));
}

/**
 * Adopt the journal's pending manifest as the local state. `highest*` rise to it (the state claims its sequence, and
 * `highestSequence >= sequence` must hold); the sequence floor is not written here, only by a completed publish or a pull.
 */
async function adopt(deps: CommitDeps, input: ResumeInput, journal: PublishJournal): Promise<ResumeOutcome> {
  const state = buildRootState({
    mfsRoot: input.target.mfsRoot,
    key: input.target.key,
    rootCid: input.state?.rootCid ?? null,
    vaultId: journal.vaultId,
    keyslotsSha256: journal.keyslotsSha256,
    sequence: journal.sequence,
    manifest: journal.pending.manifest,
    ...publishedFields(input.state, journal.pending.manifest, stillUnmaterialized(input.state, journal.pending.manifest)),
    mtimes: journal.pending.mtimes,
  });
  // State first, journal second: a kill between the two leaves a journal at the state's sequence, which settles.
  await writeRootState(deps.kv, state);
  await deleteJournal(deps.kv, input.target.mfsRoot);
  return { kind: "adopted", state };
}

async function settle(deps: CommitDeps, state: RootState, journal: PublishJournal): Promise<ResumeOutcome> {
  if (!sameManifest(state.manifest, journal.pending.manifest)) throw journalManifestMismatch(journal.sequence, "content");
  await deleteJournal(deps.kv, journal.mfsRoot);
  return { kind: "settled", state };
}

async function discard(deps: CommitDeps, journal: PublishJournal, why: "never-written" | "damaged"): Promise<ResumeOutcome> {
  await deleteJournal(deps.kv, journal.mfsRoot);
  return { kind: "discarded", why };
}

/** The node holds the manifest the journal announced: finish it, or adopt the pending state when the snapshot cannot be trusted. */
async function finishOrAdopt(deps: CommitDeps, input: ResumeInput, journal: PublishJournal, raw: Bytes, startRoot: string | null): Promise<ResumeOutcome> {
  const manifest = journal.pending.manifest;
  try {
    await ensureHistoryFile(deps, manifest, raw);
  } catch (error) {
    // A history file someone else put at this sequence's name is a fact about the snapshot, not a reason to keep the journal:
    // adopt, and the run continues at the next sequence, whose own name is checked by `commitPublish` before it writes a journal
    // or manifest.enc, so no journal is left to wedge on. The planted file stays where it is until the operator removes it.
    if (error instanceof PublishRefusedError && error.code === "history-conflict") return adopt(deps, input, journal);
    throw error;
  }
  if ((await deps.node.currentCid()) !== manifest.rootCID) return adopt(deps, input, journal);
  try {
    const state = await finishPublish(deps, {
      target: input.target,
      manifest,
      manifestFile: raw,
      mtimes: journal.pending.mtimes,
      previousRootCid: input.state?.rootCid ?? null,
      unmaterialized: stillUnmaterialized(input.state, manifest),
      // The name is read once more right before `name/publish`, against the root the interrupted run started from.
      nameStart: { root: startRoot, firstPublish: false },
    });
    return { kind: "completed", state };
  } catch (error) {
    if (error instanceof ReadBackError) return adopt(deps, input, journal);
    throw error;
  }
}

/**
 * The node's `manifest.enc` does not authenticate while a journal is waiting: the write of the pending manifest was most
 * likely cut short. The journal holds the manifest this publish was going to write, so it is encrypted again and
 * written (journal first: its hash is updated to the new file), and the publish then finishes as usual.
 */
async function rewriteFromJournal(deps: CommitDeps, input: ResumeInput, journal: PublishJournal, startRoot: string | null): Promise<ResumeOutcome> {
  // Before anything is written: the unreadable file may be another device's write, and the name says whether another device published.
  await assertNameStillAt(deps.node, startRoot, false);
  const file = await deps.encodeManifest(journal.pending.manifest);
  // The journal is written again, so it is brought to format 2 here, with the start root this resume compared against.
  await writeJournal(deps.kv, { ...journal, manifestSha256: await sha256Hex(file), startRoot });
  await deps.node.writeManifestFile(file);
  return finishOrAdopt(deps, input, journal, file, startRoot);
}

async function reconcile(deps: CommitDeps, input: ResumeInput, journal: PublishJournal): Promise<ResumeOutcome> {
  const { state } = input;
  if (state !== undefined && state.sequence > journal.sequence) throw journalConflict(journal.sequence, state.sequence);
  if (state !== undefined && state.sequence === journal.sequence) return settle(deps, state, journal);

  const raw = await deps.node.readManifestFile();
  if (raw === undefined) {
    if (journal.sequence === 1) return discard(deps, journal, "never-written");
    throw nodeManifestMissing();
  }
  // Where the name stood when the interrupted publish started; a format 1 journal did not record it, so the local state's root stands in.
  const startRoot = journal.startRoot !== undefined ? journal.startRoot : (state?.rootCid ?? null);
  let node: Awaited<ReturnType<CommitDeps["decodeManifest"]>>;
  try {
    node = await deps.decodeManifest(raw);
  } catch (error) {
    if (!isUnreadableManifest(error)) throw error;
    return rewriteFromJournal(deps, input, journal, startRoot);
  }
  if (node.vaultId !== journal.vaultId) throw journalMismatch("vault");
  if (node.sequence === journal.sequence - 1) return discard(deps, journal, "never-written");
  if (node.sequence > journal.sequence) throw sequenceAhead(node.sequence, state?.sequence);
  if (node.sequence < journal.sequence) throw journalOutOfStep(journal.sequence, node.sequence);
  // The node holds a manifest at the journal's sequence. Whether it is ours or another device's, the name decides before anything is adopted
  // or published: a name that moved means another device published, and this device must neither adopt over its manifest nor publish.
  const ours = (await sha256Hex(raw)) === journal.manifestSha256;
  await assertNameStillAt(deps.node, startRoot, ours);
  if (!ours) throw journalManifestMismatch(journal.sequence, "different-manifest");
  if (!sameManifest(node, journal.pending.manifest)) throw journalManifestMismatch(journal.sequence, "content");
  return finishOrAdopt(deps, input, journal, raw, startRoot);
}

/**
 * Reconcile an interrupted publish before anything else in a publish run. Call it after the vault is unlocked
 * (it must authenticate the node's manifest) and before the sequence rules and the baseline check.
 */
export async function resumeJournal(deps: CommitDeps, input: ResumeInput): Promise<ResumeOutcome> {
  const read = await readJournal(deps.kv, input.target.mfsRoot);
  if (read.kind === "none") return { kind: "none" };
  if (read.kind === "damaged") {
    await deleteJournal(deps.kv, input.target.mfsRoot);
    return { kind: "discarded", why: "damaged" };
  }
  assertJournalMatches(read.journal, input.target);
  try {
    return await reconcile(deps, input, read.journal);
  } catch (error) {
    if (input.repair === true && error instanceof PublishRefusedError && REPAIRABLE.has(error.code)) return { kind: "deferred", code: error.code, sequence: read.journal.sequence };
    throw error;
  }
}
