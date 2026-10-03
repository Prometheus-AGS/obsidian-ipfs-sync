export type ThreeWayOutcome = "fetch" | "unchanged" | "replace" | "locally-modified" | "conflict";

/**
 * The decision table, shared by the plaintext (version 1) pull planner and the encrypted pull planner. `local` (L) is
 * undefined when the file is missing, `base` (B) when the path is untracked, `remote` (R) is the manifest sha256.
 * - L missing: fetch.  - L = R: unchanged.  - L = B: replace (no local edit).
 * - B = R (and L differs): locally modified, leave it.  - otherwise (including B absent): conflict.
 */
export function decideThreeWay(local: string | undefined, base: string | undefined, remote: string): ThreeWayOutcome {
  if (local === undefined) return "fetch";
  if (local === remote) return "unchanged";
  if (base !== undefined && local === base) return "replace";
  if (base !== undefined && base === remote) return "locally-modified";
  return "conflict";
}
