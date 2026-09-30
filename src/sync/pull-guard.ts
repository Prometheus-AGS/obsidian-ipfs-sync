import { FIXTURE_MARKER, FIXTURE_MARKER_VALUE, PULLED_MARKER_VALUE, type MarkerState } from "../core/config";
import type { HostFs } from "../core/host-bridge";
import { REMARK_PULL_HINT, enablesPull, legacyMarkerProblem, readLegacyMarker, readMarkerState } from "./fixture-marker";
import { PullGuardError } from "./pull-errors";
import { TEMP_DIR } from "./pull-fetch";
import { STATE_FOLDER } from "./manifest-paths";
import { findSymlink } from "./symlink-guard";

const MARKER_TEXT = `${PULLED_MARKER_VALUE}\n`;

export type GuardFs = Pick<HostFs, "stat" | "read" | "lstat" | "list" | "write">;

/** A marker file that exists but holds neither accepted word (an empty marker from an earlier release, or other text). */
async function refuseUnusableMarker(fs: GuardFs, state: MarkerState): Promise<void> {
  if (state !== "empty" && state !== "unrecognised") return;
  // A marker release 0.2.0 wrote or accepted gets its own message: it predates this version and must be re-marked deliberately.
  const legacy = await readLegacyMarker(fs);
  if (legacy !== undefined) throw new PullGuardError(`${legacyMarkerProblem(legacy)}. ${REMARK_PULL_HINT}`, "real-vault");
  throw new PullGuardError(
    `the ${FIXTURE_MARKER} marker is ${state === "empty" ? "empty" : "not one of the accepted words"}; it must hold the text "${FIXTURE_MARKER_VALUE}" or "${PULLED_MARKER_VALUE}"`,
    "real-vault",
  );
}

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
  const marker = await readMarkerState(fs);
  if (enablesPull(marker)) return { needsMarker: false };
  await refuseUnusableMarker(fs, marker);
  // The state folder holds the latch and the sync record, not notes: a destination that has only it is still empty.
  const entries = await fs.list("");
  if (entries.every((entry) => entry.name.toLowerCase() === STATE_FOLDER)) return { needsMarker: true };
  throw new PullGuardError(
    `this directory is not empty and has no ${FIXTURE_MARKER} marker. Pull of a real vault is not available in this build: it refuses encrypted roots, and decrypting pull arrives in a later release`,
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
  const marker = await readMarkerState(fs);
  if (enablesPull(marker)) return { needsMarker: false };
  await refuseUnusableMarker(fs, marker);
  if ((await firstNoteFile(fs)) === undefined) return { needsMarker: true };
  throw new PullGuardError(
    `this vault has files outside .obsidian/ and .ipfs-sync/ and no ${FIXTURE_MARKER} marker. Pull of a real vault is not available in this build: it refuses encrypted roots, and decrypting pull arrives in a later release`,
    "real-vault",
  );
}

/** Mark a freshly created destination as a pulled copy (`pulled-fixture`): later pulls are allowed, publishing is not. */
export async function writeFixtureMarker(fs: Pick<HostFs, "write">): Promise<void> {
  await fs.write(FIXTURE_MARKER, new TextEncoder().encode(MARKER_TEXT));
}
