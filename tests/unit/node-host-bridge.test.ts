import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostPathError, createNodeHostBridge } from "../../cli/node-host-bridge";
import type { HostBridge } from "../../src/core/host-bridge";
import { HostNotImplementedError } from "../../src/sync/host-errors";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe("node host bridge", () => {
  let root: string;
  let host: HostBridge;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-host-"));
    host = createNodeHostBridge({ root, env: { IPFS_SYNC_DEVICE: "test-box" }, now: () => 1234 });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes with parents, reads, stats and lists sorted entries without symlinks", async () => {
    await host.fs.write("notes/deep/a.md", bytes("hello"));
    await host.fs.write("b.txt", bytes("bee"));
    await symlink(join(root, "b.txt"), join(root, "link.txt"));
    expect(text(await host.fs.read("notes/deep/a.md"))).toBe("hello");
    expect(await host.fs.stat("notes/deep/a.md")).toMatchObject({ kind: "file", size: 5 });
    expect(await host.fs.stat("notes")).toMatchObject({ kind: "directory", size: 0 });
    expect(await host.fs.stat("missing.md")).toBeUndefined();
    const listed = await host.fs.list("");
    expect(listed.map((e) => `${e.kind}:${e.name}`)).toEqual(["file:b.txt", "directory:notes"]);
  });

  it("reads ranges, short at the end of the file", async () => {
    await host.fs.write("r.bin", bytes("0123456789"));
    expect(text(await host.fs.readRange("r.bin", 2, 4))).toBe("2345");
    expect(text(await host.fs.readRange("r.bin", 8, 10))).toBe("89");
    expect((await host.fs.readRange("r.bin", 10, 4)).length).toBe(0);
  });

  it("creates directories, removes files and tolerates removing a missing one", async () => {
    await host.fs.mkdir("x/y/z");
    expect(await host.fs.stat("x/y/z")).toMatchObject({ kind: "directory" });
    await host.fs.write("x/f.txt", bytes("1"));
    await host.fs.remove("x/f.txt");
    await host.fs.remove("x/f.txt");
    expect(await host.fs.stat("x/f.txt")).toBeUndefined();
  });

  it.each(["../escape", "a/../../escape", "/etc/passwd", "a\\b", "./a/./b"])("refuses the path %j", async (path) => {
    await expect(host.fs.read(path)).rejects.toBeInstanceOf(HostPathError);
  });

  it("stores kv values under .ipfs-sync/ and lists them by prefix", async () => {
    expect(await host.kv.get("state.json")).toBeUndefined();
    await host.kv.set("state.json", bytes("{}"));
    await host.kv.set("state.bak", bytes("x"));
    await host.kv.set("other", bytes("y"));
    expect(text((await host.kv.get("state.json")) ?? new Uint8Array())).toBe("{}");
    expect(await readFile(join(root, ".ipfs-sync", "state.json"), "utf8")).toBe("{}");
    expect(await host.kv.list("state")).toEqual(["state.bak", "state.json"]);
    await host.kv.delete("state.bak");
    expect(await host.kv.list("")).toEqual(["other", "state.json"]);
  });

  it.each(["", ".hidden", "a/b", "../x", "a b"])("refuses the kv key %j", async (key) => {
    await expect(host.kv.get(key)).rejects.toBeInstanceOf(HostPathError);
  });

  it("lists nothing when the kv directory does not exist", async () => {
    await mkdir(join(root, "empty"));
    expect(await host.kv.list("")).toEqual([]);
  });

  it("answers time_now and env_read from its options", () => {
    expect(host.timeNow()).toBe(1234);
    expect(host.envRead("IPFS_SYNC_DEVICE")).toBe("test-box");
    expect(host.envRead("NOPE")).toBeUndefined();
  });

  it("raises a typed not-implemented error naming the capability for net, agent and shell", async () => {
    const calls: readonly [string, () => Promise<unknown>][] = [
      ["net_fetch", () => host.net.fetch({ url: "https://example.org" })],
      ["agent_list", () => host.agent.list()],
      ["agent_invoke", () => host.agent.invoke({ agentId: "a", input: "hi" })],
      ["shell_exec", () => host.shellExec({ command: "ls", args: [] })],
    ];
    for (const [capability, call] of calls) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostNotImplementedError);
      expect((error as HostNotImplementedError).capability).toBe(capability);
      expect((error as Error).message).toContain("not implemented in this host");
    }
    await writeFile(join(root, "keep"), "");
  });

  describe("fs.write atomicity", () => {
    it("replaces the target through a 0600 temp file and leaves no temp file", async () => {
      await host.fs.write("keys/slot.json", bytes("old"));
      await host.fs.write("keys/slot.json", bytes("new"));
      expect(text(await host.fs.read("keys/slot.json"))).toBe("new");
      expect(((await stat(join(root, "keys/slot.json"))).mode & 0o777).toString(8)).toBe("600");
      expect(await readdir(join(root, "keys"))).toEqual(["slot.json"]);
    });

    it("keeps the previous content and removes the temp file when the write fails midway", async () => {
      await host.fs.write("keys/slot.json", bytes("previous"));
      const torn = {} as unknown as Uint8Array<ArrayBuffer>;
      await expect(host.fs.write("keys/slot.json", torn)).rejects.toThrow();
      expect(text(await host.fs.read("keys/slot.json"))).toBe("previous");
      expect(await readdir(join(root, "keys"))).toEqual(["slot.json"]);
    });

    it("removes the temp file when the rename fails", async () => {
      await mkdir(join(root, "keys/slot.json/inner"), { recursive: true });
      await expect(host.fs.write("keys/slot.json", bytes("x"))).rejects.toThrow();
      expect(await readdir(join(root, "keys"))).toEqual(["slot.json"]);
    });

    it("creates missing parent directories 0700 and leaves an existing directory mode alone", async () => {
      await mkdir(join(root, "existing"), { mode: 0o755 });
      await host.fs.write("existing/new/a.txt", bytes("a"));
      expect(((await stat(join(root, "existing/new"))).mode & 0o777).toString(8)).toBe("700");
      expect(((await stat(join(root, "existing"))).mode & 0o777).toString(8)).toBe("755");
    });
  });
});
