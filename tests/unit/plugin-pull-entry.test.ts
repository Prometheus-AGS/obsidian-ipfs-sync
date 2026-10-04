import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { setPluginSeams } from "../../src/plugin/plugin-seams";
import type { PluginSettings } from "../../src/plugin/settings-model";
import { testNodeSettings } from "../helpers/test-node-settings";
import { createFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { plantPlaintextRoot } from "../helpers/plugin-pull-rig";
import { IPNS_NAME } from "../helpers/pull-fixtures";
import { serveGateway } from "../helpers/request-url-node";
import { MemoryAdapter } from "../support/memory-adapter";
import { referencePassphrase } from "../vectors/slot-helpers";
import { App as StubApp, Modal, Notice, requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse, type Plugin as StubPlugin, type RequestUrlResponse } from "../support/obsidian-stub";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const MFS = "/obsidian-vault-sync/mvp05-entry";
const KEYS = [{ name: "obsidian-vault-sync", id: IPNS_NAME }];

function settings(patch: Partial<PluginSettings> = {}): PluginSettings {
  return { ...testNodeSettings(), mfsRoot: MFS, ownedKeys: [IPNS_NAME], ...patch };
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
  await plugin.onload();
  return { plugin, stub, app };
}

/** A node whose published root is an old plaintext publication (a `manifest.json`, no key slots). */
function plaintextNode(files: Record<string, string>): { gateway: FakeGateway; paths: string[] } {
  const gateway = createFakeGateway();
  plantPlaintextRoot(gateway, files);
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

  it("registers Publish, Pull, Restore, Resolve fork, Status, Abandon and Clear stale lock commands, and a ribbon icon for each of Publish and Pull", async () => {
    const { stub } = await loadPlugin(settings(), new MemoryAdapter());
    expect(stub.commands.map((c) => `${c.id}:${c.name}`)).toEqual([
      "publish-vault:Publish vault",
      "pull-vault:Pull vault",
      "restore-version:Restore an older version",
      "resolve-fork:Resolve fork",
      "show-status:Show status",
      "abandon-vault:Abandon this vault",
      "clear-stale-lock:Clear stale publish lock",
      "measure-key-derivation:Measure key derivation time",
    ]);
    expect(stub.ribbonIcons.map((r) => r.title)).toEqual(["IPFS Sync: publish vault", "IPFS Sync: pull vault"]);
    expect(stub.statusBarItems).toHaveLength(1);
  });

  it("refuses a plaintext root: a single notice that says plaintext publications are no longer supported, nothing written, only reads from the node", async () => {
    const adapter = fixtureVault();
    adapter.put("a.md", "local text", 5000);
    const { plugin, stub } = await loadPlugin(settings(), adapter);
    const { paths } = plaintextNode({ "a.md": "remote text", "b.md": "bravo" });

    const outcome = await plugin.pullVault();
    expect(outcome).toMatchObject({ kind: "refused", reason: "plaintext-unsupported" });

    expect(Notice.shown).toHaveLength(1);
    const notice = Notice.shown[0];
    expect(notice?.message).toContain("plaintext publications are no longer supported");
    expect(notice?.hidden).toBe(false);
    vi.runAllTimers();
    expect(notice?.hidden).toBe(true);

    expect(adapter.text("a.md")).toBe("local text");
    expect(adapter.files.has("b.md")).toBe(false);
    expect([...adapter.files.keys()].some((path) => path.startsWith("a (ipfs conflict"))).toBe(false);

    // Read-only: name resolve, key list, one listing of the root (the decrypting pull's first look, which finds no key slots here), all through requestUrl; the manifest is never fetched.
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path, path).toMatch(/^(POST \/api\/v0\/(key\/list|name\/resolve|ls)|GET \/ipfs\/)/);
    expect(paths.some((path) => path.includes("manifest.json"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((stub.data as { lastPull?: unknown }).lastPull).toBeUndefined();
  });

  it("does not refuse a vault with notes for lacking a marker (the guard is removed): it reaches the node, changes no note and writes no marker", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private", 5000);
    const { plugin } = await loadPlugin(settings(), adapter);
    plaintextNode({ "notes/real.md": "remote" });
    requestUrlCalls.length = 0;

    const outcome = await plugin.pullVault();
    expect(outcome).not.toMatchObject({ reason: "fixture-only" });
    expect(requestUrlCalls.length).toBeGreaterThan(0);
    expect(Notice.shown.map((n) => n.message).join("\n")).not.toContain("stays disabled in this build");
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

  it("sweeps the temp folder once the layout is ready, never inside onload, and sends no request", async () => {
    const adapter = fixtureVault();
    adapter.put(".ipfs-sync/tmp/stale-1.part", "partial", 1000);
    const loaded = await loadPlugin(settings({ catchUpOnLoad: false }), adapter);
    expect(adapter.files.has(".ipfs-sync/tmp/stale-1.part")).toBe(true);
    expect(adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);

    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(adapter.files.has(".ipfs-sync/tmp/stale-1.part")).toBe(false));
    expect(adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(requestUrlCalls).toEqual([]);
    expect(Notice.shown).toEqual([]);
  });

  it("waits for the layout, then pulls once when catch-up is on; a plaintext root is refused with one notice and nothing written", async () => {
    const adapter = fixtureVault();
    const loaded = await loadPlugin(settings({ catchUpOnLoad: true }), adapter);
    plaintextNode({ "a.md": "alpha", "b.md": "bravo" });
    // The plugin has loaded; nothing is requested until the workspace is ready.
    expect(loaded.stub.commands).toHaveLength(8);
    expect(requestUrlCalls).toEqual([]);

    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(Notice.shown).toHaveLength(1));
    expect(Notice.shown[0]?.message).toContain("plaintext publications are no longer supported");
    expect(adapter.files.has("a.md")).toBe(false);
    expect((loaded.stub.data as PluginSettings).lastPull).toBeUndefined();
    expect(loaded.stub.statusBarItems[0]?.text).toBe("");
  });

  it("loads normally and shows one failure notice when the node cannot be reached on load", async () => {
    setRequestUrlHandler(() => {
      throw new Error("network is unreachable");
    });
    const loaded = await loadPlugin(settings({ catchUpOnLoad: true }), fixtureVault());
    expect(loaded.stub.commands).toHaveLength(8);
    expect(Notice.shown).toEqual([]);

    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(Notice.shown).toHaveLength(1));
    expect(Notice.shown[0]?.message).toContain("pull failed");
    expect(Notice.shown[0]?.message).toContain("network is unreachable");
    expect(loaded.stub.statusBarItems[0]?.text).toBe("");
  });

  it("catch-up on load is not refused for lacking a marker in a vault with notes (the guard is removed): the pull reaches the node", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private", 5000);
    const loaded = await loadPlugin(settings({ catchUpOnLoad: true }), adapter);
    loaded.app.workspace.markLayoutReady();
    await vi.waitFor(() => expect(requestUrlCalls.length).toBeGreaterThan(0));
    expect(Notice.shown.map((n) => n.message).join("\n")).not.toContain("stays disabled in this build");
    expect(adapter.text("notes/real.md")).toBe("private");
  });

  it("W-12: exposes the passphrase source as no property, and has no plaintext-v1 switch at all", async () => {
    const { plugin } = await loadPlugin(settings(), fixtureVault());
    setPluginSeams(plugin, { passphraseSource: () => referencePassphrase() });
    const names = [...Object.getOwnPropertyNames(plugin), ...Object.getOwnPropertyNames(Object.getPrototypeOf(plugin) as object)];
    expect(names).not.toContain("passphraseSource");
    expect(names).not.toContain("allowPlaintextV1");
    expect("passphraseSource" in plugin).toBe(false);
    expect("allowPlaintextV1" in plugin).toBe(false);
  });
});
