import { describe, expect, it } from "vitest";
import { planDelta } from "../../src/sync/diff";
import { createExclusionMatcher, excludesHash } from "../../src/sync/exclusions";
import { HASH_CHUNK_BYTES, SINGLE_READ_LIMIT_BYTES, hashFile, sha256Hex } from "../../src/sync/hash";
import { buildManifest, parseManifest, serializeManifest, ManifestError } from "../../src/sync/manifest";
import { scanVault } from "../../src/sync/scan";
import { StateError, buildState, decodeState, encodeState, readState, writeState, type LocalState } from "../../src/sync/state";
import { createMemoryHost } from "../helpers/memory-host";

const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

async function stateFor(host: ReturnType<typeof createMemoryHost>): Promise<LocalState> {
  const scanned = await scanVault(host.fs, createExclusionMatcher());
  const plan = await planDelta(host.fs, scanned, undefined);
  const files = Object.fromEntries(
    plan.writes.map((w) => [w.path, { sha256: w.sha256, size: w.size, cid: `bafycid-${w.path}` }] as const),
  );
  return buildState({
    mfsRoot: "/obsidian-vault-sync/default",
    key: "obsidian-vault-sync",
    rootCid: "bafyroot0000000",
    manifest: buildManifest({ rootCid: "bafycurrent0000", publishedAt: "2026-09-30T00:00:00.000Z", device: "t", files, excludesHash: await excludesHash() }),
    mtimes: plan.mtimes,
  });
}

describe("hashing", () => {
  it("hashes small files with one read and matches the known digest", async () => {
    const host = createMemoryHost();
    host.put("a.md", "hello");
    expect(await hashFile(host.fs, "a.md", 5)).toBe(HELLO_SHA);
    expect(host.reads.wholeReads).toEqual(["a.md"]);
    expect(host.reads.rangeLengths).toEqual([]);
  });

  it("hashes a 40 MB file in ranges of at most 8 MB and equals the one-pass digest", async () => {
    const size = 40 * 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 4099) data[i] = (i / 4099) & 0xff;
    const host = createMemoryHost();
    host.put("big.bin", data);
    const chunked = await hashFile(host.fs, "big.bin", size);
    expect(chunked).toBe(await sha256Hex(data));
    expect(host.reads.wholeReads).toEqual([]);
    expect(host.reads.rangeLengths).toHaveLength(5);
    expect(Math.max(...host.reads.rangeLengths)).toBeLessThanOrEqual(HASH_CHUNK_BYTES);
  });

  it("treats exactly 32 MB as a single read", async () => {
    const host = createMemoryHost();
    host.put("edge.bin", new Uint8Array(SINGLE_READ_LIMIT_BYTES));
    await hashFile(host.fs, "edge.bin", SINGLE_READ_LIMIT_BYTES);
    expect(host.reads.wholeReads).toEqual(["edge.bin"]);
  });
});

describe("manifest", () => {
  it("has exactly the v1 top-level fields and is byte-identical for equal input", async () => {
    const input = {
      rootCid: "bafycurrent0000",
      publishedAt: "2026-09-30T00:00:00.000Z",
      device: "cli",
      files: { "notes/hello.md": { sha256: HELLO_SHA, size: 5, cid: "bafkfile00000" } },
      excludesHash: await excludesHash(),
    };
    const a = serializeManifest(buildManifest(input));
    const b = serializeManifest(buildManifest({ ...input, files: { ...input.files } }));
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(a) as object).sort()).toEqual(["device", "excludesHash", "files", "publishedAt", "rootCID", "version"]);
    expect(JSON.parse(a).version).toBe(1);
    expect(parseManifest(a).files["notes/hello.md"]).toEqual(input.files["notes/hello.md"]);
  });

  it("orders keys regardless of insertion order", async () => {
    const hash = await excludesHash();
    const one = buildManifest({ rootCid: "c", publishedAt: "t", device: "d", excludesHash: hash, files: { b: { sha256: HELLO_SHA, size: 1, cid: "x" }, a: { sha256: HELLO_SHA, size: 1, cid: "y" } } });
    const two = buildManifest({ rootCid: "c", publishedAt: "t", device: "d", excludesHash: hash, files: { a: { sha256: HELLO_SHA, size: 1, cid: "y" }, b: { sha256: HELLO_SHA, size: 1, cid: "x" } } });
    expect(serializeManifest(one)).toBe(serializeManifest(two));
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, rootCID: "c", publishedAt: "t", device: "d", excludesHash: "zz", files: {} }),
  ])("rejects an invalid manifest %#", (text) => {
    expect(() => parseManifest(text)).toThrowError(ManifestError);
  });
});

