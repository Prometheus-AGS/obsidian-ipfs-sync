import type { HostFs } from "../core/host-bridge";

/** Vault-relative folder for in-flight downloads: same filesystem as the destination, never synced. */
export const TEMP_DIR = ".ipfs-sync/tmp";

/** Remove a temp file. A failure here cannot change the outcome of the file, and the next pull sweeps the folder. */
export async function discardTemp(fs: Pick<HostFs, "remove">, temp: string): Promise<void> {
  await fs.remove(temp).catch(() => undefined);
}
