import { describe, expect, it } from "vitest";
import { authHeaders } from "../../src/kubo/auth-headers";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, SETTINGS_VERSION, type PluginSettings } from "../../src/plugin/settings-model";
import { settingsToConfig, settingsToLayer, validateSettings } from "../../src/plugin/settings-to-config";
import { GATEWAY_AUTH_NOTICE } from "../../src/plugin/settings-tab-copy";
import { createSettingsViewModel } from "../../src/plugin/settings-view-model";
import { byId, focusOrder, referencedText } from "../support/fake-dom";
import { controlFor, memoryStore, NODE_KEYS, NOW, open, type } from "../support/settings-tab-rig";
import { testNodeSettings } from "../helpers/test-node-settings";

const NODE_TOKEN = "node-secret-token-1";
const GATEWAY_TOKEN = "gateway-secret-token-2";
const SAME_ORIGIN = { rpc: { url: "https://node.example:5001" }, gateway: { url: "https://node.example:5001/gateway" } } as const;
const OTHER_ORIGIN = { rpc: { url: "https://node.example:5001" }, gateway: { url: "https://node.example:8080" } } as const;

function withNode(patch: Partial<PluginSettings>): PluginSettings {
  return testNodeSettings({ auth: { scheme: "bearer", token: NODE_TOKEN }, ...patch });
}

const rpcHeaders = (settings: PluginSettings): Record<string, string> => ({ ...authHeaders(settingsToConfig(settings, NOW).rpc.auth) });
const gatewayHeaders = (settings: PluginSettings): Record<string, string> => ({ ...authHeaders(settingsToConfig(settings, NOW).gateway.auth) });

