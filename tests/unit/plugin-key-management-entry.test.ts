import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { ACCEPT_SLOTS_COPY, KEY_ACTIONS_COPY, MASS_REMOVAL_COPY, PRUNE_HISTORY_COPY, TEST_UNLOCK_COPY } from "../../src/plugin/encryption-copy";
import { MEASURE_START_NOTICE } from "../../src/plugin/measure-notice";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { setPluginSeams } from "../../src/plugin/plugin-seams";
import { defaultSettings } from "../../src/plugin/settings-model";
import { keySlotsCopyPath } from "../../src/sync/vault-keys";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { REFERENCE_TEXT } from "../helpers/plugin-session";
import { legacyHistoryName } from "../helpers/prune-rig";
import { initVault } from "../helpers/vault-init";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import {
  App as StubApp,
  Modal,
  Notice,
  Platform,
  requestUrlCalls,
  resetRequestUrl,
  setRequestUrlHandler,
  stubResponse,
  type Plugin as StubPlugin,
} from "../support/obsidian-stub";

/**
 * mvp-07b task 2.2 at the plugin entry: the real dialogs (over the stub `Modal`), the real key session, publish runner and key actions, and the
 * real `requestUrl` transport with a fake node behind the stub. Only the platform and the Argon2id cost of the measure command are stood in.
 */

const PLUGIN_DIR = ".obsidian/plugins/ipfs-sync";
const BUILD_PATH = `${PLUGIN_DIR}/main.js`;
const MANIFEST = { id: "ipfs-sync", version: "0.2.0", dir: PLUGIN_DIR } as unknown as PluginManifest;
const ROOT = "/obsidian-vault-sync/mvp07b-entry";
const BUILD_TEXT = "// installed plugin main.js, build under test\n";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

interface Loaded {
  readonly plugin: IpfsSyncPlugin;
  readonly stub: StubPlugin;
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function serveNode(node: FakeNode): void {
  const serve = fakeNodeFetch(node, []);
  setRequestUrlHandler(async (params) => {
    const headers = { ...(params.headers ?? {}), ...(params.contentType === undefined ? {} : { "content-type": params.contentType }) };
    const response = await serve(params.url, { method: params.method, headers, body: params.body });
    return stubResponse(response.status, new Uint8Array(await response.arrayBuffer()), Object.fromEntries(response.headers.entries()));
  });
}

async function load(options: { readonly vault: boolean; readonly build?: boolean } = { vault: true }): Promise<Loaded> {
  const adapter = new MemoryAdapter();
  adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  if (options.build !== false) adapter.put(BUILD_PATH, BUILD_TEXT);
  const node = createFakeNode();
  if (options.vault) await initVault(createObsidianHostBridge({ adapter }).fs, node, ROOT);
  serveNode(node);
  vi.stubGlobal("window", { setInterval: vi.fn(() => 7), clearInterval: vi.fn() });
  const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as App, MANIFEST);
  const stub = plugin as unknown as StubPlugin;
  stub.data = { ...defaultSettings(), mfsRoot: ROOT, publishIntervalMinutes: 0 };
  await plugin.onload();
  return { plugin, stub, adapter, node };
}

const notices = (fragment: string): number => Notice.shown.filter((notice) => notice.message.includes(fragment)).length;
const writes = (node: FakeNode): string[] => node.calls.filter((call) => MUTATING.test(call));

function must(root: FakeEl, id: string): FakeEl {
  const el = byId(root, id);
  if (el === undefined) throw new Error(`no element ${id}`);
  return el;
}

const buttonIn = (root: FakeEl, matches: (text: string) => boolean): FakeEl => {
  const found = root.find((el) => el.tag === "button" && matches(el.text));
  if (found === undefined) throw new Error("no such button");
  return found;
};

const contentOf = (modal: Modal): FakeEl => modal.contentEl as unknown as FakeEl;

function dialogWith(id: string): FakeEl {
  const modal = Modal.instances.find((candidate) => candidate.opened && byId(contentOf(candidate), id) !== undefined);
  if (modal === undefined) throw new Error(`no open dialog with ${id}`);
  return contentOf(modal);
}

async function type(el: FakeEl, text: string): Promise<void> {
  el.value = text;
  await el.dispatch("input");
}

