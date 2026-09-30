import type { App as ObsidianApp, PluginManifest, Plugin as ObsidianPlugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { ClearStaleLockDialog } from "../../src/plugin/clear-stale-lock-dialog";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { createAdapterLockFile } from "../../src/plugin/adapter-lock-file";
import { createStaleLockControl } from "../../src/plugin/stale-lock";
import { createStaleLockFlow } from "../../src/plugin/stale-lock-flow";
import { STALE_LOCK_COPY } from "../../src/plugin/stale-lock-copy";
import { busyNotice, createSyncLock } from "../../src/plugin/sync-lock";
import { LOCK_STALE_MS, encodeLock } from "../../src/sync/publish-lock";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import { App, Modal, Notice, Plugin, type Plugin as StubPlugin } from "../support/obsidian-stub";

/** review-5 R5-08: "Clear stale lock", offered only when the lock's heartbeat is older than the staleness window. */

const NOW = 1_800_000_000_000;
const LOCK = ".ipfs-sync/publish.lock";
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const lockAt = (time: number, token = "old"): Uint8Array<ArrayBuffer> => encodeLock({ token, pid: 0, host: "obsidian-1a2b3c4d", time });
const STALE = NOW - LOCK_STALE_MS - 1000;
const FRESH = NOW - LOCK_STALE_MS + 60_000;

function control(adapter: MemoryAdapter, syncLock = createSyncLock(), now = NOW) {
  return createStaleLockControl({ lockFile: createAdapterLockFile(adapter, () => now), now: () => now, syncLock });
}

describe("the stale-lock control", () => {
  it("reports none, held (fresh), stale and unreadable", async () => {
    const adapter = new MemoryAdapter();
    const c = control(adapter);
    expect(await c.inspect()).toEqual({ kind: "none" });
    adapter.put(LOCK, lockAt(FRESH));
    expect(await c.inspect()).toMatchObject({ kind: "held" });
    adapter.put(LOCK, lockAt(STALE));
    const stale = await c.inspect();
    expect(stale).toMatchObject({ kind: "stale" });
    expect(JSON.stringify(stale)).not.toContain('"old"'); // the token is never shown
    adapter.put(LOCK, "not a lock record");
    expect(await c.inspect()).toEqual({ kind: "unreadable" });
  });

  it("is age-gated at exactly the staleness window", async () => {
    const adapter = new MemoryAdapter();
    const c = control(adapter);
    adapter.put(LOCK, lockAt(NOW - LOCK_STALE_MS + 1));
    expect((await c.inspect()).kind).toBe("held");
    adapter.put(LOCK, lockAt(NOW - LOCK_STALE_MS));
    expect((await c.inspect()).kind).toBe("stale");
  });

  it("clear removes only a stale lock and leaves no scratch file", async () => {
    const adapter = new MemoryAdapter();
    const c = control(adapter);
    adapter.put(LOCK, lockAt(STALE));
    expect(await c.clear()).toEqual({ kind: "cleared" });
    expect([...adapter.files.keys()]).toEqual([]);
  });

  it("clear refuses a fresh lock, an unreadable one and a missing one, and touches nothing", async () => {
    const adapter = new MemoryAdapter();
    const c = control(adapter);
    expect(await c.clear()).toEqual({ kind: "none" });
    adapter.put(LOCK, lockAt(FRESH));
    expect(await c.clear()).toEqual({ kind: "not-stale" });
    adapter.put(LOCK, "garbage");
    expect(await c.clear()).toEqual({ kind: "unreadable" });
    expect(adapter.text(LOCK)).toBe("garbage");
  });

  it("clear refuses while a sync operation runs in this plugin", async () => {
    const adapter = new MemoryAdapter();
    const syncLock = createSyncLock();
    const held = syncLock.tryAcquire("publish");
    adapter.put(LOCK, lockAt(STALE));
    expect(await control(adapter, syncLock).clear()).toEqual({ kind: "busy" });
    expect(adapter.files.has(LOCK)).toBe(true);
    held?.();
  });

  it("a lock that was refreshed between the look and the removal is put back, not deleted", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, lockAt(STALE, "old"));
    const file = createAdapterLockFile(adapter, () => NOW);
    let first = true;
    const racing = {
      ...file,
      // The holder replaces the file right after the control read it and before it moved it aside.
      read: async () => {
        const bytes = await file.read();
        if (first) {
          first = false;
          adapter.put(LOCK, lockAt(NOW - 1000, "new"));
        }
        return bytes;
      },
    };
    const c = createStaleLockControl({ lockFile: racing, now: () => NOW, syncLock: createSyncLock() });
    expect(await c.clear()).toEqual({ kind: "not-stale" });
    expect(adapter.text(LOCK)).toContain('"token":"new"');
    expect([...adapter.files.keys()]).toEqual([LOCK]);
  });
});

