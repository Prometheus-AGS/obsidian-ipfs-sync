import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_MFS_ROOT, DEFAULT_PUBLICATION_KEY } from "../../src/core/config";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { settingsToConfig, validateSettings } from "../../src/plugin/settings-to-config";

const NOW = new Date("2026-09-30T12:00:00Z");

const OLD_DEFAULT_EXCLUDES = [
  ".trash/",
  ".ipfs-sync/",
  ".DS_Store",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".obsidian/workspace.json.bak",
  ".obsidian/graph.json",
  ".obsidian/cache",
];

function oldData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rpcUrl: "https://node.example.org",
    keyName: "obsidian-vault",
    authToken: "",
    excludedPaths: OLD_DEFAULT_EXCLUDES.join("\n"),
    publishIntervalMinutes: 15,
    ...overrides,
  };
}

function withSettings(patch: Partial<PluginSettings>): PluginSettings {
  return { ...defaultSettings(), ...patch };
}

function jwt(exp: number): string {
  const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ exp })}.sig`;
}

describe("settings migration", () => {
  it("maps the old default key to the new project key without a notice", () => {
    const result = loadSettings(oldData());
    expect(result.outcome).toBe("migrated");
    expect(result.settings.publicationKey).toBe(DEFAULT_PUBLICATION_KEY);
    expect(result.notices).toEqual([]);
    expect(result.persist).toBe(true);
  });

  it("keeps a custom project key", () => {
    const result = loadSettings(oldData({ keyName: "obsidian-vault-work" }));
    expect(result.settings.publicationKey).toBe("obsidian-vault-work");
    expect(result.notices).toEqual([]);
  });

  it("replaces another project's key and explains why", () => {
    const result = loadSettings(oldData({ keyName: "consult-capture" }));
    expect(result.settings.publicationKey).toBe(DEFAULT_PUBLICATION_KEY);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("consult-capture");
    expect(result.notices[0]).toContain("another project");
  });

  it("replaces a key name outside the project pattern", () => {
    const result = loadSettings(oldData({ keyName: "my-notes" }));
    expect(result.settings.publicationKey).toBe(DEFAULT_PUBLICATION_KEY);
    expect(result.notices[0]).toContain("my-notes");
  });

  it("turns a token into bearer auth and does not keep the old field", () => {
    const result = loadSettings(oldData({ authToken: " abc " }));
    expect(result.settings.auth).toEqual({ scheme: "bearer", token: "abc" });
    expect(JSON.stringify(result.settings)).not.toContain("authToken");
  });

  it("gives scheme none for an empty token", () => {
    expect(loadSettings(oldData({ authToken: "" })).settings.auth).toEqual({ scheme: "none" });
  });

  it("keeps the RPC url, starts the gateway equal to it, and uses the default MFS root", () => {
    const { settings } = loadSettings(oldData({ rpcUrl: "https://node.example.org/" }));
    expect(settings.rpc).toEqual({ url: "https://node.example.org" });
    expect(settings.gateway).toEqual({ url: "https://node.example.org" });
    expect(settings.mfsRoot).toBe(DEFAULT_MFS_ROOT);
    expect(settings.publishIntervalMinutes).toBe(15);
  });

  it("makes only lines that are not default exclusions user exclusions", () => {
    const { settings } = loadSettings(oldData({ excludedPaths: [...OLD_DEFAULT_EXCLUDES, "private/", "  ", "private/"].join("\n") }));
    expect(settings.userExclusions).toEqual(["private/"]);
  });

  it("leaves ownedKeys empty even when the stored data has some", () => {
    const { settings } = loadSettings(oldData({ ownedKeys: ["k51stolen"] }));
    expect(settings.ownedKeys).toEqual([]);
  });

  it("migrates the old form that only carries the last-published record", () => {
    const result = loadSettings({ lastPublishedRoot: "bafy", lastPublishedAt: 1 });
    expect(result.outcome).toBe("migrated");
    expect(result.settings.rpc.url).toBe(defaultSettings().rpc.url);
    expect(JSON.stringify(result.settings)).not.toContain("lastPublished");
  });

  it("loads the current form unchanged and does not rewrite it", () => {
    const stored = withSettings({
      rpc: { url: "https://rpc.example.org", port: 5001 },
      auth: { scheme: "basic", user: "u", password: "p" },
      userExclusions: ["private/"],
      ownedKeys: ["k51mine"],
      kv: { "state.json": "e30=" },
    });
    const result = loadSettings(JSON.parse(JSON.stringify(stored)));
    expect(result.outcome).toBe("current");
    expect(result.settings).toEqual(stored);
    expect(result.persist).toBe(false);
  });

  it("uses defaults for a missing file", () => {
    const result = loadSettings(null);
    expect(result).toMatchObject({ outcome: "fresh", persist: false, notices: [] });
    expect(result.settings).toEqual(defaultSettings());
  });

  it("uses defaults with a notice and does not ask to overwrite for garbage", () => {
    for (const garbage of ["text", 42, [1, 2], { version: 4 },{ ...defaultSettings(), rpc: "not-an-object" }]) {
      const result = loadSettings(garbage);
      expect(result.outcome).toBe("unreadable");
      expect(result.settings).toEqual(defaultSettings());
      expect(result.persist).toBe(false);
      expect(result.notices).toHaveLength(1);
    }
  });
});

describe("settings to config and validation", () => {
  it("builds the shared config, including separate endpoints and the owned keys", () => {
    const settings = withSettings({
      rpc: { url: "https://rpc.example.org", port: 5001 },
      gateway: { url: "https://gw.example.org", port: 8080 },
      auth: { scheme: "bearer", token: "tok" },
      ownedKeys: ["k51mine"],
    });
    const config = settingsToConfig(settings, NOW);
    expect(config.rpc.baseUrl).toBe("https://rpc.example.org:5001");
    expect(config.gateway.baseUrl).toBe("https://gw.example.org:8080");
    expect(config.rpc.auth).toEqual({ kind: "bearer", token: "tok" });
    expect(config.gateway.auth).toEqual({ kind: "bearer", token: "tok" });
    expect(config.ownedKeys).toEqual(["k51mine"]);
  });

  it("accepts the defaults", () => {
    expect(validateSettings(defaultSettings(), NOW)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects a foreign MFS root beside the mfsRoot field", () => {
    const validation = validateSettings(withSettings({ mfsRoot: "/obsidian-vault-staging" }), NOW);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]?.field).toBe("mfsRoot");
    expect(validation.errors[0]?.message).toContain("/obsidian-vault-sync");
    expect(() => settingsToConfig(withSettings({ mfsRoot: "/obsidian-vault-staging" }), NOW)).toThrowError(ConfigError);
  });

  it("rejects another project's key name", () => {
    const validation = validateSettings(withSettings({ publicationKey: "consult-capture" }), NOW);
    expect(validation.errors.map((e) => e.field)).toEqual(["publicationKey"]);
    expect(validation.errors[0]?.message).toContain("another project");
  });

  it("names both ports when the URL and the port field disagree", () => {
    const validation = validateSettings(withSettings({ rpc: { url: "https://rpc.example.org:5001", port: 5002 } }), NOW);
    expect(validation.errors.map((e) => e.field)).toEqual(["rpcPort"]);
    expect(validation.errors[0]?.message).toContain("5001");
    expect(validation.errors[0]?.message).toContain("5002");
  });

  it("reports an invalid gateway URL against the gateway field", () => {
    const validation = validateSettings(withSettings({ gateway: { url: "ftp://gw.example.org" } }), NOW);
    expect(validation.errors.map((e) => e.field)).toEqual(["gatewayUrl"]);
  });

  it("warns about an expired JWT but does not block", () => {
    const expiry = Math.floor(NOW.getTime() / 1000) - 3600;
    const validation = validateSettings(withSettings({ auth: { scheme: "bearer", token: jwt(expiry) } }), NOW);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toHaveLength(1);
    expect(validation.warnings[0]).toContain(new Date(expiry * 1000).toISOString());
  });

  it("never puts a secret into an error message", () => {
    const secrets = ["s3cret-pass", "tok-secret", "hv-secret"];
    const cases: PluginSettings[] = [
      withSettings({ auth: { scheme: "basic", user: "a:b", password: secrets[0] ?? "" } }),
      withSettings({ auth: { scheme: "header", headerName: "bad name", headerValue: secrets[2] ?? "" } }),
      withSettings({ auth: { scheme: "bearer", token: "" }, rpc: { url: `https://u:${secrets[1]}@node.example.org` } }),
    ];
    for (const settings of cases) {
      const validation = validateSettings(settings, NOW);
      expect(validation.errors.length).toBeGreaterThan(0);
      const text = JSON.stringify(validation);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  });

  it("rejects a fractional or negative publish interval", () => {
    expect(validateSettings(withSettings({ publishIntervalMinutes: 1.5 }), NOW).errors[0]?.field).toBe("publishIntervalMinutes");
    expect(validateSettings(withSettings({ publishIntervalMinutes: -1 }), NOW).errors[0]?.field).toBe("publishIntervalMinutes");
  });
});
