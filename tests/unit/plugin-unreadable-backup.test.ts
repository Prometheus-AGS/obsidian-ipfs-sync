import type { App, PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { openSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { createUnreadableBackup, unreadableBackupName } from "../../src/plugin/unreadable-backup";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Notice, resetRequestUrl, type Plugin as StubPlugin } from "../support/obsidian-stub";

/** Round 3 review, P-M3: an unreadable data.json is copied, as it is, before the first save replaces it with defaults. */

const DIR = ".obsidian/plugins/ipfs-sync";
const DATA = `${DIR}/data.json`;
const RAW = '{ "version": 99,\n  "auth": { "scheme": "bearer", "token": "tok-secret" } }\n';
const NOW = new Date("2026-10-05T12:34:56.789Z");
const BACKUP = `${DATA}.unreadable-20261005T123456Z`;

function adapterWithRaw(raw = RAW): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(DATA, raw);
  return adapter;
}

function rig(adapter: MemoryAdapter, stored: unknown, saves: unknown[] = []) {
  const backup = createUnreadableBackup({ adapter, dataPath: DATA, now: () => NOW });
  return openSettingsStore({ loadData: async () => stored, saveData: async (data) => void saves.push(data) }, backup);
}

describe("P-M3: the unreadable settings file is copied before it is replaced", () => {
  it("names the copy by the UTC time, with no colon", () => {
    expect(unreadableBackupName(DATA, NOW)).toBe(BACKUP);
  });

  it("writes the original text, byte for byte, before the first save, and not again", async () => {
    const adapter = adapterWithRaw();
    const saves: unknown[] = [];
    const { store, load } = await rig(adapter, { version: 99 }, saves);
    expect(load.outcome).toBe("unreadable");
    expect(adapter.text(BACKUP)).toBeUndefined();
    expect(saves).toEqual([]);

    const order: string[] = [];
    const writeBinary = adapter.writeBinary.bind(adapter);
    adapter.writeBinary = async (path, data) => {
      order.push(`write ${path}`);
      await writeBinary(path, data);
    };
    const port = { loadData: async () => ({ version: 99 }), saveData: async () => void order.push("saveData") };
    const second = await openSettingsStore(port, createUnreadableBackup({ adapter, dataPath: DATA, now: () => NOW }));
    await second.store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }));
    expect(order).toEqual([`write ${BACKUP}`, "saveData"]);
    expect(adapter.text(BACKUP)).toBe(RAW);
    expect(adapter.text(DATA)).toBe(RAW);

    await second.store.update((s) => ({ ...s, publicationKey: "obsidian-vault-y" }));
    expect(order).toEqual([`write ${BACKUP}`, "saveData", "saveData"]);
    expect(store.get()).toEqual(defaultSettings());
  });

  it("never overwrites an earlier backup", async () => {
    const adapter = adapterWithRaw();
    adapter.put(BACKUP, "an earlier copy");
    const { store } = await rig(adapter, { version: 99 });
    await store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }));
    expect(adapter.text(BACKUP)).toBe("an earlier copy");
    expect(adapter.text(`${BACKUP}-2`)).toBe(RAW);
  });

  it("refuses the save, and keeps memory as it was, when the copy cannot be written", async () => {
    const adapter = adapterWithRaw();
    adapter.writeBinary = async () => {
      throw new Error("disk full");
    };
    const saves: unknown[] = [];
    const { store } = await rig(adapter, { version: 99 }, saves);
    await expect(store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }))).rejects.toThrow(/disk full/);
    expect(saves).toEqual([]);
    expect(store.get().publicationKey).toBe(defaultSettings().publicationKey);
  });

  it("falls back to the parsed value when the file text cannot be read", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(DIR + "/keep", "x");
    const { store } = await rig(adapter, { version: 99 });
    await store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }));
    expect(adapter.text(BACKUP)).toBe(JSON.stringify({ version: 99 }));
  });

  it("writes no copy for readable data", async () => {
    const adapter = adapterWithRaw();
    const stored = { ...defaultSettings(), ownedKeys: ["k51mine"] };
    const { store, load } = await rig(adapter, stored);
    expect(load.outcome).toBe("current");
    await store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }));
    expect([...adapter.files.keys()].filter((p) => p.includes("unreadable"))).toEqual([]);
  });

  it("says in the notice what a save would replace, that the copy is plain text, and where it goes", () => {
    const notice = loadSettings("garbage").notices.join(" ");
    expect(notice).toContain("credentials");
    expect(notice).toContain("owned keys");
    expect(notice).toContain("sequence floor");
    expect(notice).toContain("plain text");
    expect(notice).toContain("plugin folder");
    expect(notice).toContain("data.json.unreadable-");
    expect(notice).not.toContain("garbage");
  });
});

describe("P-M3: the plugin", () => {
  const MANIFEST = { id: "ipfs-sync", version: "0.2.0", dir: DIR } as unknown as PluginManifest;

  beforeEach(() => {
    Notice.reset();
    resetRequestUrl();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("copies the file on the first save, tells the user the name and that it is plain text, and leaves the original until then", async () => {
    const adapter = adapterWithRaw();
    const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as App, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    stub.data = { version: 99 };
    await plugin.onload();
    expect([...adapter.files.keys()].filter((p) => p.includes("unreadable"))).toEqual([]);
    await (plugin as unknown as { store: SettingsStore }).store.update((s) => ({ ...s, publicationKey: "obsidian-vault-x" }));
    const copies = [...adapter.files.keys()].filter((p) => p.startsWith(`${DATA}.unreadable-`));
    expect(copies).toHaveLength(1);
    expect(adapter.text(copies[0] ?? "")).toBe(RAW);
    const said = Notice.shown.map((n) => n.message).filter((m) => m.includes(copies[0] ?? "@"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("plain text");
    expect(said[0]).not.toContain("tok-secret");
  });
});
