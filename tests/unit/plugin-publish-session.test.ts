import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { encryptManifestEnvelope } from "../../src/crypto/manifest-envelope";
import { INCOMPATIBLE_MANIFEST_NOTICE, LOCKED_TIMER_NOTICE, NOT_SET_UP_TIMER_NOTICE } from "../../src/plugin/publish-notices";
import { createPublishRunner, type PublishOutcome, type PublishRunner } from "../../src/plugin/publish-runner";
import { createPluginLockContext } from "../../src/plugin/adapter-lock-file";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type PluginDataPort, type SettingsStore } from "../../src/plugin/settings-store";
import { decodeManifestFile, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { encodeLock } from "../../src/sync/publish-lock";
import type { PublishClient } from "../../src/sync/publish";
import { keySlotsCopyPath } from "../../src/sync/vault-keys";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { REFERENCE_TEXT, sessionRig, type SessionRig } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";

/**
 * mvp-06 task 4.3: the plugin publish runner over the key session, at the real engine, the real `open` port and a
 * fake node. Only the dialogs are scripted. Argon2id calls are counted at the library (`argon2idAsync`) so "no
 * derivation" is observed where it would happen, not inferred from a callback.
 */

const argon2 = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return {
    ...original,
    argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => {
      argon2.calls += 1;
      return original.argon2idAsync(...args);
    },
  };
});

const MFS_ROOT = "/obsidian-vault-sync/mvp06-plugin";
const KEY = "obsidian-vault-sync";
const NOW = 1_800_000_000_000;
const LOCK_PATH = ".ipfs-sync/publish.lock";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

function port(): PluginDataPort & { data: unknown } {
  const self: PluginDataPort & { data: unknown } = {
    data: null,
    loadData: async () => self.data,
    saveData: async (next) => {
      self.data = structuredClone(next);
    },
  };
  return self;
}

interface Rig {
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly store: SettingsStore;
  readonly data: { data: unknown };
  readonly sessionRig: SessionRig;
  readonly runner: PublishRunner;
  readonly heartbeats: (() => void)[];
  /** Tests wrap the client the runner uses through `hooks.client`. */
  readonly hooks: { client: (client: PublishClient) => PublishClient };
}

interface RigOptions {
  readonly marker?: boolean;
  /** Create the vault the way the setup dialog will (local key-slot copy and key slots on the node) before the run. */
  readonly vault?: boolean;
  readonly settings?: Partial<PluginSettings>;
  /** `app.vault.configDir` as the plugin shell passes it. */
  readonly configDir?: string;
  readonly typed?: readonly (string | undefined)[];
  readonly setup?: SessionRigOptionsSetup;
}
type SessionRigOptionsSetup = Parameters<typeof sessionRig>[0]["setup"];

async function rig(options: RigOptions = {}): Promise<Rig> {
  const adapter = new MemoryAdapter();
  if (options.marker !== false) adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  adapter.put("notes/world.md", "world", 1000);
  const node = createFakeNode();
  const data = port();
  const store = createSettingsStore(data, { ...loadSettings(null), settings: { ...defaultSettings(), mfsRoot: MFS_ROOT, ...options.settings } });
  if (options.vault === true) await initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT);
  const hooks = { client: (client: PublishClient): PublishClient => client };
  const heartbeats: (() => void)[] = [];
  const createClient = (): PublishClient => hooks.client(node.client);
  const keys = sessionRig({ store, adapter, createClient, typed: options.typed, setup: options.setup });
  const lockContext = { ...createPluginLockContext(() => NOW), every: (_ms: number, task: () => void) => (heartbeats.push(task), () => undefined) };
  const runner = createPublishRunner({ store, adapter, ...(options.configDir === undefined ? {} : { configDir: options.configDir }), bus: createSyncEventBus(), session: keys.session, createClient, lockContext, now: () => new Date(NOW) });
  await keys.session.refresh();
  argon2.calls = 0; // creating the test vault derived once; count from here
  return { adapter, node, store, data, heartbeats, hooks, sessionRig: keys, runner };
}

