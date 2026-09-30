import { createSyncEventBus, type ConflictEvent, type FileChangedEvent, type PullCompleteEvent } from "../../src/core/events";
import { pullVault, type PullOptions, type PullResult } from "../../src/sync/pull";
import { TEMP_DIR } from "../../src/sync/pull-fetch";
import { createFakeGateway, type FakeGateway } from "./fake-gateway";
import { createMemoryHost, type MemoryHost } from "./memory-host";
import { IPNS_NAME, decode } from "./pull-fixtures";

export const MFS = "/obsidian-vault-sync/pull-test";
export const KEY = "obsidian-vault-sync";
export const TREE1 = "bafytreeone000000000000";
export const ROOT1 = "bafyrootone000000000000";
export const TREE2 = "bafytreetwo000000000000";
export const ROOT2 = "bafyroottwo000000000000";
export const TODAY = "2026-09-29";

export interface Harness {
  readonly host: MemoryHost;
  readonly gateway: FakeGateway;
  readonly changed: FileChangedEvent[];
  readonly conflicts: ConflictEvent[];
  readonly completed: PullCompleteEvent[];
  readonly warnings: string[];
  run(overrides?: Partial<PullOptions>): Promise<PullResult>;
}

export function harness(gatewayOptions: Parameters<typeof createFakeGateway>[0] = {}): Harness {
  const host = createMemoryHost();
  host.clock = new Date(2026, 8, 29, 12, 0, 0).getTime();
  const gateway = createFakeGateway(gatewayOptions);
  const bus = createSyncEventBus();
  const changed: FileChangedEvent[] = [];
  const conflicts: ConflictEvent[] = [];
  const completed: PullCompleteEvent[] = [];
  const warnings: string[] = [];
  bus.on("file.changed", (event) => void changed.push(event));
  bus.on("conflict", (event) => void conflicts.push(event));
  bus.on("pull.complete", (event) => void completed.push(event));
  let counter = 0;
  const base: PullOptions = { mfsRoot: MFS, keyName: KEY, ownedKeys: [], name: IPNS_NAME, selector: { kind: "latest" }, concurrency: 3 };
  return {
    host,
    gateway,
    changed,
    conflicts,
    completed,
    warnings,
    run: (overrides = {}) =>
      pullVault(
        { client: gateway.client, host, bus, warn: (message) => void warnings.push(message), newId: () => `id${(counter += 1)}` },
        { ...base, ...overrides },
      ),
  };
}

export const FILES_V1 = { "notes/a.md": "alpha", "notes/b.md": "bravo", "c.md": "charlie" };
export const text = (h: Harness, path: string): string | undefined => (h.host.files.has(path) ? decode(h.host.files.get(path)?.data) : undefined);
export const leftovers = (h: Harness): string[] => [...h.host.files.keys()].filter((p) => p.startsWith(`${TEMP_DIR}/`));
