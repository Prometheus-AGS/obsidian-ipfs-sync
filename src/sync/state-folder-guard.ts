import type { HostFs } from "../core/host-bridge";
import { PullGuardError } from "./pull-errors";
import { findSymlink } from "./symlink-guard";
import { TEMP_DIR } from "./temp-files";

export type StateFolderFs = Pick<HostFs, "lstat">;

/**
 * Pull writes its record and temp files under the state folder, so no prefix of it may be a symbolic link.
 * This is a safety check, not fixture policy: it is called by the pull engine as its first step, independent of
 * the destination policy functions, and by those functions too. Throws `PullGuardError`.
 */
export async function assertStateFolderSafe(fs: StateFolderFs): Promise<void> {
  const link = await findSymlink(fs, TEMP_DIR);
  if (link !== undefined) throw new PullGuardError(`"${link}" is a symbolic link; pull will not write its state through it`);
}
