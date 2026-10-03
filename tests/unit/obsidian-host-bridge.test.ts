import { describe, expect, it, vi } from "vitest";
import type { Bytes } from "../../src/core/host-bridge";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createFolderKv, createPluginDataKv } from "../../src/plugin/obsidian-kv";
import { createSettingsStore, type PluginDataPort } from "../../src/plugin/settings-store";
import { loadSettings } from "../../src/plugin/settings-migration";
import { HostDeniedError, HostNotImplementedError, HostPathError } from "../../src/sync/host-errors";
import { MemoryAdapter } from "../support/memory-adapter";

const bytes = (text: string): Bytes => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

function memoryPort(): PluginDataPort & { data: unknown } {
  const port: PluginDataPort & { data: unknown } = {
    data: null,
    loadData: async () => (port.data === null ? null : structuredClone(port.data)),
    saveData: async (next: unknown) => {
      port.data = structuredClone(next);
    },
  };
  return port;
}

function setup(): { adapter: MemoryAdapter; port: ReturnType<typeof memoryPort>; host: ReturnType<typeof createObsidianHostBridge> } {
  const adapter = new MemoryAdapter();
  const port = memoryPort();
  const store = createSettingsStore(port, loadSettings(null));
  return { adapter, port, host: createObsidianHostBridge({ adapter, kv: createPluginDataKv(store), env: { IPFS_SYNC_DEVICE: "obsidian" } }) };
}

describe("obsidian host bridge: fs", () => {
  it("lists a directory with sizes and modification times, hidden folders included, sorted by name", async () => {
    const { adapter, host } = setup();
    adapter.put("notes/b.md", "bb", 20);
    adapter.put("a.md", "a", 10);
    adapter.put(".obsidian/app.json", "{}", 30);
    const root = await host.fs.list("");
    expect(root.map((e) => `${e.kind}:${e.name}`)).toEqual(["directory:.obsidian", "file:a.md", "directory:notes"]);
    expect(root.find((e) => e.name === "a.md")).toMatchObject({ size: 1, mtimeMs: 10 });
    expect((await host.fs.list("notes")).map((e) => e.name)).toEqual(["b.md"]);
  });

  it("stats files, folders, the root and missing paths", async () => {
    const { adapter, host } = setup();
    adapter.put("notes/a.md", "abc", 5);
    expect(await host.fs.stat("notes/a.md")).toEqual({ kind: "file", size: 3, mtimeMs: 5 });
    expect((await host.fs.stat("notes"))?.kind).toBe("directory");
    expect((await host.fs.stat(""))?.kind).toBe("directory");
    expect(await host.fs.stat("nope.md")).toBeUndefined();
    expect(await host.fs.lstat("notes/a.md")).toMatchObject({ kind: "file", size: 3 });
  });

  it("reads one file and a range that is a copy of only the requested bytes", async () => {
    const { adapter, host } = setup();
    adapter.put("big.bin", "0123456789");
    adapter.put("other.md", "other");
    expect(text(await host.fs.read("other.md"))).toBe("other");
    const range = await host.fs.readRange("big.bin", 3, 4);
    expect(text(range)).toBe("3456");
    expect(range.buffer.byteLength).toBe(4);
    expect(text(await host.fs.readRange("big.bin", 8, 100))).toBe("89");
    // Only the files that were asked for were read; the second range is served from the copy the first one loaded.
    expect(adapter.reads).toEqual(["other.md", "big.bin"]);
  });

  it("writes into a hidden folder that does not exist yet, creating each missing level", async () => {
    const { adapter, host } = setup();
    await host.fs.write(".ipfs-sync/deep/state.json", bytes("{}"));
    expect(adapter.text(".ipfs-sync/deep/state.json")).toBe("{}");
    expect(adapter.calls.filter((c) => c.startsWith("mkdir"))).toEqual(["mkdir .ipfs-sync", "mkdir .ipfs-sync/deep"]);
  });

  it("writes exactly the bytes of a view onto a larger buffer", async () => {
    const { adapter, host } = setup();
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9]);
    await host.fs.write("v.bin", whole.subarray(2, 5) as Bytes);
    expect([...new Uint8Array(adapter.files.get("v.bin")?.data ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
  });

  it("mkdir, remove, rename and append behave like the Node host", async () => {
    const { adapter, host } = setup();
    await host.fs.mkdir("a/b/c");
    expect(adapter.folders.has("a/b/c")).toBe(true);
    await host.fs.mkdir("a/b/c");
    await host.fs.write("a/x.txt", bytes("x"));
    await host.fs.remove("a/x.txt");
    await host.fs.remove("a/x.txt");
    expect(adapter.files.has("a/x.txt")).toBe(false);
    await expect(host.fs.remove("a/b")).rejects.toBeInstanceOf(HostPathError);

    await host.fs.write("old.txt", bytes("old"));
    await host.fs.write("new/target.txt", bytes("stale"));
    await host.fs.rename("old.txt", "new/target.txt");
    expect(adapter.text("new/target.txt")).toBe("old");
    expect(adapter.files.has("old.txt")).toBe(false);

    await host.fs.append("log/out.txt", bytes("a"));
    await host.fs.append("log/out.txt", bytes("b"));
    expect(adapter.text("log/out.txt")).toBe("ab");
  });

  it("refuses absolute paths, `..`, `.` segments, backslashes and NUL without touching any file", async () => {
    const { adapter, host } = setup();
    adapter.put("keep.md", "keep");
    adapter.calls.length = 0;
    const bad = ["../x", "a/../../x", "/etc/passwd", "a\\b", "a/./b", "nul\0"];
    for (const path of bad) {
      await expect(host.fs.read(path)).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.write(path, bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.stat(path)).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.list(path)).rejects.toBeInstanceOf(HostPathError);
    }
    await expect(host.fs.rename("keep.md", "../x")).rejects.toBeInstanceOf(HostPathError);
    expect(adapter.calls).toEqual([]);
    expect(adapter.reads).toEqual([]);
    expect(adapter.text("keep.md")).toBe("keep");
  });
});

