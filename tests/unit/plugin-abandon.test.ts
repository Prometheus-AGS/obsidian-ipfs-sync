import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { createAbandonFlow, NOTHING_TO_ABANDON, type AbandonFlowDeps } from "../../src/plugin/abandon-flow";
import { AbandonVaultDialog } from "../../src/plugin/abandon-vault-dialog";
import { ABANDON_COPY } from "../../src/plugin/encryption-copy";
import { defaultSettings } from "../../src/plugin/settings-model";
import type { SettingsStore } from "../../src/plugin/settings-store";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { rootDigest } from "../../src/sync/vault-keys";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Modal, Notice, requestUrlCalls, resetRequestUrl, type Plugin as StubPlugin } from "../support/obsidian-stub";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const NOW = new Date("2026-09-30T12:00:00Z");
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const KINDS = ["keyslots", "state", "journal"] as const;

async function seedState(adapter: MemoryAdapter, mfsRoot = defaultSettings().mfsRoot): Promise<string> {
  const digest = await rootDigest(mfsRoot);
  for (const kind of KINDS) adapter.put(`.ipfs-sync/${kind}.${digest}.json`, `${kind}-body`);
  return digest;
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

async function confirmInDialog(word: string): Promise<FakeEl> {
  const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl };
  const field = byId(dialog.contentEl, "ipfs-sync-abandon-confirm");
  if (field === undefined) throw new Error("no confirmation field");
  field.value = word;
  await field.dispatch("input");
  await button(dialog.contentEl, ABANDON_COPY.confirm).dispatch("click");
  await flush();
  return dialog.contentEl;
}

describe("plugin: Abandon this vault", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    Notice.reset();
    Modal.reset();
    resetRequestUrl();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load(adapter: MemoryAdapter): Promise<{ plugin: IpfsSyncPlugin; stub: StubPlugin }> {
    const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as ObsidianApp, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    stub.data = null;
    await plugin.onload();
    return { plugin, stub };
  }

  it("registers a command that opens the confirmation dialog", async () => {
    const { stub } = await load(new MemoryAdapter());
    const command = stub.commands.find((c) => c.id === "abandon-vault");
    expect(command?.name).toBe("Abandon this vault");
    await command?.callback?.();
    await flush();
    expect(Modal.instances.at(-1)).toBeInstanceOf(AbandonVaultDialog);
  });

  it("moves the copy, state and journal into a backup after the word is typed, and sends no request", async () => {
    const adapter = new MemoryAdapter();
    const digest = await seedState(adapter);
    const { stub } = await load(adapter);
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    await confirmInDialog("abandon");
    await vi.waitFor(() => expect(Notice.shown.some((n) => n.message.includes("vault abandoned"))).toBe(true));
    for (const kind of KINDS) {
      expect(adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
      const backup = [...adapter.files.keys()].find((path) => path.endsWith(`/${kind}.json`) && path.includes("abandoned-"));
      expect(backup, kind).toMatch(new RegExp(`^\\.ipfs-sync/abandoned-${digest}-\\d+/${kind}\\.json$`));
      expect(adapter.text(backup ?? "")).toBe(`${kind}-body`);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestUrlCalls).toEqual([]);
    const notice = Notice.shown.map((n) => n.message).find((m) => m.includes("vault abandoned"));
    expect(notice).toContain("3 files moved");
    expect(notice).toContain("Nothing on the node was changed");
  });

  it("moves nothing while the word is not typed", async () => {
    const adapter = new MemoryAdapter();
    const digest = await seedState(adapter);
    const { stub } = await load(adapter);
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    await confirmInDialog("aband");
    for (const kind of KINDS) expect(adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(true);
    expect([...adapter.files.keys()].some((path) => path.includes("abandoned-"))).toBe(false);
  });

  it("says in the dialog that a device with nothing to abandon moved nothing", async () => {
    const { stub } = await load(new MemoryAdapter());
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    const root = await confirmInDialog("abandon");
    await vi.waitFor(() => expect(byId(root, "ipfs-sync-abandon-error")?.text).toContain(NOTHING_TO_ABANDON.slice(0, 30)));
  });
});

describe("abandon flow", () => {
  function deps(overrides: Partial<AbandonFlowDeps> = {}, adapter = new MemoryAdapter()) {
    const lock = vi.fn();
    const refresh = vi.fn(async () => "not-set-up" as const);
    const store = { get: () => defaultSettings() } as unknown as SettingsStore;
    let request: Parameters<AbandonFlowDeps["openDialog"]>[0] | undefined;
    let finish: Parameters<AbandonFlowDeps["openDialog"]>[1] | undefined;
    const close = vi.fn();
    const all: AbandonFlowDeps = {
      store,
      adapter,
      lock: createSyncLock(),
      session: { lock, refresh },
      now: () => NOW,
      openDialog: (r, f) => {
        request = r;
        finish = f;
        return { close };
      },
      ...overrides,
    };
    return { all, lock, refresh, close, request: () => request, finish: () => finish, adapter };
  }

  it("locks the key session and looks again after the move", async () => {
    const d = deps();
    await seedState(d.adapter);
    const flow = createAbandonFlow(d.all);
    void flow.open();
    expect(await d.request()?.abandon()).toMatchObject({ ok: true });
    expect(d.lock).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it("is busy, and opens no dialog, while publish or pull holds the sync lock", async () => {
    const lock = createSyncLock();
    const release = lock.tryAcquire("publish");
    const open = vi.fn();
    const flow = createAbandonFlow(deps({ lock, openDialog: open as unknown as AbandonFlowDeps["openDialog"] }).all);
    expect(await flow.open()).toBe("busy");
    expect(open).not.toHaveBeenCalled();
    release?.();
  });

  it("refuses the move when an operation starts between opening the dialog and confirming, and holds the lock while it moves", async () => {
    const lock = createSyncLock();
    const d = deps({ lock });
    await seedState(d.adapter);
    const flow = createAbandonFlow(d.all);
    void flow.open();
    const release = lock.tryAcquire("pull");
    const refused = await d.request()?.abandon();
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain("pull");
    expect([...d.adapter.files.keys()].some((p) => p.includes("abandoned-"))).toBe(false);
    release?.();
    expect(await d.request()?.abandon()).toMatchObject({ ok: true });
    expect(lock.holder()).toBeUndefined();
  });

  it("returns an invalid MFS root as text and moves nothing", async () => {
    const bad = { get: () => ({ ...defaultSettings(), mfsRoot: "/elsewhere" }) } as unknown as SettingsStore;
    const d = deps({ store: bad });
    await seedState(d.adapter);
    void createAbandonFlow(d.all).open();
    const result = await d.request()?.abandon();
    expect(result).toMatchObject({ ok: false });
    expect(d.lock).not.toHaveBeenCalled();
  });

  it("closes an open dialog when disposed", () => {
    const d = deps();
    const flow = createAbandonFlow(d.all);
    void flow.open();
    flow.dispose();
    expect(d.close).toHaveBeenCalledTimes(1);
  });
});
