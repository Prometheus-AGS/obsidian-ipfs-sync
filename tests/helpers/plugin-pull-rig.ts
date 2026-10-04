import { createSyncEventBus, type SyncEventBus } from "../../src/core/events";
import { createPullRunner, type PullOutcome, type PullRunner } from "../../src/plugin/pull-runner";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import type { PluginSettings } from "../../src/plugin/settings-model";
import { testNodeSettings } from "./test-node-settings";
import { createSyncLock, type SyncLock } from "../../src/plugin/sync-lock";
import type { FakeGateway } from "./fake-gateway";
import { createFakeGateway, type FakeGatewayOptions } from "./fake-gateway";
import { IPNS_NAME } from "./pull-fixtures";
import { MemoryAdapter } from "../support/memory-adapter";

export const MFS = "/obsidian-vault-sync/mvp05-test";
export const KEY = "obsidian-vault-sync";
export const SECRET = "tok-must-not-appear-Qw81";
export const TREE1 = "bafytreeone000000000000";
export const ROOT1 = "bafyrootone000000000000";
export const TREE2 = "bafytreetwo000000000000";
export const ROOT2 = "bafyroottwo000000000000";
export const TODAY = "2026-09-30";
/** Local noon on the day the conflict copies are dated. */
export const NOW = new Date(2026, 8, 30, 12, 0, 0);

export function memoryPort(): PluginDataPort & { data: unknown } {
  const self: PluginDataPort & { data: unknown } = {
    data: null,
    loadData: async () => self.data,
    saveData: async (next) => {
      self.data = structuredClone(next);
    },
  };
  return self;
}

export function storeWith(patch: Partial<PluginSettings> = {}): SettingsStore & { readonly port: ReturnType<typeof memoryPort> } {
  const port = memoryPort();
  const settings: PluginSettings = {
    ...testNodeSettings(),
    mfsRoot: MFS,
    auth: { scheme: "bearer", token: SECRET },
    ownedKeys: [IPNS_NAME],
    ...patch,
  };
  const store = createSettingsStore(port, { settings, outcome: "fresh", notices: [], persist: false });
  return Object.assign(store, { port });
}

export interface PullRig {
  readonly adapter: MemoryAdapter;
  readonly gateway: FakeGateway;
  readonly store: ReturnType<typeof storeWith>;
  readonly runner: PullRunner;
  readonly bus: SyncEventBus;
  readonly lock: SyncLock;
  readonly events: string[];
  pull(): Promise<PullOutcome>;
}

export interface RigOptions {
  readonly adapter?: MemoryAdapter;
  readonly settings?: Partial<PluginSettings>;
  readonly gateway?: FakeGatewayOptions;
  readonly flushEditors?: () => Promise<void>;
  readonly lock?: SyncLock;
}

/** A pull runner over a memory vault and a recording fake gateway that also answers `key/list`. */
export function pullRig(options: RigOptions = {}): PullRig {
  const adapter = options.adapter ?? new MemoryAdapter();
  const gateway = createFakeGateway({ keys: [{ name: KEY, id: IPNS_NAME }], ...options.gateway });
  const store = storeWith(options.settings);
  const bus = createSyncEventBus();
  const lock = options.lock ?? createSyncLock();
  const events: string[] = [];
  bus.on("conflict", (event) => void events.push(`conflict ${event.path}`));
  let counter = 0;
  const runner = createPullRunner({
    store,
    adapter,
    bus,
    lock,
    flushEditors: options.flushEditors,
    createClient: () => gateway.client,
    now: () => NOW,
    newId: () => `id${(counter += 1)}`,
  });
  return { adapter, gateway, store, runner, bus, lock, events, pull: () => runner.run() };
}

/**
 * What an old plaintext publication left on the node: a `manifest.json` and a `current/` tree, no key slots and no
 * `manifest.enc`. The manifest bytes are never parsed by anything (no plaintext reader exists), so they are a stub.
 */
export function plantPlaintextRoot(gateway: Pick<FakeGateway, "objects" | "names">, files: Readonly<Record<string, string>> = { "notes/a.md": "alpha" }): void {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  for (const [path, text] of Object.entries(files)) gateway.objects.set(`${TREE1}/${path}`, encode(text));
  gateway.objects.set(`${ROOT1}/manifest.json`, encode(JSON.stringify({ version: 1, rootCID: TREE1 })));
  gateway.names.set(IPNS_NAME, `/ipfs/${ROOT1}`);
}

/** A vault as Obsidian creates one: only `.obsidian/` and the plugin's own folder. */
export function freshVault(): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(".obsidian/app.json", "{}", 1000);
  adapter.put(".obsidian/plugins/ipfs-sync/data.json", "{}", 1000);
  return adapter;
}
