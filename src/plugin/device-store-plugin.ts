import type { Bytes } from "../core/host-bridge";
import { DEVICE_ID_FILE, DeviceStoreError, type DeviceStore } from "../sync/device-store";
import { mergeFloorBytes, SEQUENCE_FLOOR_FILE } from "../sync/sequence-floor";
import { base64ToBytes, bytesToBase64 } from "./base64";
import type { PluginSettings } from "./settings-model";

/**
 * The plugin's device-local store: the `deviceStore` section of the plugin data (entry name to base64 bytes). The
 * settings store stays the only writer of `data.json`; this adapter changes the section through its `update` and
 * `settings-store.ts` applies `mergeDeviceStore` on every save, so a change built from an older snapshot cannot lower
 * the sequence floor or replace the device id.
 *
 * The plugin data sits under `<config folder>/plugins/ipfs-sync/`, which is excluded from publish and refused by pull.
 * If the user syncs that folder with another tool, the device id is copied to the other device (documented residual).
 */

/** The part of the settings store the adapter uses. */
export interface DeviceStoreSettings {
  get(): PluginSettings;
  update(change: (current: PluginSettings) => PluginSettings): Promise<PluginSettings>;
}

function decode(name: string, text: string): Bytes {
  try {
    return base64ToBytes(text);
  } catch {
    throw new DeviceStoreError(`the device store entry ${name} in the plugin data is not valid base64`);
  }
}

export function createPluginDeviceStore(settings: DeviceStoreSettings): DeviceStore {
  return {
    get: async (name) => {
      const text = settings.get().deviceStore[name];
      return text === undefined ? undefined : decode(name, text);
    },
    set: async (name, bytes) => {
      const text = bytesToBase64(bytes);
      await settings.update((current) => ({ ...current, deviceStore: { ...current.deviceStore, [name]: text } }));
    },
  };
}

function bytesOf(text: string | undefined): Bytes | undefined {
  if (text === undefined) return undefined;
  try {
    return base64ToBytes(text);
  } catch {
    return undefined;
  }
}

/**
 * `next` with what must not be lost taken from `current` (the latest saved section): the sequence floor keeps the higher
 * sequence per vault, the device id stays as it is once set, and any other entry that `next` lacks is kept. Returns
 * `next` itself when nothing needs to change.
 */
export function mergeDeviceStore(current: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const merged: Record<string, string> = { ...next };
  let changed = false;
  for (const [name, value] of Object.entries(current)) {
    const incoming = Object.hasOwn(next, name) ? next[name] : undefined;
    let wanted = value;
    if (name === SEQUENCE_FLOOR_FILE && incoming !== undefined) {
      const bytes = mergeFloorBytes(bytesOf(value), bytesOf(incoming));
      wanted = bytes === undefined ? incoming : bytesToBase64(bytes);
    } else if (name !== DEVICE_ID_FILE && incoming !== undefined) {
      wanted = incoming;
    }
    if (wanted !== incoming) {
      merged[name] = wanted;
      changed = true;
    }
  }
  return changed ? merged : next;
}
