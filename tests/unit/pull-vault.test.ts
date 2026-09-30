import { describe, expect, it } from "vitest";
import { ManifestError } from "../../src/sync/manifest";
import { PullGuardError, PullSourceError, PullTargetError } from "../../src/sync/pull-errors";
import { readState } from "../../src/sync/state";
import { FILES_V1, KEY, ROOT1, ROOT2, TREE1, TREE2, harness, leftovers, text } from "../helpers/pull-harness";
import { IPNS_NAME, seedRemote, sha } from "../helpers/pull-fixtures";

describe("pullVault: first pull into an absent destination", () => {
  it("fetches every file, creates the marker, records the manifest and emits the events", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 3, unchanged: 0, conflicted: 0, failed: 0, remoteDeleted: 0, rootCid: ROOT1, manifestCid: TREE1 });
    expect(text(h, "notes/a.md")).toBe("alpha");
    expect(text(h, "c.md")).toBe("charlie");
    expect(h.host.files.has(".ipfs-sync-fixture")).toBe(true);
    expect(leftovers(h)).toEqual([]);
    const state = await readState(h.host.kv);
    expect(Object.keys(state?.manifest.files ?? {})).toEqual(["c.md", "notes/a.md", "notes/b.md"]);
    expect(state?.mtimes["c.md"]).toBe(h.host.files.get("c.md")?.mtimeMs);
    expect(h.changed.map((e) => `${e.kind} ${e.path}`).sort()).toEqual(["added c.md", "added notes/a.md", "added notes/b.md"]);
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]).toMatchObject({ fetched: 3, rootCid: ROOT1, forcedReverify: false });
    expect(h.warnings).toEqual([]);
  });

  it("requests only a name resolve and gateway reads when given --name", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    expect(h.gateway.requests.every((r) => r.startsWith("nameResolve ") || r.startsWith("GET "))).toBe(true);
    expect(h.gateway.requests[0]).toBe(`nameResolve ${IPNS_NAME}`);
  });

  it("does not write the marker or anything else when the manifest is invalid", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1, alter: (m) => ({ ...m, version: 2 as unknown as 1 }) });
    await expect(h.run()).rejects.toThrowError(ManifestError);
    expect(h.host.mutations).toEqual([]);
    expect(h.completed).toEqual([]);
  });
});