const manual = (r: Rig): Promise<PublishOutcome> => r.runner.run();
const timer = (r: Rig): Promise<PublishOutcome> => r.runner.run({ unattended: true });
const mutating = (node: FakeNode): string[] => node.calls.filter((call) => MUTATING.test(call));
async function sequenceOf(r: Rig): Promise<number> {
  const keys = r.sessionRig.session.provider()?.keys;
  if (keys === undefined) throw new Error("expected an unlocked session");
  return (await decodeManifestFile(keys, r.node.files.get(`${MFS_ROOT}/manifest.enc`) ?? new Uint8Array())).sequence;
}
const noDialogs = (r: Rig): void => {
  expect(r.sessionRig.unlockRequests).toHaveLength(0);
  expect(r.sessionRig.setupRequests).toHaveLength(0);
};

beforeEach(() => {
  argon2.calls = 0;
});

describe("4.3 marker guard first", () => {
  it.each([false, true])("sends no request and opens no dialog for a vault without the fixture marker (unattended: %s)", async (unattended) => {
    const r = await rig({ marker: false, vault: true });
    r.node.calls.length = 0;
    const outcome = await r.runner.run({ unattended });
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(outcome.notice).toContain("not yet independently reviewed or verified in Obsidian");
    expect(r.node.calls).toEqual([]);
    expect(r.node.requests).toEqual([]);
    noDialogs(r);
    expect(argon2.calls).toBe(0);
  });
});

describe("4.3 the timer never opens a dialog", () => {
  it("while locked: refuses with the locked notice, sends no request, opens no dialog, derives nothing", async () => {
    const r = await rig({ vault: true });
    expect(r.sessionRig.session.state()).toBe("locked");
    const outcome = await timer(r);
    expect(outcome).toEqual({ kind: "refused", reason: "locked", notice: LOCKED_TIMER_NOTICE });
    expect(r.node.calls).toEqual([]);
    expect(r.node.requests).toEqual([]);
    noDialogs(r);
    expect(argon2.calls).toBe(0);
  });

  it("with no vault on the device: refuses, creates nothing, opens no dialog", async () => {
    const r = await rig();
    const outcome = await timer(r);
    expect(outcome).toEqual({ kind: "refused", reason: "not-set-up", notice: NOT_SET_UP_TIMER_NOTICE });
    expect(r.node.calls).toEqual([]);
    noDialogs(r);
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(false);
  });

  it("a locked run decided from the disk alone: a vault made after load is seen without a request", async () => {
    const r = await rig();
    await initVault(createObsidianHostBridge({ adapter: r.adapter }).fs, r.node, MFS_ROOT);
    expect(await timer(r)).toMatchObject({ kind: "refused", reason: "locked" });
    expect(r.node.calls).toEqual([]);
  });
});