describe("plugin gateway authentication: resolution through settingsToConfig", () => {
  it("same origin and Same as node: the gateway request carries the node credential", () => {
    const settings = withNode({ ...SAME_ORIGIN });
    expect(gatewayHeaders(settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
  });

  it("different origin and Same as node: the gateway request carries no credential and the node token is in no gateway header", () => {
    const settings = withNode({ ...OTHER_ORIGIN });
    expect(gatewayHeaders(settings)).toEqual({});
    expect(JSON.stringify(gatewayHeaders(settings))).not.toContain(NODE_TOKEN);
    expect(rpcHeaders(settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
  });

  it("different origin and an explicit gateway bearer: the gateway gets that token only, the RPC gets the node credential only", () => {
    const settings = withNode({ ...OTHER_ORIGIN, gatewayAuth: { scheme: "bearer", token: GATEWAY_TOKEN } });
    expect(gatewayHeaders(settings)).toEqual({ Authorization: `Bearer ${GATEWAY_TOKEN}` });
    expect(rpcHeaders(settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
    expect(JSON.stringify(rpcHeaders(settings))).not.toContain(GATEWAY_TOKEN);
  });

  it("every explicit kind reaches the gateway endpoint only", () => {
    const kinds = [
      [{ scheme: "basic", user: "ann", password: "pw" }, { Authorization: `Basic ${btoa("ann:pw")}` }],
      [{ scheme: "header", headerName: "X-Api-Key", headerValue: "k-1" }, { "X-Api-Key": "k-1" }],
    ] as const;
    for (const [gatewayAuth, expected] of kinds) {
      const settings = withNode({ ...OTHER_ORIGIN, gatewayAuth });
      expect(gatewayHeaders(settings)).toEqual(expected);
      expect(rpcHeaders(settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
    }
  });

  it("explicit none wins over inheritance at matching origins", () => {
    const settings = withNode({ ...SAME_ORIGIN, gatewayAuth: { scheme: "none" } });
    expect(gatewayHeaders(settings)).toEqual({});
    expect(rpcHeaders(settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
  });

  it("settingsToLayer emits gateway.auth only for an explicit block, including none, and adds no origin rule of its own", () => {
    expect(settingsToLayer(withNode({ ...OTHER_ORIGIN })).gateway).not.toHaveProperty("auth");
    expect(settingsToLayer(withNode({ ...SAME_ORIGIN })).gateway).not.toHaveProperty("auth");
    expect(settingsToLayer(withNode({ ...SAME_ORIGIN, gatewayAuth: { scheme: "none" } })).gateway?.auth).toEqual({ scheme: "none" });
    expect(settingsToLayer(withNode({ ...OTHER_ORIGIN, gatewayAuth: { scheme: "bearer", token: GATEWAY_TOKEN } })).gateway?.auth).toEqual({
      scheme: "bearer",
      token: GATEWAY_TOKEN,
    });
  });

  it("warns, naming the gateway, about an expired gateway JWT, and flags an incomplete explicit block as a field error", () => {
    const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const expired = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(NOW.getTime() / 1000) - 3600 })}.sig`;
    const config = settingsToConfig(withNode({ ...OTHER_ORIGIN, gatewayAuth: { scheme: "bearer", token: expired } }), NOW);
    expect(config.warnings.join(" ")).toMatch(/gateway bearer token \(JWT\) expired/);
    const broken = validateSettings(withNode({ ...OTHER_ORIGIN, gatewayAuth: { scheme: "basic", user: "", password: "" } }), NOW);
    expect(broken.errors.map((e) => e.field)).toContain("gatewayAuth");
  });
});

describe("plugin gateway authentication: stored data", () => {
  it("keeps SETTINGS_VERSION at 3: the block is optional and absence means Same as node", () => {
    expect(SETTINGS_VERSION).toBe(3);
    expect(defaultSettings()).not.toHaveProperty("gatewayAuth");
  });

  it("a stored file with no gateway block loads as Same as node and the node credential is not copied", () => {
    const stored = { ...withNode({ ...OTHER_ORIGIN }), version: 3 };
    const result = loadSettings(JSON.parse(JSON.stringify(stored)));
    expect(result.outcome).toBe("current");
    expect(result.notices).toEqual([]);
    expect(result.persist).toBe(false);
    expect(result.settings).not.toHaveProperty("gatewayAuth");
    expect(result.settings.auth).toEqual({ scheme: "bearer", token: NODE_TOKEN });
    expect(JSON.stringify(settingsToLayer(result.settings).gateway)).not.toContain(NODE_TOKEN);
    expect(gatewayHeaders(result.settings)).toEqual({});
  });

  it("old data at matching origins behaves as after the origin change: the gateway inherits", () => {
    const result = loadSettings(JSON.parse(JSON.stringify({ ...withNode({ ...SAME_ORIGIN }), version: 3 })));
    expect(gatewayHeaders(result.settings)).toEqual({ Authorization: `Bearer ${NODE_TOKEN}` });
  });

  it("the previous plugin's form and version 2 load with no gateway block", () => {
    const legacy = loadSettings({ rpcUrl: "https://node.example:5001", authToken: NODE_TOKEN });
    expect(legacy.outcome).toBe("migrated");
    expect(legacy.settings).not.toHaveProperty("gatewayAuth");
    const v2 = loadSettings(JSON.parse(JSON.stringify({ ...withNode({ ...OTHER_ORIGIN }), version: 2 })));
    expect(v2.outcome).toBe("upgraded");
    expect(v2.settings).not.toHaveProperty("gatewayAuth");
  });

  it("round trips an explicit block, including none, and leaves the node block unchanged", async () => {
    for (const gatewayAuth of [
      { scheme: "bearer", token: GATEWAY_TOKEN },
      { scheme: "basic", user: "ann", password: "pw" },
      { scheme: "header", headerName: "X-Api-Key", headerValue: "k-1" },
      { scheme: "none" },
    ] as const) {
      const store = memoryStore(withNode({ ...OTHER_ORIGIN }));
      await store.update((s) => ({ ...s, gatewayAuth }));
      const reloaded = loadSettings(JSON.parse(JSON.stringify(store.get())));
      expect(reloaded.outcome).toBe("current");
      expect(reloaded.settings.gatewayAuth).toEqual(gatewayAuth);
      expect(reloaded.settings.auth).toEqual({ scheme: "bearer", token: NODE_TOKEN });
      expect(reloaded.settings).toEqual(store.get());
    }
  });

  it("a malformed gateway block makes the data unreadable and leaves it untouched, like a malformed node block", () => {
    for (const gatewayAuth of [{ scheme: "bearer" }, { scheme: "ftp" }, "bearer", null]) {
      const result = loadSettings(JSON.parse(JSON.stringify({ ...withNode({ ...OTHER_ORIGIN }), version: 3, gatewayAuth })));
      expect(result.outcome).toBe("unreadable");
      expect(result.persist).toBe(false);
    }
  });
});

describe("plugin gateway authentication: view model", () => {
  const modelFor = (patch: Partial<PluginSettings>) => {
    const store = memoryStore(withNode(patch));
    return { store, vm: createSettingsViewModel({ store, now: () => NOW, listNodeKeys: async () => NODE_KEYS }) };
  };

  it("shows the origin line only when the origins differ, a node credential is set and the block is Same as node", async () => {
    const { vm, store } = modelFor({ ...OTHER_ORIGIN });
    expect(vm.state().gatewayAuthNotice).toBe(GATEWAY_AUTH_NOTICE);
    expect(vm.state().values.gatewayAuthScheme).toBe("same");

    await store.update((s) => ({ ...s, gateway: { url: "https://node.example:5001/gateway" } }));
    expect(vm.state().gatewayAuthNotice).toBe("");

    await store.update((s) => ({ ...s, gateway: OTHER_ORIGIN.gateway }));
    expect(vm.state().gatewayAuthNotice).toBe(GATEWAY_AUTH_NOTICE);

    await store.update((s) => ({ ...s, auth: { scheme: "none" } }));
    expect(vm.state().gatewayAuthNotice).toBe("");

    await store.update((s) => ({ ...s, auth: { scheme: "bearer", token: NODE_TOKEN }, gatewayAuth: { scheme: "none" } }));
    expect(vm.state().gatewayAuthNotice).toBe("");
  });

  it("hides the line while a node URL is unset or invalid, and the line holds no secret", () => {
    expect(modelFor({ rpc: { url: "" }, gateway: OTHER_ORIGIN.gateway }).vm.state().gatewayAuthNotice).toBe("");
    expect(modelFor({ ...OTHER_ORIGIN, gateway: { url: "ftp://nope" } }).vm.state().gatewayAuthNotice).toBe("");
    expect(GATEWAY_AUTH_NOTICE).toBe(
      "The node credential is not sent to the gateway because its address differs. Set a gateway credential below if it needs one.",
    );
    expect(GATEWAY_AUTH_NOTICE).not.toContain(NODE_TOKEN);
  });

  it("saves a complete explicit block, holds an incomplete one back, and returns to Same as node by removing the block", async () => {
    const { vm, store } = modelFor({ ...OTHER_ORIGIN });
    let result = await vm.edit("gatewayAuthScheme", "bearer");
    expect(result.saved).toBe(false);
    expect(result.state.gatewayAuthPending).toBe(true);
    expect(store.get()).not.toHaveProperty("gatewayAuth");
    result = await vm.edit("gatewayAuthToken", GATEWAY_TOKEN);
    expect(result.saved).toBe(true);
    expect(store.get().gatewayAuth).toEqual({ scheme: "bearer", token: GATEWAY_TOKEN });
    expect(store.get().auth).toEqual({ scheme: "bearer", token: NODE_TOKEN });
    expect(result.state.gatewayAuthNotice).toBe("");
    expect(vm.visibleGatewayAuthFields()).toEqual(["gatewayAuthToken"]);

    result = await vm.edit("gatewayAuthScheme", "none");
    expect(store.get().gatewayAuth).toEqual({ scheme: "none" });
    result = await vm.edit("gatewayAuthScheme", "same");
    expect(store.get()).not.toHaveProperty("gatewayAuth");
    expect(result.state.gatewayAuthNotice).toBe(GATEWAY_AUTH_NOTICE);
    expect(vm.visibleGatewayAuthFields()).toEqual([]);
  });

  it("refuses an unknown gateway scheme text", async () => {
    const { vm, store } = modelFor({ ...OTHER_ORIGIN });
    const result = await vm.edit("gatewayAuthScheme", "kerberos");
    expect(result.saved).toBe(false);
    expect(store.get()).not.toHaveProperty("gatewayAuth");
  });
});

describe("plugin gateway authentication: settings tab", () => {
  it("puts the control under the gateway port, defaulting to Same as node, in keyboard order", async () => {
    const { root } = await open(withNode({ ...OTHER_ORIGIN }));
    const select = controlFor(root, "Gateway authentication");
    expect(select.value).toBe("same");
    const labels = focusOrder(root).map((el) => el.getAttr("aria-labelledby"));
    const names = focusOrder(root).map((el) => referencedText(root, el.getAttr("aria-labelledby")));
    expect(labels.length).toBeGreaterThan(0);
    const at = names.indexOf("Gateway authentication");
    expect(names[at - 1]).toBe("Gateway port");
    expect(names[at + 1]).toBe("Publication key name");
  });

  it("offers Same as node, None, Basic, Bearer and Custom header, and shows only the fields of the selected kind", async () => {
    const { root } = await open(withNode({ ...OTHER_ORIGIN }));
    const select = controlFor(root, "Gateway authentication");
    expect(select.children.map((o) => o.value)).toEqual(["same", "none", "basic", "bearer", "header"]);
    expect(select.children[0]?.text).toBe("Same as node");
    const gatewayLabels = (): string[] =>
      focusOrder(root)
        .map((el) => referencedText(root, el.getAttr("aria-labelledby")))
        .filter((name) => name.startsWith("Gateway ") && !["Gateway URL", "Gateway port", "Gateway authentication"].includes(name));
    expect(gatewayLabels()).toEqual([]);
    await type(root, "Gateway authentication", "basic");
    expect(gatewayLabels()).toEqual(["Gateway user", "Gateway password"]);
    await type(root, "Gateway authentication", "bearer");
    expect(gatewayLabels()).toEqual(["Gateway bearer token"]);
    await type(root, "Gateway authentication", "header");
    expect(gatewayLabels()).toEqual(["Gateway header name", "Gateway header value"]);
    expect(controlFor(root, "Gateway authentication")).toBe(select);
  });

  it("masks the gateway secrets and points them at a plain-text warning shown beside them", async () => {
    const { root } = await open(withNode({ ...OTHER_ORIGIN }));
    for (const [scheme, label] of [["basic", "Gateway password"], ["bearer", "Gateway bearer token"], ["header", "Gateway header value"]] as const) {
      await type(root, "Gateway authentication", scheme);
      const secret = controlFor(root, label);
      expect(secret.type).toBe("password");
      expect(referencedText(root, secret.getAttr("aria-describedby"))).toContain("unencrypted");
    }
    const note = byId(root, "ipfs-sync-secrets-warning-gateway");
    expect(note?.textContent()).toContain("Secrets are stored in plain text");
    await type(root, "Gateway authentication", "none");
    expect(byId(root, "ipfs-sync-secrets-warning-gateway")).toBeUndefined();
  });

  it("shows the origin line as text while it applies, ties it to the control, and removes it when the block is set", async () => {
    const { root, store } = await open(withNode({ ...OTHER_ORIGIN }));
    const line = byId(root, "ipfs-sync-gateway-auth-notice");
    expect(line?.textContent()).toBe(GATEWAY_AUTH_NOTICE);
    expect(controlFor(root, "Gateway authentication").getAttr("aria-describedby")).toContain("ipfs-sync-gateway-auth-notice");

    await type(root, "Gateway authentication", "bearer");
    await type(root, "Gateway bearer token", GATEWAY_TOKEN);
    expect(store.get().gatewayAuth).toEqual({ scheme: "bearer", token: GATEWAY_TOKEN });
    expect(byId(root, "ipfs-sync-gateway-auth-notice")?.textContent()).toBe("");

    await type(root, "Gateway authentication", "same");
    expect(byId(root, "ipfs-sync-gateway-auth-notice")?.textContent()).toBe(GATEWAY_AUTH_NOTICE);
  });

  it("never prints the saved gateway secret in any text of the tab, its status lines or a configuration error", async () => {
    const { root, store } = await open(withNode({ ...OTHER_ORIGIN, gatewayAuth: { scheme: "bearer", token: GATEWAY_TOKEN } }));
    expect(root.textContent()).not.toContain(GATEWAY_TOKEN);
    expect(root.textContent()).not.toContain(NODE_TOKEN);
    await type(root, "Gateway URL", "ftp://gw.example.org");
    expect(root.textContent()).not.toContain(GATEWAY_TOKEN);
    expect(store.get().gatewayAuth).toEqual({ scheme: "bearer", token: GATEWAY_TOKEN });
    let message = "";
    try {
      settingsToConfig(withNode({ gateway: { url: "ftp://gw.example.org" }, gatewayAuth: { scheme: "bearer", token: GATEWAY_TOKEN } }), NOW);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(GATEWAY_TOKEN);
    expect(message).not.toContain(NODE_TOKEN);
  });
});
