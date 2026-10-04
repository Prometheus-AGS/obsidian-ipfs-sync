import type { HostFs } from "../core/host-bridge";
import { hashFile } from "./hash";
import { FileChangedDuringReadError, HostReadCapError } from "./host-errors";
import type { ScannedFile } from "./scan";

/** What change detection needs of the last published record: the plaintext hash and size per path, and the mtimes. */
export interface DeltaEntry {
  readonly sha256: string;
  readonly size: number;
}

export interface DeltaBaseline<E extends DeltaEntry = DeltaEntry> {
  readonly manifest: { readonly files: Readonly<Record<string, E>> };
  readonly mtimes: Readonly<Record<string, number>>;
}

/** A file that must be written to the node. */
export interface PendingWrite {
  readonly path: string;
  readonly kind: "added" | "modified";
  readonly sha256: string;
  readonly size: number;
}

export interface DeltaPlan<E extends DeltaEntry = DeltaEntry> {
  /** New or changed files, in path order. */
  readonly writes: readonly PendingWrite[];
  /** Files already on the node with the same content, as their manifest entries. */
  readonly unchanged: Readonly<Record<string, E>>;
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
  /**
   * The baseline's entries for the carried paths (paths this device could not restore, see `planDelta`'s `carried`
   * option), as they are. They are neither classified against a local file nor reported in `removed`.
   */
  readonly carried: Readonly<Record<string, E>>;
}

export interface DeltaOptions {
  readonly singleReadLimit?: number;
  /**
   * Paths of the baseline whose content this device does not hold at that version (`RootState.unmaterialized`). A
   * carried path that is in the baseline is not compared with a local file (none is hashed, none can be a write),
   * is not in `removed` and is returned in `carried` with the baseline's entry. A path that is not in the baseline is
   * not carried: it is an ordinary file.
   */
  readonly carried?: ReadonlySet<string>;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

type Classified<E extends DeltaEntry> =
  | { readonly kind: "unchanged"; readonly file: ScannedFile; readonly entry: E; readonly hashed: boolean }
  | { readonly kind: "write"; readonly file: ScannedFile; readonly write: PendingWrite }
  | { readonly kind: "skipped"; readonly file: ScannedFile; readonly reason: string; readonly entry: E | undefined };

/** Own-property lookup, so a vault file named `constructor` cannot match an inherited member. */
function lookup<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

async function classify<E extends DeltaEntry>(
  fs: Pick<HostFs, "read" | "readRange">,
  file: ScannedFile,
  previous: DeltaBaseline<E> | undefined,
  singleReadLimit: number | undefined,
): Promise<Classified<E>> {
  const entry = lookup(previous?.manifest.files, file.path);
  if (entry !== undefined && entry.size === file.size && lookup(previous?.mtimes, file.path) === file.mtimeMs) {
    return { kind: "unchanged", file, entry, hashed: false };
  }
  let sha256: string;
  try {
    sha256 = await hashFile(fs, file.path, file.size, singleReadLimit);
  } catch (error) {
    // A file over the read cap, or one that changed while it was read, is left out of this run (and uploaded whole by the next).
    if (error instanceof HostReadCapError || error instanceof FileChangedDuringReadError) return { kind: "skipped", file, reason: error.message, entry };
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
export async function planDelta<E extends DeltaEntry = DeltaEntry>(
  fs: Pick<HostFs, "read" | "readRange">,
  scanned: readonly ScannedFile[],
  previous: DeltaBaseline<E> | undefined,
  options: DeltaOptions = {},
): Promise<DeltaPlan<E>> {
  const carriedEntries = carriedFrom(previous, options.carried);
  const classified: Classified<E>[] = [];
  // A carried path is never read: this device holds no current copy, so a local file there is not an edit to publish.
  for (const file of scanned) if (!Object.hasOwn(carriedEntries, file.path)) classified.push(await classify(fs, file, previous, options.singleReadLimit));

  const present = new Set(scanned.map((file) => file.path));
  const removed = Object.keys(previous?.manifest.files ?? {})
    .filter((path) => !present.has(path) && !Object.hasOwn(carriedEntries, path))
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
    // A carried path keeps none either: the state holds no mtime for a file this device did not write.
    mtimes: Object.fromEntries(
      scanned.filter((file) => !isSkipped.has(file.path) && !Object.hasOwn(carriedEntries, file.path)).map((file) => [file.path, file.mtimeMs] as const),
    ),
    hashed: classified.filter((item) => item.kind === "write" || (item.kind === "unchanged" && item.hashed)).length,
    skipped,
    carried: carriedEntries,
  };
}

/** The baseline's entry for each requested carried path that the baseline actually holds. */
function carriedFrom<E extends DeltaEntry>(previous: DeltaBaseline<E> | undefined, carried: ReadonlySet<string> | undefined): Readonly<Record<string, E>> {
  if (previous === undefined || carried === undefined) return {};
  return Object.fromEntries([...carried].sort().flatMap((path) => {
    const entry = lookup(previous.manifest.files, path);
    return entry === undefined ? [] : [[path, entry] as const];
  }));
}
