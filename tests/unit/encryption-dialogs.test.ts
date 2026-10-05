import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AbandonVaultDialog, type AbandonDialogRequest } from "../../src/plugin/abandon-vault-dialog";
import { ABANDON_COPY, CREATING_TEXT, ENCRYPTION_COPY, SETUP_COPY, UNLOCK_COPY, UNLOCKING_TEXT } from "../../src/plugin/encryption-copy";
import type { EncryptionState, EncryptionStatusSource } from "../../src/plugin/encryption-settings-model";
import { SetupVaultDialog, type SetupDialogRequest } from "../../src/plugin/setup-dialog";
import { UnlockVaultDialog, type UnlockDialogRequest } from "../../src/plugin/unlock-dialog";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { byId, focusOrder, referencedText, type FakeEl } from "../support/fake-dom";
import { App, Modal, Plugin } from "../support/obsidian-stub";
import { flush, labelOf, memoryStore, NODE_KEYS, NOW } from "../support/settings-tab-rig";

const PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const app = (): ObsidianApp => new App() as unknown as ObsidianApp;

beforeEach(() => Modal.reset());

interface Opened<T> {
  readonly dialog: T;
  readonly content: FakeEl;
}

function content(dialog: unknown): FakeEl {
  return (dialog as { contentEl: FakeEl }).contentEl;
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

async function type(el: FakeEl, text: string): Promise<void> {
  el.value = text;
  await el.dispatch("input");
}

async function tick(el: FakeEl, on: boolean): Promise<void> {
  el.checked = on;
  await el.dispatch("change");
}

// ---------- setup dialog ----------

function openSetup(create: SetupDialogRequest["create"] = async () => ({ ok: true })): Opened<SetupVaultDialog> & { finished: ReturnType<typeof vi.fn> } {
  const finished = vi.fn();
  const dialog = new SetupVaultDialog(app(), { passphrase: PASSPHRASE, create }, finished);
  dialog.open();
  return { dialog, content: content(dialog), finished };
}

const reentryOf = (root: FakeEl): FakeEl => {
  const el = byId(root, "ipfs-sync-setup-reentry");
  if (el === undefined) throw new Error("no re-entry field");
  return el;
};
const ackOf = (root: FakeEl): FakeEl => {
  const el = byId(root, "ipfs-sync-setup-acknowledge");
  if (el === undefined) throw new Error("no acknowledgement");
  return el;
};

describe("setup dialog: content", () => {
  it("shows the passphrase in monospace in 5 groups of 5 with the required notes and consequence text", () => {
    const { content: root } = openSetup();
    const group = byId(root, "ipfs-sync-setup-passphrase");
    expect(group?.getAttr("role")).toBe("group");
    expect(group?.style["font-family"]).toContain("monospace");
    const groups = group?.findAll((el) => el.tag === "code") ?? [];
    expect(groups.map((el) => el.text)).toEqual(["ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWX2"]);
    const text = root.textContent();
    expect(text).toContain("Letters are not case-sensitive");
    expect(text).toContain("password manager");
    expect(text).toContain("permanently");
    expect(text).toContain("no recovery mechanism");
    expect(root.find((el) => el.hasClass("callout"))?.textContent()).toContain("No recovery");
  });

  it("never calls the alphabet unambiguous or free of look-alikes", () => {
    const { content: root } = openSetup();
    expect(root.textContent().toLowerCase()).not.toMatch(/unambiguous|look-alike-free|no look-alike/);
    expect(root.textContent()).toContain("S and 5, Z and 2, G and 6, I and L");
  });

  it("offers no field for choosing one's own passphrase: the only text entry is the masked re-entry", () => {
    const { content: root } = openSetup();
    const entries = root.findAll((el) => el.tag === "input" && el.type !== "checkbox");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("password");
    expect(entries[0]?.id).toBe("ipfs-sync-setup-reentry");
  });

  it("puts the controls in reading order and gives each an accessible name", () => {
    const { content: root } = openSetup();
    const order = focusOrder(root);
    expect(order.map((el) => labelOf(root, el) || el.text)).toEqual([
      "Enter the passphrase again",
      "Show what I type",
      "I understand that if I lose this passphrase, my data is permanently lost and cannot be recovered.",
      "Cancel",
    ]);
    expect(button(root, SETUP_COPY.create).disabled).toBe(true);
  });

  it("starts with initial focus on the re-entry field", () => {
    const { content: root } = openSetup();
    expect(reentryOf(root).focused).toBe(true);
  });
});

describe("setup dialog: gating and errors", () => {
  it("disables Create until the re-entry matches and the box is ticked, and explains what is missing in text", async () => {
    const { content: root } = openSetup();
    const create = button(root, SETUP_COPY.create);
    expect(create.disabled).toBe(true);
    expect(referencedText(root, create.getAttr("aria-describedby"))).toContain(SETUP_COPY.needReentry);

    await type(reentryOf(root), PASSPHRASE);
    expect(create.disabled).toBe(true);
    expect(referencedText(root, create.getAttr("aria-describedby"))).toContain(SETUP_COPY.needAcknowledgement);
    expect(referencedText(root, create.getAttr("aria-describedby"))).not.toContain(SETUP_COPY.needReentry);

    await tick(ackOf(root), true);
    expect(create.disabled).toBe(false);
    expect(byId(root, "ipfs-sync-setup-requirements")?.text).toBe("");
  });

  it("keeps Create disabled with the box ticked and a mismatched re-entry, and ties a text error to the field", async () => {
    const { content: root } = openSetup();
    await tick(ackOf(root), true);
    const field = reentryOf(root);
    await type(field, "ABCDE-FGHIJ-KLMNO-PQRST-UVWX3");
    expect(button(root, SETUP_COPY.create).disabled).toBe(true);
    const error = byId(root, "ipfs-sync-setup-reentry-error");
    expect(error?.text).toBe(`Error: ${SETUP_COPY.mismatch}`);
    expect(field.getAttr("aria-invalid")).toBe("true");
    expect(field.getAttr("aria-describedby")).toContain("ipfs-sync-setup-reentry-error");
    expect(error?.getAttr("aria-live")).toBe("polite");
    await type(field, PASSPHRASE);
    expect(error?.text).toBe("");
    expect(field.getAttr("aria-invalid")).toBeNull();
  });

  it("switches the re-entry between masked and plain text with the reveal control", async () => {
    const { content: root } = openSetup();
    const field = reentryOf(root);
    const reveal = byId(root, "ipfs-sync-setup-reveal");
    expect(field.type).toBe("password");
    if (reveal === undefined) throw new Error("no reveal control");
    await tick(reveal, true);
    expect(field.type).toBe("text");
    await tick(reveal, false);
    expect(field.type).toBe("password");
  });

  it("does not create anything when Enter is pressed while gated", async () => {
    const create = vi.fn(async () => ({ ok: true }) as const);
    const { content: root, dialog } = openSetup(create);
    await reentryOf(root).dispatch("keydown", { key: "Enter" });
    await flush();
    expect(create).not.toHaveBeenCalled();
    expect((dialog as unknown as { opened: boolean }).opened).toBe(true);
  });
});

describe("setup dialog: creating", () => {
  async function ready(create: SetupDialogRequest["create"]) {
    const rig = openSetup(create);
    await type(reentryOf(rig.content), PASSPHRASE);
    await tick(ackOf(rig.content), true);
    return rig;
  }

  it("calls create once, shows the foreground indicator with progress, and closes as created", async () => {
    let release: () => void = () => undefined;
    let report: (fraction: number) => void = () => undefined;
    const create = vi.fn(
      (onProgress: (fraction: number) => void) =>
        new Promise<{ ok: true }>((resolve) => {
          report = onProgress;
          release = () => resolve({ ok: true });
        }),
    );
    const { content: root, finished, dialog } = await ready(create);
    const click = button(root, SETUP_COPY.create).dispatch("click");
    await flush();
    const status = byId(root, "ipfs-sync-setup-progress");
    expect(status?.getAttr("role")).toBe("status");
    expect(status?.textContent()).toContain(CREATING_TEXT);
    expect(status?.textContent()).toContain("foreground");
    expect(button(root, SETUP_COPY.create).disabled).toBe(true);
    expect(button(root, SETUP_COPY.cancel).disabled).toBe(true);
    expect(reentryOf(root).disabled).toBe(true);
    report(0.6);
    expect(status?.textContent()).toContain("50 percent");
    await button(root, SETUP_COPY.create).dispatch("click");
    expect(create).toHaveBeenCalledTimes(1);
    release();
    await click;
    await flush();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith("created");
    expect((dialog as unknown as { opened: boolean }).opened).toBe(false);
  });

  it("stays open on failure with the reason as text, re-enables Create, and reports cancelled on cancel", async () => {
    const { content: root, finished } = await ready(async () => ({ ok: false, reason: "the node refused the key slots" }));
    await button(root, SETUP_COPY.create).dispatch("click");
    await flush();
    expect(byId(root, "ipfs-sync-setup-failure")?.text).toBe(`Error: ${SETUP_COPY.createFailed}: the node refused the key slots.`);
    expect(button(root, SETUP_COPY.create).disabled).toBe(false);
    expect(finished).not.toHaveBeenCalled();
    await button(root, SETUP_COPY.cancel).dispatch("click");
    expect(finished).toHaveBeenCalledWith("cancelled");
  });

  it("turns a thrown error into a shown failure", async () => {
    const { content: root } = await ready(async () => {
      throw new Error("disk full");
    });
    await button(root, SETUP_COPY.create).dispatch("click");
    await flush();
    expect(byId(root, "ipfs-sync-setup-failure")?.text).toContain("disk full");
  });

  it("treats Cancel, and closing any other way, as cancelled exactly once, and clears the passphrase from the screen", async () => {
    const { content: root, finished, dialog } = openSetup();
    await button(root, SETUP_COPY.cancel).dispatch("click");
    (dialog as unknown as { close(): void }).close();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith("cancelled");
    expect(root.textContent()).not.toContain("ABCDE");
  });

});

// ---------- unlock dialog ----------

const checkOf = (input: string): "wrong-length" | "check-failed" | undefined => {
  const canonical = input.replaceAll("-", "").replace(/\s+/g, "").toUpperCase();
  if (canonical.length !== 25) return "wrong-length";
  return canonical === "ABCDEFGHIJKLMNOPQRSTUVWX2" ? undefined : "check-failed";
};

function openUnlock(unlock: UnlockDialogRequest["unlock"] = async () => ({ ok: true })) {
  const finished = vi.fn();
  const dialog = new UnlockVaultDialog(app(), { check: checkOf, unlock }, finished);
  dialog.open();
  return { dialog, content: content(dialog), finished };
}

const unlockField = (root: FakeEl): FakeEl => {
  const el = byId(root, "ipfs-sync-unlock-passphrase");
  if (el === undefined) throw new Error("no passphrase field");
  return el;
};

describe("unlock dialog", () => {
  it("has one labelled, masked field with a reveal control, focused first", () => {
    const { content: root } = openUnlock();
    const field = unlockField(root);
    expect(field.type).toBe("password");
    expect(labelOf(root, field)).toBe(UNLOCK_COPY.fieldName);
    expect(field.focused).toBe(true);
    expect(focusOrder(root).map((el) => el.id || el.text)).toEqual([
      "ipfs-sync-unlock-passphrase",
      "ipfs-sync-unlock-reveal",
      UNLOCK_COPY.cancel,
      UNLOCK_COPY.unlock,
    ]);
  });

  it("reports a probable typo as text without calling unlock, and clears the error on the next edit", async () => {
    const unlock = vi.fn(async () => ({ ok: true }) as const);
    const { content: root } = openUnlock(unlock);
    const field = unlockField(root);
    await type(field, "ABCDE-FGHIJ-KLMNO-PQRST-UVWX3");
    await button(root, UNLOCK_COPY.unlock).dispatch("click");
    await flush();
    const error = byId(root, "ipfs-sync-unlock-error");
    expect(error?.text).toBe(`Error: ${UNLOCK_COPY.checkFailed}`);
    expect(field.getAttr("aria-invalid")).toBe("true");
    expect(referencedText(root, field.getAttr("aria-describedby"))).toContain("Probable typo");
    expect(unlock).not.toHaveBeenCalled();
    await type(field, "A");
    expect(error?.text).toBe("");
  });

  it("reports an empty submit as text", async () => {
    const unlock = vi.fn(async () => ({ ok: true }) as const);
    const { content: root } = openUnlock(unlock);
    await button(root, UNLOCK_COPY.unlock).dispatch("click");
    expect(byId(root, "ipfs-sync-unlock-error")?.text).toBe(`Error: ${UNLOCK_COPY.empty}`);
    expect(unlock).not.toHaveBeenCalled();
  });

  it("passes the entry to unlock, clears the field at once, shows the foreground indicator, and closes as unlocked", async () => {
    let release: () => void = () => undefined;
    let seen = "";
    const unlock = vi.fn(
      (passphrase: string) =>
        new Promise<{ ok: true }>((resolve) => {
          seen = passphrase;
          release = () => resolve({ ok: true });
        }),
    );
    const { content: root, finished, dialog } = openUnlock(unlock);
    const field = unlockField(root);
    await type(field, "abcde-fghij-klmno-pqrst-uvwx2");
    const submit = button(root, UNLOCK_COPY.unlock).dispatch("click");
    await flush();
    expect(seen).toBe("abcde-fghij-klmno-pqrst-uvwx2");
    expect(field.value).toBe("");
    expect(byId(root, "ipfs-sync-unlock-progress")?.textContent()).toContain(UNLOCKING_TEXT);
    expect(byId(root, "ipfs-sync-unlock-progress")?.textContent()).toContain("Keep the app in the foreground");
    expect(button(root, UNLOCK_COPY.unlock).disabled).toBe(true);
    release();
    await submit;
    await flush();
    expect(finished).toHaveBeenCalledWith("unlocked");
    expect(finished).toHaveBeenCalledTimes(1);
    expect((dialog as unknown as { opened: boolean }).opened).toBe(false);
  });

  it("keeps the dialog open on a refusal, shows it as text on the field, and does not echo the passphrase", async () => {
    const { content: root, finished } = openUnlock(async () => ({ ok: false, reason: "That passphrase does not open this vault." }));
    const field = unlockField(root);
    await type(field, "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2");
    await button(root, UNLOCK_COPY.unlock).dispatch("click");
    await flush();
    const error = byId(root, "ipfs-sync-unlock-error");
    expect(error?.text).toBe(`Error: ${UNLOCK_COPY.unlockFailed}: That passphrase does not open this vault.`);
    expect(error?.text).not.toContain("ABCDE");
    expect(field.getAttr("aria-invalid")).toBe("true");
    expect(field.focused).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    await button(root, UNLOCK_COPY.cancel).dispatch("click");
    expect(finished).toHaveBeenCalledWith("cancelled");
  });

  it("submits on Enter", async () => {
    const unlock = vi.fn(async () => ({ ok: true }) as const);
    const { content: root } = openUnlock(unlock);
    await type(unlockField(root), "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2");
    await unlockField(root).dispatch("keydown", { key: "Enter" });
    await flush();
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});

// ---------- abandon dialog ----------

function openAbandon(abandon: AbandonDialogRequest["abandon"] = async () => ({ ok: true, backupNote: "Backup kept in .ipfs-sync/backup" })) {
  const finished = vi.fn();
  const dialog = new AbandonVaultDialog(app(), { abandon }, finished);
  dialog.open();
  return { dialog, content: content(dialog), finished };
}

describe("abandon dialog", () => {
  it("states what happens, focuses Cancel first, and keeps the destructive button disabled until the word is typed", async () => {
    const { content: root } = openAbandon();
    const text = root.textContent();
    for (const line of ABANDON_COPY.consequences) expect(text).toContain(line);
    expect(focusOrder(root).filter((el) => el.focused).map((el) => el.text)).toEqual([ABANDON_COPY.cancel]);
    const confirm = button(root, ABANDON_COPY.confirm);
    expect(confirm.disabled).toBe(true);
    expect(referencedText(root, confirm.getAttr("aria-describedby"))).toContain("Nothing on the node is changed");
    const field = byId(root, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    expect(labelOf(root, field)).toBe(ABANDON_COPY.confirmName);
    await type(field, "aband");
    expect(confirm.disabled).toBe(true);
    await type(field, "abandon");
    expect(confirm.disabled).toBe(false);
  });

  it("does nothing for Enter before the word is typed, and abandons once after", async () => {
    const abandon = vi.fn(async () => ({ ok: true }) as const);
    const { content: root, finished } = openAbandon(abandon);
    const field = byId(root, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    await field.dispatch("keydown", { key: "Enter" });
    expect(abandon).not.toHaveBeenCalled();
    await type(field, "abandon");
    await button(root, ABANDON_COPY.confirm).dispatch("click");
    await flush();
    expect(abandon).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("reports the backup note on success and abandoned:false on cancel", async () => {
    const done = openAbandon();
    const field = byId(done.content, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    await type(field, "abandon");
    await button(done.content, ABANDON_COPY.confirm).dispatch("click");
    await flush();
    expect(done.finished).toHaveBeenCalledWith({ abandoned: true, backupNote: "Backup kept in .ipfs-sync/backup" });

    const cancelled = openAbandon();
    await button(cancelled.content, ABANDON_COPY.cancel).dispatch("click");
    expect(cancelled.finished).toHaveBeenCalledWith({ abandoned: false });
  });

  it("reports the real result, not a cancel, when it is closed while the abandon runs (review round 3, P-L2)", async () => {
    let release: (result: { ok: true; backupNote: string }) => void = () => undefined;
    const pending = new Promise<{ ok: true; backupNote: string }>((resolve) => {
      release = resolve;
    });
    const { dialog, content: root, finished } = openAbandon(() => pending);
    const field = byId(root, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    await type(field, "abandon");
    await button(root, ABANDON_COPY.confirm).dispatch("click");
    dialog.close();
    expect(finished).not.toHaveBeenCalled();
    release({ ok: true, backupNote: "Backup kept in .ipfs-sync/backup" });
    await flush();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith({ abandoned: true, backupNote: "Backup kept in .ipfs-sync/backup" });
  });

  it("reports a cancel when it is closed while the abandon runs and the abandon then fails", async () => {
    let release: (result: { ok: false; reason: string }) => void = () => undefined;
    const pending = new Promise<{ ok: false; reason: string }>((resolve) => {
      release = resolve;
    });
    const { dialog, content: root, finished } = openAbandon(() => pending);
    const field = byId(root, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    await type(field, "abandon");
    await button(root, ABANDON_COPY.confirm).dispatch("click");
    dialog.close();
    release({ ok: false, reason: "could not write the backup" });
    await flush();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith({ abandoned: false });
  });

  it("shows a failure as text and stays open", async () => {
    const { content: root, finished } = openAbandon(async () => ({ ok: false, reason: "could not write the backup" }));
    const field = byId(root, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no confirmation field");
    await type(field, "abandon");
    await button(root, ABANDON_COPY.confirm).dispatch("click");
    await flush();
    expect(byId(root, "ipfs-sync-abandon-error")?.text).toBe(`Error: ${ABANDON_COPY.failed}: could not write the backup.`);
    expect(finished).not.toHaveBeenCalled();
  });
});

// ---------- Encryption section of the settings tab ----------

function source(initial: EncryptionState, extra: Partial<EncryptionStatusSource> = {}) {
  let state = initial;
  const listeners = new Set<() => void>();
  const lock = vi.fn(() => {
    state = "locked";
  });
  const api: EncryptionStatusSource = {
    state: () => state,
    lock,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...extra,
  };
  return {
    api,
    lock,
    listeners,
    set: (next: EncryptionState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

async function openTab(encryption?: EncryptionStatusSource) {
  const store = memoryStore({});
  const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS });
  const host = new App();
  const tab = new IpfsSyncSettingTab(host as unknown as ObsidianApp, new Plugin(host) as unknown as ObsidianPlugin, vm, encryption);
  tab.display();
  const root = (tab as unknown as { containerEl: FakeEl }).containerEl;
  await vi.waitFor(() => expect(root.textContent()).not.toContain("Asking the node"));
  return { root, tab };
}

const lockButton = (root: FakeEl): FakeEl => button(root, ENCRYPTION_COPY.lockButton);

describe("settings tab: Encryption section", () => {
  it("shows each state as a word with its meaning, and enables Lock only while unlocked", async () => {
    const s = source("not-set-up");
    const { root } = await openTab(s.api);
    const status = root.find((el) => el.getAttr("aria-live") === "polite" && el.textContent().includes("Not set up."));
    expect(status?.textContent()).toContain(ENCRYPTION_COPY.notSetUpDesc);
    expect(lockButton(root).disabled).toBe(true);
    expect(referencedText(root, lockButton(root).getAttr("aria-describedby"))).toContain(ENCRYPTION_COPY.lockUnavailable);

    s.set("locked");
    expect(status?.textContent()).toContain("Locked.");
    expect(status?.textContent()).toContain("Automatic publishing is skipped");
    expect(lockButton(root).disabled).toBe(true);

    s.set("unlocked");
    expect(status?.textContent()).toContain("Unlocked.");
    expect(lockButton(root).disabled).toBe(false);
  });

  it("locks through the source, updates in place, and disables Lock", async () => {
    const s = source("unlocked");
    const { root } = await openTab(s.api);
    const before = lockButton(root);
    await before.dispatch("click");
    expect(s.lock).toHaveBeenCalledTimes(1);
    expect(lockButton(root)).toBe(before);
    expect(before.disabled).toBe(true);
    expect(root.textContent()).toContain("Locked.");
  });

  it("puts the section between Publication and Authentication and keeps every control named", async () => {
    const { root } = await openTab(source("unlocked").api);
    const headings = root.findAll((el) => el.getAttr("role") === "heading").map((el) => el.textContent());
    expect(headings.slice(0, 4)).toEqual(["Endpoints", "Publication", "Encryption", "Authentication"]);
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.tag} has no accessible name`).not.toBe("");
  });

  it("offers Set up and Unlock only when the source provides them", async () => {
    const open = vi.fn();
    const withSetup = source("not-set-up", { openSetup: open });
    const { root } = await openTab(withSetup.api);
    await button(root, ENCRYPTION_COPY.setUpButton).dispatch("click");
    expect(open).toHaveBeenCalledTimes(1);
    const plain = await openTab(source("locked").api);
    expect(plain.root.find((el) => el.tag === "button" && el.text === ENCRYPTION_COPY.unlockButton)).toBeUndefined();
  });

  it("offers Abandon only when the source provides it, with the consequences in its description, and opens the confirmation", async () => {
    const open = vi.fn();
    const { root } = await openTab(source("locked", { openAbandon: open }).api);
    const abandon = button(root, ENCRYPTION_COPY.abandonButton);
    expect(root.textContent()).toContain(ENCRYPTION_COPY.abandonName);
    expect(referencedText(root, abandon.getAttr("aria-describedby"))).toContain("nothing on the node is changed");
    await abandon.dispatch("click");
    expect(open).toHaveBeenCalledTimes(1);
    const plain = await openTab(source("locked").api);
    expect(plain.root.find((el) => el.tag === "button" && el.text === ENCRYPTION_COPY.abandonButton)).toBeUndefined();
  });

  it("keeps the Abandon button available in every state, including unlocked", async () => {
    for (const state of ["not-set-up", "locked", "unlocked"] as const) {
      const { root } = await openTab(source(state, { openAbandon: () => undefined }).api);
      expect(button(root, ENCRYPTION_COPY.abandonButton).disabled).toBe(false);
    }
  });

  it("stops listening when the tab is hidden", async () => {
    const s = source("locked");
    const { tab } = await openTab(s.api);
    expect(s.listeners.size).toBe(1);
    tab.hide();
    expect(s.listeners.size).toBe(0);
  });

  it("is not shown without a status source", async () => {
    const { root } = await openTab();
    expect(root.textContent()).not.toContain(ENCRYPTION_COPY.stateName);
  });
});
