import { createExclusionMatcher, type ExclusionMatcher } from "./exclusions";
import { readJournal } from "./journal";
import { RootStateError } from "./local-record";
import { untrustedPathReason } from "./manifest-paths";
import { statIfPresent } from "./node-reader";
import { openPublicationKey } from "./publish-key";
import type { CheckedTarget } from "./publish-session";
import type { PublishDeps, PublishOptions, PublishResult } from "./publish-types";
import { readRootState, type RootState } from "./root-state";
import { scanVault, type ScannedFile } from "./scan";

/**
 * The keyless idle fast path (review-3 W-07). A timer tick on a vault that has not changed must not spend an
 * Argon2id derivation (64 MiB and several seconds on a phone) only to learn there is nothing to send. Before the
 * vault is unlocked, this checks what needs no key:
 *
 *  - a local record of a completed publish to this root, under this key, and no journal and no `--repair`;
 *  - the MFS root on the node has exactly the CID this device published last: a matching Merkle root proves the
 *    node holds what was published, manifest, history and blobs included;
 *  - the publication key exists and is owned (a read-only lookup);
 *  - the scanned vault matches the recorded manifest by path, size and modification time. No file is read or hashed
 *    here: a file that was touched, added, removed or that has no recorded time (one the host could not read) sends
 *    the run down the normal path, which hashes it and decides.
 *
 * Any doubt returns undefined and the normal path runs, which unlocks and decides. The check writes nothing.
 */

/**
 * Every scanned file has a manifest entry of the same size and a recorded modification time that equals its own, and nothing
 * else is recorded. Only materialized entries take part: a carried path (`unmaterialized`) is a path this device holds no
 * current copy of, so neither its entry nor a local file at that path counts. A carried path that the exclusion list matches
 * now, or whose shape is unsafe, is a pending change (the next publish drops it), so the record does not match.
 */
function matchesRecord(state: RootState, scanned: readonly ScannedFile[], excluded: ExclusionMatcher): boolean {
  const carried = new Set(state.unmaterialized);
  if (state.unmaterialized.some((path) => excluded(path) || untrustedPathReason(path) !== undefined)) return false;
  const present = scanned.filter((file) => !carried.has(file.path));
  const recorded = Object.keys(state.manifest.files).length - carried.size;
  if (present.length !== recorded) return false;
  return present.every((file) => {
    const entry = Object.hasOwn(state.manifest.files, file.path) ? state.manifest.files[file.path] : undefined;
    return entry !== undefined && entry.size === file.size && Object.hasOwn(state.mtimes, file.path) && state.mtimes[file.path] === file.mtimeMs;
  });
}

async function readRecord(deps: PublishDeps, checked: CheckedTarget): Promise<RootState | undefined> {
  try {
    const state = await readRootState(deps.host.kv, checked.mfsRoot);
    return state !== undefined && state.rootCid !== null && state.key === checked.keyName ? state : undefined;
  } catch (error) {
    if (error instanceof RootStateError) return undefined;
    throw error;
  }
}

export async function idlePublishResult(deps: PublishDeps, options: PublishOptions, checked: CheckedTarget): Promise<PublishResult | undefined> {
  if (options.repair === true) return undefined;
  const state = await readRecord(deps, checked);
  if (state === undefined || (await readJournal(deps.host.kv, checked.mfsRoot)).kind !== "none") return undefined;
  if ((await statIfPresent(deps.client, checked.mfsRoot))?.cid !== state.rootCid) return undefined;
  const key = await openPublicationKey(deps.client, checked.keyName, options.ownedKeys, options.recordOwnedKey);
  if (key.absent) return undefined;

  const excluded = createExclusionMatcher(options.extraExclusions);
  const scanned = await scanVault(deps.host.fs, excluded);
  if (!matchesRecord(state, scanned, excluded)) return undefined;
  return { published: false, written: 0, removed: 0, skipped: [], carried: state.unmaterialized, dropped: [], keyId: key.id(), keyCreated: false, anomalies: 0, warnings: [] };
}