describe("C5-03: clear holds the sync lock for its whole duration", () => {
  it("a publish that starts while clear is working is refused as busy and cannot lose its lock; the lock is released afterwards", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, lockAt(STALE, "old"));
    const file = createAdapterLockFile(adapter, () => NOW);
    const syncLock = createSyncLock();
    let inside: (() => void) | undefined;
    const reachedMoveAside = new Promise<void>((resolve) => (inside = resolve));
    let proceed: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    const gated = {
      ...file,
      moveAside: async () => {
        inside?.();
        await gate;
        return file.moveAside();
      },
    };
    const c = createStaleLockControl({ lockFile: gated, now: () => NOW, syncLock });
    const clearing = c.clear();
    await reachedMoveAside;
    // What the timer publish and the manual publish do at their gates: neither can take the sync lock now.
    expect(syncLock.holder()).toBe("clear-stale-lock");
    expect(syncLock.tryAcquire("publish")).toBeUndefined();
    expect(busyNotice(syncLock.holder())).toContain("stale-lock clearing");
    proceed?.();
    expect(await clearing).toEqual({ kind: "cleared" });
    expect(syncLock.holder()).toBeUndefined();
    expect(syncLock.tryAcquire("publish")).toBeTypeOf("function");
  });

  it("releases the sync lock when clearing refuses or throws", async () => {
    const adapter = new MemoryAdapter();
    const syncLock = createSyncLock();
    expect(await control(adapter, syncLock).clear()).toEqual({ kind: "none" });
    expect(syncLock.holder()).toBeUndefined();
    adapter.put(LOCK, lockAt(STALE));
    const file = createAdapterLockFile(adapter, () => NOW);
    const failing = { ...file, moveAside: async () => Promise.reject(new Error("EIO")) };
    await expect(createStaleLockControl({ lockFile: failing, now: () => NOW, syncLock }).clear()).rejects.toThrow("EIO");
    expect(syncLock.holder()).toBeUndefined();
  });
});

describe("the stale-lock flow", () => {
  function flowOver(adapter: MemoryAdapter) {
    let request: Parameters<Parameters<typeof createStaleLockFlow>[0]["openDialog"]>[0] | undefined;
    let finish: Parameters<Parameters<typeof createStaleLockFlow>[0]["openDialog"]>[1] | undefined;
    const flow = createStaleLockFlow({
      control: control(adapter),
      openDialog: (r, f) => {
        request = r;
        finish = f;
        return { close: () => undefined };
      },
    });
    return { flow, request: () => request, finish: () => finish };
  }

  it.each([
    ["no lock", undefined, STALE_LOCK_COPY.noneNotice],
    ["a fresh lock", lockAt(FRESH), STALE_LOCK_COPY.freshNotice],
    ["an unreadable lock", new TextEncoder().encode("garbage"), STALE_LOCK_COPY.unreadableNotice],
  ])("opens no dialog for %s and says why", async (_name, content, notice) => {
    const adapter = new MemoryAdapter();
    if (content !== undefined) adapter.put(LOCK, content);
    const h = flowOver(adapter);
    expect(await h.flow.open()).toEqual({ notice });
    expect(h.request()).toBeUndefined();
  });

  it("opens the dialog for a stale lock; nothing is removed until Clear lock; cancel changes nothing", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, lockAt(STALE));
    const h = flowOver(adapter);
    const done = h.flow.open();
    await flush();
    expect(h.request()?.description).toMatch(/process 0 on obsidian-1a2b3c4d, last heartbeat \d+ s ago/);
    expect(adapter.files.has(LOCK)).toBe(true);
    h.finish()?.({ cleared: false });
    expect(await done).toEqual({ notice: "" });
    expect(adapter.files.has(LOCK)).toBe(true);
  });

  it("Clear lock removes the lock and reports it; a lock that became fresh is refused with a reason", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, lockAt(STALE));
    const h = flowOver(adapter);
    const done = h.flow.open();
    await flush();
    expect(await h.request()?.clear()).toEqual({ ok: true });
    h.finish()?.({ cleared: true });
    expect(await done).toEqual({ notice: STALE_LOCK_COPY.cleared });
    expect(adapter.files.has(LOCK)).toBe(false);

    adapter.put(LOCK, lockAt(STALE));
    const again = flowOver(adapter);
    void again.flow.open();
    await flush();
    adapter.put(LOCK, lockAt(NOW - 1000, "refreshed"));
    expect(await again.request()?.clear()).toMatchObject({ ok: false, reason: expect.stringContaining("no longer stale") });
    expect(adapter.text(LOCK)).toContain("refreshed");
  });
});

