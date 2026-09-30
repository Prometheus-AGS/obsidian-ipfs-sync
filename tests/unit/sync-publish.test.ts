import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/config";
import { createSyncEventBus, type FileChangedEvent, type PublishCompleteEvent } from "../../src/core/events";
import { parseManifest } from "../../src/sync/manifest";
import { publishVault, type PublishOptions, type PublishResult } from "../../src/sync/publish";
import { OwnedKeyNotRecordedError, TransferFailedError, UnsafeTargetError, WriteVerificationError } from "../../src/sync/publish-errors";
import { STATE_KEY, buildState, encodeState, readState } from "../../src/sync/state";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";

const ROOT = "/obsidian-vault-sync/mvp02-test";
const KEY = "obsidian-vault-sync";
const decode = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

interface Harness {
  readonly host: MemoryHost;
  readonly node: FakeNode;
  readonly changed: FileChangedEvent[];
  readonly completed: PublishCompleteEvent[];
  readonly recorded: string[];
  run(overrides?: Partial<PublishOptions>): Promise<PublishResult>;
}

function harness(options: { readonly keys?: { name: string; id: string }[]; readonly marker?: boolean } = {}): Harness {
  const host = createMemoryHost({ env: { IPFS_SYNC_DEVICE: "test-device" } });
  if (options.marker !== false) host.put(".ipfs-sync-fixture", "fixture\n");
  const node = createFakeNode(options.keys);
  const bus = createSyncEventBus();
  const changed: FileChangedEvent[] = [];
  const completed: PublishCompleteEvent[] = [];
  const recorded: string[] = [];
  bus.on("file.changed", (event) => void changed.push(event));
  bus.on("publish.complete", (event) => void completed.push(event));
  const base: PublishOptions = {
    mfsRoot: ROOT,
    keyName: KEY,
    ownedKeys: [],
    recordOwnedKey: async (id) => void recorded.push(id),
    concurrency: 1,
  };
  return {
    host,
    node,
    changed,
    completed,
    recorded,
    run: (overrides = {}) => publishVault({ client: node.client, host, bus }, { ...base, ...overrides }),
  };
}

function seed(h: Harness): void {
  h.host.put("notes/hello.md", "hello", 1000);
  h.host.put("attachment.bin", new Uint8Array([1, 2, 3]), 1000);
  h.host.put(".trash/old.md", "trash", 1000);
  h.host.put(".obsidian/workspace.json", "{}", 1000);
}

const isFileOp = (call: string): boolean => /^(write|stat) .*\/current\/./.test(call);

