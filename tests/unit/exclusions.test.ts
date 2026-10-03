import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUSIONS, effectiveExclusions, excludesHash, isExcluded } from "../../src/sync/exclusions";

/** sha256 of the sorted default list joined with "\n" (no trailing newline). Pinned so mvp-03 can compare across devices.
 * mvp-04 added the plugin data file (was d891b0bd...) and then .obsidian/plugins/ (was fb9fe399...); devices on an older build see a divergence warning by design. */
const DEFAULT_HASH = "ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f";
/** The value before `.smart-env/` joined the defaults (Smart Connections embeddings, rewritten about every 13 s while editing). */
const HASH_BEFORE_SMART_ENV = "70f14cd58f2dba5999edb491433546a33649d088800578740933a81ce6a8a0b8";
/** The value before mvp-07a task 1.3 (the six narrow .obsidian entries); every old manifest carries it. */
const PREVIOUS_HASH = "062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d";

describe("isExcluded", () => {
  it.each([
    [".trash/old.md", true],
    [".trash/a/b.md", true],
    ["notes/.trash/x.md", true],
    ["notes/.trash-notes.md", false],
    [".ipfs-sync/state.json", true],
    [".DS_Store", true],
    ["notes/sub/.DS_Store", true],
    [".obsidian/workspace.json", true],
    // `.obsidian/` has no inner slash, so the unchanged matcher reads it as "a directory called .obsidian at any depth".
    ["notes/.obsidian/workspace.json", true],
    [".obsidian/workspace.json.bak", true],
    [".obsidian/cache/deep/file", true],
    [".obsidian/app.json", true],
    [".obsidian/themes/x.css", true],
    [".obsidian/snippets/a.css", true],
    [".obsidian/plugins/a/main.js", true],
    [".obsidian/plugins/x/main.js", true],
    [".obsidian/plugins/x", true],
    [".obsidian/pluginsx/a.md", true],
    [".obsidianx/a.md", false],
    ["Notes/.Obsidian/app.json", false],
    ["notes/.obsidian/plugins/x/main.js", true],
    [".obsidian/plugins/ipfs-sync/data.json", true],
    [".obsidian/plugins/ipfs-sync/main.js", true],
    [".obsidian/plugins/other/data.json", true],
    ["notes/.obsidian/plugins/ipfs-sync/data.json", true],
    ["node_modules/pkg/index.js", true],
    ["src/node_modules/pkg/index.js", true],
    [".git/config", true],
    [".ipfs-sync-fixture", true],
    ["notes/hello.md", false],
    ["attachment.pdf", false],
  ])("%s -> %s", (path, expected) => {
    expect(isExcluded(path)).toBe(expected);
  });

  it("normalises backslashes and leading separators", () => {
    expect(isExcluded(".trash\\a\\b.md")).toBe(true);
    expect(isExcluded(".obsidian\\workspace.json")).toBe(true);
    expect(isExcluded("./.trash/a.md")).toBe(true);
    expect(isExcluded("notes\\.obsidian\\workspace.json")).toBe(true);
  });

  it("matches a directory entry only when the path is a directory", () => {
    expect(isExcluded(".trash", [], true)).toBe(true);
    expect(isExcluded(".trash", [], false)).toBe(false);
  });

  it("accepts extra entries", () => {
    expect(isExcluded("drafts/a.md")).toBe(false);
    expect(isExcluded("drafts/a.md", ["drafts/"])).toBe(true);
    expect(isExcluded("private/x.md", ["private/x.md"])).toBe(true);
    expect(isExcluded("deep/private/x.md", ["private/x.md"])).toBe(false);
  });
});

describe("default exclusions: configuration folder (task 1.3)", () => {
  it("lists .obsidian/ and none of the narrower .obsidian entries", () => {
    expect(DEFAULT_EXCLUSIONS).toContain(".obsidian/");
    expect(DEFAULT_EXCLUSIONS.filter((entry) => entry.startsWith(".obsidian/") && entry !== ".obsidian/")).toEqual([]);
  });

  /** Not identical: a nested `.obsidian` directory was kept before (only the root one was listed) and is now excluded, because the matcher is unchanged. */
  it.each([
    ["notes/.obsidian/app.json", true],
    ["notes/.obsidian/plugins/x/main.js", true],
  ])("%s -> %s (nested .obsidian, changed)", (path, expected) => {
    expect(isExcluded(path)).toBe(expected);
  });

  /** Answers recorded from the matcher before this change: nothing outside .obsidian/ moved. */
  it.each([
    [".trash/old.md", true], ["notes/.trash/x.md", true], ["notes/.trash-notes.md", false], [".ipfs-sync/state.json", true],
    [".ipfs-sync-fixture", true], [".DS_Store", true], ["a/.DS_Store", true], ["node_modules/p/i.js", true],
    ["src/node_modules/p.js", true], [".git/config", true], ["a/.git/x", true], ["notes/hello.md", false],
    ["attachment.pdf", false], ["drafts/a.md", false], [".obsidianx/a.md", false], ["Notes/.Obsidian/app.json", false],
  ])("%s -> %s (same as before)", (path, expected) => {
    expect(isExcluded(path)).toBe(expected);
  });
});

describe("default exclusions: Smart Connections embeddings", () => {
  it.each([
    [".smart-env/x", true],
    [".smart-env/multi/a.ajson", true],
    ["notes/.smart-env/x", true],
    ["notes/.smart-env-notes.md", false],
  ])("%s -> %s", (path, expected) => {
    expect(isExcluded(path)).toBe(expected);
  });

  it("changes the default hash from the value before .smart-env/ was excluded", async () => {
    expect(DEFAULT_EXCLUSIONS).toContain(".smart-env/");
    expect(await excludesHash()).not.toBe(HASH_BEFORE_SMART_ENV);
  });
});

describe("excludesHash", () => {
  it("has the pinned literal value for the default list", async () => {
    expect(await excludesHash()).toBe(DEFAULT_HASH);
  });

  it("does not depend on entry order or repeats", async () => {
    const reordered = [...DEFAULT_EXCLUSIONS].reverse();
    expect(await excludesHash(reordered)).toBe(DEFAULT_HASH);
    expect(await excludesHash([".git/", ".DS_Store"])).toBe(DEFAULT_HASH);
  });

  it("differs from the value before the configuration folder was excluded", async () => {
    expect(DEFAULT_HASH).not.toBe(PREVIOUS_HASH);
    expect(await excludesHash()).not.toBe(PREVIOUS_HASH);
  });

  it("changes when one entry is added", async () => {
    expect(await excludesHash(["drafts/"])).not.toBe(DEFAULT_HASH);
  });

  it("sorts by code unit", () => {
    expect(effectiveExclusions()).toEqual([...DEFAULT_EXCLUSIONS].sort());
    const sorted = effectiveExclusions(["a", "B"]);
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("a"));
  });
});
