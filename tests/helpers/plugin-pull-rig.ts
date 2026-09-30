import { createSyncEventBus, type SyncEventBus } from "../../src/core/events";
import { createPullRunner, type PullOutcome, type PullRunner } from "../../src/plugin/pull-runner";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSyncLock, type SyncLock } from "../../src/plugin/sync-lock";
import type { FakeGateway } from "./fake-gateway";
import { createFakeGateway, type FakeGatewayOptions } from "./fake-gateway";
import { IPNS_NAME, seedRemote } from "./pull-fixtures";
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
    ...defaultSettings(),
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

export const FILES_V1 = { "notes/a.md": "alpha", "notes/b.md": "bravo", "c.md": "charlie" };

/** Publish state as the node would hold it after `files` were published. */
export async function seed(rig: PullRig, files: Readonly<Record<string, string>>, generation: 1 | 2 = 1): Promise<void> {
  await seedRemote(rig.gateway, files, generation === 1 ? { tree: TREE1, root: ROOT1 } : { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
}

/** A vault as Obsidian creates one: only `.obsidian/` and the plugin's own folder. */
export function freshVault(): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(".obsidian/app.json", "{}", 1000);
  adapter.put(".obsidian/plugins/ipfs-sync/data.json", "{}", 1000);
  return adapter;
}
