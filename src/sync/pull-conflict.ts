import type { HostFs } from "../core/host-bridge";
import { chooseConflictName } from "./conflict-name";
import { HASH_CHUNK_BYTES, SINGLE_READ_LIMIT_BYTES } from "./hash";
import { foldKey } from "./path-fold";
import { ConflictPreserveError } from "./pull-errors";
import { findSymlink } from "./symlink-guard";
import { TEMP_DIR, discardTemp } from "./temp-files";

export type PreserveFs = Pick<HostFs, "lstat" | "stat" | "read" | "readRange" | "write" | "append" | "rename" | "remove">;

/** Names a conflict copy must not take. A `Set<string>` satisfies it (the plaintext pull passes one of manifest paths). */
export interface ConflictReservations {
  has(name: string): boolean;
  add(name: string): unknown;
}

export interface PreserveContext {
  readonly fs: PreserveFs;
  readonly newId: () => string;
  /** `YYYY-MM-DD`, the pulling machine's local date. */
  readonly dateStamp: string;
  /** Names reserved against manifest paths plus the copy names handed out in this run, so two concurrent conflicts never pick the same name. */
  readonly reserved: ConflictReservations;
}

/**
 * The reserved set of the encrypted pull (mvp-07a task 4.5): every manifest path, compared by fold key. A conflict copy
 * that took the name of a file about to be fetched would be overwritten by it, and on a case-insensitive or
 * normalising volume `Note (ipfs conflict D).md` is the same file as `note (ipfs conflict D).md`, so an exact-string
 * set is not enough. Copy names handed out later are added under their fold key too.
 */
export function createConflictReservations(manifestPaths: Iterable<string>): ConflictReservations {
  const keyOf = (name: string): string => name.split("/").map(foldKey).join("/");
  const keys = new Set<string>();
  for (const path of manifestPaths) keys.add(keyOf(path));
  return {
    has: (name) => keys.has(keyOf(name)),
    add: (name) => keys.add(keyOf(name)),
  };
}

/** Reads of the local file for one conflict copy: the first, and one redo when the file changed while it was read. */
const COPY_ATTEMPTS = 2;

async function copyToTemp(fs: PreserveFs, from: string, temp: string, size: number): Promise<void> {
  if (size <= SINGLE_READ_LIMIT_BYTES) {
    await fs.write(temp, await fs.read(from));
    return;
  }
  await fs.write(temp, new Uint8Array(0));
  for (let offset = 0; offset < size; offset += HASH_CHUNK_BYTES) {
    await fs.append(temp, await fs.readRange(from, offset, Math.min(HASH_CHUNK_BYTES, size - offset)));
  }
}

/**
 * Preserve the local file at `path` next to itself under a free conflict name and return that name.
 * The bytes go to a temp file first and are renamed into place, so a crash leaves either nothing or a
 * whole copy. An existing file (or link) with the candidate name is never touched. The original is not
 * modified here; any failure leaves it as it was.
 */
export async function preserveLocalCopy(ctx: PreserveContext, path: string): Promise<string> {
  const { fs, reserved } = ctx;
  const temp = `${TEMP_DIR}/${ctx.newId()}.copy`;
  try {
    const link = await findSymlink(fs, path);
    if (link !== undefined) throw new Error(`"${link}" is a symbolic link`);
    let info = await fs.stat(path);
    if (info?.kind !== "file") throw new Error("the local file is gone");
    const copyPath = await chooseConflictName(path, ctx.dateStamp, async (candidate) => reserved.has(candidate) || (await fs.lstat(candidate)) !== undefined);
    reserved.add(copyPath);
    // The local file is looked at again after it is read and before the copy is renamed into place (final review A-05): an edit
    // saved in between is in neither the copy nor, after the replace, the vault. One change is redone (the usual case is a single
    // autosave and the new copy loses nothing); a second change means the file is being written to, so the replace is abandoned.
    for (let attempt = 1; ; attempt++) {
      await copyToTemp(fs, path, temp, info.size);
      const after = await fs.stat(path);
      if (after?.kind !== "file") throw new Error("the local file is gone");
      if (after.size === info.size && after.mtimeMs === info.mtimeMs) break;
      if (attempt === COPY_ATTEMPTS) throw new Error("the local file kept changing while it was being copied");
      info = after;
    }
    await fs.rename(temp, copyPath);
    return copyPath;
  } catch (error) {
    await discardTemp(fs, temp);
    throw new ConflictPreserveError(path, error);
  }
}

/** Fixed reason text for a path whose replace was aborted because its conflict copy could not be written. It names no path. */
export const CONFLICT_COPY_FAILED_REASON = "could not write a conflict copy; the local file was left as it was";

export type PreserveResult =
  | { readonly ok: true; readonly copyPath: string }
  | { readonly ok: false; readonly reason: string; readonly cause: unknown };

/**
 * `preserveLocalCopy` with a refusal as data: the replace of `path` must not go ahead when the copy cannot be made (a
 * name the host rejects, a full disk, a link in the way). The caller then discards the verified temp file, leaves the
 * local file as it is and counts the path `unfetched` with `reason`. Only a `ConflictPreserveError` becomes data; any other
 * error is a fault of the environment and propagates.
 */
export async function tryPreserveLocalCopy(ctx: PreserveContext, path: string): Promise<PreserveResult> {
  try {
    return { ok: true, copyPath: await preserveLocalCopy(ctx, path) };
  } catch (error) {
    if (error instanceof ConflictPreserveError) return { ok: false, reason: CONFLICT_COPY_FAILED_REASON, cause: error.cause };
    throw error;
  }
}
