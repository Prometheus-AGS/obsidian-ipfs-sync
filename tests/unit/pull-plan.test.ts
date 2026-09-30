import { describe, expect, it } from "vitest";
import { parseManifest } from "../../src/sync/manifest";
import { decideThreeWay, planPull, untrustedPathReason, type PullDecision } from "../../src/sync/pull-plan";
import { sha256Hex } from "../../src/sync/hash";
import { buildState, type LocalState } from "../../src/sync/state";
import { createMemoryHost } from "../helpers/memory-host";
import { manifestFor, sha } from "../helpers/pull-fixtures";

describe("decideThreeWay: every L/B/R combination", () => {
  const A = "a";
  const B = "b";
  const C = "c";
  // [local, base, remote, outcome]
  const table: readonly (readonly [string | undefined, string | undefined, string, string])[] = [
    [undefined, undefined, A, "fetch"],
    [undefined, A, A, "fetch"],
    [undefined, B, A, "fetch"],
    [A, undefined, A, "unchanged"],
    [A, A, A, "unchanged"],
    [A, B, A, "unchanged"],
    [A, undefined, B, "conflict"],
    [A, A, B, "replace"],
    [A, B, C, "conflict"],
    [A, C, B, "conflict"],
    [A, B, A, "unchanged"],
    [B, A, A, "locally-modified"],
    [B, undefined, A, "conflict"],
    [B, C, A, "conflict"],
  ];
  it.each(table)("L=%s B=%s R=%s -> %s", (local, base, remote, outcome) => {
    expect(decideThreeWay(local, base, remote)).toBe(outcome);
  });
});

describe("untrustedPathReason", () => {
  it.each(["../x", "a/../../x", "/etc/passwd", "a\\b", "a//b", "a/./b", "", "a/\u0007b", "C:/x", ".ipfs-sync/state.json", ".IPFS-Sync/state.json", ".ipfs-sync/tmp/x"])(
    "refuses %j",
    (path) => {
      expect(untrustedPathReason(path)).toBeDefined();
    },
  );
  it.each(["notes/a.md", ".obsidian/app.json", ".ipfs-sync-fixture", "a b/c.md", "...", "dir/.hidden"])("accepts %j", (path) => {
    expect(untrustedPathReason(path)).toBeUndefined();
  });
});

describe("manifest validation", () => {
  it("rejects an unknown version and missing fields before any planning", () => {
    expect(() => parseManifest(JSON.stringify({ version: 2 }))).toThrow(/unsupported manifest version 2/);
    expect(() => parseManifest(JSON.stringify({ version: 1 }))).toThrow(/rootCID/);
    expect(() => parseManifest("not json")).toThrow(/not valid JSON/);
  });
});

async function stateFor(
  files: Readonly<Record<string, string>>,
  mtimes: Readonly<Record<string, number>>,
): Promise<LocalState> {
  return buildState({ mfsRoot: "/obsidian-vault-sync/t", key: "obsidian-vault-sync", rootCid: "root", manifest: await manifestFor(files), mtimes });
}

const kindOf = (decisions: readonly PullDecision[], path: string): string | undefined => decisions.find((d) => d.path === path)?.kind;

