import type { HostFs } from "../core/host-bridge";
import { hashFile } from "./hash";
import { HostReadCapError } from "./host-errors";
import type { ManifestFile } from "./manifest";
import type { ScannedFile } from "./scan";
import type { LocalState } from "./state";

/** A file that must be written to the node. */
export interface PendingWrite {
  readonly path: string;
  readonly kind: "added" | "modified";
  readonly sha256: string;
  readonly size: number;
}

export interface DeltaPlan {
  /** New or changed files, in path order. */
  readonly writes: readonly PendingWrite[];
  /** Files already on the node with the same content, as their manifest entries. */
  readonly unchanged: Readonly<Record<string, ManifestFile>>;
  /** Paths in the last manifest that are gone locally or now excluded. */
  readonly removed: readonly string[];
  /** Modification time of every current file, for the next run's pre-filter. */
  readonly mtimes: Readonly<Record<string, number>>;
  /** How many files had to be hashed (zero for an untouched vault). */
  readonly hashed: number;
  /**
   * Files the host refused to read because they exceed its read cap. Not written and not removed: a file that
   * was published before keeps its previous entry, so the node is never told it was deleted.
   */
  readonly skipped: readonly SkippedFile[];
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

type Classified =
  | { readonly kind: "unchanged"; readonly file: ScannedFile; readonly entry: ManifestFile; readonly hashed: boolean }
  | { readonly kind: "write"; readonly file: ScannedFile; readonly write: PendingWrite }
  | { readonly kind: "skipped"; readonly file: ScannedFile; readonly reason: string; readonly entry: ManifestFile | undefined };

/** Own-property lookup, so a vault file named `constructor` cannot match an inherited member. */
function lookup<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

async function classify(
  fs: Pick<HostFs, "read" | "readRange">,
  file: ScannedFile,
  previous: LocalState | undefined,
): Promise<Classified> {
  const entry = lookup(previous?.manifest.files, file.path);
  if (entry !== undefined && entry.size === file.size && lookup(previous?.mtimes, file.path) === file.mtimeMs) {
    return { kind: "unchanged", file, entry, hashed: false };
  }
  let sha256: string;
  try {
    sha256 = await hashFile(fs, file.path, file.size);
  } catch (error) {
    if (error instanceof HostReadCapError) return { kind: "skipped", file, reason: error.message, entry };
    throw error;
  }
  if (entry !== undefined && entry.sha256 === sha256) return { kind: "unchanged", file, entry, hashed: true };
  return { kind: "write", file, write: { path: file.path, kind: entry === undefined ? "added" : "modified", sha256, size: file.size } };
}

/**
 * Compare the scanned vault with the last published record. A file whose size and
 * mtime match the record is trusted without hashing; otherwise it is hashed and
 * transfers only if the sha256 differs. Files are hashed one at a time so memory
 * stays bounded on mobile.
 */
export async function planDelta(
  fs: Pick<HostFs, "read" | "readRange">,
  scanned: readonly ScannedFile[],
  previous: LocalState | undefined,
): Promise<DeltaPlan> {
  const classified: Classified[] = [];
  for (const file of scanned) classified.push(await classify(fs, file, previous));

  const present = new Set(scanned.map((file) => file.path));
  const removed = Object.keys(previous?.manifest.files ?? {})
    .filter((path) => !present.has(path))
    .sort();
  const kept = classified.flatMap((item) => {
    if (item.kind === "unchanged") return [[item.file.path, item.entry] as const];
    return item.kind === "skipped" && item.entry !== undefined ? [[item.file.path, item.entry] as const] : [];
  });
  const skipped = classified.flatMap((item) => (item.kind === "skipped" ? [{ path: item.file.path, reason: item.reason }] : []));
  const isSkipped = new Set(skipped.map((item) => item.path));
  return {
    writes: classified.flatMap((item) => (item.kind === "write" ? [item.write] : [])),
    unchanged: Object.fromEntries(kept),
    removed,
    // A skipped file keeps no new mtime, so the next run hashes it again instead of trusting a stale record.
    mtimes: Object.fromEntries(scanned.filter((file) => !isSkipped.has(file.path)).map((file) => [file.path, file.mtimeMs] as const)),
    hashed: classified.filter((item) => item.kind === "write" || (item.kind === "unchanged" && item.hashed)).length,
    skipped,
  };
}