describe("publishVault: first publish", () => {
  it("issues the requests in the specified order and publishes the root CID with ttl 5m", async () => {
    const h = harness();
    seed(h);
    const result = await h.run();

    const calls = h.node.calls;
    const current = `${ROOT}/current`;
    const currentCid = h.node.cidOf(current) as string;
    const rootCid = h.node.cidOf(ROOT) as string;
    expect(calls[0]).toBe("keyList");
    expect(calls[1]).toBe(`keyGen ${KEY}`);
    expect(calls.filter(isFileOp)).toEqual([
      `write ${current}/attachment.bin`,
      `stat ${current}/attachment.bin`,
      `write ${current}/notes/hello.md`,
      `stat ${current}/notes/hello.md`,
    ]);
    expect(calls.slice(2 + 4)).toEqual([
      `stat ${current}`,
      `write ${ROOT}/manifest.json`,
      `stat ${ROOT}/manifests/${currentCid}.json`,
      `write ${ROOT}/manifests/${currentCid}.json`,
      `stat ${ROOT}`,
      `pin ${rootCid}`,
      `publish ${KEY} ${rootCid} 5m`,
    ]);
    expect(result).toMatchObject({ published: true, written: 2, removed: 0, keyCreated: true, rootCid, currentCid });
  });

  it("records the generated key ID before any file is written, and never touches excluded paths", async () => {
    const h = harness();
    seed(h);
    await h.run();
    expect(h.recorded).toEqual([h.node.keys[0]?.id]);
    expect([...h.node.files.keys()].some((path) => /\.trash|workspace|fixture/.test(path))).toBe(false);
  });

  it("stores a manifest whose rootCID is the CID of current/ and that lists every published file", async () => {
    const h = harness();
    seed(h);
    const result = await h.run();
    const latest = parseManifest(decode(h.node.files.get(`${ROOT}/manifest.json`)));
    const archived = parseManifest(decode(h.node.files.get(`${ROOT}/manifests/${result.currentCid}.json`)));
    expect(latest).toEqual(archived);
    expect(latest.rootCID).toBe(h.node.cidOf(`${ROOT}/current`));
    expect(latest.device).toBe("test-device");
    expect(Object.keys(latest.files)).toEqual(["attachment.bin", "notes/hello.md"]);
    expect(latest.files["notes/hello.md"]?.size).toBe(5);
    expect(h.node.published.get(h.node.keys[0]?.id ?? "")).toBe(`/ipfs/${result.rootCid}`);
  });

  it("emits file.changed once per written file and one publish.complete, after the state is written", async () => {
    const h = harness();
    seed(h);
    const result = await h.run();
    expect(h.changed.map((e) => `${e.kind}:${e.path}`).sort()).toEqual(["added:attachment.bin", "added:notes/hello.md"]);
    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]).toMatchObject({ rootCid: result.rootCid, manifestCid: result.currentCid, written: 2, removed: 0 });
    expect(await readState(h.host.kv)).toMatchObject({ mfsRoot: ROOT, key: KEY, rootCid: result.rootCid });
    const allowed = new Set(["path", "kind", "sha256", "rootCid", "manifestCid", "written", "removed", "durationMs"]);
    expect([...h.changed, ...h.completed].flatMap((event) => Object.keys(event)).every((key) => allowed.has(key))).toBe(true);
  });
});

describe("publishVault: delta behaviour", () => {
  it("sends nothing and creates no manifest when the vault is unchanged", async () => {
    const h = harness();
    seed(h);
    await h.run();
    h.node.calls.length = 0;
    h.changed.length = 0;
    h.completed.length = 0;
    const again = await h.run({ ownedKeys: [h.node.keys[0]?.id ?? ""] });
    expect(again).toMatchObject({ published: false, written: 0, removed: 0, keyCreated: false });
    expect(h.node.calls).toEqual(["keyList"]);
    expect(h.changed).toEqual([]);
    expect(h.completed).toEqual([]);
  });

  it("writes exactly one file after one edit and reports the new sha256 in the manifest", async () => {
    const h = harness();
    seed(h);
    await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    h.node.calls.length = 0;
    h.host.put("notes/hello.md", "hello, edited", 2000);
    const again = await h.run({ ownedKeys: owned });
    expect(again).toMatchObject({ published: true, written: 1, removed: 0 });
    expect(h.node.calls.filter((c) => c.startsWith("write ") && c.includes("/current/"))).toEqual([`write ${ROOT}/current/notes/hello.md`]);
    const latest = parseManifest(decode(h.node.files.get(`${ROOT}/manifest.json`)));
    expect(latest.files["notes/hello.md"]?.size).toBe(13);
    expect(h.changed.slice(-1)[0]).toMatchObject({ path: "notes/hello.md", kind: "modified" });
  });

  it("removes a deleted file remotely, counts it, and keeps earlier manifests", async () => {
    const h = harness();
    seed(h);
    const first = await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    h.host.drop("attachment.bin");
    const second = await h.run({ ownedKeys: owned });
    expect(second).toMatchObject({ written: 0, removed: 1 });
    expect(h.node.files.has(`${ROOT}/current/attachment.bin`)).toBe(false);
    expect(h.node.files.has(`${ROOT}/manifests/${first.currentCid}.json`)).toBe(true);
    expect(h.node.files.has(`${ROOT}/manifests/${second.currentCid}.json`)).toBe(true);
    expect(Object.keys(parseManifest(decode(h.node.files.get(`${ROOT}/manifest.json`))).files)).toEqual(["notes/hello.md"]);
    expect(h.changed.slice(-1)[0]).toEqual({ path: "attachment.bin", kind: "removed" });
  });

  it("never overwrites an archived manifest when the content returns to an earlier state", async () => {
    const h = harness();
    h.host.put("a.md", "one", 1000);
    const first = await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    h.host.put("a.md", "two", 2000);
    await h.run({ ownedKeys: owned });
    h.host.put("a.md", "one", 3000);
    h.node.calls.length = 0;
    const third = await h.run({ ownedKeys: owned });
    expect(third.currentCid).toBe(first.currentCid);
    expect(h.node.calls.filter((c) => c === `write ${ROOT}/manifests/${first.currentCid}.json`)).toEqual([]);
    expect(h.node.calls).toContain(`write ${ROOT}/manifest.json`);
  });

  it("ignores a last-published record made for a different MFS root", async () => {
    const h = harness();
    seed(h);
    const first = await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    const stale = await readState(h.host.kv);
    if (stale === undefined) throw new Error("state expected");
    await h.host.kv.set(STATE_KEY, encodeState(buildState({ ...stale, mfsRoot: "/obsidian-vault-sync/elsewhere" })));
    const second = await h.run({ ownedKeys: owned });
    expect(second.written).toBe(2);
    expect(second.currentCid).toBe(first.currentCid);
  });
});

