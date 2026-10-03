import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeHostBridge } from "../../cli/node-host-bridge";
import { createSyncEventBus } from "../../src/core/events";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { createPublishRunner, type PublishOutcome, type PublishRunner } from "../../src/plugin/publish-runner";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { publishVault } from "../../src/sync/publish";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";
import { createNodeFsAdapter } from "../support/node-fs-adapter";
import { sessionRig } from "../helpers/plugin-session";
import { referencePassphrase } from "../vectors/slot-helpers";

const MFS_ROOT = "/obsidian-vault-sync/mvp04-test";
const KEY = "obsidian-vault-sync";
const SECRET = "tok-must-not-appear-Qw81";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

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

type Adapter = MemoryAdapter | ReturnType<typeof createNodeFsAdapter>;

/** The node client with every request held until `gate` settles: a run that has taken the sync lock stays inside it. */
function gatedClient(client: FakeNode["client"], gate: Promise<void>): FakeNode["client"] {
  const held = Object.entries(client).map(([name, member]) => [name, typeof member === "function" ? async (...args: unknown[]) => (await gate, (member as (...a: unknown[]) => unknown)(...args)) : member]);
  return Object.fromEntries(held) as FakeNode["client"];
}

/** The runner over a vault whose encrypted vault already exists (the setup dialog or `init` creates it before any publish). */
async function rig(adapter: Adapter, store: SettingsStore, node = createFakeNode(), options: { readonly cancelUnlock?: boolean; readonly init?: boolean; readonly gate?: Promise<void> } = {}): Promise<Rig> {
  const progress: number[] = [];
  if (options.init !== false) await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
  const runner = createPublishRunner({
    store,
    adapter,
    bus: createSyncEventBus(),
    createClient: () => (options.gate === undefined ? node.client : gatedClient(node.client, options.gate)),
    session: sessionRig({ store, adapter, createClient: () => node.client, typed: options.cancelUnlock === true ? [undefined] : undefined }).session,
    now: () => new Date(1_800_000_000_000),
  });
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

const blobCount = (node: FakeNode): number => [...node.files.keys()].filter((path) => /\/current\/[a-z2-7]{2}\/[a-z2-7]{52}$/.test(path)).length;

describe("plugin publish runner", () => {
  it("sends no request at all when the vault has no fixture marker, and says why", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/real.md", "private");
    const r = await rig(adapter, storeWith());
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(outcome.notice).toContain("not yet independently reviewed or verified in Obsidian");
    expect(outcome.notice).toContain(".ipfs-sync-fixture");
    expect(r.node.calls).toEqual([]);
  });

  it("refuses invalid settings before any request", async () => {
    const r = await rig(fixtureVault(), storeWith({ mfsRoot: "/obsidian-vault-staging" }));
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "invalid-settings" });
    expect(outcome.notice).toContain("/obsidian-vault-sync");
    expect(r.node.calls).toEqual([]);
  });

  it("refuses a foreign key: no name/publish, no write, and the notice points to the settings", async () => {
    const r = await rig(fixtureVault(), storeWith(), createFakeNode([{ name: KEY, id: "k51foreign" }]));
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "foreign-key" });
    expect(outcome.notice).toContain("settings");
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(r.store.get().ownedKeys).toEqual([]);
  });

  it("creates the key once on the first publish and records its ID in the plugin data", async () => {
    const r = await rig(fixtureVault(), storeWith());
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
    // 1.2: the device id is saved to the same plugin data before the key is created, so it is stored already; only the key ID cannot be saved.
    const r = await rig(fixtureVault(), storeWith({ deviceStore: { "device-id": btoa(`${"ab".repeat(16)}\n`) } }, true));
    const outcome = await publish(r);
    const keyId = r.node.keys[0]?.id ?? "";
    expect(outcome).toMatchObject({ kind: "refused", reason: "key-not-recorded" });
    expect(outcome.notice).toContain(keyId);
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([`keyGen ${KEY}`]);
  });

  it("1.2: when the plugin data cannot be saved, the device id fails the publish before the key is created or anything is written", async () => {
    const r = await rig(fixtureVault(), storeWith({}, true));
    const outcome = await publish(r);
    expect(outcome.kind).toBe("failed");
    expect(r.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses when the unlock dialog is cancelled, saying so and sending nothing", async () => {
    const r = await rig(fixtureVault(), storeWith(), createFakeNode(), { cancelUnlock: true });
    const outcome = await publish(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(outcome.notice).toContain("not unlocked");
    expect(r.node.calls).toEqual([]);
  });

  it("ignores a second publish while one is running, then allows the next", async () => {
    // The marker guard, settings and session steps run before the lock is taken, so the first run is held inside the
    // engine (its node requests wait on the gate) and the second starts only once the first demonstrably holds the lock.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const r = await rig(fixtureVault(), storeWith(), createFakeNode(), { gate });
    const first = publish(r);
    await vi.waitFor(() => expect(r.runner.isRunning()).toBe(true));
    const second = await publish(r);
    expect(second).toMatchObject({ kind: "refused", reason: "busy" });
    expect(r.runner.isRunning()).toBe(true);
    open();
    expect((await first).kind).toBe("published");
    expect(r.runner.isRunning()).toBe(false);
    expect((await publish(r)).kind).toBe("unchanged");
  });

  it("releases the lock and names the failure when the node rejects a write, without partial-success wording", async () => {
    const node = createFakeNode();
    node.failWriteFor = /\/current\//;
    const r = await rig(fixtureVault(), storeWith(), node);
    const outcome = await publish(r);
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("publish failed");
    expect(outcome.notice).not.toContain("hello.md");
    expect(outcome.notice).not.toMatch(/published|partial/i);
    expect(node.calls.some((c) => c.startsWith("publish "))).toBe(false);
    expect(r.runner.isRunning()).toBe(false);
  });

  it("never publishes the plugin data file or sends the token to the node", async () => {
    const r = await rig(fixtureVault(), storeWith());
    await publish(r);
    expect([...r.node.files.keys()].some((path) => path.includes("data.json"))).toBe(false);
    for (const bytes of r.node.files.values()) expect(new TextDecoder().decode(bytes)).not.toContain(SECRET);
    for (const request of r.node.requests) expect(`${request.line}${new TextDecoder().decode(request.body ?? new Uint8Array())}`).not.toContain(SECRET);
  });

  it("honours the user's extra exclusions", async () => {
    const adapter = fixtureVault();
    adapter.put("private/secret.md", "nope", 1000);
    const r = await rig(adapter, storeWith({ userExclusions: ["private/"] }));
    const outcome = await publish(r);
    expect(outcome.notice).toContain("2 written"); // hello and world; private/secret.md is excluded
  });

  it("reports the running change count through the event bus, ending with done", async () => {
    const r = await rig(fixtureVault(), storeWith());
    await publish(r);
    expect(r.progress).toEqual([1, 2, 2]);
  });
});

