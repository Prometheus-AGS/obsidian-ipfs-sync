import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { createAbandonFlow, type AbandonFlowDeps } from "../../src/plugin/abandon-flow";
import { AbandonVaultDialog, type AbandonOutcome } from "../../src/plugin/abandon-vault-dialog";
import { ClearStaleLockDialog, type ClearLockOutcome } from "../../src/plugin/clear-stale-lock-dialog";
import { ABANDON_COPY } from "../../src/plugin/encryption-copy";
import { createAdapterLockFile } from "../../src/plugin/adapter-lock-file";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, openSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { SECRETS_REDIRECT_NOTE } from "../../src/plugin/settings-tab-copy";
import { createSettingsViewModel, type SettingsViewModel } from "../../src/plugin/settings-view-model";
import { createStaleLockControl } from "../../src/plugin/stale-lock";
import { STALE_LOCK_COPY } from "../../src/plugin/stale-lock-copy";
import { createStaleLockFlow, type StaleLockFlowDeps } from "../../src/plugin/stale-lock-flow";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { createUnreadableBackup } from "../../src/plugin/unreadable-backup";
import { LOCK_STALE_MS, encodeLock } from "../../src/sync/publish-lock";
import { testNodeSettings } from "../helpers/test-node-settings";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Modal, Notice, type Plugin as StubPlugin } from "../support/obsidian-stub";
import { open as openTab, type as typeInto } from "../support/settings-tab-rig";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const NOW = new Date("2026-10-05T12:34:56.789Z");
const LOCK = ".ipfs-sync/publish.lock";
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const SECRET = "secret-token-xyz";

const buttonOf = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

async function loadPlugin(data: unknown, adapter = new MemoryAdapter()): Promise<{ plugin: IpfsSyncPlugin; stub: StubPlugin; adapter: MemoryAdapter }> {
  const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as ObsidianApp, MANIFEST);
  const stub = plugin as unknown as StubPlugin;
  stub.data = data;
  await plugin.onload();
  return { plugin, stub, adapter };
}

const messages = (): string[] => Notice.shown.map((n) => n.message);

