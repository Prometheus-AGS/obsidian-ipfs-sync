import { describe, expect, it } from "vitest";
import { parsePullName, previewPullTarget, resolvePullTarget, NO_PULL_TARGET_MESSAGE } from "../../src/plugin/pull-target";
import { isValidReadCapMb, parseReadCapMb, READ_CAP_RANGE_MESSAGE } from "../../src/plugin/read-cap";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings, SETTINGS_VERSION, type PluginSettings, type PullSummary } from "../../src/plugin/settings-model";

const KEY_ID = "k51qzi5uqu5dhjghbrp9iqsoa6b3ob3i3jnljq09d3a4j9j4a5c7t";
const OTHER_ID = "k51qzi5uqu5dlfgjhskdfhj2389sdfhjk23489sdhfjkshdf28sd";

/** A version 2 file as mvp-04 wrote it: no pull fields. */
function version2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { pullName: _p, catchUpOnLoad: _c, maxReadMb: _m, lastPull: _l, lastPublish: _u, ...rest } = defaultSettings() as unknown as Record<string, unknown>;
  return {
    ...rest,
    version: 2,
    rpc: { url: "https://rpc.example.org", port: 5001 },
    gateway: { url: "https://gw.example.org", port: 8080 },
    auth: { scheme: "bearer", token: "tok-v2" },
    userExclusions: ["private/"],
    ownedKeys: [KEY_ID],
    publishIntervalMinutes: 15,
    kv: { "state.json": "e30=" },
    ...overrides,
  };
}

const PULL: PullSummary = {
  at: "2026-09-30T12:00:00.000Z",
  rootCid: "bafyroot",
  manifestCid: "bafymanifest",
  fetched: 3,
  unchanged: 2,
  conflicts: 1,
  failed: 0,
  remoteDeleted: 0,
};

describe("settings model version 3", () => {
  it("has the pull defaults on a fresh install: no pull name, catch-up off, 64 MB", () => {
    const settings = defaultSettings();
    expect(settings).toMatchObject({ version: 3, pullName: "", catchUpOnLoad: false, maxReadMb: 64 });
    expect(settings.lastPull).toBeUndefined();
    expect(settings.lastPublish).toBeUndefined();
  });

  it("loads version 2 with defaults for the new fields and every existing value unchanged", () => {
    const result = loadSettings(version2());
    expect(result.outcome).toBe("upgraded");
    expect(result.persist).toBe(false);
    expect(result.notices).toEqual([]);
    expect(result.settings).toEqual({
      ...defaultSettings(),
      rpc: { url: "https://rpc.example.org", port: 5001 },
      gateway: { url: "https://gw.example.org", port: 8080 },
      auth: { scheme: "bearer", token: "tok-v2" },
      userExclusions: ["private/"],
      ownedKeys: [KEY_ID],
      publishIntervalMinutes: 15,
      kv: { "state.json": "e30=" },
    });
    expect(result.settings.version).toBe(SETTINGS_VERSION);
  });

  it("round-trips version 3 including both summaries", () => {
    const stored: PluginSettings = {
      ...defaultSettings(),
      pullName: KEY_ID,
      catchUpOnLoad: true,
      maxReadMb: 128,
      lastPull: PULL,
      lastPublish: { at: "2026-09-30T11:00:00.000Z", written: 2, removed: 0, skipped: 1, rootCid: "bafyroot" },
    };
    const result = loadSettings(JSON.parse(JSON.stringify(stored)));
    expect(result.outcome).toBe("current");
    expect(result.settings).toEqual(stored);
  });

  it("drops a malformed summary instead of losing the endpoints and the token", () => {
    const stored = { ...defaultSettings(), auth: { scheme: "bearer", token: "keep-me" }, lastPull: { at: 5, fetched: "many" }, lastPublish: "yesterday" };
    const result = loadSettings(JSON.parse(JSON.stringify(stored)));
    expect(result.outcome).toBe("current");
    expect(result.settings.auth).toEqual({ scheme: "bearer", token: "keep-me" });
    expect(result.settings.lastPull).toBeUndefined();
    expect(result.settings.lastPublish).toBeUndefined();
  });

  it("treats a wrongly typed pull field as unreadable and leaves the stored data alone", () => {
    for (const bad of [{ pullName: 5 }, { catchUpOnLoad: "yes" }, { maxReadMb: 4 }, { maxReadMb: 2048 }, { maxReadMb: 64.5 }]) {
      const result = loadSettings({ ...defaultSettings(), ...bad });
      expect(result.outcome, JSON.stringify(bad)).toBe("unreadable");
      expect(result.persist).toBe(false);
    }
  });

  it("keeps stored summaries free of paths and secrets", () => {
    const stored = { ...defaultSettings(), auth: { scheme: "bearer", token: "tok-secret-Zx91" }, lastPull: { ...PULL, path: "notes/private.md", token: "tok-secret-Zx91" } };
    const loaded = loadSettings(JSON.parse(JSON.stringify(stored))).settings.lastPull;
    expect(Object.keys(loaded ?? {}).sort()).toEqual(["at", "conflicts", "failed", "fetched", "manifestCid", "remoteDeleted", "rootCid", "unchanged"]);
    expect(JSON.stringify(loaded)).not.toMatch(/private|secret/);
  });
});

