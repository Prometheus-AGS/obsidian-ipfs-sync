import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { publishVault } from "../../src/sync/publish";
import { TEMP_DIR } from "../../src/sync/pull-fetch";
import { STATE_KEY, decodeState, readState } from "../../src/sync/state";
import { createFakeNode } from "../helpers/fake-kubo";
import { FILES_V1, KEY, MFS, ROOT1, ROOT2, TODAY, TREE1, TREE2, harness, leftovers, text, type Harness } from "../helpers/pull-harness";
import { IPNS_NAME, seedRemote, sha } from "../helpers/pull-fixtures";

describe("pullVault: conflicts", () => {
  async function conflicted(): Promise<Harness> {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    h.host.put("notes/a.md", "LOCAL edit", h.host.clock + 1000);
    await seedRemote(h.gateway, { ...FILES_V1, "notes/a.md": "REMOTE edit" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    return h;
  }

  it("preserves the local text in a copy that keeps the extension, then writes the remote text", async () => {
    const h = await conflicted();
    h.changed.length = 0;
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 1, unchanged: 2, conflicted: 1, failed: 0 });
    expect(text(h, "notes/a.md")).toBe("REMOTE edit");
    expect(text(h, `notes/a (ipfs conflict ${TODAY}).md`)).toBe("LOCAL edit");
    expect(result.conflicts).toEqual([{ path: "notes/a.md", conflictPath: `notes/a (ipfs conflict ${TODAY}).md` }]);
    expect(h.conflicts).toEqual([
      { path: "notes/a.md", conflictPath: `notes/a (ipfs conflict ${TODAY}).md`, localSha256: await sha("LOCAL edit"), remoteSha256: await sha("REMOTE edit") },
    ]);
    const state = await readState(h.host.kv);
    expect(state?.manifest.files["notes/a.md"]?.sha256).toBe(await sha("REMOTE edit"));
    expect(Object.keys(state?.manifest.files ?? {})).not.toContain(`notes/a (ipfs conflict ${TODAY}).md`);
    expect(leftovers(h)).toEqual([]);
  });

  it("does not raise a second conflict for the copy on the next pull", async () => {
    const h = await conflicted();
    await h.run();
    const again = await h.run();
    expect(again).toMatchObject({ fetched: 0, conflicted: 0, failed: 0 });
  });

  it("uses the counter form for a second same-day conflict and leaves the first copy alone", async () => {
    const h = await conflicted();
    await h.run();
    h.host.put("notes/a.md", "LOCAL edit two", h.host.clock + 2000);
    await seedRemote(h.gateway, { ...FILES_V1, "notes/a.md": "REMOTE edit two" }, { tree: "bafytreethree0000000000", root: "bafyrootthree0000000000", previousRoot: ROOT2 });
    const result = await h.run();
    expect(result.conflicted).toBe(1);
    expect(text(h, `notes/a (ipfs conflict ${TODAY}).md`)).toBe("LOCAL edit");
    expect(text(h, `notes/a (ipfs conflict ${TODAY} 2).md`)).toBe("LOCAL edit two");
    expect(text(h, "notes/a.md")).toBe("REMOTE edit two");
  });

  it("treats an untracked local file that differs from the remote as a conflict", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    h.host.put(".ipfs-sync-fixture", "marker");
    h.host.put("c.md", "predates the record");
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 3, conflicted: 1 });
    expect(text(h, `c (ipfs conflict ${TODAY}).md`)).toBe("predates the record");
    expect(text(h, "c.md")).toBe("charlie");
  });

  it("never lets a conflict copy take the name of a file the manifest is about to deliver", async () => {
    const h = harness();
    const files = { "a.md": "remote a", [`a (ipfs conflict ${TODAY}).md`]: "another device's copy" };
    await seedRemote(h.gateway, files, { tree: TREE1, root: ROOT1 });
    h.host.put(".ipfs-sync-fixture", "marker");
    h.host.put("a.md", "my local a");
    const result = await h.run();
    expect(result.failed).toBe(0);
    expect(text(h, `a (ipfs conflict ${TODAY}).md`)).toBe("another device's copy");
    expect(text(h, `a (ipfs conflict ${TODAY} 2).md`)).toBe("my local a");
    expect(text(h, "a.md")).toBe("remote a");
  });

  it("keeps the local content and fails the file when the copy cannot be written", async () => {
    const h = await conflicted();
    h.host.failOn.rename = /conflict/;
    h.conflicts.length = 0;
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 0, conflicted: 0, failed: 1 });
    expect(text(h, "notes/a.md")).toBe("LOCAL edit");
    expect(h.conflicts).toEqual([]);
    expect(leftovers(h)).toEqual([]);
    const state = await readState(h.host.kv);
    expect(state?.manifest.files["notes/a.md"]?.sha256).toBe(await sha("alpha"));
  });
});

