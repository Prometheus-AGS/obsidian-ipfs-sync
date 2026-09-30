import type { Bytes } from "../core/host-bridge";
import { CryptoError, type CryptoErrorCode } from "../crypto";
import type { CommitDeps, PublishTarget } from "./commit-ports";
import type { EncryptedManifest } from "./encrypted-manifest";
import { sha256Hex } from "./hash";
import { buildJournal, deleteJournal, writeJournal } from "./journal";
import { historyConflict } from "./publish-refusals";
import { buildRootState, writeRootState, type RootState } from "./root-state";
import { sameBytes } from "./same-bytes";

/**
 * The commit tail of an encrypted publish, from the journal to the local state. The order is fixed and every
 * step is one call on a port, so a failure (or a kill) after any step leaves a state that `resumeJournal` can
 * finish or reconcile:
 *
 *   journal, manifest.enc, history file, root CID, read-back, pin, name publish, local state, journal removal.
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
}

/** Crypto failures that mean "this file is not an authentic manifest of ours" (as opposed to a platform failure to be retried). */
const NOT_AUTHENTIC: ReadonlySet<CryptoErrorCode> = new Set([
  "authentication-failed",
  "malformed-input",
  "unsupported-format",
  "vault-mismatch",
  "oversize-input",
]);

/** Is `existing` a manifest that authenticates under our key, belongs to this vault and has a LOWER sequence? */
async function isOlderOwnManifest(deps: CommitDeps, existing: Bytes, manifest: EncryptedManifest): Promise<boolean> {
  try {
    const older = await deps.decodeManifest(existing);
    return older.vaultId === manifest.vaultId && older.sequence < manifest.sequence;
  } catch (error) {
    if (error instanceof CryptoError && NOT_AUTHENTIC.has(error.code)) return false;
    throw error;
  }
}

/**
 * Make sure the history file for this snapshot holds these bytes. Absent: write it. Equal: done. Different bytes
 * are replaced only when the existing file authenticates under our key, has the same vault and a lower sequence
 * (a tree that came back to an earlier CID, or a repair over an unchanged tree); anything else is refused, so a
 * planted file can never be replaced by, or replace, a manifest that is not ours.
 */
export async function ensureHistoryFile(deps: CommitDeps, manifest: EncryptedManifest, bytes: Bytes): Promise<void> {
  const existing = await deps.node.readHistoryFile(manifest.rootCID);
  if (existing !== undefined && sameBytes(existing, bytes)) return;
  if (existing !== undefined && !(await isOlderOwnManifest(deps, existing, manifest))) throw historyConflict();
  await deps.node.writeHistoryFile(manifest.rootCID, bytes);
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
  await deps.node.publishRoot(rootCid);
  const state = buildRootState({
    mfsRoot: pending.target.mfsRoot,
    key: pending.target.key,
    rootCid,
    vaultId: pending.target.vaultId,
    keyslotsSha256: pending.target.keyslotsSha256,
    sequence: pending.manifest.sequence,
    manifest: pending.manifest,
    mtimes: pending.mtimes,
  });
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
  const existing = await deps.node.readHistoryFile(manifest.rootCID);
  if (existing !== undefined && !sameBytes(existing, manifestFile) && !(await isOlderOwnManifest(deps, existing, manifest))) throw historyConflict();
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
    }),
  );
  await deps.node.writeManifestFile(manifestFile);
  await ensureHistoryFile(deps, manifest, manifestFile);
  return finishPublish(deps, pending);
}