describe("B-M1: closing the dialog while the action runs does not hide a failure (abandon)", () => {
  beforeEach(() => {
    Notice.reset();
    Modal.reset();
  });

  function dialogOver(abandon: () => Promise<{ ok: true; backupNote?: string } | { ok: false; reason: string }>) {
    const finished = vi.fn<(outcome: AbandonOutcome) => void>();
    const dialog = new AbandonVaultDialog(new StubApp(new MemoryAdapter()) as unknown as ObsidianApp, { abandon }, finished);
    dialog.open();
    const content = (dialog as unknown as { contentEl: FakeEl }).contentEl;
    return { dialog, content, finished };
  }

  async function confirmThenClose(h: ReturnType<typeof dialogOver>): Promise<void> {
    const field = byId(h.content, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no field");
    field.value = "abandon";
    await field.dispatch("input");
    const click = buttonOf(h.content, ABANDON_COPY.confirm).dispatch("click");
    h.dialog.close();
    await click;
  }

  it.each([
    ["a refusal", async () => ({ ok: false as const, reason: "a sync operation is running in this plugin" }), "a sync operation is running in this plugin"],
    ["a refusal with other text", async () => ({ ok: false as const, reason: "nothing was moved" }), "nothing was moved"],
  ])("carries %s as failure when closed while running", async (_name, abandon, expected) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = dialogOver(async () => {
      await gate;
      return abandon();
    });
    await confirmThenClose(h);
    expect(h.finished).not.toHaveBeenCalled();
    release();
    await flush();
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.finished).toHaveBeenCalledWith({ abandoned: false, failure: expected });
  });

  it("uses fixed text, never the raw error, when the action throws", async () => {
    const h = dialogOver(async () => {
      throw new Error(SECRET);
    });
    await confirmThenClose(h);
    await flush();
    const outcome = h.finished.mock.calls[0]?.[0];
    expect(outcome).toMatchObject({ abandoned: false });
    expect((outcome as { failure?: string }).failure).toBeDefined();
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("shows fixed text, never the raw error, in the open dialog when the action throws", async () => {
    const h = dialogOver(async () => {
      throw new Error(SECRET);
    });
    const field = byId(h.content, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no field");
    field.value = "abandon";
    await field.dispatch("input");
    await buttonOf(h.content, ABANDON_COPY.confirm).dispatch("click");
    await flush();
    expect(byId(h.content, "ipfs-sync-abandon-error")?.text ?? "").not.toContain(SECRET);
  });

  it("reports success normally when closed while running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = dialogOver(async () => {
      await gate;
      return { ok: true as const, backupNote: "moved" };
    });
    await confirmThenClose(h);
    release();
    await flush();
    expect(h.finished).toHaveBeenCalledWith({ abandoned: true, backupNote: "moved" });
  });

  it("a plain Cancel is a cancel with no failure", async () => {
    const h = dialogOver(async () => ({ ok: true as const }));
    await buttonOf(h.content, ABANDON_COPY.cancel).dispatch("click");
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.finished).toHaveBeenCalledWith({ abandoned: false });
  });

  it("index.ts shows a notice for the failure after close-while-running, and none for a plain Cancel", async () => {
    const { stub } = await loadPlugin(null);
    const command = stub.commands.find((c) => c.id === "abandon-vault");
    // Cancel: nothing shown.
    void command?.callback?.();
    await flush();
    const first = Modal.instances.at(-1) as unknown as { contentEl: FakeEl };
    await buttonOf(first.contentEl, ABANDON_COPY.cancel).dispatch("click");
    await flush();
    expect(messages().filter((m) => m.includes(ABANDON_COPY.failed) || m.includes("abandoned"))).toEqual([]);

    // Close while the action runs; a fresh device has nothing to move, so the action fails.
    void command?.callback?.();
    await flush();
    const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl; close(): void };
    const field = byId(dialog.contentEl, "ipfs-sync-abandon-confirm");
    if (field === undefined) throw new Error("no field");
    field.value = "abandon";
    await field.dispatch("input");
    const click = buttonOf(dialog.contentEl, ABANDON_COPY.confirm).dispatch("click");
    dialog.close();
    await click;
    await vi.waitFor(() => expect(messages().some((m) => m.includes(ABANDON_COPY.failed))).toBe(true));
    expect(messages().some((m) => m.includes("vault abandoned"))).toBe(false);
  });
});

