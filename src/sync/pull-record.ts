import type { Manifest, ManifestFile } from "./manifest";
import { buildState, type LocalState } from "./state";

export interface RecordTarget {
  readonly mfsRoot: string;
  readonly key: string;
  /** CID of the published root the pull resolved. */
  readonly rootCid: string;
}

export interface MergeInput {
  /** The applicable record before the pull, or undefined when there was none. */
  readonly previous: LocalState | undefined;
  /** The manifest the pull applied. */
  readonly manifest: Manifest;
  readonly target: RecordTarget;
  /**
   * Paths whose local file now equals the manifest entry (fetched, replaced, conflict-replaced or
   * found unchanged), with the local modification time read after the write.
   */
  readonly synced: ReadonlyMap<string, number>;
}

/** Own-property lookup, so a path such as `constructor` cannot match an inherited member. */
function lookup<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The record after a pull: the selected manifest, with every path that is not now in sync (failed,
 * refused, locally modified) put back to its previous entry, or dropped when it had none. A conflict
 * path is in sync with the remote text (the local text lives in the copy), so it records the remote
 * sha256. Paths the manifest no longer lists are dropped. Modification times come from the caller.
 */
export function mergeRecord(input: MergeInput): LocalState {
  const { previous, manifest, target, synced } = input;
  // Built with fromEntries: a path named `__proto__` must become a key, never a prototype assignment.
  const fileEntries: (readonly [string, ManifestFile])[] = [];
  const mtimeEntries: (readonly [string, number])[] = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    const mtime = synced.get(path);
    if (mtime !== undefined) {
      fileEntries.push([path, entry]);
      mtimeEntries.push([path, mtime]);
      continue;
    }
    const kept = previous === undefined ? undefined : lookup(previous.manifest.files, path);
    if (kept === undefined) continue;
    fileEntries.push([path, kept]);
    const keptMtime = previous === undefined ? undefined : lookup(previous.mtimes, path);
    if (keptMtime !== undefined) mtimeEntries.push([path, keptMtime]);
  }
  return buildState({
    mfsRoot: target.mfsRoot,
    key: target.key,
    rootCid: target.rootCid,
    manifest: { ...manifest, files: Object.fromEntries(fileEntries) },
    mtimes: Object.fromEntries(mtimeEntries),
  });
}
