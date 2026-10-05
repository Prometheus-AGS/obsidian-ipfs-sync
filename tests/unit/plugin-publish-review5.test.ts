import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { createAdapterLockFile, createPluginLockContext } from "../../src/plugin/adapter-lock-file";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createPublishRunner, type PublishOutcome } from "../../src/plugin/publish-runner";
import type { SessionKeys, UnlockOutcome } from "../../src/plugin/session-keys";
import { loadSettings } from "../../src/plugin/settings-migration";
import { testNodeSettings } from "../helpers/test-node-settings";
import { createSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { encodeLock } from "../../src/sync/publish-lock";
import type { PublishClient } from "../../src/sync/publish";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { sessionRig, type SessionRig } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";

/** review-5 R5-01 (runner side), R5-04 and R5-05, at the real engine and a fake node. */

const MFS_ROOT = "/obsidian-vault-sync/mvp06-review5";
const NOW = 1_800_000_000_000;
const LOCK_PATH = ".ipfs-sync/publish.lock";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

interface Rig {
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly store: SettingsStore;
  readonly keys: SessionRig;
  readonly build: (options?: { readonly session?: SessionKeys; readonly adapter?: MemoryAdapter; readonly lock?: ReturnType<typeof createSyncLock> }) => ReturnType<typeof createPublishRunner>;
}

async function rig(): Promise<Rig> {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  const node = createFakeNode();
  const store = createSettingsStore({ loadData: async () => null, saveData: async () => undefined }, { ...loadSettings(null), settings: { ...testNodeSettings(), mfsRoot: MFS_ROOT } });
  await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
  const createClient = (): PublishClient => node.client;
  const keys = sessionRig({ store, adapter, createClient });
  await keys.session.refresh();
  const build: Rig["build"] = (options = {}) =>
    createPublishRunner({
      store,
      adapter: options.adapter ?? adapter,
      bus: createSyncEventBus(),
      session: options.session ?? keys.session,
      lock: options.lock,
      createClient,
      lockContext: { ...createPluginLockContext(() => NOW), every: () => () => undefined },
      now: () => new Date(NOW),
    });
  return { adapter, node, store, keys, build };
}

const mutating = (node: FakeNode): string[] => node.calls.filter((call) => MUTATING.test(call));

describe("R5-01: the token is checked again right before the publish reaches the node", () => {
  it("a lock file replaced by a rename that overwrote it is a lock-held refusal, with no write to the node and the rival's file kept", async () => {
    const r = await rig();
    const rival = encodeLock({ token: "rival", pid: 7, host: "cli-host", time: NOW });
    // The adapter renames over an existing target. The file is read once for the read-back right after creation; the
    // rival's rename lands after that read, before the runner looks again.
    class Racing extends MemoryAdapter {
      private lockReads = 0;
      override async rename(path: string, newPath: string): Promise<void> {
        const file = this.files.get(path);
        if (file === undefined) throw new Error(`ENOENT ${path}`);
        this.files.delete(path);
        this.files.set(newPath, file);
      }
      override async readBinary(path: string): Promise<ArrayBuffer> {
        const data = await super.readBinary(path);
        if (path === LOCK_PATH && (this.lockReads += 1) === 1) this.put(LOCK_PATH, rival);
        return data;
      }
    }
    const racing = new Racing();
    for (const [path, file] of r.adapter.files) racing.files.set(path, file);
    for (const folder of r.adapter.folders) racing.folders.add(folder);
    const runner = r.build({ adapter: racing });
    await r.keys.session.unlock();
    r.node.calls.length = 0;
    const outcome = await runner.run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(mutating(r.node)).toEqual([]);
    expect(new TextDecoder().decode(new Uint8Array(racing.files.get(LOCK_PATH)!.data))).toContain('"token":"rival"');
  }, 30_000);
});

describe("R5-04: the sync lock is not held while a dialog is open", () => {
  it("an unlock dialog left open holds no sync lock; pull can take it, and the run ends when the dialog is cancelled", async () => {
    const r = await rig();
    let answer: ((outcome: UnlockOutcome) => void) | undefined;
    let asked = 0;
    const session: SessionKeys = {
      ...r.keys.session,
      unlock: () => {
        asked += 1;
        return new Promise<UnlockOutcome>((resolve) => (answer = resolve));
      },
    };
    const lock = createSyncLock();
    const runner = r.build({ session, lock });
    const running = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toBe(1);
    expect(lock.holder()).toBeUndefined();
    expect(runner.isRunning()).toBe(false);
    const pull = lock.tryAcquire("pull");
    expect(pull).toBeDefined(); // a pull, an abandon or the timer is not made to answer "busy" by an open dialog
    pull?.();
    answer?.({ kind: "cancelled" });
    const outcome: PublishOutcome = await running;
    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(lock.holder()).toBeUndefined();
  });

  it("a busy lock is answered before any dialog opens", async () => {
    const r = await rig();
    const lock = createSyncLock();
    const held = lock.tryAcquire("pull");
    const outcome = await r.build({ lock }).run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(r.keys.unlockRequests).toHaveLength(0);
    held?.();
  });

  it("the sync lock is held while the engine runs and released afterwards", async () => {
    const r = await rig();
    const lock = createSyncLock();
    const seen: (string | undefined)[] = [];
    const original = r.node.client;
    const runner = createPublishRunner({
      store: r.store,
      adapter: r.adapter,
      bus: createSyncEventBus(),
      session: r.keys.session,
      lock,
      createClient: () => ({ ...original, filesWrite: async (...args: Parameters<typeof original.filesWrite>) => (seen.push(lock.holder()), original.filesWrite(...args)) }),
      lockContext: { ...createPluginLockContext(() => NOW), every: () => () => undefined },
      now: () => new Date(NOW),
    });
    expect(await runner.run()).toMatchObject({ kind: "published" });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["publish"]));
    expect(lock.holder()).toBeUndefined();
  }, 30_000);
});