describe("publishVault: failure handling", () => {
  it("does not publish, does not advance the state and emits nothing when a write fails; a rerun converges", async () => {
    const h = harness();
    seed(h);
    h.node.failWriteFor = /notes\/hello\.md$/;
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferFailedError);
    expect((error as TransferFailedError).failures[0]?.path).toBe("notes/hello.md");
    expect(h.node.calls.some((c) => c.startsWith("publish ") || c.startsWith("pin "))).toBe(false);
    expect(h.host.kvStore.has(STATE_KEY)).toBe(false);
    expect(h.changed).toEqual([]);
    expect(h.completed).toEqual([]);

    h.node.failWriteFor = undefined;
    const recovered = await h.run({ ownedKeys: [h.node.keys[0]?.id ?? ""] });
    expect(recovered).toMatchObject({ published: true, written: 2 });
    expect(h.completed).toHaveLength(1);
  });

  it("fails the file and does not publish on a short write", async () => {
    const h = harness();
    seed(h);
    h.node.shortWriteFor = /attachment\.bin$/;
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransferFailedError);
    expect(((error as TransferFailedError).failures[0]?.error) instanceof WriteVerificationError).toBe(true);
    expect(h.node.calls.some((c) => c.startsWith("publish "))).toBe(false);
    expect(h.host.kvStore.has(STATE_KEY)).toBe(false);
  });

  it("converges after a partial removal (the file is already gone remotely)", async () => {
    const h = harness();
    seed(h);
    await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    h.host.drop("attachment.bin");
    h.node.files.delete(`${ROOT}/current/attachment.bin`);
    const result = await h.run({ ownedKeys: owned });
    expect(result).toMatchObject({ published: true, removed: 1 });
  });

  it("refuses a removal that resolves outside current/ and publishes nothing", async () => {
    const h = harness();
    seed(h);
    const first = await h.run();
    const owned = [h.node.keys[0]?.id ?? ""];
    const state = await readState(h.host.kv);
    if (state === undefined) throw new Error("state expected");
    const files = { ...state.manifest.files, "../../obsidian-vault-staging/x.md": { sha256: "0".repeat(64), size: 1, cid: "bafx" } };
    await h.host.kv.set(STATE_KEY, encodeState(buildState({ ...state, manifest: { ...state.manifest, files } })));
    h.node.calls.length = 0;
    const error = await h.run({ ownedKeys: owned }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect(h.node.calls.some((c) => c.startsWith("rm ") || c.startsWith("publish "))).toBe(false);
    expect(first.published).toBe(true);
  });

  it("fails before the first write when a file name is unsafe for MFS", async () => {
    const h = harness();
    h.host.put("100% done.md", "x");
    h.host.put("ok.md", "y");
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(h.node.calls.some((c) => c.startsWith("write "))).toBe(false);
  });
});