describe("B-M1: closing the dialog while the action runs does not hide a failure (clear stale lock)", () => {
  beforeEach(() => {
    Notice.reset();
    Modal.reset();
  });

  function dialogOver(clear: () => Promise<{ ok: true } | { ok: false; reason: string }>) {
    const finished = vi.fn<(outcome: ClearLockOutcome) => void>();
    const dialog = new ClearStaleLockDialog(new StubApp(new MemoryAdapter()) as unknown as ObsidianApp, { description: "process 0 on h, last heartbeat 999 s ago", clear }, finished);
    dialog.open();
    return { dialog, content: (dialog as unknown as { contentEl: FakeEl }).contentEl, finished };
  }

  it.each(["the lock is no longer stale (a publish refreshed it)", "the lock file cannot be read"])("carries the failure %s when closed while running", async (reason) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = dialogOver(async () => {
      await gate;
      return { ok: false, reason };
    });
    const click = buttonOf(h.content, STALE_LOCK_COPY.confirm).dispatch("click");
    h.dialog.close();
    await click;
    release();
    await flush();
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.finished).toHaveBeenCalledWith({ cleared: false, failure: reason });
  });

  it("uses fixed text when the action throws, with the dialog open or closed", async () => {
    for (const closeFirst of [true, false]) {
      const h = dialogOver(async () => {
        throw new Error(SECRET);
      });
      const click = buttonOf(h.content, STALE_LOCK_COPY.confirm).dispatch("click");
      if (closeFirst) h.dialog.close();
      await click;
      await flush();
      expect(JSON.stringify(h.finished.mock.calls)).not.toContain(SECRET);
      expect(byId(h.content, "ipfs-sync-stale-lock-error")?.text ?? "").not.toContain(SECRET);
      if (closeFirst) expect(h.finished.mock.calls[0]?.[0]).toMatchObject({ cleared: false, failure: expect.any(String) });
    }
  });

  it("reports success when closed while running, and a plain Cancel carries no failure", async () => {
    const ok = dialogOver(async () => ({ ok: true }));
    const click = buttonOf(ok.content, STALE_LOCK_COPY.confirm).dispatch("click");
    ok.dialog.close();
    await click;
    await flush();
    expect(ok.finished).toHaveBeenCalledWith({ cleared: true });

    const cancel = dialogOver(async () => ({ ok: true }));
    await buttonOf(cancel.content, STALE_LOCK_COPY.cancel).dispatch("click");
    expect(cancel.finished).toHaveBeenCalledWith({ cleared: false });
  });

  it("the flow turns a failure into the notice text and a cancel into nothing", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.now();
    adapter.put(LOCK, encodeLock({ token: "t", pid: 0, host: "obsidian-1a2b3c4d", time: now - LOCK_STALE_MS - 5000 }));
    let finish: ((outcome: ClearLockOutcome) => void) | undefined;
    const control = createStaleLockControl({ lockFile: createAdapterLockFile(adapter, () => now), now: () => now, syncLock: createSyncLock() });
    const flow = createStaleLockFlow({
      control,
      openDialog: (_request, onFinish) => {
        finish = onFinish;
        return { close: () => undefined };
      },
    });
    const failed = flow.open();
    await flush();
    finish?.({ cleared: false, failure: "the lock file cannot be read" });
    const { notice } = await failed;
    expect(notice).toContain(STALE_LOCK_COPY.failed);
    expect(notice).toContain("the lock file cannot be read");

    const cancelled = flow.open();
    await flush();
    finish?.({ cleared: false });
    expect(await cancelled).toEqual({ notice: "" });
  });

  it("index.ts shows a notice for a failure after close-while-running", async () => {
    const adapter = new MemoryAdapter();
    const { stub } = await loadPlugin(null, adapter);
    adapter.put(LOCK, encodeLock({ token: "t", pid: 0, host: "obsidian-1a2b3c4d", time: Date.now() - LOCK_STALE_MS - 5000 }));
    const done = stub.commands.find((c) => c.id === "clear-stale-lock")?.callback?.();
    await vi.waitFor(() => expect(Modal.instances.at(-1)).toBeInstanceOf(ClearStaleLockDialog));
    const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl; close(): void };
    // The lock is refreshed after the dialog opened: clearing is refused.
    adapter.put(LOCK, encodeLock({ token: "t", pid: 0, host: "obsidian-1a2b3c4d", time: Date.now() }));
    const click = buttonOf(dialog.contentEl, STALE_LOCK_COPY.confirm).dispatch("click");
    dialog.close();
    await click;
    await done;
    await vi.waitFor(() => expect(messages().some((m) => m.includes(STALE_LOCK_COPY.failed))).toBe(true));
    expect(messages().some((m) => m === STALE_LOCK_COPY.cleared)).toBe(false);
  });
});

