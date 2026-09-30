import { describe, expect, it } from "vitest";
import type { Bytes, HostKv } from "../../src/core/host-bridge";
import { KuboHttpError } from "../../src/kubo";
import { createObsidianFs } from "../../src/plugin/obsidian-fs";
import { createFolderKv } from "../../src/plugin/obsidian-kv";
import { MemoryAdapter } from "../support/memory-adapter";
import { EncryptedVaultError, PlaintextV1RefusedError } from "../../src/sync/pull-errors";
import { LATCH_KEY, isLatched, recordEncryptedSeen } from "../../src/sync/pull-latch";
import { rootFileNames } from "../../src/sync/root-files";
import { ABANDON_CONFIRMATION, abandonVault } from "../../src/sync/vault-keys";
import { excludedPathReason } from "../../src/sync/pull-plan";
import { FILES_V1, MFS, ROOT1, TREE1, harness, type Harness } from "../helpers/pull-harness";
import { IPNS_NAME, encode, seedRemote } from "../helpers/pull-fixtures";

function createMemoryKv(): Pick<HostKv, "get" | "set" | "list"> {
  const store = new Map<string, Bytes>();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => void store.set(key, value),
    list: async (prefix) => [...store.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

const NOT_MANIFEST_READ = (request: string): boolean => !/manifest\.json|manifests\//.test(request);

/** A root the way an encrypted publish leaves it: key slots and `manifest.enc`, no `manifest.json`. */
async function encryptedRoot(h: Harness, present: readonly string[] = ["keyslots.json", "manifest.enc"]): Promise<void> {
  await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
  h.gateway.objects.delete(`${ROOT1}/manifest.json`);
  h.gateway.objects.delete(`${ROOT1}/manifests/${TREE1}.json`);
  for (const name of present) h.gateway.objects.set(`${ROOT1}/${name}`, encode("opaque"));
}

describe("pull of an encrypted root", () => {
  it.each([[["keyslots.json"]], [["manifest.enc"]], [["keyslots.json", "manifest.enc"]]] as const)(
    "stops with the not-supported-yet error when the root holds %j, writes nothing to the vault and sets the latch",
    async (present) => {
      const h = harness();
      await encryptedRoot(h, present);
      const error = await h.run().then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(EncryptedVaultError);
      expect((error as Error).message).toMatch(/encrypted vault.*not supported yet/);
      expect(h.host.mutations).toEqual([]);
      expect(h.host.files.size).toBe(0);
      expect(h.host.kvStore.has(LATCH_KEY)).toBe(true);
      expect(h.gateway.requests.every(NOT_MANIFEST_READ)).toBe(true);
      expect(h.gateway.ranges.every(([start, length]) => start === 0 && length === 1)).toBe(true);
      expect(h.changed).toEqual([]);
      expect(h.completed).toEqual([]);
    },
  );

  it("stops even when a plaintext manifest.json sits beside the key slots (a hybrid root is not read as plaintext)", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    h.gateway.objects.set(`${ROOT1}/keyslots.json`, encode("{}"));
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
    expect(h.gateway.requests.every(NOT_MANIFEST_READ)).toBe(true);
  });

  it("is stopped the same way for a manifest given as text: the root is screened first", async () => {
    const h = harness();
    await encryptedRoot(h);
    await expect(h.run({ selector: { kind: "text", text: "{}" } })).rejects.toBeInstanceOf(EncryptedVaultError);
  });

  it("does not write the fixture marker for an encrypted root, and asks the node only for read-only one-byte ranges", async () => {
    const h = harness();
    await encryptedRoot(h);
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
    expect(h.host.files.has(".ipfs-sync-fixture")).toBe(false);
    expect(h.gateway.requests.filter((request) => request.startsWith("GET ")).every((request) => request.includes("Range: bytes=0-0"))).toBe(true);
  });

  it("records what it saw, keeps earlier sightings, and holds no secret", async () => {
    const h = harness();
    await encryptedRoot(h);
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
    const latch = JSON.parse(new TextDecoder().decode(h.host.kvStore.get(LATCH_KEY))) as { sightings: { ipnsName: string; mfsRoot: string; key: string; at: string }[] };
    expect(latch.sightings).toHaveLength(2);
    expect(latch.sightings[0]).toMatchObject({ ipnsName: IPNS_NAME, mfsRoot: MFS, key: "obsidian-vault-sync" });
    expect(Object.keys(latch.sightings[0] ?? {}).sort()).toEqual(["at", "ipnsName", "key", "mfsRoot"]);
  });

  it("treats a failure to ask as a failure, never as absence: an error that is not 404 stops the pull without reading a manifest", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    const stream = h.gateway.client.gatewayStream;
    h.gateway.client.gatewayStream = async (cid, path, range) => {
      if (path === "keyslots.json") throw new KuboHttpError("gateway", "https://gw.test", 500, "gateway busy");
      return stream(cid, path, range);
    };
    await expect(h.run()).rejects.toBeInstanceOf(KuboHttpError);
    expect(h.host.files.size).toBe(0);
    expect(h.host.kvStore.has(LATCH_KEY)).toBe(false);
  });

  it("reads a 416 answer to the one-byte range (an empty file) as the object being there", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    const stream = h.gateway.client.gatewayStream;
    h.gateway.client.gatewayStream = async (cid, path, range) => {
      if (path === "manifest.enc") throw new KuboHttpError("gateway", "https://gw.test", 416, "range not satisfiable");
      return stream(cid, path, range);
    };
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
  });
});

