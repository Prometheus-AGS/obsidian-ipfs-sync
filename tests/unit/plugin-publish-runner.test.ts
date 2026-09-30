import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeHostBridge } from "../../cli/node-host-bridge";
import { createSyncEventBus } from "../../src/core/events";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { createPublishRunner, type PublishOutcome, type PublishRunner } from "../../src/plugin/publish-runner";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { publishVault } from "../../src/sync/publish";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { MemoryAdapter } from "../support/memory-adapter";
import { createNodeFsAdapter } from "../support/node-fs-adapter";

const MFS_ROOT = "/obsidian-vault-sync/mvp04-test";
const KEY = "obsidian-vault-sync";
const SECRET = "tok-must-not-appear-Qw81";

function port(failSave = false): PluginDataPort & { data: unknown } {
  const self: PluginDataPort & { data: unknown } = {
    data: null,
    loadData: async () => self.data,
    saveData: async (next) => {
      if (failSave) throw new Error("disk full");
      self.data = structuredClone(next);
    },
  };
  return self;
}

function storeWith(patch: Partial<PluginSettings> = {}, failSave = false): SettingsStore {
  const initial = loadSettings(null);
  return createSettingsStore(port(failSave), {
    ...initial,
    settings: { ...defaultSettings(), mfsRoot: MFS_ROOT, auth: { scheme: "bearer", token: SECRET }, ...patch },
  });
}

interface Rig {
  readonly node: FakeNode;
  readonly runner: PublishRunner;
  readonly store: SettingsStore;
  readonly progress: number[];
}

function rig(adapter: MemoryAdapter | ReturnType<typeof createNodeFsAdapter>, store: SettingsStore, node = createFakeNode()): Rig {
  const progress: number[] = [];
  const runner = createPublishRunner({ store, adapter, bus: createSyncEventBus(), createClient: () => node.client, now: () => new Date(1_800_000_000_000) });
  return { node, runner, store, progress };
}

const publish = (r: Rig): Promise<PublishOutcome> => r.runner.run({ onProgress: (p) => void r.progress.push(p.changed) });

function fixtureVault(): MemoryAdapter {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  adapter.put("notes/world.md", "world", 1000);
  adapter.put(".obsidian/plugins/ipfs-sync/data.json", JSON.stringify({ token: SECRET }), 1000);
  return adapter;
}

describe("plugin publish runner", () => {
  it("sends no request at all when the vault has no fixture marker, and says why", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private");
    const r = rig(adapter, storeWith());
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(outcome.notice).toContain("Encryption is not available yet");
    expect(outcome.notice).toContain(".ipfs-sync-fixture");
    expect(r.node.calls).toEqual([]);
  });

  it("refuses invalid settings before any request", async () => {
    const r = rig(fixtureVault(), storeWith({ mfsRoot: "/obsidian-vault-staging" }));
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "invalid-settings" });
    expect(outcome.notice).toContain("/obsidian-vault-sync");
    expect(r.node.calls).toEqual([]);
  });

  it("refuses a foreign key: no name/publish, no write, and the notice points to the settings", async () => {
    const r = rig(fixtureVault(), storeWith(), createFakeNode([{ name: KEY, id: "k51foreign" }]));
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "foreign-key" });
    expect(outcome.notice).toContain("settings");
    expect(r.node.calls).toEqual(["keyList"]);
    expect(r.store.get().ownedKeys).toEqual([]);
  });

  it("creates the key once on the first publish and records its ID in the plugin data", async () => {
    const r = rig(fixtureVault(), storeWith());
    const first = await publish(r);
    expect(first).toMatchObject({ kind: "published" });
    const keyId = r.node.keys[0]?.id ?? "";
    expect(r.node.calls.filter((c) => c.startsWith("keyGen"))).toEqual([`keyGen ${KEY}`]);
    expect(r.store.get().ownedKeys).toEqual([keyId]);
    expect(first.notice).toContain("2 written, 0 removed");

    const second = await publish(r);
    expect(second.kind).toBe("unchanged");
    expect(r.node.calls.filter((c) => c.startsWith("keyGen"))).toHaveLength(1);
  });

  it("stops before any write when the new key ID cannot be recorded, and shows the ID", async () => {
    const r = rig(fixtureVault(), storeWith({}, true));
    const outcome = await publish(r);
    const keyId = r.node.keys[0]?.id ?? "";
    expect(outcome).toMatchObject({ kind: "refused", reason: "key-not-recorded" });
    expect(outcome.notice).toContain(keyId);
    expect(r.node.calls).toEqual(["keyList", `keyGen ${KEY}`]);
  });

  it("ignores a second publish while one is running, then allows the next", async () => {
    const r = rig(fixtureVault(), storeWith());
    const first = publish(r);
    const second = await publish(r);
    expect(second).toMatchObject({ kind: "refused", reason: "busy" });
    expect(r.runner.isRunning()).toBe(true);
    expect((await first).kind).toBe("published");
    expect(r.runner.isRunning()).toBe(false);
    expect((await publish(r)).kind).toBe("unchanged");
  });

  it("releases the lock and names the failure when the node rejects a write, without partial-success wording", async () => {
    const node = createFakeNode();
    node.failWriteFor = /hello\.md$/;
    const r = rig(fixtureVault(), storeWith(), node);
    const outcome = await publish(r);
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("publish failed");
    expect(outcome.notice).toContain("hello.md");
    expect(outcome.notice).not.toMatch(/published|partial/i);
    expect(node.calls.some((c) => c.startsWith("publish "))).toBe(false);
    expect(r.runner.isRunning()).toBe(false);
  });

  it("never publishes the plugin data file or sends the token to the node", async () => {
    const r = rig(fixtureVault(), storeWith());
    await publish(r);
    expect([...r.node.files.keys()].some((path) => path.includes("data.json"))).toBe(false);
    for (const bytes of r.node.files.values()) expect(new TextDecoder().decode(bytes)).not.toContain(SECRET);
    expect(r.node.calls.join("\n")).not.toContain(SECRET);
  });

  it("honours the user's extra exclusions", async () => {
    const adapter = fixtureVault();
    adapter.put("private/secret.md", "nope", 1000);
    const r = rig(adapter, storeWith({ userExclusions: ["private/"] }));
    await publish(r);
    expect([...r.node.files.keys()].some((path) => path.includes("private"))).toBe(false);
  });

  it("reports the running change count through the event bus, ending with done", async () => {
    const r = rig(fixtureVault(), storeWith());
    await publish(r);
    expect(r.progress).toEqual([1, 2, 2]);
  });
});