describe("B-L6: the flows track each dialog handle by identity", () => {
  it("stale-lock: a late finish of the first dialog does not drop the second handle, and dispose closes what is open", async () => {
    const adapter = new MemoryAdapter();
    const now = Date.now();
    adapter.put(LOCK, encodeLock({ token: "t", pid: 0, host: "obsidian-1a2b3c4d", time: now - LOCK_STALE_MS - 5000 }));
    const control = createStaleLockControl({ lockFile: createAdapterLockFile(adapter, () => now), now: () => now, syncLock: createSyncLock() });
    const handles: { close: ReturnType<typeof vi.fn>; finish: (o: ClearLockOutcome) => void }[] = [];
    const deps: StaleLockFlowDeps = {
      control,
      openDialog: (_request, onFinish) => {
        const close = vi.fn();
        handles.push({ close, finish: onFinish });
        return { close };
      },
    };
    for (const order of ["first-finishes-late", "first-finishes-on-close"] as const) {
      handles.length = 0;
      const flow = createStaleLockFlow(deps);
      const a = flow.open();
      await flush();
      const b = flow.open();
      await flush();
      expect(handles).toHaveLength(2);
      expect(handles[0]?.close).toHaveBeenCalledTimes(1);
      if (order === "first-finishes-on-close") handles[0]?.finish({ cleared: false });
      handles[0]?.finish({ cleared: false });
      flow.dispose();
      expect(handles[1]?.close).toHaveBeenCalledTimes(1);
      handles[1]?.finish({ cleared: false });
      await Promise.all([a, b]);
    }
  });

  it("abandon: only one dialog is open; the first is closed when a second opens, and dispose closes the second even after the first finished late", async () => {
    const handles: { close: ReturnType<typeof vi.fn>; finish: (o: AbandonOutcome) => void }[] = [];
    const flow = createAbandonFlow({
      store: { get: () => defaultSettings() } as unknown as SettingsStore,
      adapter: new MemoryAdapter() as unknown as AbandonFlowDeps["adapter"],
      lock: createSyncLock(),
      session: { lock: vi.fn(), refresh: vi.fn(async () => "not-set-up" as const) },
      now: () => NOW,
      openDialog: (_request, onFinish) => {
        const close = vi.fn(() => onFinish({ abandoned: false }));
        handles.push({ close, finish: onFinish });
        return { close };
      },
    });
    const a = flow.open();
    const b = flow.open();
    expect(handles).toHaveLength(2);
    expect(handles[0]?.close).toHaveBeenCalledTimes(1);
    expect(await a).toEqual({ abandoned: false });
    handles[0]?.finish({ abandoned: false }); // a late duplicate must not clear the second handle
    flow.dispose();
    expect(handles[1]?.close).toHaveBeenCalledTimes(1);
    expect(await b).toEqual({ abandoned: false });
  });

  it("abandon: a dialog that is running (lock held) is not replaced by a second open", async () => {
    const lock = createSyncLock();
    const open = vi.fn(() => ({ close: vi.fn() }));
    const flow = createAbandonFlow({
      store: { get: () => defaultSettings() } as unknown as SettingsStore,
      adapter: new MemoryAdapter() as unknown as AbandonFlowDeps["adapter"],
      lock,
      session: { lock: vi.fn(), refresh: vi.fn(async () => "not-set-up" as const) },
      now: () => NOW,
      openDialog: open,
    });
    const release = lock.tryAcquire("abandon");
    expect(await flow.open()).toBe("busy");
    expect(open).not.toHaveBeenCalled();
    release?.();
  });
});

