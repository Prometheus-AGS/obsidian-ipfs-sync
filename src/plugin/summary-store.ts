import type { PluginSettings } from "./settings-model";
import type { SettingsStore } from "./settings-store";

/**
 * Save a run's summary (`lastPull`, `lastPublish`) after the run has already changed the vault or the node.
 * A failed save must not turn a finished run into a failed one, and must not be swallowed either: the returned
 * text says the summary was not saved and is appended to the notice. Undefined means it was saved.
 */
export async function saveSummary(store: SettingsStore, change: (current: PluginSettings) => PluginSettings): Promise<string | undefined> {
  try {
    await store.update(change);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return `(The summary could not be saved: ${reason}.)`;
  }
}
