import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { createDeviceIdProvider, DEVICE_ID_FILE, DeviceStoreError, loadDeviceId } from "../../src/sync/device-store";
import { sanitizeDevice } from "../../src/sync/publish-manifest";
import { publishVault } from "../../src/sync/publish";
import { createMemoryDeviceStore } from "../helpers/memory-device-store";
import { createRig, KEY, ROOT, seedVault } from "../helpers/publish-rig";

const HEX32 = /^[0-9a-f]{32}$/;

function fixedRandom(byte: number) {
  return (length: number): Uint8Array => new Uint8Array(length).fill(byte);
}

describe("device id", () => {
  it("is 16 random bytes in hex, generated once and stable across calls", async () => {
    const store = createMemoryDeviceStore();
    const first = await loadDeviceId(store, fixedRandom(0xab));
    const second = await loadDeviceId(store, fixedRandom(0xcd));
    expect(first).toBe("ab".repeat(16));
    expect(second).toBe(first);
    expect(store.writes).toEqual([DEVICE_ID_FILE]);
  });

  it("differs between two stores with the system random source", async () => {
    const a = await loadDeviceId(createMemoryDeviceStore());
    const b = await loadDeviceId(createMemoryDeviceStore());
    expect(a).toMatch(HEX32);
    expect(b).toMatch(HEX32);
    expect(a).not.toBe(b);
  });

  it("refuses a stored value that is not 32 lowercase hex characters instead of replacing it", async () => {
    const store = createMemoryDeviceStore();
    store.entries.set(DEVICE_ID_FILE, new TextEncoder().encode("not-an-id"));
    await expect(loadDeviceId(store)).rejects.toBeInstanceOf(DeviceStoreError);
    expect(store.writes).toEqual([]);
  });

  it("keeps the value another process stored first", async () => {
    const store = createMemoryDeviceStore();
    const racing = { ...store, set: async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
      await store.set(name, new TextEncoder().encode(`${"11".repeat(16)}\n`));
      void bytes;
    } };
    expect(await loadDeviceId(racing, fixedRandom(0x22))).toBe("11".repeat(16));
  });

  it("the provider loads once and retries after a failure", async () => {
    const store = createMemoryDeviceStore();
    let calls = 0;
    const flaky = { get: store.get, set: async (name: string, bytes: Uint8Array<ArrayBuffer>) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      await store.set(name, bytes);
    } };
    const provide = createDeviceIdProvider(flaky, fixedRandom(0x33));
    await expect(provide()).rejects.toThrow("disk full");
    const id = await provide();
    expect(await provide()).toBe(id);
    expect(calls).toBe(2);
  });
});

describe("manifest device", () => {
  const ID = "0123456789abcdef0123456789abcdef";

  it("is <label>-<12 hex> and within 64 characters even for a long label", () => {
    expect(sanitizeDevice("laptop", ID)).toBe("laptop-0123456789ab");
    const long = sanitizeDevice("x".repeat(200), ID);
    expect(Array.from(long)).toHaveLength(40 + 1 + 12);
    expect(Array.from(long).length).toBeLessThanOrEqual(64);
  });

  it("falls back to the default label and strips control characters", () => {
    expect(sanitizeDevice(undefined, ID)).toBe("cli-0123456789ab");
    expect(sanitizeDevice("a\nb", ID)).toBe("ab-0123456789ab");
  });

  it("without an id stays the bare label (a host with no device store)", () => {
    expect(sanitizeDevice("laptop")).toBe("laptop");
  });

  it("a publish writes the device carried by the provider", async () => {
    const rig = createRig({ env: { IPFS_SYNC_DEVICE: "box" } });
    seedVault(rig.host);
    await rig.init();
    const id = await loadDeviceId(createMemoryDeviceStore(), fixedRandom(0x5a));
    await publishVault(
      { client: rig.node.client, host: rig.killableHost, bus: createSyncEventBus(), deviceId: async () => id },
      { mfsRoot: ROOT, keyName: KEY, ownedKeys: rig.owned, recordOwnedKey: async (key) => void rig.owned.push(key), passphrase: rig.passphrase },
    );
    expect((await rig.manifest()).device).toBe(`box-${"5a".repeat(6)}`);
  });
});