describe("B-L7: the unreadable-file copy is verified, and the pending flag clears only after the save", () => {
  const DATA = ".obsidian/plugins/ipfs-sync/data.json";
  const RAW = '{ "version": 99, "auth": { "token": "tok-secret" } }';

  function adapterWithRaw(): MemoryAdapter {
    const adapter = new MemoryAdapter();
    adapter.put(DATA, RAW);
    return adapter;
  }

  it("keeps the backup pending when saveData fails, so the retry copies again; clears it after a success", async () => {
    const adapter = adapterWithRaw();
    let fail = true;
    const saves: unknown[] = [];
    const port = {
      loadData: async () => ({ version: 99 }),
      saveData: async (data: unknown) => {
        if (fail) throw new Error("disk full");
        saves.push(data);
      },
    };
    const { store } = await openSettingsStore(port, createUnreadableBackup({ adapter, dataPath: DATA, now: () => NOW }));
    const copies = (): string[] => [...adapter.files.keys()].filter((p) => p.includes(".unreadable-"));
    await expect(store.update((s) => ({ ...s, mfsRoot: "/a" }))).rejects.toThrow("disk full");
    expect(copies()).toHaveLength(1);
    await expect(store.update((s) => ({ ...s, mfsRoot: "/a" }))).rejects.toThrow("disk full");
    expect(copies()).toHaveLength(2); // still pending: the copy is made again
    fail = false;
    await store.update((s) => ({ ...s, mfsRoot: "/a" }));
    expect(copies()).toHaveLength(3);
    await store.update((s) => ({ ...s, mfsRoot: "/b" }));
    expect(copies()).toHaveLength(3); // cleared by the success: no further copy
    expect(saves).toHaveLength(2);
  });

  it.each([
    ["truncates the copy", (path: string, data: ArrayBuffer, adapter: MemoryAdapter) => adapter.put(path, new Uint8Array(data).slice(0, 5))],
    ["writes other bytes", (path: string, _data: ArrayBuffer, adapter: MemoryAdapter) => adapter.put(path, "something else")],
    ["writes nothing", () => undefined],
  ])("refuses the save when the adapter %s", async (_name, write) => {
    const adapter = adapterWithRaw();
    adapter.writeBinary = async (path, data) => void write(path, data, adapter);
    const saveData = vi.fn(async () => undefined);
    const { store } = await openSettingsStore({ loadData: async () => ({ version: 99 }), saveData }, createUnreadableBackup({ adapter, dataPath: DATA, now: () => NOW }));
    await expect(store.update((s) => ({ ...s, mfsRoot: "/a" }))).rejects.toThrow();
    expect(saveData).not.toHaveBeenCalled();
    expect(adapter.text(DATA)).toBe(RAW);
    expect(store.get()).toEqual(defaultSettings());
  });

  it("accepts a copy that reads back identical", async () => {
    const adapter = adapterWithRaw();
    const backup = createUnreadableBackup({ adapter, dataPath: DATA, now: () => NOW });
    const path = await backup.save("");
    expect(adapter.text(path)).toBe(RAW);
  });

  it("store keeps working with no backup port", async () => {
    const store = createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { settings: defaultSettings(), outcome: "current", notices: [], persist: false });
    await expect(store.update((s) => s)).resolves.toBeDefined();
  });
});

