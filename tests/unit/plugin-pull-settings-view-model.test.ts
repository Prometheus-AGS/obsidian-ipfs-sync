import { describe, expect, it } from "vitest";
import { defaultSettings, type PluginSettings, type PullSummary } from "../../src/plugin/settings-model";
import { createSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { createSettingsViewModel, type SettingsViewModel } from "../../src/plugin/settings-view-model";
import { validateSettings } from "../../src/plugin/settings-to-config";

const NOW = new Date("2026-09-30T12:00:00Z");
const KEY_ID = "k51qzi5uqu5dhjghbrp9iqsoa6b3ob3i3jnljq09d3a4j9j4a5c7t";
const OTHER_ID = "k51qzi5uqu5dlfgjhskdfhj2389sdfhjk23489sdhfjkshdf28sd";

function rig(patch: Partial<PluginSettings> = {}): { readonly vm: SettingsViewModel; readonly store: SettingsStore } {
  let saved: unknown = null;
  const store = createSettingsStore(
    {
      loadData: async () => saved,
      saveData: async (next) => {
        saved = structuredClone(next);
      },
    },
    { settings: { ...defaultSettings(), ...patch }, outcome: "current", notices: [], persist: false },
  );
  return { store, vm: createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => [] }) };
}

describe("settings view model: pull name", () => {
  it("shows the owned key's ID as the name that will be pulled when the field is empty", () => {
    const r = rig({ ownedKeys: [KEY_ID] });
    expect(r.vm.state().values.pullName).toBe("");
    expect(r.vm.state().pullTarget).toContain(KEY_ID);
    expect(r.vm.state().pullTarget).toContain("publication key");
  });

  it("says no name is available when the field is empty and no owned key is recorded", () => {
    expect(rig().vm.state().pullTarget).toContain("No name is available");
  });

  it("explains that the key is looked up on the node when several owned IDs are recorded", () => {
    const text = rig({ ownedKeys: [KEY_ID, OTHER_ID] }).vm.state().pullTarget;
    expect(text).toContain('"obsidian-vault-sync"');
    expect(text).toContain("2 owned key IDs");
  });

  it("saves a valid name, with or without the /ipns/ prefix, and shows it as the target", async () => {
    const r = rig({ ownedKeys: [KEY_ID] });
    expect((await r.vm.edit("pullName", `/ipns/${OTHER_ID}`)).saved).toBe(true);
    expect(r.store.get().pullName).toBe(OTHER_ID);
    expect(r.vm.state().pullTarget).toContain(OTHER_ID);
    expect(r.vm.state().pullTarget).toContain("pull name setting");
    expect((await r.vm.edit("pullName", "")).saved).toBe(true);
    expect(r.vm.state().pullTarget).toContain(KEY_ID);
  });

  it("rejects text with spaces inline and keeps the previous value", async () => {
    const r = rig({ pullName: OTHER_ID });
    const result = await r.vm.edit("pullName", `${OTHER_ID} extra`);
    expect(result.saved).toBe(false);
    expect(result.state.errors.pullName).toContain("no spaces");
    expect(r.store.get().pullName).toBe(OTHER_ID);
    expect(r.vm.state().values.pullName).toBe(`${OTHER_ID} extra`);
    expect(r.vm.state().pullTarget).toContain(OTHER_ID);
    // Correcting it clears the error.
    expect((await r.vm.edit("pullName", KEY_ID)).state.errors.pullName).toBeUndefined();
  });
});

describe("settings view model: catch-up and read cap", () => {
  it("has catch-up off by default and saves the toggle", async () => {
    const r = rig();
    expect(r.vm.state().values.catchUpOnLoad).toBe("false");
    expect((await r.vm.edit("catchUpOnLoad", "true")).saved).toBe(true);
    expect(r.store.get().catchUpOnLoad).toBe(true);
    expect(r.vm.state().values.catchUpOnLoad).toBe("true");
    await r.vm.edit("catchUpOnLoad", "false");
    expect(r.store.get().catchUpOnLoad).toBe(false);
  });

  it("shows the default cap of 64 MB and saves a value in range", async () => {
    const r = rig();
    expect(r.vm.state().values.maxReadMb).toBe("64");
    expect((await r.vm.edit("maxReadMb", "128")).saved).toBe(true);
    expect(r.store.get().maxReadMb).toBe(128);
  });

  it("rejects a cap out of range inline, states the range, and does not save", async () => {
    const r = rig();
    for (const bad of ["4", "2048", "0", "abc", "12.5", ""]) {
      const result = await r.vm.edit("maxReadMb", bad);
      expect(result.saved, bad).toBe(false);
      expect(result.state.errors.maxReadMb, bad).toContain("8 to 1024");
    }
    expect(r.store.get().maxReadMb).toBe(64);
  });

  it("validates stored values too, so a hand-edited file shows its error beside the field", () => {
    const found = validateSettings({ ...defaultSettings(), maxReadMb: 4, pullName: "two words" }, NOW);
    expect(found.errors.map((e) => e.field).sort()).toEqual(["maxReadMb", "pullName"]);
  });
});

describe("settings view model: last activity", () => {
  const pull: PullSummary = {
    at: new Date(2026, 8, 30, 14, 5).toISOString(),
    rootCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    manifestCid: "bafymanifest",
    fetched: 3,
    unchanged: 5,
    conflicts: 1,
    failed: 0,
    remoteDeleted: 2,
  };

  it("says no pull and no publish have run yet", () => {
    const state = rig().vm.state();
    expect(state.lastPull).toEqual({ exists: false, text: "No pull has run on this device yet." });
    expect(state.lastPublish).toEqual({ exists: false, text: "No publish has run on this device yet." });
  });

  it("shows the time, the counts and a shortened root CID after a pull", () => {
    const { text, exists } = rig({ lastPull: pull }).vm.state().lastPull;
    expect(exists).toBe(true);
    expect(text).toContain("2026-09-30 14:05");
    expect(text).toContain("3 fetched, 5 unchanged, 1 conflicts, 0 failed, 2 remote deletions kept");
    expect(text).toContain("Root bafybeigdyrzt5sf…");
  });

  it("shows the last publish with skipped files, or that nothing changed", () => {
    const at = new Date(2026, 8, 30, 9, 0).toISOString();
    const published = rig({ lastPublish: { at, written: 2, removed: 1, skipped: 1, rootCid: "bafyroot" } }).vm.state().lastPublish.text;
    expect(published).toContain("2026-09-30 09:00: 2 written, 1 removed, 1 skipped (over the read cap). Root bafyroot.");
    const unchanged = rig({ lastPublish: { at, written: 0, removed: 0, skipped: 0 } }).vm.state().lastPublish.text;
    expect(unchanged).toContain("Nothing was published");
  });

  it("follows the stored summary when a pull finishes after the tab was built", async () => {
    const r = rig();
    expect(r.vm.state().lastPull.exists).toBe(false);
    await r.store.update((settings) => ({ ...settings, lastPull: pull }));
    expect(r.vm.state().lastPull.exists).toBe(true);
  });

  it("puts no path and no secret into the summary text", () => {
    const text = rig({ lastPull: pull, auth: { scheme: "bearer", token: "tok-secret-Zx91" } }).vm.state().lastPull.text;
    expect(text).not.toMatch(/\.md|tok-secret|notes\//);
  });
});
