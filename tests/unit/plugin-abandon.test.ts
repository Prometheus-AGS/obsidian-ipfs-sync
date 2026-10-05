import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { ConfigError } from "../../src/core/config";
import { DeviceStoreError } from "../../src/sync/device-store";
import { ABANDON_FAILURES, createAbandonFlow, NOTHING_TO_ABANDON, type AbandonFlowDeps } from "../../src/plugin/abandon-flow";
import { AbandonVaultDialog } from "../../src/plugin/abandon-vault-dialog";
import { ABANDON_COPY, ENCRYPTION_COPY } from "../../src/plugin/encryption-copy";
import { defaultSettings } from "../../src/plugin/settings-model";
import type { SettingsStore } from "../../src/plugin/settings-store";
import { bytesToBase64 } from "../../src/plugin/base64";
import { busyNotice, createSyncLock } from "../../src/plugin/sync-lock";
import { createAdapterLockFile } from "../../src/plugin/adapter-lock-file";
import { encodeLock, type LockFile } from "../../src/sync/publish-lock";
import { lockUnsupported } from "../../src/sync/publish-refusals";
import { SEQUENCE_FLOOR_FILE, SEQUENCE_FLOOR_VERSION, SequenceFloorError, encodeFloor } from "../../src/sync/sequence-floor";
import { VaultKeysError, rootDigest } from "../../src/sync/vault-keys";
import { expectDiscardCaveat } from "../helpers/abandon-discard-text";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Modal, Notice, requestUrlCalls, resetRequestUrl, type Plugin as StubPlugin } from "../support/obsidian-stub";

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const NOW = new Date("2026-09-30T12:00:00Z");
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const KINDS = ["keyslots", "state", "journal"] as const;

async function seedState(adapter: MemoryAdapter, mfsRoot = defaultSettings().mfsRoot): Promise<string> {
  const digest = await rootDigest(mfsRoot);
  for (const kind of KINDS) adapter.put(`.ipfs-sync/${kind}.${digest}.json`, `${kind}-body`);
  return digest;
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

async function confirmInDialog(word: string): Promise<FakeEl> {
  const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl };
  const field = byId(dialog.contentEl, "ipfs-sync-abandon-confirm");
  if (field === undefined) throw new Error("no confirmation field");
  field.value = word;
  await field.dispatch("input");
  await button(dialog.contentEl, ABANDON_COPY.confirm).dispatch("click");
  await flush();
  return dialog.contentEl;
}

