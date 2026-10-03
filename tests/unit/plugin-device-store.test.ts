import { describe, expect, it } from "vitest";
import { createPluginDeviceStore, mergeDeviceStore } from "../../src/plugin/device-store-plugin";
import { bytesToBase64 } from "../../src/plugin/base64";
import { defaultSettings, SETTINGS_VERSION, type PluginSettings } from "../../src/plugin/settings-model";
import { loadSettings } from "../../src/plugin/settings-migration";
import { createSettingsStore, openSettingsStore, type PluginDataPort } from "../../src/plugin/settings-store";
import { createDeviceIdProvider, DEVICE_ID_FILE } from "../../src/sync/device-store";
import { raiseFloor, readFloor, SEQUENCE_FLOOR_FILE } from "../../src/sync/sequence-floor";

const VAULT = "a".repeat(32);
const OTHER = "b".repeat(32);
const ID = "1".repeat(64);
const entry = (sequence: number, at = 1) => ({ sequence, identity: ID, at });

function memoryPort(initial: unknown = null): PluginDataPort & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    loadData: async () => initial,
    saveData: async (data) => void saved.push(JSON.parse(JSON.stringify(data))),
  };
}

function freshStore() {
  const port = memoryPort();
  const store = createSettingsStore(port, loadSettings(null));
  return { port, store, devices: createPluginDeviceStore(store) };
}

describe("plugin device store", () => {
  it("keeps the device id and the floor in the deviceStore section and survives a reload", async () => {
    const { port, store, devices } = freshStore();
    const id = await createDeviceIdProvider(devices)();
    await raiseFloor(devices, VAULT, entry(4));
    expect(Object.keys(store.get().deviceStore).sort()).toEqual([DEVICE_ID_FILE, SEQUENCE_FLOOR_FILE]);
    const reloaded = await openSettingsStore(memoryPort(port.saved.at(-1)));
    const again = createPluginDeviceStore(reloaded.store);
    expect(await createDeviceIdProvider(again)()).toBe(id);
    expect((await readFloor(again, VAULT))?.sequence).toBe(4);
  });

  it("a settings update built from an older snapshot cannot lower any floor", async () => {
    const { store, devices } = freshStore();
    const stale: PluginSettings = store.get();
    await raiseFloor(devices, VAULT, entry(5));
    await raiseFloor(devices, OTHER, entry(9, 2));
    // The change returns the snapshot taken before the floors were raised, with an unrelated edit.
    await store.update(() => ({ ...stale, publishIntervalMinutes: 30 }));
    expect(store.get().publishIntervalMinutes).toBe(30);
    expect((await readFloor(devices, VAULT))?.sequence).toBe(5);
    expect((await readFloor(devices, OTHER))?.sequence).toBe(9);
  });

  it("a stale snapshot that holds a LOWER floor for a vault leaves the stored maximum", async () => {
    const { store, devices } = freshStore();
    await raiseFloor(devices, VAULT, entry(2));
    const stale = store.get();
    await raiseFloor(devices, VAULT, entry(8, 5));
    await store.update(() => stale);
    expect((await readFloor(devices, VAULT))?.sequence).toBe(8);
  });

  it("a stale snapshot cannot replace the device id or drop it", async () => {
    const { store, devices } = freshStore();
    const stale = store.get();
    const id = await createDeviceIdProvider(devices)();
    await store.update(() => ({ ...stale, deviceStore: { [DEVICE_ID_FILE]: bytesToBase64(new TextEncoder().encode(`${"9".repeat(32)}\n`)) } }));
    expect(await createDeviceIdProvider(devices)()).toBe(id);
    await store.update(() => stale);
    expect(await createDeviceIdProvider(devices)()).toBe(id);
  });

  it("mergeDeviceStore returns the incoming section itself when nothing needs restoring", () => {
    const next = { [DEVICE_ID_FILE]: "abc" };
    expect(mergeDeviceStore({ [DEVICE_ID_FILE]: "abc" }, next)).toBe(next);
  });
});

describe("plugin settings: deviceStore section", () => {
  it("data written before the section existed loads with an empty one, keeping every other value", () => {
    const stored = { ...defaultSettings(), userExclusions: ["private/"], ownedKeys: ["k51mine"] } as Record<string, unknown>;
    delete stored["deviceStore"];
    const result = loadSettings(JSON.parse(JSON.stringify(stored)));
    expect(result.outcome).toBe("current");
    expect(result.settings.deviceStore).toEqual({});
    expect(result.settings.userExclusions).toEqual(["private/"]);
    expect(result.settings.ownedKeys).toEqual(["k51mine"]);
    expect(result.settings.version).toBe(SETTINGS_VERSION);
  });

  it("a legacy (previous plugin) migration gets the section and keeps its migrated values", () => {
    const result = loadSettings({ rpcUrl: "https://node.example.org", excludedPaths: ".obsidian/graph.json\n.obsidian/snippets/\nprivate/", publishIntervalMinutes: 15 });
    expect(result.outcome).toBe("migrated");
    expect(result.settings.deviceStore).toEqual({});
    expect(result.settings.userExclusions).toEqual(["private/"]);
  });

  it("an unreadable deviceStore section makes the data unreadable, never silently emptied", () => {
    const result = loadSettings({ ...JSON.parse(JSON.stringify(defaultSettings())), deviceStore: { [DEVICE_ID_FILE]: 5 } });
    expect(result.outcome).toBe("unreadable");
    expect(result.persist).toBe(false);
  });
});