describe("plugin publish runner: shared lock and read cap", () => {
  const MB = 1024 * 1024;

  it("refuses a publish while a pull holds the shared lock and sends nothing", async () => {
    const lock = createSyncLock();
    const node = createFakeNode();
    const adapter = fixtureVault();
    await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
    const store = storeWith();
    const runner = createPublishRunner({ store, adapter, bus: createSyncEventBus(), lock, createClient: () => node.client, session: sessionRig({ store, adapter, createClient: () => node.client }).session });
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
    const r = await rig(adapter, storeWith({ maxReadMb: 8 }));
    const outcome = await publish(r);
    expect(outcome.kind).toBe("published");
    expect(outcome.notice).toContain("2 written");
    expect(outcome.notice).toContain("1 skipped");
    expect(outcome.notice).toContain("big.bin");
    expect(blobCount(r.node)).toBe(2); // the big file was not uploaded
    expect(r.store.get().lastPublish).toMatchObject({ written: 2, removed: 0, skipped: 1 });
  });

  it("keeps an already published file on the node when it becomes too large to read, and never removes it", async () => {
    const adapter = fixtureVault();
    adapter.put("big.bin", new Uint8Array(9 * MB), 1000);
    const r = await rig(adapter, storeWith({ maxReadMb: 16 }));
    expect((await publish(r)).notice).toContain("3 written");
    expect(blobCount(r.node)).toBe(3);

    adapter.put("big.bin", new Uint8Array(10 * MB), 2000);
    await r.store.update((settings) => ({ ...settings, maxReadMb: 8 }));
    r.node.calls.length = 0;
    const outcome = await publish(r);
    expect(outcome.kind).toBe("unchanged");
    expect(outcome.notice).toContain("1 skipped");
    expect(r.node.calls.some((call) => call.startsWith("rm "))).toBe(false);
    expect(blobCount(r.node)).toBe(3); // the published big file stays on the node
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
    await initVault(cliHost.fs, node, MFS_ROOT);
    const baseline = await publishVault(
      { client: node.client, host: cliHost, bus: createSyncEventBus() },
      { mfsRoot: MFS_ROOT, keyName: KEY, ownedKeys: [], recordOwnedKey: async () => undefined, concurrency: 1, passphrase: referencePassphrase() },
    );
    expect(baseline).toMatchObject({ published: true, written: 2, keyCreated: true });

    await writeFile(join(dir, "b.md"), "beta edited");
    node.calls.length = 0;

    const r = await rig(createNodeFsAdapter(dir), storeWith({ ownedKeys: [baseline.keyId] }), node, { init: false });
    const outcome = await publish(r);
    expect(outcome.kind).toBe("published");
    expect(outcome.notice).toContain("1 written, 0 removed");
    expect(node.calls.filter((c) => c.startsWith("write ") && /\/current\/[a-z2-7]{2}\//.test(c))).toHaveLength(1);
    expect(node.calls.some((c) => c.startsWith("keyGen"))).toBe(false);
  });
});