describe("4.3 setup only through the dialog's Create", () => {
  it("Publish with no vault opens the setup dialog, creates the vault, then publishes; no secret is stored anywhere", async () => {
    const r = await rig();
    const outcome = await manual(r);
    expect(r.sessionRig.setupRequests).toHaveLength(1);
    expect(r.sessionRig.unlockRequests).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: "published" });
    expect(outcome.notice).toContain("2 written");
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(true);
    expect(r.node.files.has(`${MFS_ROOT}/keyslots.json`)).toBe(true);
    expect(r.sessionRig.session.state()).toBe("unlocked");

    const shown = r.sessionRig.setupRequests[0]?.passphrase ?? "";
    const symbols = shown.replaceAll("-", "").replaceAll(" ", "");
    expect(symbols).toHaveLength(25);
    const haystacks = [
      JSON.stringify(r.data.data),
      JSON.stringify(r.store.get()),
      outcome.notice,
      ...[...r.adapter.files.values()].map((file) => new TextDecoder().decode(file.data)),
      ...[...r.node.files.values()].map((bytes) => new TextDecoder().decode(bytes)),
      ...r.node.requests.map((request) => `${request.line} ${new TextDecoder().decode(request.body ?? new Uint8Array())}`),
    ];
    for (const text of haystacks) {
      expect(text.toUpperCase()).not.toContain(symbols);
      expect(text.toUpperCase()).not.toContain(shown.toUpperCase());
    }
  }, 30_000);

  it("a cancelled setup dialog creates no vault and sends nothing", async () => {
    const r = await rig({ setup: async () => undefined });
    const outcome = await manual(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(r.node.calls).toEqual([]);
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(false);
    expect(argon2.calls).toBe(0);
  });

  it("refuses to create a vault in a root that already holds one, and writes nothing", async () => {
    const r = await rig();
    await initVault(createObsidianHostBridge({ adapter: new MemoryAdapter() }).fs, r.node, MFS_ROOT); // key slots on the node, no local copy
    const outcome = await manual(r);
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("already holds a vault");
    expect(mutating(r.node)).toEqual([]);
    expect(r.adapter.files.has(await keySlotsCopyPath(MFS_ROOT))).toBe(false);
  }, 30_000);

  it("unlock with a vault present never opens the setup dialog", async () => {
    const r = await rig({ vault: true });
    expect(await manual(r)).toMatchObject({ kind: "published" });
    expect(r.sessionRig.unlockRequests).toHaveLength(1);
    expect(r.sessionRig.setupRequests).toHaveLength(0);
  }, 30_000);

  it("a cancelled unlock dialog sends nothing and derives nothing", async () => {
    const r = await rig({ vault: true, typed: [undefined] });
    expect(await manual(r)).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(r.node.calls).toEqual([]);
    expect(argon2.calls).toBe(0);
  });

  it("a wrong passphrase is asked for again, then the right one publishes", async () => {
    const r = await rig({ vault: true, typed: ["AAAAAAAAAAAAAAAAAAAAAAAJ6", REFERENCE_TEXT] });
    const outcome = await manual(r);
    expect(r.sessionRig.unlockRequests.map((request) => request.failure)).toEqual([undefined, "wrong-passphrase"]);
    expect(outcome.kind).toBe("published");
  }, 30_000);
});

describe("4.3 the session key goes to the engine; timer ticks derive nothing", () => {
  it("after one unlock, a changed-file tick and idle ticks run no Argon2id and no dialog", async () => {
    const r = await rig({ vault: true });
    expect(await manual(r)).toMatchObject({ kind: "published" });
    const afterUnlock = argon2.calls;
    expect(afterUnlock).toBeGreaterThan(0);

    r.adapter.put("notes/edited.md", "edited", 5000);
    const changed = await timer(r);
    expect(changed).toMatchObject({ kind: "published" });
    expect(changed.notice).toContain("1 written");
    for (let index = 0; index < 3; index += 1) expect((await timer(r)).kind).toBe("unchanged");

    expect(argon2.calls).toBe(afterUnlock);
    expect(r.sessionRig.unlockRequests).toHaveLength(1);
    expect(r.sessionRig.derivations()).toBe(1);
  }, 60_000);

  it("after Lock the timer refuses again and sends nothing; a manual run asks again", async () => {
    const r = await rig({ vault: true });
    await manual(r);
    r.sessionRig.session.lock();
    r.node.calls.length = 0;
    expect(await timer(r)).toMatchObject({ kind: "refused", reason: "locked" });
    expect(r.node.calls).toEqual([]);
    expect(await manual(r)).toMatchObject({ kind: "unchanged" });
    expect(r.sessionRig.unlockRequests).toHaveLength(2);
  }, 60_000);
});

