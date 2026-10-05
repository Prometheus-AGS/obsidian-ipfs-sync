import type { App as ObsidianApp, Plugin as ObsidianPlugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { IpfsSyncSettingTab } from "../../src/plugin/settings-tab";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { validateSettings } from "../../src/plugin/settings-to-config";
import { testNodeSettings } from "../helpers/test-node-settings";
import { byId, type FakeEl } from "../support/fake-dom";
import { App, Plugin } from "../support/obsidian-stub";
import { controlFor, flush, memoryStore, NODE_KEYS, NOW, type } from "../support/settings-tab-rig";

/** Round 3 review, P-M1 and P-M5: a typed host never receives the credential saved for the old one; the interval stays inside what a timer can hold. */

const SECRET = "tok-old-node-secret";
const GATEWAY_SECRET = "tok-old-gateway-secret";

function vmRig(patch = {}) {
  const store = memoryStore(testNodeSettings({ auth: { scheme: "bearer", token: SECRET }, gatewayAuth: { scheme: "bearer", token: GATEWAY_SECRET }, ...patch }));
  const listNodeKeys = vi.fn(async () => NODE_KEYS);
  const vm = createSettingsViewModel({ store, now: () => NOW, listNodeKeys });
  return { store, vm, listNodeKeys };
}

describe("P-M1: a changed origin clears the credential saved for the old one", () => {
  it("blanks the node credential when the RPC origin changes, says so, and sends no request", async () => {
    const { store, vm, listNodeKeys } = vmRig();
    const result = await vm.edit("rpcUrl", "https://other.test");
    expect(result.saved).toBe(true);
    expect(store.get().rpc.url).toBe("https://other.test");
    expect(store.get().auth).toEqual({ scheme: "none" });
    expect(result.state.values.authScheme).toBe("none");
    expect(result.state.values.authToken).toBe("");
    expect(result.state.rpcCredentialNotice).toMatch(/^The node credential was cleared/);
    expect(JSON.stringify(result.state)).not.toContain(SECRET);
    expect(store.get().gatewayAuth).toEqual({ scheme: "bearer", token: GATEWAY_SECRET });
    expect(listNodeKeys).not.toHaveBeenCalled();
  });

  it("blanks the node credential when only the RPC port changes the origin", async () => {
    const { store, vm } = vmRig();
    const result = await vm.edit("rpcPort", "5001");
    expect(result.saved).toBe(true);
    expect(store.get().auth).toEqual({ scheme: "none" });
    expect(result.state.rpcCredentialNotice).not.toBe("");
  });

  it("keeps the credential when only the path changes", async () => {
    const { store, vm } = vmRig();
    const result = await vm.edit("rpcUrl", "https://node.test/api/v0");
    expect(result.saved).toBe(true);
    expect(store.get().auth).toEqual({ scheme: "bearer", token: SECRET });
    expect(result.state.rpcCredentialNotice).toBe("");
  });

  it("blanks the gateway credential, and only it, when the gateway origin changes", async () => {
    const { store, vm } = vmRig();
    const result = await vm.edit("gatewayUrl", "https://gw-other.test");
    expect(result.saved).toBe(true);
    expect(store.get().gatewayAuth).toBeUndefined();
    expect(result.state.values.gatewayAuthScheme).toBe("same");
    expect(result.state.values.gatewayAuthToken).toBe("");
    expect(result.state.gatewayCredentialNotice).toMatch(/^The gateway credential was cleared/);
    expect(store.get().auth).toEqual({ scheme: "bearer", token: SECRET });
    expect(result.state.rpcCredentialNotice).toBe("");
  });

  it("keeps the gateway credential when only the gateway path changes", async () => {
    const { store, vm } = vmRig();
    await vm.edit("gatewayUrl", "https://gw.test/ipfs-gateway");
    expect(store.get().gatewayAuth).toEqual({ scheme: "bearer", token: GATEWAY_SECRET });
  });

  it("forgets the notice on reset", async () => {
    const { vm } = vmRig();
    await vm.edit("rpcUrl", "https://other.test");
    expect(vm.reset().rpcCredentialNotice).toBe("");
  });
});

async function tabRig() {
  const { store, vm, listNodeKeys } = vmRig();
  const app = new App();
  const tab = new IpfsSyncSettingTab(app as unknown as ObsidianApp, new Plugin(app) as unknown as ObsidianPlugin, vm);
  tab.display();
  const root = (tab as unknown as { containerEl: FakeEl }).containerEl;
  await flush();
  return { store, vm, listNodeKeys, tab, root };
}

describe("P-M1: the tab", () => {
  it("issues no key list request on a URL, port or credential edit, and shows the clearing line", async () => {
    const { root, listNodeKeys, store } = await tabRig();
    const opened = listNodeKeys.mock.calls.length;
    await type(root, "Bearer token", "tok-new");
    expect(store.get().auth).toEqual({ scheme: "bearer", token: "tok-new" });
    await type(root, "RPC URL", "https://other.test");
    await type(root, "RPC port", "5002");
    await type(root, "Gateway URL", "https://gw-other.test");
    expect(listNodeKeys.mock.calls.length).toBe(opened);
    expect(store.get().auth).toEqual({ scheme: "none" });
    expect(root.textContent()).toContain("The gateway credential was cleared");
    expect(root.textContent()).not.toContain(GATEWAY_SECRET);
  });

  it("resets the pickers to what the cleared credential is", async () => {
    const { root } = await tabRig();
    await type(root, "RPC URL", "https://other.test");
    expect(controlFor(root, "Authentication scheme").value).toBe("none");
    expect(root.textContent()).toContain("The node credential was cleared");
    expect(byId(root, "ipfs-sync-rpc-credential-notice")?.textContent()).toContain("cleared");
  });

  it("asks the node again only from Check again", async () => {
    const { root, listNodeKeys } = await tabRig();
    await type(root, "RPC URL", "https://other.test");
    const before = listNodeKeys.mock.calls.length;
    const button = controlFor(root, "Check again: ask the node about the publication key");
    await button.dispatch("click");
    await flush();
    expect(listNodeKeys.mock.calls.length).toBe(before + 1);
  });

  it("empties the tab on hide so a password input does not keep a secret in detached DOM", async () => {
    const { tab, root } = await tabRig();
    expect(root.children.length).toBeGreaterThan(0);
    tab.hide();
    expect(root.children.length).toBe(0);
  });
});

describe("P-M5: the auto-publish interval cap", () => {
  it("rejects an interval a timer cannot hold, and names the cap", () => {
    const settings = testNodeSettings({ publishIntervalMinutes: 35_001 });
    const errors = validateSettings(settings, NOW).errors.filter((e) => e.field === "publishIntervalMinutes");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("35000");
  });

  it("accepts the cap itself", () => {
    const settings = testNodeSettings({ publishIntervalMinutes: 35_000 });
    expect(validateSettings(settings, NOW).errors.filter((e) => e.field === "publishIntervalMinutes")).toEqual([]);
  });

  it("does not save a typed interval over the cap and shows the message", async () => {
    const { store, vm } = vmRig();
    const result = await vm.edit("publishIntervalMinutes", "999999");
    expect(result.saved).toBe(false);
    expect(result.state.errors.publishIntervalMinutes).toContain("35000");
    expect(store.get().publishIntervalMinutes).toBe(0);
  });
});