describe("plugin: Abandon this vault", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    Notice.reset();
    Modal.reset();
    resetRequestUrl();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function load(adapter: MemoryAdapter): Promise<{ plugin: IpfsSyncPlugin; stub: StubPlugin }> {
    const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as ObsidianApp, MANIFEST);
    const stub = plugin as unknown as StubPlugin;
    // Fresh settings: no node is set, and abandon is local-only so it must still work.
    stub.data = null;
    await plugin.onload();
    return { plugin, stub };
  }

  it("registers a command that opens the confirmation dialog", async () => {
    const { stub } = await load(new MemoryAdapter());
    const command = stub.commands.find((c) => c.id === "abandon-vault");
    expect(command?.name).toBe("Abandon this vault");
    await command?.callback?.();
    await flush();
    expect(Modal.instances.at(-1)).toBeInstanceOf(AbandonVaultDialog);
  });

  it("moves the copy, state and journal into a backup after the word is typed, and sends no request", async () => {
    const adapter = new MemoryAdapter();
    const digest = await seedState(adapter);
    const { stub } = await load(adapter);
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    await confirmInDialog("abandon");
    await vi.waitFor(() => expect(Notice.shown.some((n) => n.message.includes("vault abandoned"))).toBe(true));
    for (const kind of KINDS) {
      expect(adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
      const backup = [...adapter.files.keys()].find((path) => path.endsWith(`/${kind}.json`) && path.includes("abandoned-"));
      expect(backup, kind).toMatch(new RegExp(`^\\.ipfs-sync/abandoned-${digest}-\\d+/${kind}\\.json$`));
      expect(adapter.text(backup ?? "")).toBe(`${kind}-body`);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(requestUrlCalls).toEqual([]);
    const notice = Notice.shown.map((n) => n.message).find((m) => m.includes("vault abandoned"));
    expect(notice).toContain("3 files moved");
    expect(notice).toContain("Nothing on the node was changed");
  });

  it("moves nothing while the word is not typed", async () => {
    const adapter = new MemoryAdapter();
    const digest = await seedState(adapter);
    const { stub } = await load(adapter);
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    await confirmInDialog("aband");
    for (const kind of KINDS) expect(adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(true);
    expect([...adapter.files.keys()].some((path) => path.includes("abandoned-"))).toBe(false);
  });

  it("says in the dialog that a device with nothing to abandon moved nothing", async () => {
    const { stub } = await load(new MemoryAdapter());
    await stub.commands.find((c) => c.id === "abandon-vault")?.callback?.();
    await flush();
    const root = await confirmInDialog("abandon");
    await vi.waitFor(() => expect(byId(root, "ipfs-sync-abandon-error")?.text).toContain(NOTHING_TO_ABANDON.slice(0, 30)));
  });
});

describe("abandon flow", () => {
  function deps(overrides: Partial<AbandonFlowDeps> = {}, adapter = new MemoryAdapter()) {
    const lock = vi.fn();
    const refresh = vi.fn(async () => "not-set-up" as const);
    const store = { get: () => defaultSettings() } as unknown as SettingsStore;
    let request: Parameters<AbandonFlowDeps["openDialog"]>[0] | undefined;
    let finish: Parameters<AbandonFlowDeps["openDialog"]>[1] | undefined;
    const close = vi.fn();
    const all: AbandonFlowDeps = {
      store,
      adapter,
      lock: createSyncLock(),
      session: { lock, refresh },
      now: () => NOW,
      openDialog: (r, f) => {
        request = r;
        finish = f;
        return { close };
      },
      ...overrides,
    };
    return { all, lock, refresh, close, request: () => request, finish: () => finish, adapter };
  }

  it("locks the key session and looks again after the move", async () => {
    const d = deps();
    await seedState(d.adapter);
    const flow = createAbandonFlow(d.all);
    void flow.open();
    expect(await d.request()?.abandon()).toMatchObject({ ok: true });
    expect(d.lock).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledTimes(1);
  });

  it("is busy, and opens no dialog, while publish or pull holds the sync lock", async () => {
    const lock = createSyncLock();
    const release = lock.tryAcquire("publish");
    const open = vi.fn();
    const flow = createAbandonFlow(deps({ lock, openDialog: open as unknown as AbandonFlowDeps["openDialog"] }).all);
    expect(await flow.open()).toBe("busy");
    expect(open).not.toHaveBeenCalled();
    release?.();
  });

  it("refuses the move when an operation starts between opening the dialog and confirming, and holds the lock while it moves", async () => {
    const lock = createSyncLock();
    const d = deps({ lock });
    await seedState(d.adapter);
    const flow = createAbandonFlow(d.all);
    void flow.open();
    const release = lock.tryAcquire("pull");
    const refused = await d.request()?.abandon();
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain("pull");
    expect([...d.adapter.files.keys()].some((p) => p.includes("abandoned-"))).toBe(false);
    release?.();
    expect(await d.request()?.abandon()).toMatchObject({ ok: true });
    expect(lock.holder()).toBeUndefined();
  });

  it("returns an invalid MFS root as text and moves nothing", async () => {
    const bad = { get: () => ({ ...defaultSettings(), mfsRoot: "/elsewhere" }) } as unknown as SettingsStore;
    const d = deps({ store: bad });
    await seedState(d.adapter);
    void createAbandonFlow(d.all).open();
    const result = await d.request()?.abandon();
    expect(result).toMatchObject({ ok: false });
    expect(d.lock).not.toHaveBeenCalled();
  });

  // R5-L6 (c): the text returned by the action, and so the post-close `failure`, comes from a closed set of fixed lines; no error message is read.
  describe("a failure is a fixed line, never an error message", () => {
    const HOSTILE = "\u001b[2JFORGED /Users/someone/secret-path";
    const throwing = (error: unknown): SettingsStore =>
      ({
        get: () => {
          throw error;
        },
      }) as unknown as SettingsStore;
    const FIXED = new Set<string>(Object.values(ABANDON_FAILURES));

    it.each([
      ["a ConfigError that echoes the typed root", new ConfigError("unsafe-mfs-path", `refusing to modify "${HOSTILE}"`), ABANDON_FAILURES.invalidRoot],
      ["a VaultKeysError", new VaultKeysError("abandon-not-confirmed", HOSTILE), ABANDON_FAILURES.local],
      ["a DeviceStoreError", new DeviceStoreError(HOSTILE), ABANDON_FAILURES.local],
      ["a plain Error", new Error(HOSTILE), ABANDON_FAILURES.unexpected],
      ["a thrown string", HOSTILE, ABANDON_FAILURES.unexpected],
      ["a thrown object", { message: HOSTILE }, ABANDON_FAILURES.unexpected],
    ])("%s becomes one fixed line", async (_label, error, expected) => {
      const d = deps({ store: throwing(error) });
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: expected });
      expect(FIXED.has((result as { reason: string }).reason)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("FORGED");
      expect(JSON.stringify(result)).not.toContain("secret-path");
    });

    it("an MFS root with hostile text in the settings is refused with the fixed line, not the typed root", async () => {
      const bad = { get: () => ({ ...defaultSettings(), mfsRoot: `/elsewhere${HOSTILE}` }) } as unknown as SettingsStore;
      const d = deps({ store: bad });
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: ABANDON_FAILURES.invalidRoot });
    });

    it("the dialog closed after Confirm reports the fixed line as its failure", async () => {
      const bad = { get: () => ({ ...defaultSettings(), mfsRoot: `/elsewhere${HOSTILE}` }) } as unknown as SettingsStore;
      const app = new StubApp(new MemoryAdapter()) as unknown as ObsidianApp;
      const finished = vi.fn();
      const d = deps({
        store: bad,
        openDialog: (request, onFinish) => {
          const dialog = new AbandonVaultDialog(app, request, (outcome) => {
            finished(outcome);
            onFinish(outcome);
          });
          dialog.open();
          return dialog;
        },
      });
      void createAbandonFlow(d.all).open();
      const dialog = Modal.instances.at(-1) as unknown as { contentEl: FakeEl; close(): void };
      const field = byId(dialog.contentEl, "ipfs-sync-abandon-confirm");
      if (field === undefined) throw new Error("no confirmation field");
      field.value = "abandon";
      await field.dispatch("input");
      const pressed = button(dialog.contentEl, ABANDON_COPY.confirm).dispatch("click");
      dialog.close();
      await pressed;
      await flush();
      expect(finished).toHaveBeenCalledTimes(1);
      expect(finished).toHaveBeenCalledWith({ abandoned: false, failure: ABANDON_FAILURES.invalidRoot });
    });
  });

  // R5-M1: a device whose only local file is a maintenance journal still abandons; the move is not 'nothing to abandon'.
  it.each(["keyslots", "state", "journal", "maintenance"] as const)("moves a device whose only local file is the %s file", async (only) => {
    const d = deps();
    const digest = await rootDigest(defaultSettings().mfsRoot);
    d.adapter.put(`.ipfs-sync/${only}.${digest}.json`, `${only}-body`);
    void createAbandonFlow(d.all).open();
    const result = await d.request()?.abandon();
    expect(result).toMatchObject({ ok: true });
    expect((result as { backupNote: string }).backupNote).toContain("1 file moved");
    expect([...d.adapter.files.keys()].some((path) => path.endsWith(`/${only}.json`) && path.includes("abandoned-"))).toBe(true);
  });

  describe("sequence floor", () => {
    const VAULT_ID = "e".repeat(32);

    function storeWithFloor(sequence: number | undefined) {
      const floors = sequence === undefined ? {} : { [VAULT_ID]: { sequence, identity: "1".repeat(64), at: 1000 } };
      const deviceStore = { [SEQUENCE_FLOOR_FILE]: bytesToBase64(encodeFloor({ version: SEQUENCE_FLOOR_VERSION, floors })) };
      const update = vi.fn();
      const store = { get: () => ({ ...defaultSettings(), deviceStore }), update } as unknown as SettingsStore;
      return { store, update, deviceStore };
    }

    async function seedVault(adapter: MemoryAdapter): Promise<void> {
      const digest = await rootDigest(defaultSettings().mfsRoot);
      adapter.put(`.ipfs-sync/state.${digest}.json`, JSON.stringify({ vaultId: VAULT_ID }));
      adapter.put(`.ipfs-sync/journal.${digest}.json`, "journal-body");
    }

    it("puts 'sequence floor kept: N' in the notice text and does not write the settings", async () => {
      const { store, update, deviceStore } = storeWithFloor(7);
      const d = deps({ store });
      await seedVault(d.adapter);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toMatchObject({ ok: true });
      expect((result as { backupNote: string }).backupNote).toContain("sequence floor kept: 7");
      expect(update).not.toHaveBeenCalled();
      expect(store.get().deviceStore).toBe(deviceStore);
    });

    it("says none when the device holds no floor for the vault", async () => {
      const { store } = storeWithFloor(undefined);
      const d = deps({ store });
      await seedVault(d.adapter);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect((result as { backupNote: string }).backupNote).toContain("sequence floor kept: none");
    });
  });

  it("R5-M1/R6-M2: the dialog's consequences say a pending rewrap or prune is dropped, its node write is not withdrawn, and keys discard withdraws only an unpublished rewrap", () => {
    const text = ABANDON_COPY.consequences.join(" ").replace(/\s+/g, " ");
    expect(text).toContain("ipfs-sync keys discard");
    expectDiscardCaveat(text);
    expect(text).toContain("the plugin has no discard action");
    // The existing statements stay.
    expect(text).toContain("Nothing on the node is changed or deleted");
  });

  it("R6-L2: the consequence text and the settings row name all four files", () => {
    for (const [label, text] of [
      ["consequences", ABANDON_COPY.consequences.join(" ")],
      ["abandonDesc", ENCRYPTION_COPY.abandonDesc],
    ] as const) {
      for (const name of ["key-slot copy", "sync state", "publish journal", "key-management journal"]) expect(text, `${label}: ${name}`).toContain(name);
    }
  });

  describe("R6-M1: the cross-process publish lock is held around the move", () => {
    const LOCK_PATH = ".ipfs-sync/publish.lock";
    const heldLock = (): Uint8Array => encodeLock({ token: "other-token", pid: 4242, host: "other-host", time: NOW.getTime() });

    it("a lock file held by another process gives the busy result and moves nothing", async () => {
      const d = deps();
      const digest = await seedState(d.adapter);
      d.adapter.put(LOCK_PATH, new TextDecoder().decode(heldLock()));
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: busyNotice(undefined) });
      for (const kind of KINDS) expect(d.adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(true);
      expect([...d.adapter.files.keys()].some((p) => p.includes("abandoned-"))).toBe(false);
      expect(d.lock).not.toHaveBeenCalled();
      expect(d.all.lock.holder()).toBeUndefined();
      // The other process's lock is untouched.
      expect(d.adapter.text(LOCK_PATH)).toContain("other-token");
    });

    it("the lock file is gone after a successful move", async () => {
      const d = deps();
      await seedState(d.adapter);
      void createAbandonFlow(d.all).open();
      expect(await d.request()?.abandon()).toMatchObject({ ok: true });
      expect(d.adapter.files.has(LOCK_PATH)).toBe(false);
    });

    it("the lock file is gone after the move throws", async () => {
      const d = deps();
      await seedState(d.adapter);
      const rename = d.adapter.rename.bind(d.adapter);
      d.adapter.rename = async (from: string, to: string) => {
        if (to.includes("abandoned-")) throw new Error("EIO /secret");
        return rename(from, to);
      };
      void createAbandonFlow(d.all).open();
      expect(await d.request()?.abandon()).toEqual({ ok: false, reason: ABANDON_FAILURES.unexpected });
      expect(d.adapter.files.has(LOCK_PATH)).toBe(false);
      expect(d.all.lock.holder()).toBeUndefined();
    });

    it("is held while the files move", async () => {
      const d = deps();
      await seedState(d.adapter);
      let heldAtRename: boolean | undefined;
      const rename = d.adapter.rename.bind(d.adapter);
      d.adapter.rename = async (from: string, to: string) => {
        if (to.includes("abandoned-")) heldAtRename ??= d.adapter.files.has(LOCK_PATH);
        return rename(from, to);
      };
      void createAbandonFlow(d.all).open();
      await d.request()?.abandon();
      expect(heldAtRename).toBe(true);
    });
  });

  describe("R7-M1 and R7-M2: the publish lock never decides the outcome", () => {
    const LOCK_PATH = ".ipfs-sync/publish.lock";
    const WITHOUT_LOCK = "the publish lock could not be used, so abandon ran without it; make sure no publish is running";
    const PARTIAL = "1 of 4 files were moved. Run abandon again to move the rest into a new backup folder.";

    const releaseThrows = (adapter: MemoryAdapter): LockFile => ({
      ...createAdapterLockFile(adapter),
      remove: async () => {
        throw new Error("secret-lock-path EIO");
      },
    });

    async function seedFour(adapter: MemoryAdapter): Promise<string> {
      const digest = await rootDigest(defaultSettings().mfsRoot);
      for (const kind of ["keyslots", "state", "journal", "maintenance"]) adapter.put(`.ipfs-sync/${kind}.${digest}.json`, `${kind}-body`);
      return digest;
    }

    it("a release that throws after a full success returns the success result, locks the session and looks again", async () => {
      const d = deps();
      const digest = await seedState(d.adapter);
      void createAbandonFlow({ ...d.all, lockFile: releaseThrows(d.adapter) }).open();
      const result = await d.request()?.abandon();
      expect(result).toMatchObject({ ok: true });
      expect((result as { backupNote: string }).backupNote).toContain("3 files moved");
      expect(JSON.stringify(result)).not.toContain("secret-lock-path");
      for (const kind of KINDS) expect(d.adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
      expect(d.lock).toHaveBeenCalledTimes(1);
      expect(d.refresh).toHaveBeenCalledTimes(1);
      expect(d.all.lock.holder()).toBeUndefined();
    });

    it("a release that throws after a partial move returns the partial-move result with its counts and locks the session", async () => {
      const d = deps();
      await seedFour(d.adapter);
      let count = 0;
      const rename = d.adapter.rename.bind(d.adapter);
      d.adapter.rename = async (from: string, to: string) => {
        if (to.includes("abandoned-") && ++count === 2) throw new Error("EIO");
        return rename(from, to);
      };
      void createAbandonFlow({ ...d.all, lockFile: releaseThrows(d.adapter) }).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: PARTIAL });
      expect(d.lock).toHaveBeenCalledTimes(1);
      expect(d.refresh).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a junk lock file", "this is not a lock record\n"],
      ["a 70 KiB lock file", "x".repeat(70 * 1024)],
    ])("%s does not block abandon: the files move and the note carries the fixed line", async (_label, body) => {
      const d = deps();
      const digest = await seedState(d.adapter);
      d.adapter.put(LOCK_PATH, body);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toMatchObject({ ok: true });
      const note = (result as { backupNote: string }).backupNote;
      expect(note).toContain("3 files moved");
      expect(note).toContain(WITHOUT_LOCK);
      for (const kind of KINDS) expect(d.adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
      expect(d.adapter.text(LOCK_PATH)).toBe(body);
      expect(d.lock).toHaveBeenCalledTimes(1);
    });

    it("a lock file that cannot be created (no hard links) does not block abandon, and no error text is echoed", async () => {
      const d = deps();
      await seedState(d.adapter);
      const lockFile: LockFile = {
        ...createAdapterLockFile(d.adapter),
        createExclusive: async () => {
          throw lockUnsupported("EPERM");
        },
      };
      void createAbandonFlow({ ...d.all, lockFile }).open();
      const result = await d.request()?.abandon();
      expect(result).toMatchObject({ ok: true });
      const note = (result as { backupNote: string }).backupNote;
      expect(note).toContain(WITHOUT_LOCK);
      expect(note).not.toContain("EPERM");
      expect(note).not.toContain("hard links");
    });

    it("a normal move has no without-lock line", async () => {
      const d = deps();
      await seedState(d.adapter);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect((result as { backupNote: string }).backupNote).not.toContain(WITHOUT_LOCK);
    });
  });

  describe("R6-M3: a failing device store never blocks the move", () => {
    const SECRET = "/Users/someone/secret-store";
    it.each([
      ["a DeviceStoreError", () => new DeviceStoreError(SECRET)],
      ["a generic Error", () => new Error(SECRET)],
      ["a SequenceFloorError", () => new SequenceFloorError(SECRET)],
    ])("%s: all files move, the notice says the floor could not be read, and no message is echoed", async (_label, make) => {
      const settings = {
        ...defaultSettings(),
        get deviceStore(): Record<string, string> {
          throw make();
        },
      };
      const store = { get: () => settings } as unknown as SettingsStore;
      const d = deps({ store });
      const digest = await rootDigest(defaultSettings().mfsRoot);
      d.adapter.put(`.ipfs-sync/state.${digest}.json`, JSON.stringify({ vaultId: "e".repeat(32) }));
      d.adapter.put(`.ipfs-sync/journal.${digest}.json`, "journal-body");
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toMatchObject({ ok: true });
      const note = (result as { backupNote: string }).backupNote;
      expect(note).toContain("2 files moved");
      expect(note).toContain("could not be read");
      expect(note).not.toContain("secret");
      expect(d.adapter.files.has(`.ipfs-sync/state.${digest}.json`)).toBe(false);
      expect(d.lock).toHaveBeenCalledTimes(1);
    });
  });

  describe("R6-M4: a rename that fails after the first is a partial move", () => {
    const PARTIAL = (moved: number, total: number): string => `${moved} of ${total} files were moved. Run abandon again to move the rest into a new backup folder.`;

    /** Fail the `n`th rename into the backup folder (the lock file's own renames are not counted). */
    function failBackupRename(adapter: MemoryAdapter, n: number): void {
      let count = 0;
      const rename = adapter.rename.bind(adapter);
      adapter.rename = async (from: string, to: string) => {
        if (to.includes("abandoned-") && ++count === n) throw new Error("EIO: i/o error, rename '/Users/someone/secret/state.json'");
        return rename(from, to);
      };
    }

    async function seedFour(adapter: MemoryAdapter): Promise<string> {
      const digest = await rootDigest(defaultSettings().mfsRoot);
      for (const kind of ["keyslots", "state", "journal", "maintenance"]) adapter.put(`.ipfs-sync/${kind}.${digest}.json`, `${kind}-body`);
      return digest;
    }

    it.each([
      [2, 1],
      [3, 2],
      [4, 3],
    ])("failing rename number %i returns the fixed line with %i of 4, locks the session and looks again", async (failing, moved) => {
      const d = deps();
      const digest = await seedFour(d.adapter);
      failBackupRename(d.adapter, failing);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: PARTIAL(moved, 4) });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(JSON.stringify(result)).not.toContain("EIO");
      expect(d.lock).toHaveBeenCalledTimes(1);
      expect(d.refresh).toHaveBeenCalledTimes(1);
      const remaining = ["keyslots", "state", "journal", "maintenance"].filter((kind) => d.adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`));
      expect(remaining).toHaveLength(4 - moved);
      expect(d.adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
      expect(d.all.lock.holder()).toBeUndefined();
    });

    it("says so, after the fixed line, when the status could not be re-read", async () => {
      const d = deps({ session: { lock: vi.fn(), refresh: vi.fn(async () => Promise.reject(new Error("secret"))) } });
      await seedFour(d.adapter);
      failBackupRename(d.adapter, 2);
      void createAbandonFlow(d.all).open();
      const result = (await d.request()?.abandon()) as { ok: false; reason: string };
      expect(result.reason.startsWith(PARTIAL(1, 4))).toBe(true);
      expect(result.reason).toContain("could not be re-read");
      expect(result.reason).not.toContain("secret");
    });

    it("a failure of the first rename is today's line: the session is not locked, nothing changed", async () => {
      const d = deps();
      await seedFour(d.adapter);
      failBackupRename(d.adapter, 1);
      void createAbandonFlow(d.all).open();
      const result = await d.request()?.abandon();
      expect(result).toEqual({ ok: false, reason: ABANDON_FAILURES.unexpected });
      expect(d.lock).not.toHaveBeenCalled();
      expect(d.refresh).not.toHaveBeenCalled();
    });

    it("running abandon again moves the rest", async () => {
      const d = deps();
      const digest = await seedFour(d.adapter);
      failBackupRename(d.adapter, 3);
      void createAbandonFlow(d.all).open();
      expect(await d.request()?.abandon()).toEqual({ ok: false, reason: PARTIAL(2, 4) });
      const second = await d.request()?.abandon();
      expect(second).toMatchObject({ ok: true });
      expect((second as { backupNote: string }).backupNote).toContain("2 files moved");
      for (const kind of ["keyslots", "state", "journal", "maintenance"]) expect(d.adapter.files.has(`.ipfs-sync/${kind}.${digest}.json`)).toBe(false);
    });
  });

  it("closes an open dialog when disposed", () => {
    const d = deps();
    const flow = createAbandonFlow(d.all);
    void flow.open();
    flow.dispose();
    expect(d.close).toHaveBeenCalledTimes(1);
  });
});
