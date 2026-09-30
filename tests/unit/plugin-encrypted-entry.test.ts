import type { App, PluginManifest } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IpfsSyncPlugin from "../../src/plugin";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { REFERENCE_TEXT } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { byId, type FakeEl } from "../support/fake-dom";
import { MemoryAdapter } from "../support/memory-adapter";
import { App as StubApp, Modal, Notice, requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse, type Plugin as StubPlugin } from "../support/obsidian-stub";

/**
 * mvp-06 task 4.3 at the plugin entry: the real dialogs (over the stub `Modal`), the real key session, the real
 * publish runner and the real `requestUrl` transport, with a fake node behind the stub. Only the platform is faked.
 */

const MANIFEST = { id: "ipfs-sync", version: "0.2.0" } as unknown as PluginManifest;
const ROOT = "/obsidian-vault-sync/mvp06-entry";

interface Loaded {
  readonly plugin: IpfsSyncPlugin;
  readonly stub: StubPlugin;
  readonly adapter: MemoryAdapter;
  readonly node: FakeNode;
  readonly tick: () => void;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** requestUrl answers from the fake node, so the plugin's real client talks to it. */
function serveNode(node: FakeNode): void {
  const serve = fakeNodeFetch(node, []);
  setRequestUrlHandler(async (params) => {
    const headers = { ...(params.headers ?? {}), ...(params.contentType === undefined ? {} : { "content-type": params.contentType }) };
    const response = await serve(params.url, { method: params.method, headers, body: params.body });
    return stubResponse(response.status, new Uint8Array(await response.arrayBuffer()), Object.fromEntries(response.headers.entries()));
  });
}

async function load(options: { readonly vault: boolean; readonly marker?: boolean }): Promise<Loaded> {
  const adapter = new MemoryAdapter();
  if (options.marker !== false) adapter.put(".ipfs-sync-fixture", "fixture\n");
  adapter.put("notes/hello.md", "hello", 1000);
  const node = createFakeNode();
  if (options.vault) await initVault(createObsidianHostBridge({ adapter }).fs, node, ROOT);
  serveNode(node);
  const setIntervalStub = vi.fn(() => 7);
  vi.stubGlobal("window", { setInterval: setIntervalStub, clearInterval: vi.fn() });
  const plugin = new IpfsSyncPlugin(new StubApp(adapter) as unknown as App, MANIFEST);
  const stub = plugin as unknown as StubPlugin;
  stub.data = { ...defaultSettings(), mfsRoot: ROOT, publishIntervalMinutes: 5 };
  await plugin.onload();
  const tick = (setIntervalStub.mock.calls[0] as unknown as [() => void])[0];
  return { plugin, stub, adapter, node, tick };
}

const notices = (fragment: string): number => Notice.shown.filter((notice) => notice.message.includes(fragment)).length;

function unlockDialog(): FakeEl {
  const dialog = Modal.instances.find((modal) => byId(modal.contentEl, "ipfs-sync-unlock-passphrase") !== undefined);
  if (dialog === undefined) throw new Error("no unlock dialog is open");
  return dialog.contentEl;
}

async function enterPassphrase(dialog: FakeEl, text: string): Promise<void> {
  const field = byId(dialog, "ipfs-sync-unlock-passphrase");
  if (field === undefined) throw new Error("no passphrase field");
  field.value = text;
  await field.dispatch("input");
  const button = dialog.find((el) => el.tag === "button" && el.text === "Unlock");
  if (button === undefined) throw new Error("no Unlock button");
  await button.dispatch("click");
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
});

describe("plugin entry: the timer while the vault is locked", () => {
  it("sends no request, opens no dialog, and shows one locked notice per session however often it ticks", async () => {
    const { plugin, tick } = await load({ vault: true });
    tick(); // the interval callback the plugin registered
    await until(() => notices("paused while the vault is locked") === 1, "the locked notice");
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "locked" });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "locked" });
    expect(requestUrlCalls).toEqual([]);
    expect(Modal.instances).toHaveLength(0);
    expect(notices("paused while the vault is locked")).toBe(1);
  });

  it("with no vault on the device: no request, no dialog, one notice, and nothing created", async () => {
    const { plugin, adapter } = await load({ vault: false });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "not-set-up" });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "not-set-up" });
    expect(requestUrlCalls).toEqual([]);
    expect(Modal.instances).toHaveLength(0);
    expect(notices("no encrypted vault is set up")).toBe(1);
    expect([...adapter.files.keys()].some((path) => path.startsWith(".ipfs-sync/keyslots"))).toBe(false);
  });

  it("an unmarked vault gives the review-pending notice once for the timer, before any session or request", async () => {
    const { plugin } = await load({ vault: true, marker: false });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(notices("not yet independently reviewed or verified in Obsidian")).toBe(1);
    expect(notices("locked")).toBe(0);
    expect(requestUrlCalls).toEqual([]);
    expect(Modal.instances).toHaveLength(0);
  });
});