describe("plugin publish runner: shared lock and read cap", () => {
  const MB = 1024 * 1024;

  it("refuses a publish while a pull holds the shared lock and sends nothing", async () => {
    const lock = createSyncLock();
    const node = createFakeNode();
    const runner = createPublishRunner({ store: storeWith(), adapter: fixtureVault(), bus: createSyncEventBus(), lock, createClient: () => node.client });
    const release = lock.tryAcquire("pull");
    const outcome = await runner.run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(outcome.notice).toContain("pull is already in progress");
    expect(node.calls).toEqual([]);
    release?.();
    expect((await runner.run()).kind).toBe("published");
  });

  it("skips a file above the read cap with a count, publishes the rest, and names the file", async () => {
    const adapter = fixtureVault();
    adapter.put("big.bin", new Uint8Array(9 * MB), 1000);
    const r = rig(adapter, storeWith({ maxReadMb: 8 }));
    const outcome = await publish(r);
    expect(outcome.kind).toBe("published");
    expect(outcome.notice).toContain("2 written");
    expect(outcome.notice).toContain("1 skipped");
    expect(outcome.notice).toContain("big.bin");
    expect([...r.node.files.keys()].some((path) => path.endsWith("big.bin"))).toBe(false);
    expect(r.store.get().lastPublish).toMatchObject({ written: 2, removed: 0, skipped: 1 });
  });

  it("keeps an already published file on the node when it becomes too large to read, and never removes it", async () => {
    const adapter = fixtureVault();
    adapter.put("big.bin", new Uint8Array(9 * MB), 1000);
    const r = rig(adapter, storeWith({ maxReadMb: 16 }));
    expect((await publish(r)).notice).toContain("3 written");
    expect([...r.node.files.keys()].some((path) => path.endsWith("big.bin"))).toBe(true);

    adapter.put("big.bin", new Uint8Array(10 * MB), 2000);
    await r.store.update((settings) => ({ ...settings, maxReadMb: 8 }));
    r.node.calls.length = 0;
    const outcome = await publish(r);
    expect(outcome.kind).toBe("unchanged");
    expect(outcome.notice).toContain("1 skipped");
    expect(r.node.calls.some((call) => call.startsWith("rm "))).toBe(false);
    expect([...r.node.files.keys()].some((path) => path.endsWith("big.bin"))).toBe(true);
  });
});

describe("plugin publish runner over the CLI's state file", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("transfers only the edited file after the CLI engine published the same vault", async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-mvp04-"));
    await writeFile(join(dir, ".ipfs-sync-fixture"), "fixture\n");
    await writeFile(join(dir, "a.md"), "alpha");
    await writeFile(join(dir, "b.md"), "beta");

    const node = createFakeNode();
    const cliHost = createNodeHostBridge({ root: dir, env: { IPFS_SYNC_DEVICE: "cli" } });
    const baseline = await publishVault(
      { client: node.client, host: cliHost, bus: createSyncEventBus() },
      { mfsRoot: MFS_ROOT, keyName: KEY, ownedKeys: [], recordOwnedKey: async () => undefined, concurrency: 1 },
    );
    expect(baseline).toMatchObject({ published: true, written: 2, keyCreated: true });

    await writeFile(join(dir, "b.md"), "beta edited");
    node.calls.length = 0;

    const r = rig(createNodeFsAdapter(dir), storeWith({ ownedKeys: [baseline.keyId] }), node);
    const outcome = await publish(r);
    expect(outcome.kind).toBe("published");
    expect(outcome.notice).toContain("1 written, 0 removed");
    expect(node.calls.filter((c) => c.startsWith("write ") && !c.includes("manifest"))).toEqual([`write ${MFS_ROOT}/current/b.md`]);
    expect(node.calls.some((c) => c.startsWith("keyGen"))).toBe(false);
  });
});
