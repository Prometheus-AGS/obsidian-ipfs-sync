import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { createAdapterLockFile, createPluginLockContext } from "../../src/plugin/adapter-lock-file";
import { base64ToBytes } from "../../src/plugin/base64";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createPublishRunner } from "../../src/plugin/publish-runner";
import { loadSettings } from "../../src/plugin/settings-migration";
import { testNodeSettings } from "../helpers/test-node-settings";
import { createSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { encodeLock } from "../../src/sync/publish-lock";
import type { PublishClient } from "../../src/sync/publish";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, decodeFloor } from "../../src/sync/sequence-floor";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { sessionRig } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";

/** Task 2.3 (runner side: the token hook) and task 2.1 (the plugin raises the sequence floor), at the real engine and a fake node. */

const MFS_ROOT = "/obsidian-vault-sync/mvp07-hook";
const NOW = 1_800_000_000_000;
const LOCK_PATH = ".ipfs-sync/publish.lock";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const STATE_NAME = rootFileNames(MFS_ROOT).state;

interface Rig {
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly store: SettingsStore;
  readonly run: (wrap?: (client: PublishClient) => PublishClient) => ReturnType<ReturnType<typeof createPublishRunner>["run"]>;
}

async function rig(makeAdapter: (store: () => SettingsStore) => MemoryAdapter = () => new MemoryAdapter()): Promise<Rig> {
  let store: SettingsStore | undefined;
  const adapter = makeAdapter(() => {
    if (store === undefined) throw new Error("store not built yet");
    return store;
  });
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  const node = createFakeNode();
  store = createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { ...loadSettings(null), settings: { ...testNodeSettings(), mfsRoot: MFS_ROOT } });
  await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
  node.calls.length = 0;
  const keys = sessionRig({ store, adapter, createClient: () => node.client });
  await keys.session.refresh();
  await keys.session.unlock();
  const run: Rig["run"] = (wrap = (client) => client) =>
    createPublishRunner({
      store: store as SettingsStore,
      adapter,
      bus: createSyncEventBus(),
      session: keys.session,
      createClient: () => wrap(node.client),
      lockContext: { ...createPluginLockContext(() => NOW), every: () => () => undefined },
      now: () => new Date(NOW),
    }).run();
  return { adapter, node, store, run };
}

/** The node client, with a side effect on its first request of any kind. */
function onFirstRequest(effect: () => void): (client: PublishClient) => PublishClient {
  return (client) => {
    let fired = false;
    const wrapped: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(client)) {
      wrapped[name] =
        typeof member === "function"
          ? (...args: unknown[]): unknown => {
              if (!fired) {
                fired = true;
                effect();
              }
              return (member as (...inner: unknown[]) => unknown)(...args);
            }
          : member;
    }
    return wrapped as unknown as PublishClient;
  };
}

describe("plugin runner: the token is re-read from the lock file right before the engine's first write", () => {
  it("a lock file replaced after the lock was taken and checked, before the first request, is a lock-held refusal with no write and the rival's file kept", async () => {
    const r = await rig();
    const rival = encodeLock({ token: "rival", pid: 7, host: "cli-host", time: NOW });
    const outcome = await r.run(onFirstRequest(() => r.adapter.put(LOCK_PATH, rival)));
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(new TextDecoder().decode(new Uint8Array(r.adapter.files.get(LOCK_PATH)!.data))).toContain('"token":"rival"');
  }, 30_000);

  it("an untouched lock file publishes, and the lock file is gone afterwards", async () => {
    const r = await rig();
    expect(await r.run()).toMatchObject({ kind: "published" });
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
  }, 30_000);
});

describe("plugin runner: a publish raises the sequence floor, before it writes the state", () => {
  it("the floor in the plugin data holds the published sequence and identity, and was there when the state was written", async () => {
    let floorAtStateWrite: string | undefined;
    const r = await rig((getStore) => {
      class Spy extends MemoryAdapter {
        override async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
          if (path.includes(STATE_NAME) && floorAtStateWrite === undefined) floorAtStateWrite = getStore().get().deviceStore[SEQUENCE_FLOOR_FILE] ?? "absent";
          return super.writeBinary(path, data);
        }
      }
      return new Spy();
    });
    expect(r.store.get().deviceStore[SEQUENCE_FLOOR_FILE]).toBeUndefined();
    expect(await r.run()).toMatchObject({ kind: "published" });

    expect(floorAtStateWrite).toBeDefined();
    expect(floorAtStateWrite).not.toBe("absent"); // floor first, then state
    const stored = r.store.get().deviceStore[SEQUENCE_FLOOR_FILE];
    if (stored === undefined) throw new Error("the floor was not stored");
    const state = await readRootState(createObsidianHostBridge({ adapter: r.adapter }).kv, MFS_ROOT);
    if (state === undefined) throw new Error("state expected");
    const entry = decodeFloor(base64ToBytes(stored)).floors[state.vaultId];
    expect(entry).toMatchObject({ sequence: 1, identity: state.manifestIdentity });
  }, 30_000);
});
