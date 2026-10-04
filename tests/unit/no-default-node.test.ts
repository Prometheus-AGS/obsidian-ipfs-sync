import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_TEXT } from "../../cli/help-text";
import { runCli } from "../../cli/run";
import type { CliIo } from "../../cli/io";
import type { ConfigDeps } from "../../cli/load-config";
import {
  ConfigError,
  defaultLayer,
  envLayer,
  isRetiredDefaultHost,
  parseConfigFile,
  RETIRED_DEFAULT_HOSTS,
  resolveSyncConfig,
} from "../../src/core/config";
import { createSyncEventBus } from "../../src/core/events";
import type { Transport } from "../../src/kubo";
import IpfsSyncPlugin from "../../src/plugin";
import { describeNode, NODE_NOT_SET_NOTICE, retiredDefaultNotice } from "../../src/plugin/node-status";
import { createPublishRunner } from "../../src/plugin/publish-runner";
import { createPullRunner } from "../../src/plugin/pull-runner";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { settingsToConfig, validateSettings } from "../../src/plugin/settings-to-config";
import { collectStatus } from "../../src/plugin/sync-status";
import { sessionRig } from "../helpers/plugin-session";
import { testNodeSettings } from "../helpers/test-node-settings";
import { MemoryAdapter } from "../support/memory-adapter";
import { open } from "../support/settings-tab-rig";
import { pullRig } from "../helpers/plugin-pull-rig";
import { App as StubApp, Notice, requestUrlCalls, resetRequestUrl, type Plugin as StubPlugin } from "../support/obsidian-stub";

const NOW = new Date("2026-10-04T12:00:00Z");
const RETIRED_URL = `https://${RETIRED_DEFAULT_HOSTS[0] ?? ""}`;

// ---------- the host string lives in exactly one module ----------

const ALLOWED_MODULE = join("src", "core", "config", "retired-default-hosts.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js|json)$/.test(entry.name) ? [path] : [];
  });
}

describe("no default node in the shipped code", () => {
  it("names the retired host only inside the one module used for the warning comparison", () => {
    const root = process.cwd();
    const hits = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "cli"))]
      .map((file) => relative(root, file))
      .filter((file) => file !== ALLOWED_MODULE)
      .filter((file) => /prometheusags/i.test(readFileSync(join(root, file), "utf8")));
    expect(hits).toEqual([]);
    expect(readFileSync(join(root, ALLOWED_MODULE), "utf8")).toContain("RETIRED_DEFAULT_HOSTS");
  });

  it("has no default RPC or gateway URL in the default layer", () => {
    const layer = defaultLayer();
    expect(layer.rpc).toBeUndefined();
    expect(layer.gateway).toBeUndefined();
    expect(layer.mfsRoot).toBe("/obsidian-vault-sync/default");
    expect(layer.publicationKey).toBe("obsidian-vault-sync");
  });
});

// ---------- the config fails closed ----------

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof ConfigError ? error.code : "not-a-config-error";
  }
}

describe("config resolution without a node", () => {
  it("refuses with no-rpc-url and names the flag, the variable and the config key", () => {
    expect(codeOf(() => resolveSyncConfig([], NOW))).toBe("no-rpc-url");
    try {
      resolveSyncConfig([], NOW);
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("--rpc-url");
      expect(message).toContain("IPFS_SYNC_RPC_URL");
      expect(message).toContain("rpc");
      expect(message).toContain("no default node");
    }
  });

  it("treats a port alone, an empty URL and a blank URL as unset", () => {
    expect(codeOf(() => resolveSyncConfig([envLayer({ IPFS_SYNC_RPC_PORT: "5001" })], NOW))).toBe("no-rpc-url");
    expect(codeOf(() => resolveSyncConfig([envLayer({ IPFS_SYNC_RPC_URL: "" })], NOW))).toBe("no-rpc-url");
    expect(codeOf(() => resolveSyncConfig([{ rpc: { url: "   " }, gateway: { url: "https://gw.test" } }], NOW))).toBe("no-rpc-url");
  });

  it("refuses an RPC URL without a gateway with no-gateway-url and never derives the gateway from the RPC URL", () => {
    const rpcOnly = { rpc: { url: "https://node.test" } };
    expect(codeOf(() => resolveSyncConfig([rpcOnly], NOW))).toBe("no-gateway-url");
    try {
      resolveSyncConfig([rpcOnly], NOW);
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("--gateway-url");
      expect(message).toContain("IPFS_SYNC_GATEWAY_URL");
      expect(message).toContain("derived from the RPC URL");
    }
  });

  it("is satisfied by a flag, the environment or the config file", () => {
    const both = { rpc: { url: "https://rpc.test" }, gateway: { url: "https://gw.test" } };
    expect(resolveSyncConfig([both], NOW).rpc.baseUrl).toBe("https://rpc.test");
    expect(resolveSyncConfig([envLayer({ IPFS_SYNC_RPC_URL: "https://rpc.test", IPFS_SYNC_GATEWAY_URL: "https://gw.test" })], NOW).gateway.baseUrl).toBe("https://gw.test");
    const file = parseConfigFile(JSON.stringify({ rpc: { url: "https://rpc.test" }, gateway: { url: "https://gw.test" } }));
    expect(resolveSyncConfig([file], NOW).rpc.baseUrl).toBe("https://rpc.test");
  });
});