describe("the plaintext reader is off by default and never returns after an encrypted vault", () => {
  it("refuses a plaintext root without the flag, naming it, reading no manifest and setting no latch", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    const error = await h.run({ allowPlaintextV1: false }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(PlaintextV1RefusedError);
    expect(error).toMatchObject({ reason: "flag-required" });
    expect((error as Error).message).toContain("--allow-plaintext-v1");
    expect(h.gateway.requests.every(NOT_MANIFEST_READ)).toBe(true);
    expect(h.host.files.size).toBe(0);
    expect(h.host.kvStore.has(LATCH_KEY)).toBe(false);
  });

  it("refuses when the option is left out, the same as false", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(h.run({ allowPlaintextV1: undefined })).rejects.toMatchObject({ reason: "flag-required" });
  });

  it("works with the flag on a plaintext root that never held an encrypted vault", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    expect(await h.run()).toMatchObject({ fetched: 3, failed: 0 });
  });

  it("refuses a plaintext root after an encrypted one was seen, even with the flag: the downgrade", async () => {
    const h = harness();
    await encryptedRoot(h);
    await expect(h.run()).rejects.toBeInstanceOf(EncryptedVaultError);
    h.gateway.objects.delete(`${ROOT1}/keyslots.json`);
    h.gateway.objects.delete(`${ROOT1}/manifest.enc`);
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(h.run({ allowPlaintextV1: true })).rejects.toMatchObject({ reason: "downgrade" });
    await expect(h.run({ allowPlaintextV1: false })).rejects.toMatchObject({ reason: "downgrade" });
    expect(h.host.files.size).toBe(0);
  });

  it.each(["state", "journal", "keyslots"] as const)("counts the %s file of an encrypted publish as the latch", async (kind) => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.host.kv.set(rootFileNames("/obsidian-vault-sync/somewhere")[kind], encode("{}"));
    await expect(h.run({ allowPlaintextV1: true })).rejects.toMatchObject({ reason: "downgrade" });
  });

  it("keeps the latch when its file cannot be read, and the v1 pull record does not count as evidence", async () => {
    const h = harness();
    await h.host.kv.set("state.json", encode("{}"));
    expect(await isLatched(h.host.kv)).toBe(false);
    await h.host.kv.set(LATCH_KEY, encode("{ not json"));
    expect(await isLatched(h.host.kv)).toBe(true);
    await recordEncryptedSeen(h.host.kv, { ipnsName: IPNS_NAME, mfsRoot: MFS, key: "k", at: "2026-09-30T00:00:00.000Z" });
    expect(JSON.parse(new TextDecoder().decode(h.host.kvStore.get(LATCH_KEY)))).toMatchObject({ encryptedSeen: true });
  });
});