async function enterPassphrase(text: string): Promise<void> {
  const dialog = dialogWith("ipfs-sync-unlock-passphrase");
  await type(must(dialog, "ipfs-sync-unlock-passphrase"), text);
  await buttonIn(dialog, (label) => label === "Unlock").dispatch("click");
}

/** Publish by hand and enter the passphrase: the session is then unlocked. */
async function firstPublish(plugin: IpfsSyncPlugin): Promise<void> {
  const published = plugin.publishVault();
  await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-unlock-passphrase") !== undefined), "the unlock dialog");
  await enterPassphrase(REFERENCE_TEXT);
  expect((await published).kind).toBe("published");
}

beforeEach(() => {
  Notice.reset();
  Modal.reset();
  resetRequestUrl();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRequestUrl();
  Object.assign(Platform, { isIosApp: false, isAndroidApp: false, isMobile: false });
});

describe("plugin entry: Measure key derivation time", () => {
  const command = (stub: StubPlugin) => stub.commands.find((c) => c.id === "measure-key-derivation");

  it("is registered under its name and runs without a vault, a passphrase or a request", async () => {
    const { plugin, stub, adapter } = await load({ vault: false });
    setPluginSeams(plugin, { measureDerive: async () => undefined });
    expect(command(stub)?.name).toBe("Measure key derivation time");
    const readsBefore = adapter.reads.length;
    const callsBefore = adapter.calls.length;
    await command(stub)?.callback?.();
    await until(() => notices("Key derivation measured") === 1, "the measurement notice");
    expect(adapter.reads.slice(readsBefore)).toEqual([BUILD_PATH]);
    expect(adapter.calls.slice(callsBefore)).toEqual([]);
    expect(requestUrlCalls).toEqual([]);
    expect(Modal.instances).toHaveLength(0);
    expect(Notice.shown[0]?.message).toBe(MEASURE_START_NOTICE);
  });

  it("shows seconds, platform, completed and the first 16 hex characters of the build hash in groups of four", async () => {
    Object.assign(Platform, { isIosApp: true, isMobile: true });
    const { plugin, stub } = await load({ vault: false });
    setPluginSeams(plugin, { measureDerive: async () => undefined });
    await command(stub)?.callback?.();
    await until(() => notices("Key derivation measured") === 1, "the measurement notice");
    const hash = bytesToHex(sha256(new TextEncoder().encode(BUILD_TEXT))).slice(0, 16);
    const grouped = hash.replace(/(.{4})(?=.)/g, "$1 ");
    const text = Notice.shown.find((notice) => notice.message.includes("Key derivation measured"))?.message ?? "";
    expect(text).toContain("Platform: ios");
    expect(text).toContain("Completed: yes");
    expect(text).toContain("Seconds:");
    expect(text).toContain("Longest event-loop gap:");
    expect(text).toContain(`Build hash (first 16 characters): ${grouped}`);
    expect(Notice.shown.find((notice) => notice.message.includes("Key derivation measured"))?.duration).toBe(0);
  });

  it("says the build hash is unavailable when the installed file cannot be read", async () => {
    const { plugin, stub } = await load({ vault: false, build: false });
    setPluginSeams(plugin, { measureDerive: async () => undefined });
    await command(stub)?.callback?.();
    await until(() => notices("Key derivation measured") === 1, "the measurement notice");
    expect(notices("Build hash: unavailable")).toBe(1);
  });

  it("does not start a second measurement while one is running", async () => {
    const { plugin, stub } = await load({ vault: false });
    let finish: () => void = () => undefined;
    let started = false;
    setPluginSeams(plugin, {
      measureDerive: () =>
        new Promise<void>((resolve) => {
          started = true;
          finish = resolve;
        }),
    });
    void command(stub)?.callback?.();
    await until(() => started, "the derivation to start");
    await command(stub)?.callback?.();
    expect(notices("already running")).toBe(1);
    expect(notices(MEASURE_START_NOTICE)).toBe(1);
    finish();
    await until(() => notices("Key derivation measured") === 1, "the measurement notice");
  });
});