// ---------- the CLI ----------

function sink(): { readonly io: CliIo; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t) }, out, err };
}

const deps = (env: Record<string, string> = {}): ConfigDeps => ({ env, now: () => NOW, readText: async () => undefined });

describe("the CLI without a node", () => {
  const fetchStub = vi.fn();
  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([[["status"]], [["publish", "vault-dir"]], [["pull", "vault-dir"]], [["init", "vault-dir"]], [["keys", "discard", "vault-dir"]], [["prune-history", "vault-dir", "--keep", "30", "--dry-run"]]])("exits 2 with an actionable message and sends nothing for %j", async (argv) => {
    const s = sink();
    expect(await runCli(argv, deps(), s.io)).toBe(2);
    const text = s.err.join("\n");
    expect(text).toContain("configuration error");
    expect(text).toContain("--rpc-url");
    expect(text).toContain("IPFS_SYNC_RPC_URL");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("names the gateway flag and variable when only the RPC URL is set", async () => {
    const s = sink();
    expect(await runCli(["status", "--rpc-url", "https://node.test"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("--gateway-url");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("says in --help that there is no default node and how to set one", async () => {
    const s = sink();
    expect(await runCli(["--help"], deps(), s.io)).toBe(0);
    const text = s.out.join("\n");
    expect(text).toBe(HELP_TEXT);
    expect(text).toContain("There is no default node");
    expect(text).toContain("--rpc-url");
    expect(text).toContain("IPFS_SYNC_RPC_URL");
    expect(text).toContain("--gateway-url");
    expect(text).not.toMatch(/prometheusags/i);
  });
});

// ---------- the plugin ----------

const MANIFEST = { id: "ipfs-sync", version: "0.3.0" } as unknown as PluginManifest;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function countingTransport(): Transport & { readonly calls: string[] } {
  const calls: string[] = [];
  const transport = Object.assign(
    async (url: string): Promise<Response> => {
      calls.push(url);
      throw new Error("a request was sent while no node is set");
    },
    { calls },
  );
  return transport;
}

function unsetStore() {
  return createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { ...loadSettings(null), settings: defaultSettings() });
}

function fixtureVault(): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  return adapter;
}

describe("plugin settings without a node", () => {
  it("starts with an empty RPC URL and gateway URL", () => {
    const settings = defaultSettings();
    expect(settings.rpc.url).toBe("");
    expect(settings.gateway.url).toBe("");
  });

  it("refuses settingsToConfig with the plugin's own words and the stable code", () => {
    let caught: unknown;
    try {
      settingsToConfig(defaultSettings(), NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("no-rpc-url");
    expect((caught as ConfigError).message).toContain(NODE_NOT_SET_NOTICE);
    expect((caught as ConfigError).message).not.toContain("--rpc-url");
    expect(codeOf(() => settingsToConfig({ ...defaultSettings(), rpc: { url: "https://node.test" } }, NOW))).toBe("no-gateway-url");
  });

  it("does not call an empty URL a field error, and says Not configured", () => {
    expect(validateSettings(defaultSettings(), NOW)).toEqual({ errors: [], warnings: [] });
    const node = describeNode(defaultSettings());
    expect(node.configured).toBe(false);
    expect(node.summary).toBe("Not configured");
    expect(node.explanation).toContain("no default IPFS node");
    expect(describeNode(testNodeSettings())).toMatchObject({ configured: true, summary: "Configured", explanation: "" });
  });

  it("publish (manual and timer) refuses with the notice and sends no request", async () => {
    const transport = countingTransport();
    const adapter = fixtureVault();
    const store = unsetStore();
    const runner = createPublishRunner({
      store,
      adapter,
      bus: createSyncEventBus(),
      transport,
      session: sessionRig({ store, adapter, createClient: () => { throw new Error("no client may be made"); } }).session,
      now: () => NOW,
    });
    const manual = await runner.run();
    expect(manual).toMatchObject({ kind: "refused", reason: "invalid-settings" });
    expect(manual.notice).toContain(NODE_NOT_SET_NOTICE);
    const timer = await runner.run({ unattended: true });
    expect(timer).toMatchObject({ kind: "refused", reason: "invalid-settings" });
    expect(timer.notice).toContain(NODE_NOT_SET_NOTICE);
    expect(transport.calls).toEqual([]);
  });

  it("pull refuses with the notice and sends no request", async () => {
    const transport = countingTransport();
    const adapter = fixtureVault();
    const runner = createPullRunner({ store: unsetStore(), adapter, bus: createSyncEventBus(), transport, now: () => NOW });
    const outcome = await runner.run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "invalid-settings" });
    expect(outcome.notice).toContain(NODE_NOT_SET_NOTICE);
    expect(transport.calls).toEqual([]);
  });

  it("the pull record readout refuses with the notice when unset and answers with a node", async () => {
    const unset = pullRig({ settings: { rpc: { url: "" }, gateway: { url: "" } } });
    await expect(unset.runner.record()).rejects.toThrow(NODE_NOT_SET_NOTICE);
    const set = pullRig();
    await expect(set.runner.record()).resolves.toBeUndefined();
  });

  it("status reports the problem and sends no request", async () => {
    const transport = countingTransport();
    const report = await collectStatus({ store: unsetStore(), adapter: fixtureVault(), transport, now: () => NOW });
    expect(report.notes.join(" ")).toContain(NODE_NOT_SET_NOTICE);
    expect(transport.calls).toEqual([]);
  });
});

describe("the plugin entry without a node", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    Notice.reset();
    resetRequestUrl();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load(data: unknown): Promise<{ plugin: IpfsSyncPlugin; stub: StubPlugin }> {
    const plugin = new IpfsSyncPlugin(new StubApp(fixtureVault()) as unknown as App, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    stub.data = data;
    await plugin.onload();
    return { plugin, stub };
  }

  it("publish, pull and the timer say 'Set your IPFS node in settings' and send no request", async () => {
    const setInterval = vi.fn(() => 9);
    vi.stubGlobal("window", { setInterval, clearInterval: vi.fn() });
    const { stub } = await load({ ...defaultSettings(), publishIntervalMinutes: 5 });
    stub.ribbonIcons[0]?.callback({} as MouseEvent);
    await flush();
    stub.ribbonIcons[1]?.callback({} as MouseEvent);
    await flush();
    (setInterval.mock.calls[0] as unknown as [() => void])[0]();
    await flush();
    const messages = Notice.shown.map((n) => n.message);
    expect(messages.filter((m) => m.includes(NODE_NOT_SET_NOTICE)).length).toBeGreaterThanOrEqual(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestUrlCalls).toEqual([]);
  });
});

// ---------- a saved 0.2.0 value is explicit: warn, never clear ----------

describe("the retired default host", () => {
  it("is recognised by host, case-insensitively, and nothing else is", () => {
    expect(isRetiredDefaultHost(RETIRED_URL)).toBe(true);
    expect(isRetiredDefaultHost(`${RETIRED_URL.toUpperCase()}/`)).toBe(true);
    expect(isRetiredDefaultHost("https://node.test")).toBe(false);
    expect(isRetiredDefaultHost("")).toBe(false);
    expect(isRetiredDefaultHost("not a url")).toBe(false);
  });

  const saved = { ...defaultSettings(), rpc: { url: RETIRED_URL }, gateway: { url: RETIRED_URL } };

  it("keeps a saved 0.2.0 value on load and does not clear it", () => {
    const result = loadSettings(JSON.parse(JSON.stringify(saved)));
    expect(result.settings.rpc.url).toBe(RETIRED_URL);
    expect(result.settings.gateway.url).toBe(RETIRED_URL);
  });

  it("warns once at load and records that it did", async () => {
    Notice.reset();
    resetRequestUrl();
    const plugin = new IpfsSyncPlugin(new StubApp(fixtureVault()) as unknown as App, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    stub.data = JSON.parse(JSON.stringify(saved));
    await plugin.onload();
    const warnings = Notice.shown.filter((n) => n.message.includes("open to anyone"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("project maintainer's own node");
    const stored = stub.data as { rpc: { url: string }; retiredDefaultNoticeShown?: boolean };
    expect(stored.rpc.url).toBe(RETIRED_URL);
    expect(stored.retiredDefaultNoticeShown).toBe(true);

    Notice.reset();
    const again = new IpfsSyncPlugin(new StubApp(fixtureVault()) as unknown as App, MANIFEST);
    (again as unknown as StubPlugin).data = stub.data;
    await again.onload();
    expect(Notice.shown.filter((n) => n.message.includes("open to anyone"))).toHaveLength(0);
  });

  it("shows Not configured in the settings tab for an empty URL, and the warning for the retired host", async () => {
    const unset = await open();
    expect(unset.root.textContent()).toContain("Node: Not configured");
    expect(unset.root.textContent()).toContain("no default IPFS node");
    expect(unset.root.textContent()).not.toContain("open to anyone");
    const retired = await open({ rpc: { url: RETIRED_URL }, gateway: { url: RETIRED_URL } });
    expect(retired.root.textContent()).toContain("Node: Configured");
    expect(retired.root.textContent()).toContain("Warning: This URL is the project maintainer's own node and is open to anyone");
    const own = await open({ rpc: { url: "https://node.test" }, gateway: { url: "https://gw.test" } });
    expect(own.root.textContent()).not.toContain("open to anyone");
  });

  it("shows a warning in the node description for as long as the URL is the retired host", () => {
    expect(describeNode(saved).retiredWarning).toContain("open to anyone");
    expect(describeNode(testNodeSettings()).retiredWarning).toBeUndefined();
    expect(retiredDefaultNotice(saved)).toContain("open to anyone");
    expect(retiredDefaultNotice({ ...saved, retiredDefaultNoticeShown: true })).toBeUndefined();
    expect(retiredDefaultNotice(testNodeSettings())).toBeUndefined();
  });
});