describe("pullVault: destination guard", () => {
  it("refuses a non-empty unmarked directory before any request and emits no pull.complete", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    h.host.put("private.md", "a real note");
    await expect(h.run()).rejects.toThrowError(PullGuardError);
    await expect(h.run()).rejects.toThrowError(/encryption is not available yet/);
    expect(h.gateway.requests).toEqual([]);
    expect(h.host.mutations).toEqual([]);
    expect(h.completed).toEqual([]);
  });

  it("allows an empty destination and a marked non-empty one", async () => {
    const empty = harness();
    await seedRemote(empty.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    expect((await empty.run()).fetched).toBe(3);

    const marked = harness();
    await seedRemote(marked.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    marked.host.put(".ipfs-sync-fixture", "marker");
    marked.host.put("other.md", "existing but marked");
    const result = await marked.run();
    expect(result.fetched).toBe(3);
    expect(text(marked, "other.md")).toBe("existing but marked");
  });

  it("refuses when the state folder is a symbolic link", async () => {
    const h = harness();
    h.host.link(".ipfs-sync");
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(h.run()).rejects.toThrowError(/symbolic link/);
    expect(h.gateway.requests).toEqual([]);
  });
});

describe("pullVault: target resolution", () => {
  it("uses the owned key's ID by default (key/list, then name/resolve)", async () => {
    const h = harness({ keys: [{ name: KEY, id: IPNS_NAME }] });
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run({ name: undefined, ownedKeys: [IPNS_NAME] });
    expect(h.gateway.requests.slice(0, 2)).toEqual(["keyList", `nameResolve ${IPNS_NAME}`]);
  });

  it("fails before fetching anything when the default key is unowned or absent", async () => {
    const unowned = harness({ keys: [{ name: KEY, id: IPNS_NAME }] });
    await seedRemote(unowned.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(unowned.run({ name: undefined, ownedKeys: [] })).rejects.toThrowError(PullTargetError);
    expect(unowned.gateway.requests).toEqual(["keyList"]);
    expect(unowned.host.mutations).toEqual([]);

    const absent = harness({ keys: [] });
    await expect(absent.run({ name: undefined })).rejects.toThrowError(/pass --name/);
  });

  it("rejects a malformed --name before any request", async () => {
    const h = harness();
    await expect(h.run({ name: "../evil" })).rejects.toThrowError(PullTargetError);
    expect(h.gateway.requests).toEqual([]);
  });

  it("fails on a name that resolves to something that is not a published root", async () => {
    const h = harness();
    h.gateway.names.set(IPNS_NAME, "/ipfs/bafyroot/sub");
    await expect(h.run()).rejects.toThrowError(PullSourceError);
    expect(h.host.mutations).toEqual([]);
  });
});

describe("pullVault: manifest selection", () => {
  it("restores a historical manifest from manifests/<currentCID>.json", async () => {
    const h = harness();
    await seedRemote(h.gateway, { "notes/a.md": "v1" }, { tree: TREE1, root: ROOT1 });
    await seedRemote(h.gateway, { "notes/a.md": "v2" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    const result = await h.run({ selector: { kind: "historical", currentCid: TREE1 } });
    expect(result.manifestCid).toBe(TREE1);
    expect(text(h, "notes/a.md")).toBe("v1");
    expect(h.gateway.requests).toContain(`GET ${ROOT2}/manifests/${TREE1}.json`);
  });

  it("fails before writing anything for an unknown historical manifest", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(h.run({ selector: { kind: "historical", currentCid: "bafyunknown00000000000" } })).rejects.toThrowError(PullSourceError);
    expect(h.host.mutations).toEqual([]);
    await expect(h.run({ selector: { kind: "historical", currentCid: "../x" } })).rejects.toThrowError(/not a CID/);
  });

  it("uses manifest text from a local file", async () => {
    const h = harness();
    const manifest = await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    const result = await h.run({ selector: { kind: "text", text: JSON.stringify(manifest) } });
    expect(result.fetched).toBe(3);
    expect(h.gateway.requests).not.toContain(`GET ${ROOT1}/manifest.json`);
  });
});

describe("pullVault: delta behaviour", () => {
  it("fetches nothing and rewrites nothing on an already synced vault", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    const writes = h.host.mutations.length;
    const reads = h.host.reads.count;
    h.gateway.requests.length = 0;
    const again = await h.run();
    expect(again).toMatchObject({ fetched: 0, unchanged: 3, conflicted: 0, failed: 0 });
    expect(h.host.mutations.length).toBe(writes);
    expect(h.host.reads.count).toBe(reads);
    expect(h.gateway.requests.filter((r) => r.includes("notes/") || r.endsWith("c.md"))).toEqual([]);
    expect(h.completed).toHaveLength(2);
  });

  it("replaces a remotely changed, locally untouched file without a conflict copy", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    await seedRemote(h.gateway, { ...FILES_V1, "notes/a.md": "alpha v2" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    h.changed.length = 0;
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 1, unchanged: 2, conflicted: 0, failed: 0 });
    expect(text(h, "notes/a.md")).toBe("alpha v2");
    expect([...h.host.files.keys()].filter((p) => p.includes("conflict"))).toEqual([]);
    expect(h.changed).toEqual([{ path: "notes/a.md", kind: "modified", sha256: await sha("alpha v2") }]);
    const requested = h.gateway.requests.filter((r) => r.startsWith(`GET ${TREE2}/`));
    expect(requested).toEqual([`GET ${TREE2}/notes/a.md`]);
  });

  it("leaves a locally edited file alone when the remote did not change and reports it", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    h.host.put("c.md", "my local edit", h.host.clock + 5000);
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 0, conflicted: 0, locallyModified: 1, locallyModifiedPaths: ["c.md"] });
    expect(text(h, "c.md")).toBe("my local edit");
  });

  it("reports a remote deletion and keeps the local file", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    await seedRemote(h.gateway, { "notes/a.md": "alpha", "notes/b.md": "bravo" }, { tree: TREE2, root: ROOT2, previousRoot: ROOT1 });
    const result = await h.run();
    expect(result).toMatchObject({ remoteDeleted: 1, remoteDeletedPaths: ["c.md"], failed: 0 });
    expect(text(h, "c.md")).toBe("charlie");
    expect(h.host.mutations.some((m) => m.startsWith("remove") && m.includes("c.md"))).toBe(false);
  });
});