describe("B-L8: the unreadable-settings notice reads as sentences", () => {
  it("has a space after the full stop", () => {
    const { notices } = loadSettings({ version: 99 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("sequence floor record. Before that happens");
    expect(notices[0]).not.toMatch(/\.[A-Z]/);
  });
});

describe("B-L4: the publish interval is a whole number of minutes", () => {
  const stored = (minutes: unknown): unknown => ({ ...testNodeSettings(), publishIntervalMinutes: minutes });

  it.each([0.0000001, 1.5, -1, 0.5])("loads a stored %s as the default (0, off) and keeps the rest of the file", (value) => {
    const result = loadSettings(stored(value));
    expect(result.outcome).not.toBe("unreadable");
    expect(result.settings.publishIntervalMinutes).toBe(0);
    expect(result.settings.rpc.url).toBe("https://node.test");
  });

  it.each([0, 1, 15, 35_000, 35_001])("keeps a stored whole number %s", (value) => {
    expect(loadSettings(stored(value)).settings.publishIntervalMinutes).toBe(value);
  });

  it("still treats a non-number (other than null) as unreadable", () => {
    expect(loadSettings(stored("5")).outcome).toBe("unreadable");
  });

  // R5-L5: JSON.stringify turns NaN and Infinity into null, so a stored null is a damaged number, not a different type.
  it("loads a stored null (what JSON.stringify makes of NaN or Infinity) as 0 and keeps the rest of the file", () => {
    const result = loadSettings(stored(null));
    expect(result.outcome).not.toBe("unreadable");
    expect(result.settings.publishIntervalMinutes).toBe(0);
    expect(result.settings.rpc.url).toBe("https://node.test");
    expect(result.settings.mfsRoot).toBe(testNodeSettings().mfsRoot);
  });

  it("round trips NaN and Infinity through JSON text to 0", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const reread: unknown = JSON.parse(JSON.stringify(stored(value)));
      const result = loadSettings(reread);
      expect(result.outcome).not.toBe("unreadable");
      expect(result.settings.publishIntervalMinutes).toBe(0);
      expect(result.settings.rpc.url).toBe("https://node.test");
    }
  });

  it.each([["a string", "5"], ["an object", {}], ["a boolean", true], ["an array", []], ["undefined (absent)", undefined]])(
    "keeps %s unreadable",
    (_label, value) => {
      expect(loadSettings(stored(value)).outcome).toBe("unreadable");
    },
  );

  describe("the timer", () => {
    afterEach(() => vi.unstubAllGlobals());

    async function armedWith(minutes: number): Promise<ReturnType<typeof vi.fn>> {
      const setInterval = vi.fn(() => 7);
      vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
      const { plugin } = await loadPlugin(null);
      setInterval.mockClear();
      await (plugin as unknown as { store: SettingsStore }).store.update((s) => ({ ...s, publishIntervalMinutes: minutes }));
      plugin.rearmAutoPublish();
      return setInterval;
    }

    it.each([
      [0.0000001, 1],
      [1.5, 1],
      [35_000, 35_000],
      [35_001, 35_000],
      [999_999, 35_000],
    ])("%s minutes arms the timer at %s minutes", async (minutes, expected) => {
      const setInterval = await armedWith(minutes);
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(setInterval).toHaveBeenCalledWith(expect.any(Function), expected * 60_000);
    });

    it.each([-1, Number.NaN, 0, Number.POSITIVE_INFINITY])("%s minutes arms no timer", async (minutes) => {
      const setInterval = await armedWith(minutes);
      expect(setInterval).not.toHaveBeenCalled();
    });
  });
});