describe("plugin entry: mass removal on publish", () => {
  async function emptiedAfterPublish(): Promise<Loaded> {
    const loaded = await load({ vault: true });
    await firstPublish(loaded.plugin);
    loaded.adapter.files.delete("notes/hello.md");
    loaded.node.calls.length = 0;
    return loaded;
  }

  const removalDialog = (): FakeEl => dialogWith("ipfs-sync-mass-removal-summary");

  it("a manual publish opens the dialog; cancel writes nothing", async () => {
    const { plugin, node } = await emptiedAfterPublish();
    const run = plugin.publishVault();
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-mass-removal-summary") !== undefined), "the mass-removal dialog");
    const dialog = removalDialog();
    expect(dialog.textContent()).toContain("only entry");
    await buttonIn(dialog, (label) => label === MASS_REMOVAL_COPY.cancel).dispatch("click");
    expect(await run).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(writes(node)).toEqual([]);
  });

  it("a manual publish removes the entry after the explicit confirm", async () => {
    const { plugin } = await emptiedAfterPublish();
    const run = plugin.publishVault();
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-mass-removal-summary") !== undefined), "the mass-removal dialog");
    await buttonIn(removalDialog(), (label) => label.startsWith("Remove ")).dispatch("click");
    const outcome = await run;
    expect(outcome).toMatchObject({ kind: "published" });
    expect(outcome.kind === "published" && outcome.result.removed).toBe(1);
  });

  it("the timer shows a notice once and opens no dialog", async () => {
    const { plugin, node } = await emptiedAfterPublish();
    const dialogsBefore = Modal.instances.length;
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "mass-removal" });
    expect(Modal.instances).toHaveLength(dialogsBefore);
    expect(notices("The automatic publish stopped")).toBe(1);
    expect(writes(node)).toEqual([]);
  });
});

