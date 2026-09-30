import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { setPluginSeams } from "../../src/plugin/plugin-seams";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { IPNS_NAME, seedRemote } from "../helpers/pull-fixtures";
import { serveGateway } from "../helpers/request-url-node";
import { MemoryAdapter } from "../support/memory-adapter";
import { referencePassphrase } from "../vectors/slot-helpers";
import { App as StubApp, Modal, Notice, requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse, type Plugin as StubPlugin, type RequestUrlResponse } from "../support/obsidian-stub";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const MFS = "/obsidian-vault-sync/mvp05-entry";
const KEYS = [{ name: "obsidian-vault-sync", id: IPNS_NAME }];
const TREE = "bafytreeone000000000000";
const ROOT = "bafyrootone000000000000";

function settings(patch: Partial<PluginSettings> = {}): PluginSettings {
  return { ...defaultSettings(), mfsRoot: MFS, ownedKeys: [IPNS_NAME], ...patch };
}

interface Loaded {
  readonly plugin: IpfsSyncPlugin;
  readonly stub: StubPlugin;
  readonly app: StubApp;
}

async function loadPlugin(data: unknown, adapter: MemoryAdapter): Promise<Loaded> {
  const app = new StubApp(adapter);
  const plugin = new IpfsSyncPlugin(app as unknown as App, MANIFEST);
  const stub = plugin as unknown as StubPlugin;
  stub.data = data;
  setPluginSeams(plugin, { allowPlaintextV1: true }); // the plaintext reader is off in a real plugin; these tests are about the plaintext path
  await plugin.onload();
  return { plugin, stub, app };
}

async function remoteNode(files: Record<string, string>): Promise<{ gateway: FakeGateway; paths: string[] }> {
  const gateway = createFakeGateway();
  await seedRemote(gateway, files, { tree: TREE, root: ROOT });
  const served = serveGateway(gateway, KEYS);
  setRequestUrlHandler(served.handler);
  return { gateway, paths: served.paths };
}

function fixtureVault(): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put(".obsidian/app.json", "{}", 1000);
  return adapter;
}

