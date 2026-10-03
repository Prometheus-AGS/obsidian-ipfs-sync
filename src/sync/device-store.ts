import type { Bytes } from "../core/host-bridge";

/**
 * The device-local store: small files that must live outside the vault-synced `.ipfs-sync/` folder and must survive
 * `abandon`, a deleted state folder and a changed MFS root. The CLI keeps them in a per-user directory
 * (`cli/device-store-node.ts`), the plugin inside its own plugin data (`src/plugin/device-store-plugin.ts`). This module
 * is the port and the device id; it has no Node and no Obsidian imports.
 */
export interface DeviceStore {
  /** The bytes stored under `name`, or `undefined` when there are none. */
  get(name: string): Promise<Bytes | undefined>;
  set(name: string, bytes: Bytes): Promise<void>;
  /**
   * Run `run` while no other process uses this store's read-merge-write sections (review-final A-08). Present on a store
   * that other processes share (the CLI's per-user directory); absent on a store with one writer (the plugin's data, memory).
   */
  exclusive?<T>(run: () => Promise<T>): Promise<T>;
}

export class DeviceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceStoreError";
  }
}

/** Store entry holding the device id: 32 lowercase hex characters (16 random bytes). */
export const DEVICE_ID_FILE = "device-id";
export const DEVICE_ID_BYTES = 16;
/** Leading hex characters of the id that the manifest `device` carries after the label. */
export const DEVICE_SUFFIX_CHARS = 12;
/** The label (`IPFS_SYNC_DEVICE`, or the host's default) is cut to this many code points before the suffix is added. */
export const DEVICE_LABEL_MAX_CHARS = 40;

const DEVICE_ID_FORMAT = /^[0-9a-f]{32}$/;

export type RandomBytes = (length: number) => Uint8Array;

const systemRandom: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseDeviceId(bytes: Bytes): string {
  const text = new TextDecoder().decode(bytes).trim();
  if (!DEVICE_ID_FORMAT.test(text)) {
    throw new DeviceStoreError(`the stored device id (${DEVICE_ID_FILE}) is not 32 lowercase hex characters; delete that entry to get a new one`);
  }
  return text;
}

/**
 * The installation's device id. Generated once from 16 random bytes and stored; later calls return the stored value.
 * A stored value that is not 32 lowercase hex characters is refused rather than replaced: replacing it would change
 * this device's identity without anyone noticing.
 */
export async function loadDeviceId(store: DeviceStore, random: RandomBytes = systemRandom): Promise<string> {
  const existing = await store.get(DEVICE_ID_FILE);
  if (existing !== undefined) return parseDeviceId(existing);
  const generated = toHex(random(DEVICE_ID_BYTES));
  await store.set(DEVICE_ID_FILE, new TextEncoder().encode(`${generated}\n`));
  // Another process may have written first; whatever the store holds now is the id.
  const stored = await store.get(DEVICE_ID_FILE);
  return stored === undefined ? generated : parseDeviceId(stored);
}

/** A provider for `PublishDeps.deviceId`: loads the id on first use and reuses it. A failed load is retried on the next call. */
export function createDeviceIdProvider(store: DeviceStore, random?: RandomBytes): () => Promise<string> {
  let loading: Promise<string> | undefined;
  return () => {
    loading ??= loadDeviceId(store, random).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
}

/** The suffix a device id contributes to the manifest `device`. */
export function deviceSuffix(deviceId: string): string {
  return deviceId.slice(0, DEVICE_SUFFIX_CHARS);
}
