import { describe, expect, it } from "vitest";
import { chooseConflictName, conflictCandidate, localDateStamp } from "../../src/sync/conflict-name";
import { mergeRecord } from "../../src/sync/pull-record";
import { buildState, type LocalState } from "../../src/sync/state";
import { manifestFor, sha } from "../helpers/pull-fixtures";

const DATE = "2026-09-29";

describe("conflictCandidate", () => {
  it.each([
    ["a.md", "a (ipfs conflict 2026-09-29).md"],
    ["notes/a.md", "notes/a (ipfs conflict 2026-09-29).md"],
    ["deep/er/note.name.md", "deep/er/note.name (ipfs conflict 2026-09-29).md"],
    ["LICENSE", "LICENSE (ipfs conflict 2026-09-29)"],
    [".gitignore", ".gitignore (ipfs conflict 2026-09-29)"],
    ["dir/.gitignore", "dir/.gitignore (ipfs conflict 2026-09-29)"],
    ["data.tar.gz", "data.tar (ipfs conflict 2026-09-29).gz"],
    ["dir.with.dots/LICENSE", "dir.with.dots/LICENSE (ipfs conflict 2026-09-29)"],
  ])("%s -> %s", (path, expected) => {
    expect(conflictCandidate(path, DATE, 1)).toBe(expected);
  });

  it("puts the counter inside the parentheses from the second attempt", () => {
    expect(conflictCandidate("a.md", DATE, 2)).toBe("a (ipfs conflict 2026-09-29 2).md");
    expect(conflictCandidate("LICENSE", DATE, 3)).toBe("LICENSE (ipfs conflict 2026-09-29 3)");
  });
});

describe("chooseConflictName", () => {
  it("uses the plain name when free", async () => {
    expect(await chooseConflictName("a.md", DATE, async () => false)).toBe("a (ipfs conflict 2026-09-29).md");
  });

  it("skips taken names and never reuses the first copy", async () => {
    const taken = new Set(["a (ipfs conflict 2026-09-29).md", "a (ipfs conflict 2026-09-29 2).md"]);
    const probed: string[] = [];
    const name = await chooseConflictName("a.md", DATE, async (candidate) => {
      probed.push(candidate);
      return taken.has(candidate);
    });
    expect(name).toBe("a (ipfs conflict 2026-09-29 3).md");
    expect(probed).toHaveLength(3);
  });
});

describe("localDateStamp", () => {
  it("uses the local calendar date of the injected instant", () => {
    const instant = new Date(2026, 8, 29, 23, 59, 30).getTime();
    expect(localDateStamp(instant)).toBe("2026-09-29");
    expect(localDateStamp(new Date(2026, 0, 5, 0, 0, 1).getTime())).toBe("2026-01-05");
  });
});

const TARGET = { mfsRoot: "/obsidian-vault-sync/t", key: "obsidian-vault-sync", rootCid: "rootcid" };

async function previousState(files: Record<string, string>, mtimes: Record<string, number>): Promise<LocalState> {
  return buildState({ ...TARGET, manifest: await manifestFor(files), mtimes });
}

describe("mergeRecord", () => {
  it("records the selected manifest with post-write mtimes for synced paths", async () => {
    const manifest = await manifestFor({ "a.md": "A", "b.md": "B" });
    const merged = mergeRecord({ previous: undefined, manifest, target: TARGET, synced: new Map([["a.md", 11], ["b.md", 22]]) });
    expect(Object.keys(merged.manifest.files)).toEqual(["a.md", "b.md"]);
    expect(merged.mtimes).toEqual({ "a.md": 11, "b.md": 22 });
    expect(merged).toMatchObject({ version: 1, rootCid: "rootcid", key: "obsidian-vault-sync" });
  });

  it("reverts a failed path to its previous entry and mtime", async () => {
    const previous = await previousState({ "a.md": "old" }, { "a.md": 5 });
    const manifest = await manifestFor({ "a.md": "new", "b.md": "B" });
    const merged = mergeRecord({ previous, manifest, target: TARGET, synced: new Map([["b.md", 9]]) });
    expect(merged.manifest.files["a.md"]?.sha256).toBe(await sha("old"));
    expect(merged.mtimes["a.md"]).toBe(5);
    expect(merged.manifest.files["b.md"]?.sha256).toBe(await sha("B"));
  });

  it("drops a failed path that had no previous entry", async () => {
    const manifest = await manifestFor({ "a.md": "new" });
    const merged = mergeRecord({ previous: undefined, manifest, target: TARGET, synced: new Map() });
    expect(merged.manifest.files).toEqual({});
    expect(merged.mtimes).toEqual({});
  });

  it("records a conflict path as the remote sha256 with the new file's mtime", async () => {
    const previous = await previousState({ "a.md": "orig" }, { "a.md": 5 });
    const manifest = await manifestFor({ "a.md": "remote" });
    const merged = mergeRecord({ previous, manifest, target: TARGET, synced: new Map([["a.md", 99]]) });
    expect(merged.manifest.files["a.md"]?.sha256).toBe(await sha("remote"));
    expect(merged.mtimes["a.md"]).toBe(99);
  });

  it("drops paths the manifest no longer lists", async () => {
    const previous = await previousState({ "gone.md": "x", "kept.md": "y" }, { "gone.md": 1, "kept.md": 2 });
    const manifest = await manifestFor({ "kept.md": "y" });
    const merged = mergeRecord({ previous, manifest, target: TARGET, synced: new Map([["kept.md", 2]]) });
    expect(Object.keys(merged.manifest.files)).toEqual(["kept.md"]);
    expect(Object.keys(merged.mtimes)).toEqual(["kept.md"]);
  });

  it("keeps a path named __proto__ as a key", async () => {
    const manifest = await manifestFor({ ["__proto__"]: "p" });
    const merged = mergeRecord({ previous: undefined, manifest, target: TARGET, synced: new Map([["__proto__", 1]]) });
    expect(Object.keys(merged.mtimes)).toEqual(["__proto__"]);
  });
});