describe("obsidian host bridge: kv", () => {
  it("round-trips bytes and leaves the settings alone, in the same stored file", async () => {
    const port = memoryPort();
    const initial = loadSettings(null);
    const store = createSettingsStore(port, initial);
    const kv = createPluginDataKv(store);
    const value = new Uint8Array([0, 1, 254, 255]) as Bytes;

    await store.update((settings) => ({ ...settings, publicationKey: "obsidian-vault-work" }));
    await kv.set("state.json", value);
    await store.update((settings) => ({ ...settings, ownedKeys: ["k51mine"] }));

    expect([...((await kv.get("state.json")) ?? [])]).toEqual([0, 1, 254, 255]);
    expect(await kv.get("missing")).toBeUndefined();
    // A "later session": reload from the stored data.
    const reloaded = loadSettings(port.data);
    expect(reloaded.outcome).toBe("current");
    expect(reloaded.settings.publicationKey).toBe("obsidian-vault-work");
    expect(reloaded.settings.ownedKeys).toEqual(["k51mine"]);
    const again = createPluginDataKv(createSettingsStore(port, reloaded));
    expect([...((await again.get("state.json")) ?? [])]).toEqual([0, 1, 254, 255]);
  });

  it("lists by prefix, sorted, deletes, and refuses malformed keys", async () => {
    const store = createSettingsStore(memoryPort(), loadSettings(null));
    const kv = createPluginDataKv(store);
    await kv.set("b.two", bytes("2"));
    await kv.set("a.one", bytes("1"));
    await kv.set("b.one", bytes("3"));
    expect(await kv.list("b.")).toEqual(["b.one", "b.two"]);
    await kv.delete("b.one");
    expect(await kv.list("")).toEqual(["a.one", "b.two"]);
    for (const key of ["", "-lead", "a/b", "a b", "x".repeat(129)]) {
      await expect(kv.get(key)).rejects.toBeInstanceOf(HostPathError);
    }
  });

  it("does not let a failed save run ahead of the stored data", async () => {
    const port = memoryPort();
    const store = createSettingsStore(port, loadSettings(null));
    port.saveData = () => Promise.reject(new Error("disk full"));
    await expect(store.update((s) => ({ ...s, ownedKeys: ["k51x"] }))).rejects.toThrowError("disk full");
    expect(store.get().ownedKeys).toEqual([]);
  });

  it("serialises concurrent updates so none is lost", async () => {
    const store = createSettingsStore(memoryPort(), loadSettings(null));
    await Promise.all([1, 2, 3].map((n) => store.update((s) => ({ ...s, ownedKeys: [...s.ownedKeys, `k${n}`] }))));
    expect([...store.get().ownedKeys].sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("keeps the engine state in the vault's .ipfs-sync folder, like the CLI host", async () => {
    const { adapter, host } = setup();
    const kv = createFolderKv(host.fs);
    expect(await kv.get("state.json")).toBeUndefined();
    await kv.set("state.json", bytes('{"v":1}'));
    expect(adapter.text(".ipfs-sync/state.json")).toBe('{"v":1}');
    expect(text((await kv.get("state.json")) ?? new Uint8Array())).toBe('{"v":1}');
    expect(await kv.list("st")).toEqual(["state.json"]);
    await kv.delete("state.json");
    expect(await kv.get("state.json")).toBeUndefined();
  });
});

describe("obsidian host bridge: other capabilities", () => {
  it("denies shell execution and reports agents as not implemented", async () => {
    const { host } = setup();
    await expect(host.shellExec({ command: "ls", args: [] })).rejects.toBeInstanceOf(HostDeniedError);
    await expect(host.agent.list()).rejects.toBeInstanceOf(HostNotImplementedError);
    await expect(host.agent.invoke({ agentId: "a", input: "x" })).rejects.toBeInstanceOf(HostNotImplementedError);
  });

  it("reads env, time, and fetches through the injected transport", async () => {
    const adapter = new MemoryAdapter();
    const transport = vi.fn(async () => new Response("pong", { status: 201, headers: { "x-a": "1" } }));
    const host = createObsidianHostBridge({
      adapter,
      kv: createPluginDataKv(createSettingsStore(memoryPort(), loadSettings(null))),
      env: { IPFS_SYNC_DEVICE: "obsidian" },
      transport,
      now: () => 42,
    });
    expect(host.envRead("IPFS_SYNC_DEVICE")).toBe("obsidian");
    expect(host.envRead("OTHER")).toBeUndefined();
    expect(host.timeNow()).toBe(42);
    const response = await host.net.fetch({ url: "https://example.org/x", method: "POST", body: bytes("ping") });
    expect(response.status).toBe(201);
    expect(text(response.body)).toBe("pong");
    expect(response.headers["x-a"]).toBe("1");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
