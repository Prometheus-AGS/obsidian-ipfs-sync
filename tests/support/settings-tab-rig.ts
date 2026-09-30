import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { expect, vi } from "vitest";
import type { NodeKey } from "../../src/kubo";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { createSettingsViewModel, type SettingsViewModel } from "../../src/plugin/settings-view-model";
import { focusOrder, referencedText, type FakeEl } from "./fake-dom";
import { App, Plugin } from "./obsidian-stub";

/** Shared rig for the settings tab tests: a tab over an in-memory store, its fake DOM, and label-based lookups. */

export const NOW = new Date("2026-09-30T12:00:00Z");
export const OWNED_ID = "k51ownedownedowned";
export const PEER_ID = "k51peerpeerpeerpeer";

export function memoryStore(patch: Partial<PluginSettings>): SettingsStore {
  let saved: unknown = null;
  return createSettingsStore(
    {
      loadData: async () => saved,
      saveData: async (next) => {
        saved = structuredClone(next);
      },
    },
    { settings: { ...defaultSettings(), ...patch }, outcome: "current", notices: [], persist: false },
  );
}

export interface Rig {
  readonly root: FakeEl;
  readonly store: SettingsStore;
  readonly vm: SettingsViewModel;
  readonly tab: IpfsSyncSettingTab;
}

export const NODE_KEYS: readonly NodeKey[] = [
  { name: "obsidian-vault-sync", id: OWNED_ID },
  { name: "obsidian-vault-peer", id: PEER_ID },
  { name: "prince-live", id: "k51princeprinceprince" },
];

export async function open(patch: Partial<PluginSettings> = {}): Promise<Rig> {
  const store = memoryStore(patch);
  const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS });
  const app = new App();
  const tab = new IpfsSyncSettingTab(app as unknown as ObsidianApp, new Plugin(app) as unknown as ObsidianPlugin, vm);
  tab.display();
  const root = (tab as unknown as { containerEl: FakeEl }).containerEl;
  await vi.waitFor(() => expect(root.find((el) => el.tag === "code" && /^[0-9a-f]{16,}$/.test(el.text))).toBeDefined());
  await vi.waitFor(() => expect(root.textContent()).not.toContain("Asking the node"));
  return { root, store, vm, tab };
}

export const labelOf = (root: FakeEl, el: FakeEl): string => referencedText(root, el.getAttr("aria-labelledby")) || (el.getAttr("aria-label") ?? el.text);

/** The control that belongs to a field: found by its visible label text. */
export function controlFor(root: FakeEl, label: string): FakeEl {
  const control = focusOrder(root).find((el) => labelOf(root, el) === label);
  if (control === undefined) throw new Error(`no control labelled "${label}"`);
  return control;
}

/** Let the tab's async handlers (edit, save, redraw) finish; DOM handlers do not return their promise. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

export async function type(root: FakeEl, label: string, text: string): Promise<void> {
  const input = controlFor(root, label);
  input.value = text;
  await input.dispatch("change");
  await flush();
}