describe("plugin entry: Prune history (task 2.5)", () => {
  const LEGACY = 25;
  const historyOf = (node: FakeNode): string[] =>
    [...node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`)).map((path) => path.slice(`${ROOT}/manifests/`.length)).sort();
  const manifestRemovals = (node: FakeNode): string[] => node.calls.filter((call) => call.startsWith("rm ") && call.includes("/manifests/"));

  async function settingsTab(loaded: Loaded): Promise<FakeEl> {
    const tab = loaded.stub.settingTabs[0] as unknown as { display(): void; containerEl: FakeEl };
    tab.display();
    await flush();
    return tab.containerEl;
  }

  /** A published vault whose manifests/ also holds 25 older-format names: one genuine prefixed file plus 25 legacy ones. */
  async function longHistory(): Promise<Loaded> {
    const loaded = await load({ vault: true });
    await firstPublish(loaded.plugin);
    for (let index = 0; index < LEGACY; index += 1) loaded.node.files.set(`${ROOT}/manifests/${legacyHistoryName(index)}`, new Uint8Array(40).fill(index % 251));
    loaded.node.cidOf(ROOT);
    return loaded;
  }

  async function openDialog(loaded: Loaded): Promise<FakeEl> {
    const tab = await settingsTab(loaded);
    await buttonIn(tab, (label) => label === KEY_ACTIONS_COPY.pruneHistory.button).dispatch("click");
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-prune-keep") !== undefined), "the prune dialog");
    return dialogWith("ipfs-sync-prune-keep");
  }

  async function preview(dialog: FakeEl, keep: string): Promise<void> {
    await type(must(dialog, "ipfs-sync-prune-keep"), keep);
    await type(must(dialog, "ipfs-sync-prune-current"), REFERENCE_TEXT);
    await buttonIn(dialog, (label) => label === PRUNE_HISTORY_COPY.previewButton).dispatch("click");
    await until(() => !hiddenEl(must(dialog, "ipfs-sync-prune-review")), "the preview");
  }

  const hiddenEl = (el: FakeEl): boolean => el.style["display"] === "none" || (el.parent !== null && hiddenEl(el.parent));

  it("the timer and the catch-up pull never prune, even when a prune would remove entries", async () => {
    const loaded = await longHistory();
    loaded.node.calls.length = 0;
    // The seeded names changed the node's tree behind the device's back, so the timer's publish may publish; it still must not prune.
    expect(["published", "unchanged"]).toContain((await loaded.plugin.publishVault({ quiet: true })).kind);
    await loaded.plugin.pullVault({ quiet: true });
    expect(manifestRemovals(loaded.node)).toEqual([]);
    expect(historyOf(loaded.node).filter((name) => name.startsWith("bafylegacy"))).toHaveLength(LEGACY);
  });

  it("the row opens the dialog; the preview is a dry run in counts; cancel removes nothing; a second run removes only the oldest after the explicit press", async () => {
    const loaded = await longHistory();
    const before = historyOf(loaded.node);
    const manifestBefore = loaded.node.files.get(`${ROOT}/manifest.enc`);
    const slotsBefore = loaded.node.files.get(`${ROOT}/keyslots.json`);

    const first = await openDialog(loaded);
    await preview(first, "20");
    expect(must(first, "ipfs-sync-prune-review").textContent()).toContain(`6 of the ${LEGACY + 1} history files`);
    expect(must(first, "ipfs-sync-prune-review").textContent()).not.toContain("bafylegacy");
    expect(first.find((el) => el.focused && el.tag === "button")?.text).toBe("Cancel");
    // The lock is held across the preview: a timer publish is refused as busy.
    expect(await loaded.plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "busy" });
    loaded.node.calls.length = 0;
    await buttonIn(first, (label) => label === "Cancel").dispatch("click");
    expect(manifestRemovals(loaded.node)).toEqual([]);
    expect(writes(loaded.node)).toEqual([]);
    expect(historyOf(loaded.node)).toEqual(before);

    Modal.instances.length = 0;
    const second = await openDialog(loaded);
    await preview(second, "20");
    await buttonIn(second, (label) => label === "Remove 6 history files").dispatch("click");
    await until(() => must(second, "ipfs-sync-prune-result").textContent().includes(PRUNE_HISTORY_COPY.doneTitle), "the result");
    const after = historyOf(loaded.node);
    expect(after).toHaveLength(20);
    expect(after.filter((name) => /^\d{16}-/.test(name))).toHaveLength(1);
    expect(loaded.node.files.get(`${ROOT}/manifest.enc`)).toEqual(manifestBefore);
    expect(loaded.node.files.get(`${ROOT}/keyslots.json`)).toEqual(slotsBefore);
    expect(JSON.stringify(loaded.stub.data)).not.toContain(REFERENCE_TEXT);
    // The vault stays unlocked and in sync: the next publish has nothing to do.
    Modal.instances.filter((modal) => modal.opened).forEach((modal) => modal.close());
    let outcome = await loaded.plugin.publishVault({ quiet: true });
    for (let attempt = 0; attempt < 600 && outcome.kind === "refused"; attempt += 1) {
      await flush();
      outcome = await loaded.plugin.publishVault({ quiet: true });
    }
    expect(outcome.kind).toBe("unchanged");
  });

  it("shows the row only once a vault exists", async () => {
    const loaded = await load({ vault: false });
    const tab = await settingsTab(loaded);
    const row = tab.find((el) => el.tag === "button" && el.text === KEY_ACTIONS_COPY.pruneHistory.button);
    expect(row !== undefined && hiddenEl(row)).toBe(true);
  });
});

describe("plugin entry: key-management rows and dialogs", () => {
  async function settingsTab(loaded: Loaded): Promise<FakeEl> {
    const tab = loaded.stub.settingTabs[0] as unknown as { display(): void; containerEl: FakeEl };
    tab.display();
    await flush();
    return tab.containerEl;
  }

  it("shows the slot cost and the three rows once a vault exists, and each row opens its dialog", async () => {
    const loaded = await load({ vault: true });
    const tab = await settingsTab(loaded);
    expect(tab.textContent()).toContain("Key-derivation cost");
    await until(() => /\d+ (KiB|MiB)/.test(tab.textContent()), "the slot cost");
    for (const [row, probe] of [
      [KEY_ACTIONS_COPY.changePassphrase, "ipfs-sync-change-current"],
      [KEY_ACTIONS_COPY.increaseCost, "ipfs-sync-cost-current"],
      [KEY_ACTIONS_COPY.acceptSlots, "ipfs-sync-accept-current"],
    ] as const) {
      await buttonIn(tab, (label) => label === row.button).dispatch("click");
      await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), probe) !== undefined), `the ${row.name} dialog`);
      Modal.instances.filter((modal) => modal.opened).forEach((modal) => modal.close());
    }
  });

  it("accept reads the node's current root through the real ports, finds nothing to change on the device that published it, and gives the lock back on close", async () => {
    const loaded = await load({ vault: true });
    await firstPublish(loaded.plugin);
    const tab = await settingsTab(loaded);
    await buttonIn(tab, (label) => label === KEY_ACTIONS_COPY.acceptSlots.button).dispatch("click");
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-accept-current") !== undefined), "the accept dialog");
    const dialog = dialogWith("ipfs-sync-accept-current");
    await type(must(dialog, "ipfs-sync-accept-current"), REFERENCE_TEXT);
    await buttonIn(dialog, (label) => label === ACCEPT_SLOTS_COPY.checkButton).dispatch("click");
    await until(() => must(dialog, "ipfs-sync-accept-review").textContent().includes(ACCEPT_SLOTS_COPY.nothingToAccept), "the review");
    loaded.node.calls.length = 0;
    // The review holds the lock: a publish is refused as busy until the dialog closes.
    expect(await loaded.plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "busy" });
    Modal.instances.filter((modal) => modal.opened).forEach((modal) => modal.close());
    let outcome = await loaded.plugin.publishVault({ quiet: true });
    for (let attempt = 0; attempt < 600 && outcome.kind === "refused"; attempt += 1) {
      await flush();
      outcome = await loaded.plugin.publishVault({ quiet: true });
    }
    expect(outcome.kind).toBe("unchanged");
    expect(writes(loaded.node)).toEqual([]);
  });

  it("shows no key row before a vault exists", async () => {
    const loaded = await load({ vault: false });
    const tab = await settingsTab(loaded);
    const row = tab.find((el) => el.tag === "button" && el.text === KEY_ACTIONS_COPY.changePassphrase.button);
    const hidden = (el: FakeEl | undefined): boolean => el !== undefined && (el.style["display"] === "none" || hidden(el.parent ?? undefined));
    expect(hidden(row)).toBe(true);
  });

  it("changes the passphrase through the dialog, the engine and the node; the new passphrase then opens the vault", async () => {
    const loaded = await load({ vault: true });
    await firstPublish(loaded.plugin);
    const copyPath = await keySlotsCopyPath(ROOT);
    const before = loaded.adapter.text(copyPath);
    const slotsBefore = loaded.node.files.get(`${ROOT}/keyslots.json`);
    const tab = await settingsTab(loaded);
    await buttonIn(tab, (label) => label === KEY_ACTIONS_COPY.changePassphrase.button).dispatch("click");
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-change-current") !== undefined), "the change dialog");
    const dialog = dialogWith("ipfs-sync-change-current");
    const shown = must(dialog, "ipfs-sync-change-passphrase")
      .findAll((el) => el.tag === "code")
      .map((el) => el.text)
      .join("-");
    await type(must(dialog, "ipfs-sync-change-current"), REFERENCE_TEXT);
    await type(must(dialog, "ipfs-sync-change-reentry"), shown);
    const acknowledge = must(dialog, "ipfs-sync-change-acknowledge");
    acknowledge.checked = true;
    await acknowledge.dispatch("change");
    await buttonIn(dialog, (label) => label === "Change passphrase").dispatch("click");
    await until(() => must(dialog, "ipfs-sync-change-result").textContent().includes(TEST_UNLOCK_COPY.verified), "the test unlock result");

    expect(loaded.adapter.text(copyPath)).not.toBe(before);
    expect(loaded.node.files.get(`${ROOT}/keyslots.json`)).not.toEqual(slotsBefore);
    // The held keys were opened from the old file: the session is locked again.
    expect((await settingsTab(loaded)).textContent()).toContain("Locked.");
    expect(loaded.plugin).toBeDefined();
    expect(JSON.stringify(loaded.stub.data)).not.toContain(shown);

    const next = loaded.plugin.publishVault();
    await until(() => Modal.instances.some((modal) => modal.opened && byId(contentOf(modal), "ipfs-sync-unlock-passphrase") !== undefined), "the unlock dialog");
    await enterPassphrase(shown);
    expect((await next).kind).toBe("unchanged");
    expect(requestUrlCalls.every((call) => !`${call.url}`.includes(shown))).toBe(true);
  });
});