describe("pullVault: integrity and failures", () => {
  it("writes the verified files, fails the mismatching one and reverts its record entry", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    h.gateway.corrupt = /notes\/b\.md$/;
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 2, failed: 1 });
    expect(result.failures).toEqual([{ path: "notes/b.md", reason: expect.stringContaining("sha256 differs") }]);
    expect(h.host.files.has("notes/b.md")).toBe(false);
    expect(leftovers(h)).toEqual([]);
    expect(text(h, "notes/a.md")).toBe("alpha");
    const state = await readState(h.host.kv);
    expect(Object.keys(state?.manifest.files ?? {})).toEqual(["c.md", "notes/a.md"]);
    expect(h.completed[0]).toMatchObject({ failed: 1, fetched: 2 });
  });

  it("keeps the previous file and record entry when a replacement fails verification", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    await seedRemote(h.gateway, { ...FILES_V1, "c.md": "charlie two" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    h.gateway.truncate = /c\.md$/;
    const result = await h.run();
    expect(result.failed).toBe(1);
    expect(text(h, "c.md")).toBe("charlie");
    const state = await readState(h.host.kv);
    expect(state?.manifest.files["c.md"]?.sha256).toBe(await sha("charlie"));
  });

  it("refuses untrusted manifest paths without fetching them and continues with the rest", async () => {
    const h = harness();
    const hostile = { "../outside.md": "x", "/abs.md": "x", "a\\b.md": "x", ".ipfs-sync/state.json": "x", "ok.md": "fine" };
    await seedRemote(h.gateway, hostile, { tree: TREE1, root: ROOT1 });
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 1, failed: 4 });
    expect(result.failures.map((f) => f.path).sort()).toEqual(["../outside.md", ".ipfs-sync/state.json", "/abs.md", "a\\b.md"]);
    expect(text(h, "ok.md")).toBe("fine");
    expect([...h.host.files.keys()].filter((p) => p.startsWith("..") || p.startsWith("/"))).toEqual([]);
    expect(h.gateway.requests.filter((r) => /outside|abs\.md|state\.json|a\\/.test(r))).toEqual([]);
    const state = decodeState(h.host.kvStore.get(STATE_KEY) ?? new Uint8Array());
    expect(Object.keys(state.manifest.files)).toEqual(["ok.md"]);
  });

  it("fails a file behind a symlink and continues, leaving the link and its target alone", async () => {
    const h = harness();
    await seedRemote(h.gateway, { "linked/x.md": "new", "notes/a.md": "new a", "ok.md": "ok" }, { tree: TREE1, root: ROOT1 });
    h.host.put(".ipfs-sync-fixture", "marker");
    h.host.link("linked");
    h.host.put("linked/existing.md", "outside the vault", 7);
    h.host.link("notes/a.md");
    h.host.put("notes/a.md", "target of the link", 7);
    const before = [...h.host.mutations];
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 1, failed: 2 });
    expect(result.failures.map((f) => f.path)).toEqual(["linked/x.md", "notes/a.md"]);
    expect(result.failures.every((f) => f.reason.includes("symlink") || f.reason.includes("symbolic"))).toBe(true);
    expect(text(h, "notes/a.md")).toBe("target of the link");
    expect(text(h, "linked/existing.md")).toBe("outside the vault");
    expect(h.host.files.has("linked/x.md")).toBe(false);
    expect(h.host.mutations.slice(before.length).some((m) => m.includes("linked/") || m.includes("notes/a.md"))).toBe(false);
    expect(text(h, "ok.md")).toBe("ok");
  });
});

describe("pullVault: exclusion divergence", () => {
  it("warns, ignores the mtime shortcut and re-verifies every file, deleting nothing", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    const readsBefore = h.host.reads.count;
    await seedRemote(h.gateway, FILES_V1, { tree: TREE2, root: ROOT2, previousRoot: ROOT1, excludes: "a".repeat(64) });
    const result = await h.run();
    expect(result).toMatchObject({ forcedReverify: true, fetched: 0, unchanged: 3, failed: 0 });
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("a".repeat(64));
    expect(h.host.reads.count - readsBefore).toBe(3);
    expect(h.completed.at(-1)?.forcedReverify).toBe(true);
    expect(h.host.mutations.some((m) => m.startsWith("remove") && !m.includes(TEMP_DIR))).toBe(false);
  });
});

describe("pullVault: concurrency", () => {
  it("keeps between 4 and 6 fetches in flight for 100 missing files", async () => {
    const h = harness({ chunkSize: 4 });
    const files = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`bulk/f${String(index).padStart(3, "0")}.md`, `content of file ${index}`]));
    await seedRemote(h.gateway, files, { tree: TREE1, root: ROOT1 });
    const result = await h.run({ concurrency: 6 });
    expect(result.fetched).toBe(100);
    expect(h.gateway.stats.maxInFlight).toBeLessThanOrEqual(6);
    expect(h.gateway.stats.maxInFlight).toBeGreaterThanOrEqual(4);
  });
});