describe("R5-05: a held vault that no longer opens the slots on disk is dropped and asked for once more", () => {
  function staleView(r: Rig): { readonly session: SessionKeys; readonly locks: () => number } {
    let stale = true;
    let locks = 0;
    const real = r.keys.session;
    const session: SessionKeys = {
      ...real,
      // The vault the session holds was unlocked from other key-slot bytes than the copy on disk now.
      provider: () => {
        const held = real.provider();
        if (held === undefined || !stale) return held;
        const other = new Uint8Array(held.keySlots);
        other[0] = (other[0] ?? 0) ^ 0xff;
        return { ...held, keySlots: other };
      },
      lock: () => {
        locks += 1;
        stale = false;
        real.lock();
      },
    };
    return { session, locks: () => locks };
  }

  it("a manual run locks the session and prompts again once, then publishes", async () => {
    const r = await rig();
    const { session, locks } = staleView(r);
    const outcome = await r.build({ session }).run();
    expect(outcome).toMatchObject({ kind: "published" });
    expect(locks()).toBe(1);
    expect(r.keys.unlockRequests).toHaveLength(2);
  }, 60_000);

  it("the timer never prompts: it reports locked and leaves the session alone", async () => {
    const r = await rig();
    await r.keys.session.unlock();
    const { session, locks } = staleView(r);
    const requests = r.keys.unlockRequests.length;
    const outcome = await r.build({ session }).run({ unattended: true });
    expect(outcome).toMatchObject({ kind: "refused", reason: "locked" });
    expect(locks()).toBe(0);
    expect(r.keys.unlockRequests).toHaveLength(requests);
  }, 60_000);

  it("a second failure ends the run: no loop", async () => {
    const r = await rig();
    const real = r.keys.session;
    let locks = 0;
    const session: SessionKeys = {
      ...real,
      provider: () => {
        const held = real.provider();
        if (held === undefined) return held;
        const other = new Uint8Array(held.keySlots);
        other[0] = (other[0] ?? 0) ^ 0xff;
        return { ...held, keySlots: other };
      },
      lock: () => {
        locks += 1;
        real.lock();
      },
    };
    const outcome = await r.build({ session }).run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "locked" });
    expect(locks).toBe(1);
    expect(r.keys.unlockRequests).toHaveLength(2);
  }, 60_000);
});