describe("publishVault: guards before any request", () => {
  it("refuses a vault without the fixture marker with no request at all", async () => {
    const h = harness({ marker: false });
    h.host.put("real-note.md", "private");
    await expect(h.run()).rejects.toMatchObject({ code: "plaintext-publish-refused" });
    expect(h.node.calls).toEqual([]);
  });

  it.each(["/obsidian-vault-staging", "/obsidian-vault-sync", "/obsidian-vault-sync/../other", "/"])(
    "refuses the MFS root %s with no request",
    async (mfsRoot) => {
      const h = harness();
      seed(h);
      await expect(h.run({ mfsRoot })).rejects.toBeInstanceOf(ConfigError);
      expect(h.node.calls).toEqual([]);
    },
  );

  it.each(["consult-capture", "gomark-relay-lab", "prince-live", "self"])("refuses the key %s with no request", async (keyName) => {
    const h = harness();
    seed(h);
    await expect(h.run({ keyName })).rejects.toBeInstanceOf(ConfigError);
    expect(h.node.calls).toEqual([]);
  });
});

describe("publishVault: publication key", () => {
  it("refuses a foreign key of the same name and sends neither a write nor name/publish", async () => {
    const h = harness({ keys: [{ name: "obsidian-vault", id: "k51foreign" }] });
    seed(h);
    await expect(h.run({ keyName: "obsidian-vault" })).rejects.toMatchObject({ code: "foreign-key" });
    expect(h.node.calls).toEqual(["keyList"]);
  });

  it("adopts a foreign key only when its exact ID is passed", async () => {
    const h = harness({ keys: [{ name: "obsidian-vault", id: "k51foreign" }] });
    seed(h);
    await expect(h.run({ keyName: "obsidian-vault", ownedKeys: ["k51other"] })).rejects.toMatchObject({ code: "foreign-key" });
    const result = await h.run({ keyName: "obsidian-vault", ownedKeys: ["k51foreign"] });
    expect(result).toMatchObject({ published: true, keyId: "k51foreign", keyCreated: false });
    expect(h.node.calls.some((c) => c.startsWith("keyGen"))).toBe(false);
  });

  it("does not generate a key that already exists and is owned", async () => {
    const h = harness({ keys: [{ name: KEY, id: "k51mine" }] });
    seed(h);
    await h.run({ ownedKeys: ["k51mine"] });
    expect(h.node.calls.some((c) => c.startsWith("keyGen"))).toBe(false);
    expect(h.recorded).toEqual([]);
  });

  it("stops before any write when the generated key ID cannot be recorded, naming the ID", async () => {
    const h = harness();
    seed(h);
    const error = await h
      .run({
        recordOwnedKey: async () => {
          throw new Error("read-only file system");
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnedKeyNotRecordedError);
    const id = h.node.keys[0]?.id ?? "";
    expect((error as Error).message).toContain(`--owned-key ${id}`);
    expect(h.node.calls).toEqual(["keyList", `keyGen ${KEY}`]);
  });

  it("classifies a key whose ID the node hides as foreign", async () => {
    const h = harness({ keys: [{ name: KEY, id: "" }] });
    seed(h);
    await expect(h.run({ ownedKeys: ["k51mine"] })).rejects.toMatchObject({ code: "foreign-key" });
    expect(h.node.calls).toEqual(["keyList"]);
  });
});

describe("publishVault: device-local plugin files", () => {
  it("plugin code and data are absent from the manifest and no stored bytes contain a seeded token", async () => {
    const h = harness();
    seed(h);
    const token = "seeded-token-Zx81";
    h.host.put(".obsidian/plugins/ipfs-sync/data.json", JSON.stringify({ auth: { scheme: "bearer", token } }), 1000);
    h.host.put(".obsidian/plugins/ipfs-sync/main.js", "// plugin", 1000);
    await h.run();

    const manifest = parseManifest(decode(h.node.files.get(`${ROOT}/manifest.json`)));
    expect(Object.keys(manifest.files)).toContain("notes/hello.md");
    expect(Object.keys(manifest.files).filter((p) => p.startsWith(".obsidian/plugins/"))).toEqual([]);
    for (const [path, bytes] of h.node.files) {
      expect(path).not.toContain("data.json");
      expect(decode(bytes)).not.toContain(token);
    }
    expect(h.node.calls.some((call) => call.includes(token))).toBe(false);
  });
});