describe("plugin entry: the unlock dialog, one prompt per session, no secret in the plugin data", () => {
  it("Publish opens the unlock dialog, publishes after the passphrase, and the timer then publishes without a dialog", async () => {
    const { stub, plugin, node } = await load({ vault: true });
    (stub.ribbonIcons[0] as { callback: (event: MouseEvent) => unknown }).callback({} as MouseEvent);
    await until(() => Modal.instances.length === 1, "the unlock dialog");
    expect(requestUrlCalls).toEqual([]); // the dialog derives nothing and sends nothing until a passphrase is entered

    await enterPassphrase(unlockDialog(), REFERENCE_TEXT);
    await until(() => notices("published:") === 1, "the publish notice");
    expect(node.calls.some((call) => call.startsWith("publish "))).toBe(true);
    expect(Modal.instances.filter((modal) => modal.opened)).toHaveLength(0);

    const asked = requestUrlCalls.length;
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "unchanged" });
    expect(Modal.instances).toHaveLength(1);
    expect(notices("locked")).toBe(0);
    expect(requestUrlCalls.length).toBeGreaterThan(asked); // an unlocked session lets the tick reach the node (idle check)

    const stored = JSON.stringify(stub.data);
    expect(stored).not.toContain(REFERENCE_TEXT);
    expect(stored).not.toContain(REFERENCE_TEXT.toLowerCase());
    for (const request of requestUrlCalls) expect(`${request.url}`).not.toContain(REFERENCE_TEXT);
  }, 30_000);

  it("cancelling the unlock dialog publishes nothing and asks the node for nothing", async () => {
    const { stub } = await load({ vault: true });
    (stub.ribbonIcons[0] as { callback: (event: MouseEvent) => unknown }).callback({} as MouseEvent);
    await until(() => Modal.instances.length === 1, "the unlock dialog");
    const cancel = unlockDialog().find((el) => el.tag === "button" && el.text === "Cancel");
    await cancel?.dispatch("click");
    await until(() => notices("not unlocked") === 1, "the cancelled notice");
    expect(requestUrlCalls).toEqual([]);
  });

  it("the settings tab shows the state and Lock returns the timer to refusing", async () => {
    const { stub, plugin } = await load({ vault: true });
    const tab = stub.settingTabs[0] as unknown as { display(): void; containerEl: FakeEl };
    tab.display();
    expect(tab.containerEl.textContent()).toContain("Locked.");

    (stub.ribbonIcons[0] as { callback: (event: MouseEvent) => unknown }).callback({} as MouseEvent);
    await until(() => Modal.instances.length === 1, "the unlock dialog");
    await enterPassphrase(unlockDialog(), REFERENCE_TEXT);
    await until(() => notices("published:") === 1, "the publish notice");
    tab.display();
    expect(tab.containerEl.textContent()).toContain("Unlocked.");

    const lock = tab.containerEl.find((el) => el.tag === "button" && el.text === "Lock now");
    await lock?.dispatch("click");
    expect(tab.containerEl.textContent()).toContain("Locked.");
    const before = requestUrlCalls.length;
    expect(await plugin.publishVault({ quiet: true })).toMatchObject({ kind: "refused", reason: "locked" });
    expect(requestUrlCalls.length).toBe(before);
    expect(notices("paused while the vault is locked")).toBe(1);
  }, 30_000);
});

describe("plugin entry: unload", () => {
  it("drops the key and closes an open dialog", async () => {
    const { stub, plugin } = await load({ vault: true });
    (stub.ribbonIcons[0] as { callback: (event: MouseEvent) => unknown }).callback({} as MouseEvent);
    await until(() => Modal.instances.length === 1, "the unlock dialog");
    plugin.onunload();
    expect(Modal.instances.filter((modal) => modal.opened)).toHaveLength(0);
  });
});
