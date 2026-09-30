import { describe, expect, it, vi } from "vitest";
import type { NodeKey } from "../../src/kubo";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore, type SettingsStore } from "../../src/plugin/settings-store";
import { ADOPT_CONSEQUENCES, createSettingsViewModel, type SettingsViewModel } from "../../src/plugin/settings-view-model";
import { effectiveExclusions, excludesHash } from "../../src/sync/exclusions";

const NOW = new Date("2026-09-30T12:00:00Z");
const KEY_ID = "k51qzi5uqu5dhmnyfxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function memoryStore(patch: Partial<PluginSettings> = {}, failSave = false): SettingsStore {
  let saved: unknown = null;
  return createSettingsStore(
    {
      loadData: async () => saved,
      saveData: async (next) => {
        if (failSave) throw new Error("disk full");
        saved = structuredClone(next);
      },
    },
    { settings: { ...defaultSettings(), ...patch }, outcome: "current", notices: [], persist: false },
  );
}

interface Rig {
  readonly vm: SettingsViewModel;
  readonly store: SettingsStore;
  readonly saved: PluginSettings[];
}

function rig(options: { nodeKeys?: readonly NodeKey[] | Error; patch?: Partial<PluginSettings>; failSave?: boolean } = {}): Rig {
  const store = memoryStore(options.patch, options.failSave);
  const saved: PluginSettings[] = [];
  const nodeKeys = options.nodeKeys ?? [];
  const vm = createSettingsViewModel({
    store,
    now: () => NOW,
    listNodeKeys: async () => {
      if (nodeKeys instanceof Error) throw nodeKeys;
      return nodeKeys;
    },
    onSaved: (settings) => void saved.push(settings),
  });
  return { vm, store, saved };
}

