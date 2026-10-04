import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { KdfParams } from "../../src/crypto";
import { ENCRYPTION_COPY, KEY_ACTIONS_COPY } from "../../src/plugin/encryption-copy";
import type { EncryptionState, EncryptionStatusSource } from "../../src/plugin/encryption-settings-model";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { focusOrder, referencedText, type FakeEl } from "../support/fake-dom";
import { App, Plugin } from "../support/obsidian-stub";
import { flush, labelOf, memoryStore, NODE_KEYS, NOW } from "../support/settings-tab-rig";

const STANDARD: KdfParams = { m: 65_536, t: 3, p: 1 };
const HIGH: KdfParams = { m: 131_072, t: 4, p: 1 };

function source(initial: EncryptionState, extra: Partial<EncryptionStatusSource> = {}) {
  let state = initial;
  const listeners = new Set<() => void>();
  const api: EncryptionStatusSource = {
    state: () => state,
    lock: () => {
      state = "locked";
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...extra,
  };
  return {
    api,
    set: (next: EncryptionState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

async function openTab(encryption: EncryptionStatusSource) {
  const store = memoryStore({});
  const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS });
  const host = new App();
  const tab = new IpfsSyncSettingTab(host as unknown as ObsidianApp, new Plugin(host) as unknown as ObsidianPlugin, vm, encryption);
  tab.display();
  const root = (tab as unknown as { containerEl: FakeEl }).containerEl;
  await vi.waitFor(() => expect(root.textContent()).not.toContain("Asking the node"));
  await flush();
  return { root, tab };
}

const rowOf = (root: FakeEl, name: string): FakeEl => {
  const found = root.find((el) => el.hasClass("setting-item") && el.find((child) => child.hasClass("setting-item-name") && child.text === name) !== undefined);
  if (found === undefined) throw new Error(`no row "${name}"`);
  return found;
};

const hidden = (el: FakeEl): boolean => el.style["display"] === "none";
const buttonIn = (row: FakeEl): FakeEl => {
  const found = row.find((el) => el.tag === "button");
  if (found === undefined) throw new Error("no button in row");
  return found;
};

const openers = () => ({ openChangePassphrase: vi.fn(), openIncreaseCost: vi.fn(), openAcceptSlots: vi.fn() });

describe("Encryption section: key management rows", () => {
  it("shows unlocked, the recorded sequence and the slot cost together in an unlocked, synced vault", async () => {
    const { root } = await openTab(
      source("unlocked", { pullRecord: async () => ({ highestSequence: 12, complete: true, unfinished: 0, restoredFrom: undefined }), slotCost: async () => STANDARD, ...openers() }).api,
    ).then((rig) => rig);
    const text = root.textContent();
    expect(text).toContain("Unlocked.");
    expect(text).toContain("Highest sequence recorded: 12.");
    expect(rowOf(root, ENCRYPTION_COPY.slotCostName).textContent()).toContain("64 MiB, 3 iterations (the default).");
  });

  it("says when the cost is above the default, or unknown, or unreadable", async () => {
    const high = await openTab(source("locked", { slotCost: async () => HIGH }).api);
    expect(rowOf(high.root, ENCRYPTION_COPY.slotCostName).textContent()).toContain("128 MiB, 4 iterations (above the default).");
    const unknown = await openTab(source("locked", { slotCost: async () => undefined }).api);
    expect(rowOf(unknown.root, ENCRYPTION_COPY.slotCostName).textContent()).toContain(ENCRYPTION_COPY.slotCostUnknown);
    const broken = await openTab(
      source("locked", {
        slotCost: async () => {
          throw new Error("damaged");
        },
      }).api,
    );
    expect(rowOf(broken.root, ENCRYPTION_COPY.slotCostName).textContent()).toContain(ENCRYPTION_COPY.slotCostRecordUnreadable);
  });

  it("shows no cost row and no key action when the source offers none", async () => {
    const { root } = await openTab(source("unlocked").api);
    expect(root.textContent()).not.toContain(ENCRYPTION_COPY.slotCostName);
    expect(root.textContent()).not.toContain(KEY_ACTIONS_COPY.changePassphrase.name);
  });

  it("hides the cost and the actions until a vault exists, and shows them when it does", async () => {
    const s = source("not-set-up", { slotCost: async () => STANDARD, ...openers() });
    const { root } = await openTab(s.api);
    const rows = [ENCRYPTION_COPY.slotCostName, KEY_ACTIONS_COPY.changePassphrase.name, KEY_ACTIONS_COPY.increaseCost.name, KEY_ACTIONS_COPY.acceptSlots.name].map((name) => rowOf(root, name));
    expect(rows.every(hidden)).toBe(true);
    s.set("locked");
    await flush();
    expect(rows.some(hidden)).toBe(false);
    expect(rowOf(root, ENCRYPTION_COPY.slotCostName).textContent()).toContain("64 MiB, 3 iterations");
  });

  it("opens each dialog from its own button", async () => {
    const o = openers();
    const { root } = await openTab(source("unlocked", o).api);
    await buttonIn(rowOf(root, KEY_ACTIONS_COPY.changePassphrase.name)).dispatch("click");
    await buttonIn(rowOf(root, KEY_ACTIONS_COPY.increaseCost.name)).dispatch("click");
    await buttonIn(rowOf(root, KEY_ACTIONS_COPY.acceptSlots.name)).dispatch("click");
    expect(o.openChangePassphrase).toHaveBeenCalledTimes(1);
    expect(o.openIncreaseCost).toHaveBeenCalledTimes(1);
    expect(o.openAcceptSlots).toHaveBeenCalledTimes(1);
  });

  it("shows a Prune history row, hidden until a vault exists, and opens its dialog from its own button (task 2.5)", async () => {
    const openPruneHistory = vi.fn();
    const s = source("not-set-up", { slotCost: async () => STANDARD, ...openers(), openPruneHistory });
    const { root } = await openTab(s.api);
    const row = rowOf(root, KEY_ACTIONS_COPY.pruneHistory.name);
    expect(hidden(row)).toBe(true);
    s.set("locked");
    await flush();
    expect(hidden(row)).toBe(false);
    await buttonIn(row).dispatch("click");
    expect(openPruneHistory).toHaveBeenCalledTimes(1);
    expect(referencedText(root, buttonIn(row).getAttr("aria-describedby"))).toContain("before anything is removed");
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.tag} has no accessible name`).not.toBe("");
  });

  it("shows no Prune history row when the source cannot open it", async () => {
    const { root } = await openTab(source("unlocked", openers()).api);
    expect(root.textContent()).not.toContain(KEY_ACTIONS_COPY.pruneHistory.name);
  });

  it("describes each button by the sentence that says what it does and does not undo, and names every control", async () => {
    const { root } = await openTab(source("unlocked", openers()).api);
    const change = buttonIn(rowOf(root, KEY_ACTIONS_COPY.changePassphrase.name));
    expect(referencedText(root, change.getAttr("aria-describedby"))).toContain("does not revoke anything");
    const increase = buttonIn(rowOf(root, KEY_ACTIONS_COPY.increaseCost.name));
    expect(referencedText(root, increase.getAttr("aria-describedby"))).toContain("old slot in earlier roots");
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.tag} has no accessible name`).not.toBe("");
  });

  it("keeps the cost line a polite live region so a change is announced", async () => {
    const { root } = await openTab(source("unlocked", { slotCost: async () => STANDARD }).api);
    expect(rowOf(root, ENCRYPTION_COPY.slotCostName).find((el) => el.getAttr("aria-live") === "polite")).toBeDefined();
  });
});