describe("abandoning a vault does not reopen the plaintext reader (R5-02)", () => {
  /** The real hosts' key-value store is the `.ipfs-sync/` folder: mirror what a file operation left there into `kv`. */
  async function mirrorFolderIntoKv(h: Harness): Promise<void> {
    for (const entry of await h.host.fs.list(".ipfs-sync")) {
      await h.host.kv.set(entry.name, entry.kind === "file" ? await h.host.fs.read(`.ipfs-sync/${entry.name}`) : encode(""));
    }
  }

  it("still refuses a plaintext-v1 pull with the flag after publish, abandon: the downgrade", async () => {
    const h = harness();
    const names = rootFileNames(MFS);
    for (const name of [names.keyslots, names.state, names.journal]) await h.host.fs.write(`.ipfs-sync/${name}`, encode("{}"));
    const abandoned = await abandonVault({ fs: h.host.fs, mfsRoot: MFS, confirmation: ABANDON_CONFIRMATION, nowMs: 1_700 });
    expect(abandoned.moved).toHaveLength(3);
    await mirrorFolderIntoKv(h);
    expect(h.host.kvStore.has(names.keyslots)).toBe(false);
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await expect(h.run({ allowPlaintextV1: true })).rejects.toMatchObject({ reason: "downgrade" });
  });

  it("counts an abandoned-<h>-<ms> backup folder alone as evidence, and ignores look-alike names", async () => {
    const kv = createMemoryKv();
    await kv.set("abandoned-nothex-1", encode(""));
    await kv.set("abandoned-0123456789abcdef-", encode(""));
    expect(await isLatched(kv)).toBe(false);
    await kv.set("abandoned-0123456789abcdef-1700", encode(""));
    expect(await isLatched(kv)).toBe(true);
  });

  it("C5-01: the plugin's real folder kv lists the abandoned-<h>-<ms> FOLDER, so the latch holds after encrypted-seen.json is deleted", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(".ipfs-sync/keep.json", "{}");
    const kv = createFolderKv(createObsidianFs(adapter));
    expect(await isLatched(kv)).toBe(false);
    for (const lookAlike of ["abandoned-nothex-1", "abandoned-0123456789abcdef-", "other-folder"]) await adapter.mkdir(`.ipfs-sync/${lookAlike}`);
    expect(await kv.list("")).toEqual(["keep.json"]);
    expect(await isLatched(kv)).toBe(false);
    await adapter.mkdir(".ipfs-sync/abandoned-0123456789abcdef-1700");
    adapter.put(".ipfs-sync/abandoned-0123456789abcdef-1700/keyslots.0123456789abcdef.json", "{}");
    expect(await kv.list("aband")).toEqual(["abandoned-0123456789abcdef-1700"]);
    expect(await kv.get(LATCH_KEY)).toBeUndefined();
    expect(await isLatched(kv)).toBe(true);
  });
});

describe("pull refuses Obsidian's configuration folder", () => {
  it.each([".obsidian/app.json", ".obsidian/themes/x/theme.css", ".Obsidian/hotkeys.json", ".obsidian"])("refuses the manifest path %j", (path) => {
    expect(excludedPathReason(path, [])).toMatch(/\.obsidian/);
  });

  it("still names the plugin folder specifically, and leaves ordinary notes alone", () => {
    expect(excludedPathReason(".obsidian/plugins/x/main.js", [])).toContain("plugin");
    expect(excludedPathReason("notes/.obsidian-tips.md", [])).toBeUndefined();
    expect(excludedPathReason("obsidian/app.json", [])).toBeUndefined();
  });

  it("counts a forged .obsidian/app.json as failed and writes nothing, while the notes arrive", async () => {
    const h = harness();
    await seedRemote(h.gateway, { ...FILES_V1, ".obsidian/app.json": "{}" }, { tree: TREE1, root: ROOT1 });
    const result = await h.run();
    expect(result).toMatchObject({ fetched: 3, failed: 1 });
    expect(result.failures[0]?.path).toBe(".obsidian/app.json");
    expect(h.host.files.has(".obsidian/app.json")).toBe(false);
  });
});
