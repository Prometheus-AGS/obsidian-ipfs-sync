import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_MARKER } from "../../src/core/config";
import { createExclusionMatcher } from "../../src/sync/exclusions";
import { sha256Hex } from "../../src/sync/hash";
import { FixtureTargetError, fixtureFiles, writeFixtureVault } from "../../fixtures/generate-fixture-vault";

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else out[path] = await sha256Hex(new Uint8Array(await readFile(join(dir, path))));
    }
  };
  await walk("");
  return out;
}

describe("fixture vault generator", () => {
  it("has at least 10 published files in 3 folders, a binary, an excluded .trash entry and the marker", () => {
    const files = fixtureFiles(1);
    const matcher = createExclusionMatcher();
    const published = files.filter((f) => !matcher(f.path));
    const folders = new Set(published.map((f) => f.path.split("/")[0]).filter((p) => p !== undefined && published.some((f) => f.path.startsWith(`${p}/`))));
    expect(published.length).toBeGreaterThanOrEqual(10);
    expect(folders.size).toBeGreaterThanOrEqual(3);
    expect(files.some((f) => f.path.startsWith(".trash/"))).toBe(true);
    expect(files.some((f) => f.path === FIXTURE_MARKER)).toBe(true);
    expect(matcher(FIXTURE_MARKER)).toBe(true);
    expect(files.some((f) => f.path.endsWith(".bin") && f.data.length >= 1024)).toBe(true);
  });

  it("writes identical trees for one seed and different content for another", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipfs-sync-fixture-"));
    await writeFixtureVault(join(root, "a"), 7);
    await writeFixtureVault(join(root, "b"), 7);
    await writeFixtureVault(join(root, "c"), 8);
    const [a, b, c] = await Promise.all([tree(join(root, "a")), tree(join(root, "b")), tree(join(root, "c"))]);
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(Object.keys(c));
    expect(a).not.toEqual(c);
  });

  it("refuses a non-empty directory without the marker and writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipfs-sync-fixture-"));
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "private.md"), "my real note");
    await expect(writeFixtureVault(join(root, "real"))).rejects.toBeInstanceOf(FixtureTargetError);
    expect(await readdir(join(root, "real"))).toEqual(["private.md"]);
  });

  it("accepts an empty directory and a directory that already has the marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipfs-sync-fixture-"));
    await mkdir(join(root, "empty"));
    await writeFixtureVault(join(root, "empty"));
    await expect(writeFixtureVault(join(root, "empty"))).resolves.toBeDefined();
  });
});
