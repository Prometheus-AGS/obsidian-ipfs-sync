import type { HostFs } from "../core/host-bridge";
import { chooseConflictName } from "./conflict-name";
import { HASH_CHUNK_BYTES, SINGLE_READ_LIMIT_BYTES } from "./hash";
import { ConflictPreserveError } from "./pull-errors";
import { TEMP_DIR, discardTemp } from "./pull-fetch";
import { findSymlink } from "./symlink-guard";

export type PreserveFs = Pick<HostFs, "lstat" | "stat" | "read" | "readRange" | "write" | "append" | "rename" | "remove">;

export interface PreserveContext {
  readonly fs: PreserveFs;
  readonly newId: () => string;
  /** `YYYY-MM-DD`, the pulling machine's local date. */
  readonly dateStamp: string;
  /** Copy names handed out in this run, so two concurrent conflicts never pick the same name. */
  readonly reserved: Set<string>;
}

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
    const info = await fs.stat(path);
    if (info?.kind !== "file") throw new Error("the local file is gone");
    const copyPath = await chooseConflictName(path, ctx.dateStamp, async (candidate) => reserved.has(candidate) || (await fs.lstat(candidate)) !== undefined);
    reserved.add(copyPath);
    await copyToTemp(fs, path, temp, info.size);
    await fs.rename(temp, copyPath);
    return copyPath;
  } catch (error) {
    await discardTemp(fs, temp);
    throw new ConflictPreserveError(path, error);
  }
}