describe("plugin entry: pull", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    Notice.reset();
    resetRequestUrl();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("registers Publish, Pull, Status, Abandon and Clear stale lock commands, and a ribbon icon for each of Publish and Pull", async () => {
    const { stub } = await loadPlugin(settings(), new MemoryAdapter());
    expect(stub.commands.map((c) => `${c.id}:${c.name}`)).toEqual(["publish-vault:Publish vault", "pull-vault:Pull vault", "show-status:Show status", "abandon-vault:Abandon this vault", "clear-stale-lock:Clear stale publish lock"]);
    expect(stub.ribbonIcons.map((r) => r.title)).toEqual(["IPFS Sync: publish vault", "IPFS Sync: pull vault"]);
    expect(stub.statusBarItems).toHaveLength(1);
  });

  it("pulls with one conflict: a single notice updated in place, names the copy, and only reads from the node", async () => {
    const adapter = fixtureVault();
    adapter.put("a.md", "local text", 5000);
    adapter.put("c.md", "charlie", 5000);
    const { plugin, stub } = await loadPlugin(settings(), adapter);
    const { paths } = await remoteNode({ "a.md": "remote text", "b.md": "bravo", "c.md": "charlie" });

    const outcome = await plugin.pullVault();
    expect(outcome.kind).toBe("pulled");

    expect(Notice.shown).toHaveLength(1);
    const notice = Notice.shown[0];
    expect(notice?.message).toContain("Pull complete: 2 fetched, 1 unchanged, 1 conflicts, 0 failed, 0 remote deletions kept");
    expect(notice?.message).toMatch(/Conflict copies: a \(ipfs conflict \d{4}-\d{2}-\d{2}\)\.md/);
    expect(notice?.hidden).toBe(false);
    vi.runAllTimers();
    expect(notice?.hidden).toBe(true);

    expect(stub.statusBarItems[0]?.text).toMatch(/pull \d{2}:\d{2}: 2 fetched, 1 conflicts/);
    expect(adapter.text("a.md")).toBe("remote text");
    const copy = [...adapter.files.keys()].find((path) => path.startsWith("a (ipfs conflict"));
    expect(adapter.text(copy ?? "")).toBe("local text");

    // Read-only: name resolve, key list and gateway GETs, all through requestUrl.
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path, path).toMatch(/^(POST \/api\/v0\/(key\/list|name\/resolve)|GET \/ipfs\/)/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const stored = stub.data as { lastPull?: Record<string, unknown> };
    expect(stored.lastPull).toMatchObject({ fetched: 2, unchanged: 1, conflicts: 1, failed: 0, remoteDeleted: 0 });
    expect(Object.keys(stored.lastPull ?? {}).sort()).toEqual(["at", "conflicts", "failed", "fetched", "manifestCid", "remoteDeleted", "rootCid", "unchanged"]);
    expect(JSON.stringify(stored.lastPull)).not.toMatch(/\.md/);
  });

  it("refuses a real vault with a notice, sends nothing to the node and changes no file", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private", 5000);
    const { plugin } = await loadPlugin(settings(), adapter);
    await remoteNode({ "notes/real.md": "remote" });
    requestUrlCalls.length = 0;

    const outcome = await plugin.pullVault();
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(requestUrlCalls).toEqual([]);
    expect(Notice.shown.map((n) => n.message).join("\n")).toContain("Pull of a real vault is not available in this build");
    expect(adapter.text("notes/real.md")).toBe("private");
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
  });

  it("a passphrase dialog left open by a publish does not hold the shared lock: a pull is not answered busy (review-5 R5-04)", async () => {
    const adapter = fixtureVault();
    adapter.put("notes/a.md", "a", 5000);
    const { plugin } = await loadPlugin(settings(), adapter);
    // A manual publish on a device with no vault waits at the setup dialog. The dialog runs before the lock is taken.
    Modal.reset();
    const publishing = plugin.publishVault();
    await vi.waitFor(() => expect(Modal.instances).toHaveLength(1));
    const other = await plugin.pullVault();
    expect(other).not.toMatchObject({ kind: "refused", reason: "busy" });
    expect(Notice.shown.some((n) => n.message.includes("already in progress"))).toBe(false);
    Modal.instances[0]?.close();
    expect(await publishing).toMatchObject({ kind: "refused", reason: "cancelled" });
  });

  it("runs no pull on load when catch-up is off", async () => {
    const { app } = await loadPlugin(settings({ catchUpOnLoad: false }), fixtureVault());
    app.workspace.markLayoutReady();
    await Promise.resolve();
    expect(requestUrlCalls).toEqual([]);
    expect(Notice.shown).toEqual([]);
  });

  it("waits for the layout, pulls once when catch-up is on, and shows nothing when the vault is already current", async () => {
    const adapter = fixtureVault();
    const first = await loadPlugin(settings(), adapter);
    await remoteNode({ "a.md": "alpha", "b.md": "bravo" });
    await first.plugin.pullVault();
    vi.runAllTimers();

    Notice.reset();
    requestUrlCalls.length = 0;
    const second = await loadPlugin({ ...(first.stub.data as PluginSettings), catchUpOnLoad: true }, adapter);
    // The plugin has loaded; nothing is requested until the workspace is ready.
    expect(second.stub.commands).toHaveLength(5);
    expect(requestUrlCalls).toEqual([]);

    second.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect((second.stub.data as PluginSettings).lastPull).toMatchObject({ fetched: 0, unchanged: 2, conflicts: 0, failed: 0 }));
    expect(Notice.shown).toEqual([]);
    expect(second.stub.statusBarItems[0]?.text).toBe("");
  });

  it("loads normally and shows one failure notice when the node cannot be reached on load", async () => {
    setRequestUrlHandler(() => {
      throw new Error("network is unreachable");
    });
    const loaded = await loadPlugin(settings({ catchUpOnLoad: true }), fixtureVault());
    expect(loaded.stub.commands).toHaveLength(5);
    expect(Notice.shown).toEqual([]);

    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(Notice.shown).toHaveLength(1));
    expect(Notice.shown[0]?.message).toContain("pull failed");
    expect(Notice.shown[0]?.message).toContain("network is unreachable");
    expect(loaded.stub.statusBarItems[0]?.text).toBe("");
  });

  it("refuses on load, once, when catch-up is on in a real vault", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private", 5000);
    const loaded = await loadPlugin(settings({ catchUpOnLoad: true }), adapter);
    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(Notice.shown).toHaveLength(1));
    expect(Notice.shown[0]?.message).toContain("Pull of a real vault is not available in this build");
    expect(requestUrlCalls).toEqual([]);
  });

  it("W-12: exposes neither the passphrase source nor the plaintext-v1 switch as a property", async () => {
    const { plugin } = await loadPlugin(settings(), fixtureVault());
    setPluginSeams(plugin, { passphraseSource: () => referencePassphrase(), allowPlaintextV1: true });
    const names = [...Object.getOwnPropertyNames(plugin), ...Object.getOwnPropertyNames(Object.getPrototypeOf(plugin) as object)];
    expect(names).not.toContain("passphraseSource");
    expect(names).not.toContain("allowPlaintextV1");
    expect("passphraseSource" in plugin).toBe(false);
    expect("allowPlaintextV1" in plugin).toBe(false);
  });
});