describe("the plugin: command and settings section", () => {
  beforeEach(() => {
    Notice.reset();
    Modal.reset();
  });

  const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;

  async function load(adapter: MemoryAdapter): Promise<StubPlugin> {
    const plugin = new IpfsSyncPlugin(new App(adapter) as unknown as ObsidianApp, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    stub.data = null;
    await plugin.onload();
    return stub;
  }

  const realNow = (): number => Date.now();

  it("the command tells the user when there is nothing to clear, and opens the confirmation only for a stale lock", async () => {
    const adapter = new MemoryAdapter();
    const stub = await load(adapter);
    const command = stub.commands.find((c) => c.id === "clear-stale-lock");
    expect(command?.name).toBe("Clear stale publish lock");
    await command?.callback?.();
    await vi.waitFor(() => expect(Notice.shown.map((n) => n.message)).toContain(STALE_LOCK_COPY.noneNotice));

    adapter.put(LOCK, lockAt(realNow() - 60_000));
    await command?.callback?.();
    await vi.waitFor(() => expect(Notice.shown.map((n) => n.message)).toContain(STALE_LOCK_COPY.freshNotice));
    expect(Modal.instances).toHaveLength(0);

    adapter.put(LOCK, lockAt(realNow() - LOCK_STALE_MS - 5000));
    void command?.callback?.();
    await vi.waitFor(() => expect(Modal.instances.at(-1)).toBeInstanceOf(ClearStaleLockDialog));
    const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl };
    const confirm = dialog.contentEl.find((el) => el.tag === "button" && el.text === STALE_LOCK_COPY.confirm);
    expect(adapter.files.has(LOCK)).toBe(true);
    await confirm?.dispatch("click");
    await vi.waitFor(() => expect(adapter.files.has(LOCK)).toBe(false));
    await vi.waitFor(() => expect(Notice.shown.map((n) => n.message)).toContain(STALE_LOCK_COPY.cleared));
  });

  it("the dialog puts Cancel first and shows a refusal as text", async () => {
    const adapter = new MemoryAdapter();
    const app = new App(adapter);
    const dialog = new ClearStaleLockDialog(app as unknown as ObsidianApp, { description: "process 0 on h, last heartbeat 999 s ago", clear: async () => ({ ok: false, reason: "the lock is no longer stale" }) }, () => undefined);
    dialog.onOpen();
    const content = (dialog as unknown as { contentEl: FakeEl }).contentEl;
    const buttons = content.findAll((el) => el.tag === "button");
    expect(buttons.map((b) => b.text)).toEqual([STALE_LOCK_COPY.cancel, STALE_LOCK_COPY.confirm]);
    await buttons[1]?.dispatch("click");
    await flush();
    expect(byId(content, "ipfs-sync-stale-lock-error")?.text).toContain("the lock is no longer stale");
    expect(buttons[1]?.disabled).toBe(true); // as in the adopt dialog: read why, then cancel
  });

  function tabOver(adapter: MemoryAdapter) {
    const store = createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { settings: defaultSettings(), outcome: "current", notices: [], persist: false });
    const vm = createSettingsViewModel({ store, now: () => new Date(NOW), listNodeKeys: async () => [] });
    const lockControl = control(adapter, createSyncLock(), NOW);
    const app = new App();
    const opened: number[] = [];
    const tab = new IpfsSyncSettingTab(app as unknown as ObsidianApp, new Plugin(app) as unknown as ObsidianPlugin, vm, undefined, {
      inspect: () => lockControl.inspect(),
      open: async () => void opened.push(1),
    });
    tab.display();
    return { root: (tab as unknown as { containerEl: FakeEl }).containerEl, opened };
  }

  const clearButton = (root: FakeEl): FakeEl => {
    const found = root.find((el) => el.tag === "button" && el.text === STALE_LOCK_COPY.button);
    if (found === undefined) throw new Error("no Clear stale lock button");
    return found;
  };

  it("the settings button is disabled with no lock or a fresh lock, and enabled for a stale one", async () => {
    for (const [content, enabled] of [[undefined, false], [lockAt(FRESH), false], [lockAt(STALE), true]] as const) {
      const adapter = new MemoryAdapter();
      if (content !== undefined) adapter.put(LOCK, content);
      const { root } = tabOver(adapter);
      await vi.waitFor(() => expect(root.textContent()).not.toContain(STALE_LOCK_COPY.checking));
      expect(clearButton(root).disabled).toBe(!enabled);
    }
  });

  it("pressing the enabled button opens the confirmation flow", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(LOCK, lockAt(STALE));
    const { root, opened } = tabOver(adapter);
    await vi.waitFor(() => expect(clearButton(root).disabled).toBe(false));
    await clearButton(root).dispatch("click");
    expect(opened).toEqual([1]);
  });

  it("the row has a description the button points at", async () => {
    const { root } = tabOver(new MemoryAdapter());
    expect(clearButton(root).getAttr("aria-describedby")).toBe("ipfs-sync-desc-stale-lock");
    expect(byId(root, "ipfs-sync-desc-stale-lock")?.textContent()).toContain("15 minutes");
  });
});
