import type { VaultAdapter } from "./obsidian-fs";

/**
 * A plain-text copy of an unreadable `data.json`, made before the first save replaces it with defaults. The copy holds exactly what
 * the file held (credentials included), in the plugin folder next to it; it is never encrypted and never published.
 */

/** The part of the data adapter the copy needs. */
export type BackupFs = Pick<VaultAdapter, "stat" | "readBinary" | "writeBinary">;

export interface UnreadableBackup {
  /**
   * Write the copy and return its path. `fallbackText` is kept when the file itself cannot be read back (the value the host parsed
   * from it). Rejects when the copy cannot be written, so the caller does not go on to overwrite the original.
   */
  save(fallbackText: string): Promise<string>;
}

export interface UnreadableBackupDeps {
  readonly adapter: BackupFs;
  /** Vault-relative path of the plugin's `data.json`. */
  readonly dataPath: string;
  readonly now: () => Date;
}

const MAX_NAME_ATTEMPTS = 100;

/** `20261005T123456Z`: the UTC time without separators that a file name cannot hold on every platform. */
function utcStamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replaceAll("-", "").replaceAll(":", "");
}

export function unreadableBackupName(dataPath: string, at: Date): string {
  return `${dataPath}.unreadable-${utcStamp(at)}`;
}

async function readOriginal(deps: UnreadableBackupDeps, fallbackText: string): Promise<string> {
  try {
    if ((await deps.adapter.stat(deps.dataPath)) === null) return fallbackText;
    return new TextDecoder().decode(await deps.adapter.readBinary(deps.dataPath));
  } catch {
    return fallbackText;
  }
}

export function createUnreadableBackup(deps: UnreadableBackupDeps): UnreadableBackup {
  return {
    save: async (fallbackText) => {
      const text = await readOriginal(deps, fallbackText);
      const base = unreadableBackupName(deps.dataPath, deps.now());
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
        const path = attempt === 1 ? base : `${base}-${attempt}`;
        // An earlier copy is the user's only record of an older file: take the next free name instead.
        if ((await deps.adapter.stat(path)) !== null) continue;
        await deps.adapter.writeBinary(path, new TextEncoder().encode(text).buffer);
        return path;
      }
      throw new Error("no free name for the copy of the unreadable settings file");
    },
  };
}
