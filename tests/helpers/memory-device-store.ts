import type { Bytes } from "../../src/core/host-bridge";
import type { DeviceStore } from "../../src/sync/device-store";

export interface MemoryDeviceStore extends DeviceStore {
  readonly entries: Map<string, Bytes>;
  /** Every `set` in order, as `name`. */
  readonly writes: string[];
}

/** An in-memory device store that records its writes. */
export function createMemoryDeviceStore(): MemoryDeviceStore {
  const entries = new Map<string, Bytes>();
  const writes: string[] = [];
  return {
    entries,
    writes,
    get: async (name) => entries.get(name),
    set: async (name, bytes) => {
      writes.push(name);
      entries.set(name, bytes);
    },
  };
}
