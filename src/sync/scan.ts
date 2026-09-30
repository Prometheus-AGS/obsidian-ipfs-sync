import type { HostFs } from "../core/host-bridge";
import type { ExclusionMatcher } from "./exclusions";

export interface ScannedFile {
  /** Vault-relative, `/`-separated. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Enumerate every non-excluded file below the host root. Excluded directories are
 * not entered. The result is sorted by path so equal vaults scan identically.
 */
export async function scanVault(fs: Pick<HostFs, "list">, isExcluded: ExclusionMatcher): Promise<readonly ScannedFile[]> {
  const files: ScannedFile[] = [];
  const pending: string[] = [""];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await fs.list(dir)) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (isExcluded(path, entry.kind === "directory")) continue;
      if (entry.kind === "directory") pending.push(path);
      else files.push({ path, size: entry.size, mtimeMs: entry.mtimeMs });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