describe("scan", () => {
  it("skips excluded files and directories and sorts by path", async () => {
    const host = createMemoryHost();
    for (const path of ["z.md", "notes/a.md", ".trash/old.md", ".obsidian/workspace.json", ".obsidian/app.json", ".ipfs-sync/state.json", ".ipfs-sync-fixture", "sub/.DS_Store"]) {
      host.put(path, "x");
    }
    const scanned = await scanVault(host.fs, createExclusionMatcher());
    expect(scanned.map((f) => f.path)).toEqual([".obsidian/app.json", "notes/a.md", "z.md"]);
  });
});

describe("delta planning", () => {
  it("treats every file as new on a first publish and issues no removals", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one");
    host.put("d/b.md", "two");
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), undefined);
    expect(plan.writes.map((w) => `${w.kind}:${w.path}`)).toEqual(["added:a.md", "added:d/b.md"]);
    expect(plan.removed).toEqual([]);
  });

  it("gives an empty diff for an untouched vault without hashing anything", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one");
    host.put("d/b.md", "two");
    const state = await stateFor(host);
    host.reads.count = 0;
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), state);
    expect(plan.writes).toEqual([]);
    expect(plan.removed).toEqual([]);
    expect(plan.hashed).toBe(0);
    expect(host.reads.count).toBe(0);
    expect(Object.keys(plan.unchanged).sort()).toEqual(["a.md", "d/b.md"]);
  });

  it("hashes a touched file but does not transfer it when the content is equal", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one", 1000);
    const state = await stateFor(host);
    host.put("a.md", "one", 2000);
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), state);
    expect(plan.writes).toEqual([]);
    expect(plan.hashed).toBe(1);
    expect(plan.mtimes["a.md"]).toBe(2000);
    expect(plan.unchanged["a.md"]?.cid).toBe("bafycid-a.md");
  });

  it("transfers only the edited file and carries its new sha256", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one", 1000);
    host.put("b.md", "two", 1000);
    const state = await stateFor(host);
    host.put("b.md", "two, edited", 2000);
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), state);
    expect(plan.writes).toEqual([{ path: "b.md", kind: "modified", sha256: await sha256Hex(new TextEncoder().encode("two, edited")), size: 11 }]);
    expect(Object.keys(plan.unchanged)).toEqual(["a.md"]);
  });

  it("puts deleted and newly excluded paths under removals", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one");
    host.put("gone.md", "bye");
    host.put("drafts/x.md", "draft");
    const state = await stateFor(host);
    host.drop("gone.md");
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher(["drafts/"])), state);
    expect(plan.removed).toEqual(["drafts/x.md", "gone.md"]);
    expect(plan.writes).toEqual([]);
  });

  it("does not confuse a file named after an Object member with a published one", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one");
    const state = await stateFor(host);
    host.put("constructor", "new file");
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), state);
    expect(plan.writes.map((w) => `${w.kind}:${w.path}`)).toEqual(["added:constructor"]);
  });
});

describe("local state", () => {
  it("round-trips through the kv store with equal bytes", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one");
    const state = await stateFor(host);
    await writeState(host.kv, state);
    const again = await readState(host.kv);
    expect(again).toEqual(state);
    expect(encodeState(again as LocalState)).toEqual(encodeState(state));
    expect(host.kvStore.has("state.json")).toBe(true);
  });

  it("is absent before the first publish and refuses a corrupt record loudly", async () => {
    const host = createMemoryHost();
    expect(await readState(host.kv)).toBeUndefined();
    host.kvStore.set("state.json", new TextEncoder().encode("{ broken"));
    await expect(readState(host.kv)).rejects.toBeInstanceOf(StateError);
    expect(() => decodeState(new TextEncoder().encode('{"version":9}'))).toThrowError(/unsupported state version/);
  });
});