describe("4.3 lock file with the in-process lock", () => {
  it("holds the lock file while the engine writes and removes it afterwards", async () => {
    const r = await rig({ vault: true });
    const seen: boolean[] = [];
    r.hooks.client = (client) => ({ ...client, filesWrite: async (...args: Parameters<PublishClient["filesWrite"]>) => (seen.push(r.adapter.files.has(LOCK_PATH)), client.filesWrite(...args)) });
    expect(await manual(r)).toMatchObject({ kind: "published" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
    expect(r.heartbeats).toHaveLength(1);
  }, 30_000);

  it("removes the lock file when the run fails", async () => {
    const r = await rig({ vault: true });
    r.node.failWriteFor = /\/current\//;
    expect((await manual(r)).kind).toBe("failed");
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
    expect(r.runner.isRunning()).toBe(false);
  }, 30_000);

  it("a fresh lock held by another publisher refuses as busy and writes nothing; the timer's copy of it is silent by reason", async () => {
    const r = await rig({ vault: true });
    r.adapter.put(LOCK_PATH, new TextDecoder().decode(encodeLock({ token: "abc", pid: 4242, host: "the-command-line", time: NOW - 1000 })));
    const outcome = await manual(r);
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(outcome.notice).toContain("another publish is running");
    expect(mutating(r.node)).toEqual([]);
    expect(r.adapter.files.has(LOCK_PATH)).toBe(true);
  }, 30_000);

  it("a lock with no heartbeat for 15 minutes is replaced and the publish goes on", async () => {
    const r = await rig({ vault: true });
    r.adapter.put(LOCK_PATH, new TextDecoder().decode(encodeLock({ token: "abc", pid: 4242, host: "the-command-line", time: NOW - 16 * 60_000 })));
    expect(await manual(r)).toMatchObject({ kind: "published" });
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
  }, 30_000);

  it("stops before the next write when the lock file was taken over during the run", async () => {
    const r = await rig({ vault: true });
    let taken = false;
    r.hooks.client = (client) => ({
      ...client,
      filesWrite: async (...args: Parameters<PublishClient["filesWrite"]>) => {
        if (!taken) {
          taken = true;
          r.adapter.put(LOCK_PATH, new TextDecoder().decode(encodeLock({ token: "someone-else", pid: 1, host: "elsewhere", time: NOW })));
          r.heartbeats[0]?.();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return client.filesWrite(...args);
      },
    });
    const outcome = await manual(r);
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("publish lock was taken over");
    expect(r.node.calls.some((call) => call.startsWith("publish "))).toBe(false);
    // The other publisher's lock is not ours to remove.
    expect(r.adapter.files.has(LOCK_PATH)).toBe(true);
  }, 30_000);
});

describe("N3-01: an authentic manifest this build cannot parse", () => {
  it("shows the update message instead of a stack, and leaves the node's manifest alone", async () => {
    const r = await rig({ vault: true });
    await manual(r);
    const keys = r.sessionRig.session.provider()?.keys;
    if (keys === undefined) throw new Error("expected an unlocked session");
    const plain = JSON.parse(new TextDecoder().decode(serializeManifestV2(await decodeManifestFile(keys, r.node.files.get(`${MFS_ROOT}/manifest.enc`) ?? new Uint8Array())))) as Record<string, unknown>;
    const planted = await encryptManifestEnvelope(keys, new TextEncoder().encode(JSON.stringify({ ...plain, zzzFutureField: 1 })));
    r.node.files.set(`${MFS_ROOT}/manifest.enc`, planted);
    r.adapter.put("notes/edited.md", "edited", 5000);
    r.node.calls.length = 0;
    const outcome = await manual(r);
    expect(outcome).toEqual({ kind: "refused", reason: "incompatible-manifest", notice: INCOMPATIBLE_MANIFEST_NOTICE });
    expect(outcome.notice).toContain("written by a newer or incompatible version");
    expect(outcome.notice).toContain("Update the plugin");
    expect(mutating(r.node)).toEqual([]);
    expect(r.node.files.get(`${MFS_ROOT}/manifest.enc`)).toEqual(planted);
  }, 60_000);
});

describe("the runner shows the CLI's journal, drift and read-back behaviour through the shared engine", () => {
  it("read-back: a stray entry after manifest.enc stops before the pin, leaves a journal, and the next run finishes at the next sequence", async () => {
    const r = await rig({ vault: true });
    await manual(r);
    const before = await sequenceOf(r);
    r.adapter.put("notes/new.md", "new", 5000);
    r.node.afterWrite = (path) => {
      if (path.endsWith("/manifest.enc")) r.node.files.set(`${MFS_ROOT}/planted.txt`, new Uint8Array([1]));
    };
    r.node.calls.length = 0;
    const failed = await manual(r);
    expect(failed.kind).toBe("failed");
    expect(failed.notice).toContain("read-back");
    expect(r.node.calls.some((call) => call.startsWith("pin ") || call.startsWith("publish "))).toBe(false);
    const host = createObsidianHostBridge({ adapter: r.adapter });
    expect((await readJournal(host.kv, MFS_ROOT)).kind).toBe("ok");

    r.node.afterWrite = undefined;
    r.node.files.delete(`${MFS_ROOT}/planted.txt`);
    await manual(r);
    expect(await readJournal(host.kv, MFS_ROOT)).toEqual({ kind: "none" });
    expect(await sequenceOf(r)).toBe(before + 1);
    expect(r.node.calls.filter((call) => call.startsWith("publish ")).length).toBe(1);
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
  }, 60_000);

  it("drift: a blob the node lost is uploaded again without any change in the vault", async () => {
    const r = await rig({ vault: true });
    await manual(r);
    const blob = [...r.node.files.keys()].find((path) => /\/current\/[a-z2-7]{2}\/[a-z2-7]{52}$/.test(path));
    expect(blob).toBeDefined();
    r.node.files.delete(blob as string);
    const outcome = await timer(r);
    expect(outcome).toMatchObject({ kind: "published" });
    expect(outcome.notice).toContain("1 written");
    expect(r.node.files.has(blob as string)).toBe(true);
  }, 60_000);

  it("a publish killed mid-way is resumed by the next run", async () => {
    const r = await rig({ vault: true });
    r.node.mutations = 0;
    r.node.killAfterMutation = 4;
    const killed = await manual(r);
    expect(killed.kind).toBe("failed");
    r.node.killAfterMutation = undefined;
    const again = await manual(r);
    expect(["published", "unchanged"]).toContain(again.kind);
    expect(r.adapter.files.has(LOCK_PATH)).toBe(false);
    const idle = await manual(r);
    expect(idle.kind).toBe("unchanged");
  }, 60_000);
});

describe("mvp-07a 1.2: device id and the configuration folder", () => {
  async function manifestOf(r: Rig): Promise<Awaited<ReturnType<typeof decodeManifestFile>>> {
    const keys = r.sessionRig.session.provider()?.keys;
    if (keys === undefined) throw new Error("expected an unlocked session");
    return decodeManifestFile(keys, r.node.files.get(`${MFS_ROOT}/manifest.enc`) ?? new Uint8Array());
  }

  it("publishes the device as obsidian-<12 hex of the stored id>, and the same id again on the next publish", async () => {
    const r = await rig({ vault: true });
    expect((await manual(r)).kind).toBe("published");
    const first = await manifestOf(r);
    const stored = r.store.get().deviceStore["device-id"];
    expect(stored).toBeDefined();
    const id = new TextDecoder().decode(Uint8Array.from(atob(stored ?? ""), (c) => c.charCodeAt(0))).trim();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(first.device).toBe(`obsidian-${id.slice(0, 12)}`);
    r.adapter.put("notes/more.md", "more", 5000);
    expect((await manual(r)).kind).toBe("published");
    expect((await manifestOf(r)).device).toBe(first.device);
    expect(r.store.get().deviceStore["device-id"]).toBe(stored);
  });

  it("does not publish files under a renamed configuration folder, and does publish them when the shell passes none", async () => {
    const withDir = await rig({ vault: true, configDir: "custom-config" });
    withDir.adapter.put("custom-config/app.json", "{}", 1000);
    expect((await manual(withDir)).kind).toBe("published");
    expect(Object.keys((await manifestOf(withDir)).files).sort()).toEqual(["notes/hello.md", "notes/world.md"]);

    const without = await rig({ vault: true });
    without.adapter.put("custom-config/app.json", "{}", 1000);
    expect((await manual(without)).kind).toBe("published");
    expect(Object.keys((await manifestOf(without)).files)).toContain("custom-config/app.json");
  });
});