describe("planPull", () => {
  it("classifies each file against the record and the remote", async () => {
    const host = createMemoryHost();
    host.put("same.md", "same", 10);
    host.put("edited-remote.md", "old", 10);
    host.put("edited-local.md", "mine, edited", 10);
    host.put("both.md", "local text", 10);
    host.put("untracked.md", "untracked local", 10);
    const previous = await stateFor(
      { "same.md": "same", "edited-remote.md": "old", "edited-local.md": "orig", "both.md": "orig", "gone.md": "x" },
      { "same.md": 10, "edited-remote.md": 10, "edited-local.md": 10, "both.md": 10 },
    );
    const manifest = await manifestFor({
      "same.md": "same",
      "edited-remote.md": "new",
      "edited-local.md": "orig",
      "both.md": "remote text",
      "untracked.md": "untracked remote",
      "missing.md": "fresh",
    });
    const plan = await planPull({ fs: host.fs, manifest, previous, forceVerify: false });
    expect(plan.decisions.map((d) => `${d.path}:${d.kind}`)).toEqual([
      "both.md:conflict",
      "edited-local.md:locally-modified",
      "edited-remote.md:replace",
      "missing.md:fetch",
      "same.md:unchanged",
      "untracked.md:conflict",
    ]);
    expect(plan.remoteDeleted).toEqual(["gone.md"]);
    const both = plan.decisions.find((d) => d.path === "both.md");
    expect(both?.kind === "conflict" && both.localSha256).toBe(await sha256Hex(new TextEncoder().encode("local text")));
  });

  it("treats every differing file as a conflict when there is no record", async () => {
    const host = createMemoryHost();
    host.put("a.md", "local", 5);
    const manifest = await manifestFor({ "a.md": "remote" });
    const plan = await planPull({ fs: host.fs, manifest, previous: undefined, forceVerify: false });
    expect(kindOf(plan.decisions, "a.md")).toBe("conflict");
    expect(plan.remoteDeleted).toEqual([]);
  });

  it("trusts size and mtime without hashing, and rehashes when forced", async () => {
    const host = createMemoryHost();
    host.put("a.md", "hello", 77);
    const previous = await stateFor({ "a.md": "hello" }, { "a.md": 77 });
    const manifest = await manifestFor({ "a.md": "hello" });
    const quick = await planPull({ fs: host.fs, manifest, previous, forceVerify: false });
    expect(quick.hashed).toBe(0);
    expect(host.reads.count).toBe(0);
    const forced = await planPull({ fs: host.fs, manifest, previous, forceVerify: true });
    expect(forced.hashed).toBe(1);
    expect(host.reads.count).toBe(1);
  });

  it("with forced verification a file whose mtime lies is still detected as edited", async () => {
    const host = createMemoryHost();
    host.put("a.md", "HELLO", 77); // same size and mtime as the record, different bytes
    const previous = await stateFor({ "a.md": "hello" }, { "a.md": 77 });
    const manifest = await manifestFor({ "a.md": "world" });
    const trusting = await planPull({ fs: host.fs, manifest, previous, forceVerify: false });
    expect(kindOf(trusting.decisions, "a.md")).toBe("replace");
    const forced = await planPull({ fs: host.fs, manifest, previous, forceVerify: true });
    expect(kindOf(forced.decisions, "a.md")).toBe("conflict");
  });

  it("refuses untrusted paths without touching the disk for them", async () => {
    const host = createMemoryHost();
    const manifest = await manifestFor({ "../x": "1", "/abs": "2", "a\\b": "3", ".ipfs-sync/state.json": "4", "ok.md": "5" });
    const plan = await planPull({ fs: host.fs, manifest, previous: undefined, forceVerify: false });
    expect(plan.decisions.filter((d) => d.kind === "refused").map((d) => d.path).sort()).toEqual(["../x", ".ipfs-sync/state.json", "/abs", "a\\b"]);
    expect(kindOf(plan.decisions, "ok.md")).toBe("fetch");
  });

  it("refuses a symlink destination and a symlinked directory component, without hashing through them", async () => {
    const host = createMemoryHost();
    host.put("notes/a.md", "target", 5);
    host.link("notes/a.md");
    host.link("linked");
    host.put("linked/x.md", "outside", 5);
    const manifest = await manifestFor({ "notes/a.md": "new", "linked/x.md": "new", "plain.md": "new" });
    const plan = await planPull({ fs: host.fs, manifest, previous: undefined, forceVerify: false });
    expect(plan.decisions.map((d) => `${d.path}:${d.kind}`)).toEqual(["linked/x.md:refused", "notes/a.md:refused", "plain.md:fetch"]);
    expect(host.reads.count).toBe(0);
  });

  it("does not fetch a sha the manifest already has locally, and names the manifest entry", async () => {
    const host = createMemoryHost();
    host.put("a.md", "x", 1);
    const manifest = await manifestFor({ "a.md": "x" });
    const plan = await planPull({ fs: host.fs, manifest, previous: undefined, forceVerify: false });
    expect(plan.decisions[0]).toMatchObject({ kind: "unchanged", entry: { sha256: await sha("x") } });
  });
});

describe("planPull: excluded and device-local manifest paths", () => {
  const forged = {
    ".obsidian/plugins/x/main.js": "code",
    ".Obsidian/Plugins/y/main.js": "code",
    ".ipfs-sync/state.json": "state",
    ".git/config": "cfg",
    ".trash/x": "trash",
    "drafts/a.md": "local exclusion",
    "ok.md": "fine",
  };

  it("refuses every path the exclusion list or the plugin rule covers, and continues with the rest", async () => {
    const host = createMemoryHost();
    const manifest = await manifestFor(forged);
    const plan = await planPull({ fs: host.fs, manifest, previous: undefined, forceVerify: false, extraExclusions: ["drafts/"] });
    const refused = plan.decisions.filter((d) => d.kind === "refused");
    expect(refused.map((d) => d.path).sort()).toEqual([".Obsidian/Plugins/y/main.js", ".git/config", ".ipfs-sync/state.json", ".obsidian/plugins/x/main.js", ".trash/x", "drafts/a.md"]);
    expect(refused.every((d) => d.kind === "refused" && d.reason !== "")).toBe(true);
    expect(kindOf(plan.decisions, "ok.md")).toBe("fetch");
    expect(host.reads.count).toBe(0);
  });

  it("does not refuse drafts/ when this device has no such exclusion", async () => {
    const plan = await planPull({ fs: createMemoryHost().fs, manifest: await manifestFor({ "drafts/a.md": "x" }), previous: undefined, forceVerify: false });
    expect(kindOf(plan.decisions, "drafts/a.md")).toBe("fetch");
  });

  it("names the reason for a plugin path", async () => {
    const plan = await planPull({ fs: createMemoryHost().fs, manifest: await manifestFor({ ".obsidian/plugins/x/main.js": "c" }), previous: undefined, forceVerify: false });
    expect(plan.decisions[0]).toMatchObject({ kind: "refused", reason: expect.stringContaining("plugin") });
  });
});
