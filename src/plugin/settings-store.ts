import { mergeDeviceStore } from "./device-store-plugin";
import { loadSettings, type LoadResult } from "./settings-migration";
import type { PluginSettings } from "./settings-model";
import type { UnreadableBackup } from "./unreadable-backup";

/** The part of Obsidian's `Plugin` that stores plugin data (`data.json`). */
export interface PluginDataPort {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

/**
 * The single owner of the plugin's stored data. The settings tab, the key-value capability and the
 * publish runner all change it through `update`, so no writer clobbers another: each change is applied
 * on top of the latest state, saved, and only then made visible. It is also the single writer of the device store
 * section: every save keeps the per-vault maximum of the sequence floor (`mergeDeviceStore`).
 */
export interface SettingsStore {
  get(): PluginSettings;
  /**
   * Apply `change` to the latest settings and save the result. Calls run one after another. When saving
   * fails the promise rejects and `get()` still returns the previous settings, so memory never runs ahead of disk.
   */
  update(change: (current: PluginSettings) => PluginSettings): Promise<PluginSettings>;
}

export interface LoadedStore {
  readonly store: SettingsStore;
  readonly load: LoadResult;
}

export function createSettingsStore(port: PluginDataPort, initial: LoadResult, backup?: UnreadableBackup, fallbackText = ""): SettingsStore {
  let current = initial.settings;
  let queue: Promise<unknown> = Promise.resolve();
  // Unreadable data is left untouched until the first save; that save would replace the file with defaults, so the original is copied first.
  let backupPending = initial.outcome === "unreadable" && backup !== undefined;

  async function apply(change: (settings: PluginSettings) => PluginSettings): Promise<PluginSettings> {
    const changed = change(current);
    if (backupPending && backup !== undefined) {
      // A copy that cannot be written fails the save: the original stays, and memory does not run ahead of disk.
      await backup.save(fallbackText);
      backupPending = false;
    }
    // Whatever `change` was built from, the saved sequence floor and device id are never lowered or replaced.
    const deviceStore = mergeDeviceStore(current.deviceStore, changed.deviceStore);
    const next = deviceStore === changed.deviceStore ? changed : { ...changed, deviceStore };
    await port.saveData(next);
    current = next;
    return next;
  }

  return {
    get: () => current,
    update: (change) => {
      // A failed change must not block later ones; each caller still sees its own outcome.
      const run = queue.then(() => apply(change));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** Read the stored data, migrate it if needed, and write the migrated form back once. */
export async function openSettingsStore(port: PluginDataPort, backup?: UnreadableBackup): Promise<LoadedStore> {
  const stored = await port.loadData();
  const load = loadSettings(stored);
  // The parsed value, as text, is the copy's content only when the file cannot be read back as it was.
  const store = createSettingsStore(port, load, backup, JSON.stringify(stored) ?? "");
  if (load.persist) await store.update((settings) => settings);
  return { store, load };
}
