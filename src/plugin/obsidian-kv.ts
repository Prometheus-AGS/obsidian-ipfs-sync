import type { HostFs, HostKv } from "../core/host-bridge";
import { HostPathError } from "../sync/host-errors";
import { base64ToBytes, bytesToBase64 } from "./base64";
import type { SettingsStore } from "./settings-store";

const KV_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Folder in the vault that holds the engine's local state; the default exclusions keep it out of the sync. */
export const STATE_DIRECTORY = ".ipfs-sync";

function assertKey(key: string): string {
  if (!KV_KEY.test(key)) {
    throw new HostPathError(key, "kv keys are 1-128 characters of [A-Za-z0-9._-], starting with a letter or digit");
  }
  return key;
}

/**
 * Key-value capability over the plugin's stored data: values are bytes kept as base64 in the `kv` object
 * of the same file as the settings. Every write goes through the settings store, which applies it on top of
 * the latest settings, so a kv write never clobbers a settings change (and the reverse).
 */
export function createPluginDataKv(store: SettingsStore): HostKv {
  return {
    get: async (key) => {
      const stored = store.get().kv[assertKey(key)];
      return stored === undefined ? undefined : base64ToBytes(stored);
    },
    set: async (key, value) => {
      const name = assertKey(key);
      const encoded = bytesToBase64(value);
      await store.update((settings) => ({ ...settings, kv: { ...settings.kv, [name]: encoded } }));
    },
    delete: async (key) => {
      const name = assertKey(key);
      await store.update((settings) => {
        const { [name]: _removed, ...rest } = settings.kv;
        return { ...settings, kv: rest };
      });
    },
    list: async (prefix) =>
      Object.keys(store.get().kv)
        .filter((key) => key.startsWith(prefix))
        .sort(),
  };
}

/**
 * Key-value capability as files under `<vault>/.ipfs-sync/`, the same layout the CLI host uses. The publish
 * engine keeps its last-published record here (`state.json`), which is what lets the plugin and the CLI publish
 * the same vault and transfer only what changed. The record holds paths and hashes, never credentials.
 */
export function createFolderKv(fs: HostFs): HostKv {
  const pathOf = (key: string): string => `${STATE_DIRECTORY}/${assertKey(key)}`;
  return {
    get: async (key) => ((await fs.stat(pathOf(key))) === undefined ? undefined : fs.read(pathOf(key))),
    set: async (key, value) => fs.write(pathOf(key), value),
    delete: async (key) => fs.remove(pathOf(key)),
    list: async (prefix) => {
      if ((await fs.stat(STATE_DIRECTORY)) === undefined) return [];
      const entries = await fs.list(STATE_DIRECTORY);
      return entries
        .filter((entry) => entry.kind === "file" && KV_KEY.test(entry.name) && entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort();
    },
  };
}