describe("pull name", () => {
  it("accepts empty, a key ID, and a key ID with the /ipns/ prefix (stored without it)", () => {
    expect(parsePullName("")).toEqual({ ok: true, name: "" });
    expect(parsePullName("   ")).toEqual({ ok: true, name: "" });
    expect(parsePullName(KEY_ID)).toEqual({ ok: true, name: KEY_ID });
    expect(parsePullName(`/ipns/${KEY_ID}`)).toEqual({ ok: true, name: KEY_ID });
    expect(parsePullName(`  ${KEY_ID}  `)).toEqual({ ok: true, name: KEY_ID });
  });

  it("rejects spaces, several names, other schemes, paths and short tokens", () => {
    for (const bad of [`${KEY_ID} ${OTHER_ID}`, "two words", `/ipfs/${KEY_ID}`, `${KEY_ID}/sub`, "k51", "example.com", "/ipns/"]) {
      const parsed = parsePullName(bad);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("IPNS key ID");
    }
  });
});

describe("read cap setting", () => {
  it("accepts 8 to 1024 whole megabytes and nothing else", () => {
    for (const ok of ["8", "64", "128", "1024", " 64 "]) expect(parseReadCapMb(ok)).toEqual({ ok: true, megabytes: Number(ok.trim()) });
    for (const bad of ["4", "7", "1025", "0", "-8", "64.5", "", "abc", "1e3", "100000"]) {
      expect(parseReadCapMb(bad), bad).toEqual({ ok: false, message: READ_CAP_RANGE_MESSAGE });
    }
    expect(READ_CAP_RANGE_MESSAGE).toContain("8 to 1024");
    expect([7, 8, 1024, 1025].map(isValidReadCapMb)).toEqual([false, true, true, false]);
  });
});

describe("pull target", () => {
  const base = { pullName: "", publicationKey: "obsidian-vault-sync", ownedKeys: [KEY_ID] };

  it("uses the entered name without asking the node", () => {
    expect(resolvePullTarget({ ...base, pullName: OTHER_ID }, [])).toEqual({ kind: "resolved", name: OTHER_ID, source: "setting" });
  });

  it("falls back to the ID of the owned publication key", () => {
    const keys = [{ name: "obsidian-vault-sync", id: KEY_ID }, { name: "prince-live", id: OTHER_ID }];
    expect(resolvePullTarget(base, keys)).toEqual({ kind: "resolved", name: KEY_ID, source: "owned-key" });
  });

  it("gives no target when the key is absent, foreign, or its ID is not recorded as owned", () => {
    const cases = [
      [],
      [{ name: "obsidian-vault-sync", id: OTHER_ID }],
      [{ name: "obsidian-vault-sync" }],
    ];
    for (const keys of cases) {
      const found = resolvePullTarget(base, keys);
      expect(found.kind).toBe("none");
      if (found.kind === "none") expect(found.message).toContain(NO_PULL_TARGET_MESSAGE);
    }
    expect(resolvePullTarget({ ...base, ownedKeys: [] }, [{ name: "obsidian-vault-sync", id: KEY_ID }]).kind).toBe("none");
  });

  it("previews the name from the settings alone", () => {
    expect(previewPullTarget({ ...base, pullName: OTHER_ID })).toEqual({ kind: "entered", name: OTHER_ID });
    expect(previewPullTarget(base)).toEqual({ kind: "owned-key", name: KEY_ID });
    expect(previewPullTarget({ ...base, ownedKeys: [] })).toEqual({ kind: "none" });
    expect(previewPullTarget({ ...base, ownedKeys: [KEY_ID, OTHER_ID] })).toEqual({ kind: "owned-key-from-node", keyName: "obsidian-vault-sync", recorded: 2 });
  });
});