function jwt(exp: number): string {
  const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ exp })}.sig`;
}

describe("settings view model: fields and inline errors", () => {
  it("starts with the stored values as text", () => {
    const r = rig({ patch: { rpc: { url: "https://rpc.example.org", port: 5001 } } });
    expect(r.vm.state().values).toMatchObject({ rpcUrl: "https://rpc.example.org", rpcPort: "5001", mfsRoot: "/obsidian-vault-sync/default", authScheme: "none" });
    expect(r.vm.state().errors).toEqual({});
  });

  it("saves a valid edit and tells the plugin", async () => {
    const r = rig();
    const result = await r.vm.edit("mfsRoot", "/obsidian-vault-sync/work");
    expect(result.saved).toBe(true);
    expect(r.store.get().mfsRoot).toBe("/obsidian-vault-sync/work");
    expect(r.saved).toHaveLength(1);
  });

  it("keeps the stored value and shows an inline error for a foreign MFS root", async () => {
    const r = rig();
    const result = await r.vm.edit("mfsRoot", "/obsidian-vault-staging");
    expect(result.saved).toBe(false);
    expect(result.state.errors.mfsRoot).toContain("/obsidian-vault-sync");
    expect(result.state.values.mfsRoot).toBe("/obsidian-vault-staging");
    expect(r.store.get().mfsRoot).toBe("/obsidian-vault-sync/default");
    expect(r.saved).toEqual([]);
    // A later valid edit clears the error.
    const fixed = await r.vm.edit("mfsRoot", "/obsidian-vault-sync/ok");
    expect(fixed.state.errors.mfsRoot).toBeUndefined();
  });

  it("refuses another project's key name and keeps the previous key", async () => {
    const r = rig();
    const result = await r.vm.edit("publicationKey", "consult-capture");
    expect(result.saved).toBe(false);
    expect(result.state.errors.publicationKey).toContain("another project");
    expect(r.store.get().publicationKey).toBe("obsidian-vault-sync");
  });

  it("names both ports when the URL and the port field disagree", async () => {
    const r = rig();
    expect((await r.vm.edit("rpcUrl", "https://rpc.example.org:5001")).saved).toBe(true);
    const result = await r.vm.edit("rpcPort", "5002");
    expect(result.saved).toBe(false);
    expect(result.state.errors.rpcPort).toMatch(/5001.*5002|5002.*5001/);
    expect(r.store.get().rpc.port).toBeUndefined();
  });

  it("rejects a non-numeric port and a bad interval without saving", async () => {
    const r = rig();
    expect((await r.vm.edit("gatewayPort", "eighty")).state.errors.gatewayPort).toBeDefined();
    expect((await r.vm.edit("publishIntervalMinutes", "1.5")).state.errors.publishIntervalMinutes).toBeDefined();
    expect(r.saved).toEqual([]);
  });

  it("keeps RPC and gateway independent", async () => {
    const r = rig();
    await r.vm.edit("rpcUrl", "https://rpc.example.org");
    await r.vm.edit("rpcPort", "5001");
    await r.vm.edit("gatewayUrl", "https://gw.example.org");
    await r.vm.edit("gatewayPort", "8080");
    expect(r.store.get().rpc).toEqual({ url: "https://rpc.example.org", port: 5001 });
    expect(r.store.get().gateway).toEqual({ url: "https://gw.example.org", port: 8080 });
  });

  it("does not let an error elsewhere block an unrelated edit, and keeps changes made meanwhile", async () => {
    const r = rig({ patch: { gateway: { url: "not a url" } } });
    await r.store.update((s) => ({ ...s, ownedKeys: ["k51added"] }));
    expect((await r.vm.edit("publishIntervalMinutes", "15")).saved).toBe(true);
    expect(r.store.get().ownedKeys).toEqual(["k51added"]);
    expect(r.store.get().publishIntervalMinutes).toBe(15);
  });

  it("drops unsaved edits on reset", async () => {
    const r = rig();
    await r.vm.edit("mfsRoot", "/nope");
    const state = r.vm.reset();
    expect(state.values.mfsRoot).toBe("/obsidian-vault-sync/default");
    expect(state.errors).toEqual({});
  });
});

describe("settings view model: authentication", () => {
  it("shows only the fields of the selected scheme and swaps them on a scheme switch", async () => {
    const r = rig({ patch: { auth: { scheme: "bearer", token: "tok" } } });
    expect(r.vm.visibleAuthFields()).toEqual(["authToken"]);
    const result = await r.vm.edit("authScheme", "basic");
    expect(r.vm.visibleAuthFields()).toEqual(["authUser", "authPassword"]);
    // Nothing usable yet: the stored bearer auth stays, and no error is shown for fields the user has not filled.
    expect(result).toMatchObject({ saved: false, state: { authPending: true, errors: {} } });
    expect(r.store.get().auth).toEqual({ scheme: "bearer", token: "tok" });

    await r.vm.edit("authUser", "alice");
    expect(r.store.get().auth.scheme).toBe("bearer");
    const done = await r.vm.edit("authPassword", "pw");
    expect(done.saved).toBe(true);
    expect(done.state.authPending).toBe(false);
    expect(r.store.get().auth).toEqual({ scheme: "basic", user: "alice", password: "pw" });
  });

  it("saves scheme none at once and offers custom header fields", async () => {
    const r = rig({ patch: { auth: { scheme: "bearer", token: "tok" } } });
    expect((await r.vm.edit("authScheme", "none")).saved).toBe(true);
    expect(r.store.get().auth).toEqual({ scheme: "none" });
    await r.vm.edit("authScheme", "header");
    expect(r.vm.visibleAuthFields()).toEqual(["authHeaderName", "authHeaderValue"]);
  });

  it("ignores an unknown scheme", async () => {
    const r = rig();
    expect((await r.vm.edit("authScheme", "kerberos")).saved).toBe(false);
    expect(r.vm.state().values.authScheme).toBe("none");
  });

  it("saves an expired JWT with a warning that names the expiry", async () => {
    const r = rig({ patch: { auth: { scheme: "bearer", token: "x" } } });
    const expiry = Math.floor(NOW.getTime() / 1000) - 60;
    const result = await r.vm.edit("authToken", jwt(expiry));
    expect(result.saved).toBe(true);
    expect(result.state.warnings.join(" ")).toContain(new Date(expiry * 1000).toISOString());
  });

  it("never puts a secret into an error", async () => {
    const r = rig({ patch: { auth: { scheme: "header", headerName: "X-Key", headerValue: "old" } } });
    await r.vm.edit("authHeaderName", "bad name");
    const secret = "hv-secret-77";
    const result = await r.vm.edit("authHeaderValue", secret);
    expect(result.saved).toBe(false);
    expect(result.state.errors.auth).toBeDefined();
    expect(JSON.stringify(result.state.errors)).not.toContain(secret);
    expect(result.state.warnings.join(" ")).not.toContain(secret);

    const basic = rig();
    await basic.vm.edit("authScheme", "basic");
    await basic.vm.edit("authUser", "a:b");
    const failure = await basic.vm.edit("authPassword", "pw-secret-88");
    expect(failure.state.errors.auth).toBeDefined();
    expect(JSON.stringify(failure.state.errors)).not.toContain("pw-secret-88");
  });
});

describe("settings view model: exclusions", () => {
  it("shows the effective list and a hash that changes when an entry is added", async () => {
    const r = rig();
    const before = await r.vm.exclusions();
    expect(before.effective).toEqual(effectiveExclusions());
    expect(before.excludesHash).toBe(await excludesHash());
    expect(before.effective).toContain(".obsidian/plugins/ipfs-sync/data.json");

    expect(await r.vm.addExclusion(" drafts/ ")).toEqual({ ok: true });
    const after = await r.vm.exclusions();
    expect(after.user).toEqual(["drafts/"]);
    expect(after.effective).toContain("drafts/");
    expect(after.excludesHash).not.toBe(before.excludesHash);
    expect(after.excludesHash).toBe(await excludesHash(["drafts/"]));
    expect(r.saved).toHaveLength(1);
  });

  it("keeps the defaults: removing one is refused with an explanation", async () => {
    const r = rig();
    const result = await r.vm.removeExclusion(".trash/");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("default");
    expect((await r.vm.exclusions()).effective).toContain(".trash/");
  });

  it("removes an addition, and refuses empty, duplicate and unknown entries", async () => {
    const r = rig({ patch: { userExclusions: ["private/"] } });
    expect((await r.vm.addExclusion("  ")).ok).toBe(false);
    expect((await r.vm.addExclusion("private/")).ok).toBe(false);
    expect((await r.vm.addExclusion(".trash/")).ok).toBe(false);
    expect((await r.vm.removeExclusion("missing/")).ok).toBe(false);
    expect((await r.vm.removeExclusion("private/")).ok).toBe(true);
    expect((await r.vm.exclusions()).user).toEqual([]);
  });
});

describe("settings view model: owned keys", () => {
  const keys: readonly NodeKey[] = [
    { name: "obsidian-vault-sync", id: "k51mine00000000" },
    { name: "obsidian-vault-work", id: KEY_ID },
    { name: "prince-live", id: "k51prince0000000" },
    { name: "self", id: "12D3KooWselfselfself" },
  ];

  it("reports absent, owned and foreign for the publication key", async () => {
    expect((await rig({ nodeKeys: [] }).vm.keys.keyState()).state).toBe("absent");
    expect(await rig({ nodeKeys: keys }).vm.keys.keyState()).toMatchObject({ state: "foreign", ownedKeyIds: [] });
    const owned = await rig({ nodeKeys: keys, patch: { ownedKeys: ["k51mine00000000"] } }).vm.keys.keyState();
    expect(owned).toMatchObject({ state: "owned", ownedKeyIds: ["k51mine00000000"] });
  });

  it("reports unknown, without a secret, when the node cannot be asked", async () => {
    const view = await rig({ nodeKeys: new Error("cannot reach the rpc endpoint https://node.example.org") }).vm.keys.keyState();
    expect(view.state).toBe("unknown");
    expect(view.detail).toContain("https://node.example.org");
  });

  it("records nothing until the operator confirms, and states the consequences", async () => {
    const r = rig({ nodeKeys: keys });
    const submitted = await r.vm.keys.submit(` ${KEY_ID} `);
    expect(submitted).toEqual({ step: "confirming", keyId: KEY_ID, keyName: "obsidian-vault-work" });
    expect(r.store.get().ownedKeys).toEqual([]);
    expect(ADOPT_CONSEQUENCES.join(" ")).toMatch(/replace whatever pointer/);
    expect(ADOPT_CONSEQUENCES.join(" ")).toMatch(/Other projects/);
    expect(ADOPT_CONSEQUENCES.join(" ")).toMatch(/cannot undo/);

    const recorded = await r.vm.keys.confirm();
    expect(recorded).toEqual({ step: "recorded", keyId: KEY_ID, keyName: "obsidian-vault-work" });
    expect(r.store.get().ownedKeys).toEqual([KEY_ID]);
  });

  it("leaves the owned list unchanged when the dialog is cancelled", async () => {
    const r = rig({ nodeKeys: keys });
    await r.vm.keys.submit(KEY_ID);
    expect(r.vm.keys.cancel()).toEqual({ step: "idle" });
    expect(await r.vm.keys.confirm()).toEqual({ step: "idle" });
    expect(r.store.get().ownedKeys).toEqual([]);
  });

  it("refuses a key whose name is not an allowed project key name", async () => {
    const r = rig({ nodeKeys: keys });
    for (const id of ["k51prince0000000", "12D3KooWselfselfself"]) {
      const state = await r.vm.keys.submit(id);
      expect(state.step).toBe("refused");
      expect(state).toMatchObject({ reason: expect.stringContaining("cannot be adopted") });
      expect(await r.vm.keys.confirm()).toEqual(state);
    }
    expect((await r.vm.keys.submit("k51prince0000000")) as { reason: string }).toMatchObject({ reason: expect.stringContaining("another project") });
    expect(r.store.get().ownedKeys).toEqual([]);
  });

  it("refuses unknown, malformed and already-owned IDs, and an unreachable node", async () => {
    const r = rig({ nodeKeys: keys, patch: { ownedKeys: ["k51mine00000000"] } });
    expect((await r.vm.keys.submit("k51doesnotexist00")).step).toBe("refused");
    expect((await r.vm.keys.submit("has space")).step).toBe("refused");
    expect((await r.vm.keys.submit("")).step).toBe("refused");
    expect((await r.vm.keys.submit("k51mine00000000")).step).toBe("refused");
    const down = rig({ nodeKeys: new Error("cannot reach the rpc endpoint") });
    expect((await down.vm.keys.submit(KEY_ID)).step).toBe("refused");
  });

  it("does not report success when the ID cannot be saved", async () => {
    const r = rig({ nodeKeys: keys, failSave: true });
    await r.vm.keys.submit(KEY_ID);
    const outcome = await r.vm.keys.confirm();
    expect(outcome.step).toBe("refused");
    expect(r.store.get().ownedKeys).toEqual([]);
  });

  it("notifies the plugin when the onSaved callback is provided", async () => {
    const onSaved = vi.fn();
    const vm = createSettingsViewModel({ store: memoryStore(), listNodeKeys: async () => [], onSaved, now: () => NOW });
    await vm.edit("publishIntervalMinutes", "5");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
