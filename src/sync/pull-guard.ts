import type { HostFs } from "../core/host-bridge";
import { PullGuardError } from "./pull-errors";
import { assertStateFolderSafe } from "./state-folder-guard";

// The pull side of the former fixture policy (mvp-07b tasks 3.2 and 6.2). The guard is removed: a pull is allowed into
// any directory, subject to the existing conflict policy, and it writes no marker. Every export name and signature of
// the earlier module is kept so that callers do not change. The checks that are not fixture policy stay: the
// destination must be a directory, and the state folder must not be a symbolic link (`state-folder-guard.ts`, which the
// pull engine also calls as its first step, whatever these functions do).

export type GuardFs = Pick<HostFs, "stat" | "read" | "lstat" | "list" | "write">;

/** The plugin's notice for a refused pull. Kept for the callers; the marker refusal it described no longer exists. */
export const FIXTURE_ONLY_PULL_NOTICE = "IPFS Sync: pull was refused. Nothing was sent to the node and no file changed.";

/** The `pull` paragraph of the CLI help. */
export const PULL_SCOPE_HELP = "Any directory can be pulled into.";

/**
 * The destination rule of the CLI and the default of the engine. Permissive since the guard removal: every directory
 * is allowed and no marker is ever needed, so it always answers `{ needsMarker: false }`. It still refuses a
 * destination that exists and is not a directory, and a state folder that is a symbolic link.
 */
export async function assertPullDestination(fs: GuardFs): Promise<{ readonly needsMarker: boolean }> {
  const root = await fs.stat("");
  if (root !== undefined && root.kind !== "directory") throw new PullGuardError("the destination exists and is not a directory");
  await assertStateFolderSafe(fs);
  return { needsMarker: false };
}

/**
 * The destination rule for a host whose root always holds application folders (an Obsidian vault has `.obsidian/`).
 * Permissive since the guard removal, as `assertPullDestination`: the same two structural refusals, never a marker.
 */
export async function assertVaultPullDestination(fs: GuardFs): Promise<{ readonly needsMarker: boolean }> {
  const root = await fs.stat("");
  if (root?.kind !== "directory") throw new PullGuardError("the destination is not a directory");
  await assertStateFolderSafe(fs);
  return { needsMarker: false };
}

/** Does nothing since the guard removal: a pull writes no marker, and the marker file has no meaning. */
export async function writeFixtureMarker(_fs: Pick<HostFs, "write">): Promise<void> {
  // Intentionally empty: the signature is kept for the pull stage.
}