describe("pullVault: record shared with publish", () => {
  it("lets publish treat pulled files as already synchronised", async () => {
    const h = harness();
    await seedRemote(h.gateway, { "notes/a.md": "alpha", "c.md": "charlie" }, { tree: TREE1, root: ROOT1 });
    await h.run();
    const node = createFakeNode([{ name: KEY, id: IPNS_NAME }]);
    const published = await publishVault(
      { client: node.client, host: h.host, bus: createSyncEventBus() },
      { mfsRoot: MFS, keyName: KEY, ownedKeys: [IPNS_NAME], recordOwnedKey: async () => undefined },
    );
    expect(published).toMatchObject({ published: false, written: 0, removed: 0 });
    expect(node.calls.filter((c) => c.startsWith("write "))).toEqual([]);
  });
});

describe("pullVault: only the latest manifest advances the record", () => {
  async function twoVersions(): Promise<Harness> {
    const h = harness();
    await seedRemote(h.gateway, { "notes/a.md": "v1 text" }, { tree: TREE1, root: ROOT1 });
    await seedRemote(h.gateway, { "notes/a.md": "v2 text longer" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    await h.run();
    return h;
  }
  const recordBytes = (h: Harness): string => new TextDecoder().decode(h.host.kvStore.get(STATE_KEY) ?? new Uint8Array());

  it("leaves the record byte-identical for an older --manifest and prints the notice", async () => {
    const h = await twoVersions();
    const before = recordBytes(h);
    h.warnings.length = 0;
    await h.run({ selector: { kind: "historical", currentCid: TREE1 } });
    expect(text(h, "notes/a.md")).toBe("v1 text");
    expect(recordBytes(h)).toBe(before);
    expect(h.warnings).toEqual([`restored from ${TREE1}; sync record not advanced (next publish will overwrite newer remote content)`]);
  });

  it("does not advance the record for --manifest-file either", async () => {
    const h = await twoVersions();
    const before = recordBytes(h);
    const manifest = JSON.parse(decodeText(h.gateway.objects.get(`${ROOT2}/manifest.json`)));
    await h.run({ selector: { kind: "text", text: JSON.stringify(manifest) } });
    expect(recordBytes(h)).toBe(before);
  });

  it("advances the record when --manifest names the current latest snapshot", async () => {
    const h = harness();
    await seedRemote(h.gateway, { "notes/a.md": "v1 text" }, { tree: TREE1, root: ROOT1 });
    await seedRemote(h.gateway, { "notes/a.md": "v2 text longer" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    await h.run({ selector: { kind: "historical", currentCid: TREE2 } });
    expect((await readState(h.host.kv))?.manifest.rootCID).toBe(TREE2);
    expect(h.warnings).toEqual([]);
  });

  it("makes the next publish write the restored files", async () => {
    const h = await twoVersions();
    await h.run({ selector: { kind: "historical", currentCid: TREE1 } });
    const node = createFakeNode([{ name: KEY, id: IPNS_NAME }]);
    const published = await publishVault(
      { client: node.client, host: h.host, bus: createSyncEventBus() },
      { mfsRoot: MFS, keyName: KEY, ownedKeys: [IPNS_NAME], recordOwnedKey: async () => undefined },
    );
    expect(published).toMatchObject({ published: true, written: 1 });
    expect(node.calls.filter((c) => c.startsWith("write ") && c.endsWith("notes/a.md"))).toHaveLength(1);
  });
});

const decodeText = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

describe("pullVault: forged manifest with excluded paths", () => {
  it("writes none of them, counts each as failed with a reason, and still pulls the legitimate files", async () => {
    const h = harness();
    const files = { ...FILES_V1, ".obsidian/plugins/x/main.js": "evil", ".ipfs-sync/state.json": "{}", ".git/config": "cfg", ".trash/x": "t" };
    await seedRemote(h.gateway, files, { tree: TREE1, root: ROOT1 });
    const result = await h.run();
    expect(result.fetched).toBe(3);
    expect(result.failed).toBe(4);
    expect(result.failures.map((f) => f.path).sort()).toEqual([".git/config", ".ipfs-sync/state.json", ".obsidian/plugins/x/main.js", ".trash/x"]);
    expect(result.failures.every((f) => f.reason !== "")).toBe(true);
    for (const path of [".obsidian/plugins/x/main.js", ".git/config", ".trash/x"]) expect(h.host.files.has(path)).toBe(false);
    expect(h.gateway.requests.some((r) => r.includes("plugins"))).toBe(false);
  });
});
