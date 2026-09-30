import type { HostFs } from "../core/host-bridge";

/** What one path prefix is on disk; `missing` when nothing exists there. */
type PrefixKind = "missing" | "symlink" | "other";

/** Memoises the verdict per path prefix, so a directory shared by many files is inspected once per plan. */
export type SymlinkCache = Map<string, PrefixKind>;

async function kindOf(fs: Pick<HostFs, "lstat">, prefix: string, cache: SymlinkCache | undefined): Promise<PrefixKind> {
  const known = cache?.get(prefix);
  if (known !== undefined) return known;
  const info = await fs.lstat(prefix);
  const kind: PrefixKind = info === undefined ? "missing" : info.kind === "symlink" ? "symlink" : "other";
  cache?.set(prefix, kind);
  return kind;
}

/**
 * The first path prefix (a directory component, or the destination itself) that is a symbolic
 * link, or `undefined` when none is. Nothing is followed: every prefix is inspected with
 * `lstat`, from the vault root downwards, and the walk stops at the first prefix that does not
 * exist (nothing deeper can exist either). The vault root itself is the operator's choice and
 * is not checked.
 */
export async function findSymlink(
  fs: Pick<HostFs, "lstat">,
  path: string,
  cache?: SymlinkCache,
): Promise<string | undefined> {
  const segments = path.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join("/");
    const kind = await kindOf(fs, prefix, cache);
    if (kind === "symlink") return prefix;
    if (kind === "missing") return undefined;
  }
  return undefined;
}
