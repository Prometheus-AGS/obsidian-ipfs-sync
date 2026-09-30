import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { defaultSettings } from "../../src/plugin/settings-model";
import * as entry from "../../src/main";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Notice, requestUrlCalls, resetRequestUrl, type Plugin as StubPlugin } from "../support/obsidian-stub";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;

async function loadPlugin(data: unknown, adapter = new MemoryAdapter()): Promise<{ plugin: IpfsSyncPlugin; stub: StubPlugin }> {
  const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as App, MANIFEST);
  const stub = plugin as unknown as StubPlugin;
  stub.data = data;
  await plugin.onload();
  return { plugin, stub };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("plugin entry", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    Notice.reset();
    resetRequestUrl();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the Publish, Pull, Status, Abandon and Clear stale lock commands and one ribbon icon for each of Publish and Pull", async () => {
    const { stub } = await loadPlugin(null);
    expect(stub.commands.map((c) => `${c.id}:${c.name}`)).toEqual(["publish-vault:Publish vault", "pull-vault:Pull vault", "show-status:Show status", "abandon-vault:Abandon this vault", "clear-stale-lock:Clear stale publish lock"]);
    expect(stub.ribbonIcons).toHaveLength(2);
    expect(stub.statusBarItems).toHaveLength(1);
  });

  it("refuses to publish a vault without the marker: a notice, and no request to the node", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private");
    const { stub } = await loadPlugin(null, adapter);
    stub.ribbonIcons[0]?.callback({} as MouseEvent);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestUrlCalls).toEqual([]);
    const messages = Notice.shown.map((n) => n.message);
    expect(messages.some((m) => m.includes("not yet independently reviewed or verified in Obsidian"))).toBe(true);
    // The progress notice was dismissed and the status bar cleared.
    expect(Notice.shown.filter((n) => n.message === "IPFS Sync: publishing...").every((n) => n.hidden)).toBe(true);
    expect(stub.statusBarItems[0]?.text).toBe("");
  });

  it("migrates the previous settings once, stores the new form, and shows the key notice", async () => {
    const { stub } = await loadPlugin({ rpcUrl: "https://node.example.org", keyName: "consult-capture", authToken: "abc", excludedPaths: "", publishIntervalMinutes: 0 });
    const stored = stub.data as { version: number; auth: unknown; publicationKey: string };
    expect(stored.version).toBe(3);
    expect(stored.auth).toEqual({ scheme: "bearer", token: "abc" });
    expect(stored.publicationKey).toBe("obsidian-vault-sync");
    expect(Notice.shown.some((n) => n.message.includes("consult-capture"))).toBe(true);
  });

  it("leaves unreadable stored data untouched and says so", async () => {
    const { stub } = await loadPlugin("garbage");
    expect(stub.data).toBe("garbage");
    expect(Notice.shown).toHaveLength(1);
  });

  it("arms the timer from the stored interval and explains a refusal at most once per session", async () => {
    const setInterval = vi.fn(() => 7);
    vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
    const { stub } = await loadPlugin({ ...defaultSettings(), publishIntervalMinutes: 5 });
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    expect(stub.intervals).toEqual([7]);

    const tick = (setInterval.mock.calls[0] as unknown as [() => void])[0];
    tick();
    await flush();
    tick();
    await flush();
    expect(Notice.shown.filter((n) => n.message.includes("not yet independently reviewed or verified in Obsidian"))).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not arm a timer when the interval is 0", async () => {
    const setInterval = vi.fn(() => 1);
    vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
    await loadPlugin(null);
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("shows the status without contacting the node when the settings are invalid", async () => {
    const { plugin } = await loadPlugin({ ...defaultSettings(), mfsRoot: "/obsidian-vault-staging" });
    await plugin.showStatus();
    const message = Notice.shown.at(-1)?.message ?? "";
    expect(message).toContain("unknown");
    expect(message).toContain("/obsidian-vault-sync");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("plugin source layout", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  }

  it("keeps src/main.ts to a re-export of the plugin", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(readFileSync(join(SRC, "main.ts"), "utf8").trim()).toBe('export { default } from "./plugin";');
  });

  it("has no legacy upload, private RPC helper or tar pull, and FormData only inside src/kubo", () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/ipfsRequest|api\/v0\/get|parseTar|\b(tar|untar|tarball)\b/i);
      if (!file.includes(`${join("src", "kubo")}`)) expect(text, file).not.toContain("FormData");
    }
  });

  it("imports no Node built-in module under src", () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/from ["']node:|require\(["'](fs|path|child_process)["']\)|from ["'](fs|path|child_process)["']/);
    }
  });
});