describe("B-L3: an origin change blanks that block's unsaved credential draft", () => {
  function memoryStore(patch: Partial<PluginSettings>): SettingsStore {
    let saved: unknown = null;
    return createSettingsStore(
      { loadData: async () => saved, saveData: async (next) => void (saved = structuredClone(next)) },
      { settings: { ...defaultSettings(), ...patch }, outcome: "current", notices: [], persist: false },
    );
  }

  function rig(patch: Partial<PluginSettings> = {}): { vm: SettingsViewModel; store: SettingsStore } {
    const store = memoryStore({ rpc: { url: "https://a.example.org" }, gateway: { url: "https://g.example.org" }, ...patch });
    return { vm: createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => [] }), store };
  }

  it.each([
    ["rpcUrl", "https://b.example.org"],
    ["rpcPort", "5002"],
  ] as const)("node block: password typed, then %s changed, then user typed: the old password is not saved", async (field, value) => {
    const r = rig();
    await r.vm.edit("authScheme", "basic");
    expect((await r.vm.edit("authPassword", "oldpw")).state.authPending).toBe(true);
    const moved = await r.vm.edit(field, value);
    expect(moved.saved).toBe(true);
    expect(moved.state.authPending).toBe(false);
    expect(moved.state.values.authPassword).toBe("");
    await r.vm.edit("authUser", "alice");
    expect(JSON.stringify(r.store.get())).not.toContain("oldpw");
    expect(r.store.get().auth.scheme).not.toBe("basic");
  });

  it("node block: a typed header value is blanked too", async () => {
    const r = rig();
    await r.vm.edit("authScheme", "header");
    await r.vm.edit("authHeaderValue", "oldhv");
    await r.vm.edit("rpcUrl", "https://b.example.org");
    await r.vm.edit("authHeaderName", "X-Key");
    expect(JSON.stringify(r.store.get())).not.toContain("oldhv");
    expect(r.vm.state().values.authHeaderValue).toBe("");
  });

  it("node block: a fresh complete entry after the move is saved", async () => {
    const r = rig();
    await r.vm.edit("authScheme", "basic");
    await r.vm.edit("authPassword", "oldpw");
    await r.vm.edit("rpcUrl", "https://b.example.org");
    await r.vm.edit("authScheme", "basic");
    await r.vm.edit("authUser", "alice");
    expect((await r.vm.edit("authPassword", "newpw")).saved).toBe(true);
    expect(r.store.get().auth).toEqual({ scheme: "basic", user: "alice", password: "newpw" });
  });

  it("node block: an edit that keeps the origin keeps the draft", async () => {
    const r = rig();
    await r.vm.edit("authScheme", "basic");
    await r.vm.edit("authPassword", "pw");
    const same = await r.vm.edit("rpcUrl", "https://a.example.org/path");
    expect(same.state.authPending).toBe(true);
    expect(same.state.values.authPassword).toBe("pw");
  });

  it.each([
    ["gatewayUrl", "https://h.example.org"],
    ["gatewayPort", "8081"],
  ] as const)("gateway block: password typed, then %s changed, then user typed: the old password is not saved", async (field, value) => {
    const r = rig();
    await r.vm.edit("gatewayAuthScheme", "basic");
    expect((await r.vm.edit("gatewayAuthPassword", "oldgw")).state.gatewayAuthPending).toBe(true);
    const moved = await r.vm.edit(field, value);
    expect(moved.saved).toBe(true);
    expect(moved.state.gatewayAuthPending).toBe(false);
    expect(moved.state.values.gatewayAuthPassword).toBe("");
    await r.vm.edit("gatewayAuthUser", "bob");
    expect(JSON.stringify(r.store.get())).not.toContain("oldgw");
  });

  it("the cleared line does not linger after an unrelated edit", async () => {
    const r = rig({ auth: { scheme: "bearer", token: "tok" }, gatewayAuth: { scheme: "bearer", token: "gtok" } });
    const moved = await r.vm.edit("rpcUrl", "https://b.example.org");
    expect(moved.state.rpcCredentialNotice).not.toBe("");
    expect((await r.vm.edit("mfsRoot", "/obsidian-vault-sync/other")).state.rpcCredentialNotice).toBe("");

    const gw = await r.vm.edit("gatewayUrl", "https://h.example.org");
    expect(gw.state.gatewayCredentialNotice).not.toBe("");
    expect((await r.vm.edit("publishIntervalMinutes", "5")).state.gatewayCredentialNotice).toBe("");
    expect(r.vm.state().rpcCredentialNotice).toBe("");
  });
});

describe("B-redirect: the credential area says redirects may be followed", () => {
  const count = (root: FakeEl): number => root.findAll((el) => el.text === SECRETS_REDIRECT_NOTE).length;

  it("is one plain sentence with no secret", () => {
    expect(SECRETS_REDIRECT_NOTE).toMatch(/^[A-Z][^.]*\.$/);
    expect(SECRETS_REDIRECT_NOTE.toLowerCase()).toContain("redirect");
  });

  it("is hidden when no credential kind is chosen", async () => {
    const { root } = await openTab();
    expect(count(root)).toBe(0);
  });

  it("renders once when a node credential kind is chosen, and goes away when it is set back to none", async () => {
    const { root } = await openTab();
    await typeInto(root, "Authentication scheme", "bearer");
    expect(count(root)).toBe(1);
    await typeInto(root, "Authentication scheme", "none");
    expect(count(root)).toBe(0);
  });

  it("renders once when only a gateway credential kind is chosen, and once when both are", async () => {
    const { root } = await openTab();
    await typeInto(root, "Gateway authentication", "bearer");
    expect(count(root)).toBe(1);
    await typeInto(root, "Authentication scheme", "basic");
    expect(count(root)).toBe(1);
  });

  it("renders once from the start when a saved credential exists", async () => {
    const { root } = await openTab({ auth: { scheme: "bearer", token: "tok" } });
    expect(count(root)).toBe(1);
  });
});
