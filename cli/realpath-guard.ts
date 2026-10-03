import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { HostPathError } from "../src/sync/host-errors";
import { STATE_FOLDER } from "../src/sync/manifest-paths";
import { foldKey } from "../src/sync/path-fold";

/**
 * Realpath containment for the Node CLI (mvp-07 task 3.2, path-hardening spec "Containment on the file system").
 *
 * Before the host creates, writes, renames (or removes) a path, the real path of the destination's PARENT
 * directory must lie inside the real path of the vault root. This closes the case the `lstat` prefix walk
 * (`src/sync/symlink-guard.ts`) cannot: a directory component that is a symlink the walk never saw, or a
 * check that ran earlier than the write.
 *
 * Scope and residual (stated, not hidden):
 * - Node has no `openat`/`O_NOFOLLOW` on directory components, so the check and the later `mkdir`/`open`/`rename`
 *   are separate system calls. Another process that swaps a directory for a symlink between them wins the race.
 *   This guard narrows the window to one realpath call; it does not close it. It is defence in depth behind the
 *   prefix walk and the single-writer vault lock, not a TOCTOU-free primitive.
 * - The vault root itself may be a symlink (the operator's choice, as `findSymlink` documents): containment is
 *   measured against the realpath of the root, so a symlinked root is followed once, at the top.
 * - Only the PARENT is resolved. A destination that is itself a symlink is not followed by `rename` (it is
 *   replaced) and is the prefix walk's concern.
 * - The Obsidian adapter has no `realpath` and cannot see symlinks; this guard does not run there.
 */

const REFUSAL_OUTSIDE = "its parent directory resolves outside the vault root";
const REFUSAL_PROTECTED = "its parent directory resolves into a protected folder (.obsidian, .ipfs-sync or .git) that the path was not addressed to";

/**
 * Top-level folders a destination must not reach through a link: the Obsidian configuration folder (plugins and settings run as
 * code), the state folder and the VCS folder. Compared by fold key, so a case or look-alike spelling on a case-insensitive volume
 * matches. The CLI has no other configuration folder name; the plugin does not run this guard.
 */
const PROTECTED_FOLDER_KEYS: readonly string[] = [".obsidian", STATE_FOLDER, ".git"].map(foldKey);

/** The first segment of a relative path, `undefined` for the empty path. */
function firstSegment(relativePath: string): string | undefined {
  return relativePath.split(/[\\/]/).find((segment) => segment !== "" && segment !== ".");
}
const REFUSAL_DANGLING = "a parent directory is a symbolic link that does not resolve";
const REFUSAL_LOOP = "a parent directory is part of a symbolic link loop";

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** `candidate` is the root or lies below it, compared on real (symlink-free) absolute paths. */
export function isInside(realRoot: string, candidate: string): boolean {
  const rel = relative(realRoot, candidate);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The realpath of `path`, `undefined` when it does not exist (or a component is not a directory), a refusal for a link loop. */
async function realpathIfPresent(path: string, displayPath: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ELOOP") throw new HostPathError(displayPath, REFUSAL_LOOP);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return undefined;
  }
}

/**
 * The realpath of `directory`, or of its nearest existing ancestor when it does not exist yet (a create makes
 * the missing parents, so the first existing one is the directory the new tree would hang from). A component
 * that exists as a symbolic link but does not resolve is refused: `mkdir -p` and `open` could follow it out.
 */
async function resolveExisting(directory: string, displayPath: string): Promise<string> {
  let current = directory;
  for (;;) {
    const resolved = await realpathIfPresent(current, displayPath);
    if (resolved !== undefined) return resolved;
    if (await existsAsLink(current)) {
      // `lstat` sees an entry that `realpath` did not: a link that does not resolve, or a directory another write (the pull's
      // fetch pool writes sibling files at the same time) created between the two calls. Look once more before refusing.
      const again = await realpathIfPresent(current, displayPath);
      if (again !== undefined) return again;
      throw new HostPathError(displayPath, REFUSAL_DANGLING);
    }
    const parent = dirname(current);
    if (parent === current) throw new HostPathError(displayPath, REFUSAL_OUTSIDE);
    current = parent;
  }
}

async function existsAsLink(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Refuses with `HostPathError` unless the real path of `absoluteTarget`'s parent directory lies inside the real
 * path of `root`. `displayPath` is the vault-relative path the caller asked for; it is the only path in the
 * error text (the resolved location is deliberately not echoed).
 *
 * A vault root that does not exist yet passes: nothing below a missing directory can be a symbolic link, and the
 * write that follows creates the root and its children as plain directories.
 */
export async function assertParentInsideRoot(root: string, absoluteTarget: string, displayPath: string): Promise<void> {
  if (resolve(absoluteTarget) === resolve(root)) return; // the root itself has no parent inside the vault
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  const realParent = await resolveExisting(dirname(absoluteTarget), displayPath);
  if (!isInside(realRoot, realParent)) throw new HostPathError(displayPath, REFUSAL_OUTSIDE);
  refuseProtectedParent(root, absoluteTarget, realRoot, realParent, displayPath);
}

/**
 * A directory swapped for a link to `.obsidian/plugins` stays inside the root, so containment alone passes it. The real parent's
 * first segment (relative to the real root) must not be a protected folder unless the request was itself addressed to that same
 * folder by its own first segment. That distinction is what keeps the engine's own writes working (`.ipfs-sync/tmp/<id>.part`,
 * its rename source, the kv area): their requested first segment is `.ipfs-sync` and so is the real one. A destination such as
 * `notes/a.md` whose `notes` resolves to `.obsidian/plugins` differs and is refused. Manifest paths that name these folders
 * lexically are refused earlier, by the path policy.
 */
function refuseProtectedParent(root: string, absoluteTarget: string, realRoot: string, realParent: string, displayPath: string): void {
  const real = firstSegment(relative(realRoot, realParent));
  if (real === undefined || !PROTECTED_FOLDER_KEYS.includes(foldKey(real))) return;
  const requested = firstSegment(relative(resolve(root), resolve(absoluteTarget)));
  if (requested !== undefined && foldKey(requested) === foldKey(real)) return;
  throw new HostPathError(displayPath, REFUSAL_PROTECTED);
}
