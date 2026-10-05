import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { HostPathError } from "../src/sync/host-errors";
import { STATE_FOLDER } from "../src/sync/manifest-paths";
import { UsageError } from "./args";
import { assertParentInsideRoot } from "./realpath-guard";

/**
 * The state folder (`<vault>/.ipfs-sync`) holds the sequence record, the journal, the key-slot copy and the publish lock. If it is a
 * symbolic link, every write below it lands where the link points, and the `chmod` that keeps the folder owner-only changes the target.
 * Pull has always refused it (`src/sync/state-folder-guard.ts`); every other command, the key-value store and the lock file refuse it here
 * (review round 3, C-M3).
 *
 * Two checks, because each misses a case the other catches: the folder itself must not be a link (a link to a folder inside the vault
 * passes containment), and its real path must lie inside the vault's real path (a link component above it).
 */

const LINKED = "the state folder is a symbolic link, so ipfs-sync will not read or write its state through it";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Throws `HostPathError` unless `<root>/.ipfs-sync` is absent or a real directory inside the vault root. */
export async function assertStateFolderUnlinked(root: string): Promise<void> {
  const folder = join(root, STATE_FOLDER);
  const info = await lstat(folder).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (info?.isSymbolicLink() === true) throw new HostPathError(STATE_FOLDER, LINKED);
  await assertParentInsideRoot(root, join(folder, "state"), STATE_FOLDER);
}

/** The command-line form: the same refusal as a usage error (exit 2), raised before any request or write. */
export async function refuseLinkedStateFolder(root: string): Promise<void> {
  try {
    await assertStateFolderUnlinked(root);
  } catch (error) {
    if (error instanceof HostPathError) throw new UsageError(`${error.message}; nothing was sent and nothing was written`);
    throw error;
  }
}
