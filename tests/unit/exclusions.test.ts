import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUSIONS, effectiveExclusions, excludesHash, isExcluded } from "../../src/sync/exclusions";

/** sha256 of the sorted default list joined with "\n" (no trailing newline). Pinned so mvp-03 can compare across devices.
 * mvp-04 added the plugin data file (was d891b0bd...) and then .obsidian/plugins/ (was fb9fe399...); devices on an older build see a divergence warning by design. */
const DEFAULT_HASH = "062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d";

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
    ["notes/.obsidian/workspace.json", false],
    [".obsidian/workspace.json.bak", true],
    [".obsidian/cache/deep/file", true],
    [".obsidian/plugins/x/main.js", true],
    [".obsidian/plugins/x", true],
    [".obsidian/pluginsx/a.md", false],
    ["notes/.obsidian/plugins/x/main.js", false],
    [".obsidian/plugins/ipfs-sync/data.json", true],
    [".obsidian/plugins/ipfs-sync/main.js", true],
    [".obsidian/plugins/other/data.json", true],
    ["notes/.obsidian/plugins/ipfs-sync/data.json", false],
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
    expect(isExcluded("notes\\.obsidian\\workspace.json")).toBe(false);
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

describe("excludesHash", () => {
  it("has the pinned literal value for the default list", async () => {
    expect(await excludesHash()).toBe(DEFAULT_HASH);
  });

  it("does not depend on entry order or repeats", async () => {
    const reordered = [...DEFAULT_EXCLUSIONS].reverse();
    expect(await excludesHash(reordered)).toBe(DEFAULT_HASH);
    expect(await excludesHash([".git/", ".DS_Store"])).toBe(DEFAULT_HASH);
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
