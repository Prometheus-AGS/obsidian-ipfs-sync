import { FIXTURE_MARKER } from "../core/config";
import type { HostFs } from "../core/host-bridge";
import { PullGuardError } from "./pull-errors";
import { TEMP_DIR } from "./pull-fetch";
import { findSymlink } from "./symlink-guard";

const MARKER_TEXT = "fixture copy created by ipfs-sync pull\n";

export type GuardFs = Pick<HostFs, "stat" | "lstat" | "list" | "write">;

/**
 * Plaintext guard (removed in mvp-06 with encryption). Pull writes only into a destination that is absent,
 * empty, or carries the fixture marker. A real vault is non-empty and unmarked, and is refused before any
 * request. The state folder must not be a symbolic link, because the record and temp files are written there.
 * Returns whether the marker still has to be created (absent or empty destination).
 */
export async function assertPullDestination(fs: GuardFs): Promise<{ readonly needsMarker: boolean }> {
  const root = await fs.stat("");
  if (root !== undefined && root.kind !== "directory") throw new PullGuardError("the destination exists and is not a directory");
  const link = await findSymlink(fs, TEMP_DIR);
  if (link !== undefined) throw new PullGuardError(`"${link}" is a symbolic link; pull will not write its state through it`);
  if (root === undefined) return { needsMarker: true };
  if ((await fs.stat(FIXTURE_MARKER))?.kind === "file") return { needsMarker: false };
  if ((await fs.list("")).length === 0) return { needsMarker: true };
  throw new PullGuardError(
    `encryption is not available yet, and this directory is not empty and has no ${FIXTURE_MARKER} marker`,
    "real-vault",
  );
}

/** Folders an application keeps in a vault root: they do not make a vault "real" (compared case-insensitively). */
const APPLICATION_FOLDERS: readonly string[] = [".obsidian", ".ipfs-sync"];

/** The first file anywhere outside the application folders, or undefined. Empty folders are ignored. */
async function firstNoteFile(fs: Pick<HostFs, "list">): Promise<string | undefined> {
  const pending: string[] = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await fs.list(dir)) {
      if (dir === "" && APPLICATION_FOLDERS.includes(entry.name.toLowerCase())) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.kind === "file") return path;
      pending.push(path);
    }
  }
  return undefined;
}

/**
 * The destination rule for a host whose root always holds application folders (an Obsidian vault has
 * `.obsidian/`), where "absent or empty" would refuse every fresh vault. Allowed: the fixture marker is present,
 * or there is no file outside `.obsidian/` and `.ipfs-sync/` (folders empty of files do not count); in the second
 * case the marker still has to be created. Anything else is a real vault and is refused before any request.
 * The state folder must not be a symbolic link, as for `assertPullDestination`.
 */
export async function assertVaultPullDestination(fs: GuardFs): Promise<{ readonly needsMarker: boolean }> {
  const root = await fs.stat("");
  if (root?.kind !== "directory") throw new PullGuardError("the destination is not a directory");
  const link = await findSymlink(fs, TEMP_DIR);
  if (link !== undefined) throw new PullGuardError(`"${link}" is a symbolic link; pull will not write its state through it`);
  if ((await fs.stat(FIXTURE_MARKER))?.kind === "file") return { needsMarker: false };
  if ((await firstNoteFile(fs)) === undefined) return { needsMarker: true };
  throw new PullGuardError(
    `encryption is not available yet, and this vault has files outside .obsidian/ and .ipfs-sync/ and no ${FIXTURE_MARKER} marker`,
    "real-vault",
  );
}

/** Mark a freshly created destination as a fixture copy so later pulls and publishes are allowed. */
export async function writeFixtureMarker(fs: Pick<HostFs, "write">): Promise<void> {
  await fs.write(FIXTURE_MARKER, new TextEncoder().encode(MARKER_TEXT));
}
