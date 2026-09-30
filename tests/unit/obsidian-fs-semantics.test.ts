import { describe, expect, it } from "vitest";
import type { Bytes } from "../../src/core/host-bridge";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { HostPathError, HostReadCapError } from "../../src/sync/host-errors";
import { MemoryAdapter } from "../support/memory-adapter";

const MB = 1024 * 1024;
const bytes = (text: string): Bytes => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

function host(adapter: MemoryAdapter, maxReadMb?: number) {
  return createObsidianHostBridge({ adapter, maxReadMb });
}

/** Reports a size without holding the bytes, so the default cap can be tested with a "100 MB" file. */
class SizedAdapter extends MemoryAdapter {
  private readonly claimed = new Map<string, number>();

  claim(path: string, size: number): void {
    this.put(path, "x");
    this.claimed.set(path, size);
  }

  override async stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null> {
    const found = await super.stat(path);
    const size = this.claimed.get(path);
    return found === null || size === undefined ? found : { ...found, size };
  }
}

/** Keeps no data: records the size of every call, so a test can prove chunks are handed over one at a time. */
class CountingAdapter extends MemoryAdapter {
  readonly appended: number[] = [];
  total = 0;

  override appendBinary(_path: string, data: ArrayBuffer): Promise<void> {
    this.appended.push(data.byteLength);
    this.total += data.byteLength;
    return Promise.resolve();
  }
}

describe("obsidian fs semantics: members", () => {
  it("appends inside a hidden folder that does not exist yet: creates the file, then extends it", async () => {
    const adapter = new MemoryAdapter();
    await host(adapter).fs.append(".ipfs-sync/tmp/x.part", bytes("ab"));
    expect(adapter.text(".ipfs-sync/tmp/x.part")).toBe("ab");
    await host(adapter).fs.append(".ipfs-sync/tmp/x.part", bytes("cd"));
    expect(adapter.text(".ipfs-sync/tmp/x.part")).toBe("abcd");
    expect(adapter.folders.has(".ipfs-sync/tmp")).toBe(true);
  });

  it("renames over an existing file by removing it first, and creates missing parents of the target", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(".ipfs-sync/tmp/new.part", "new");
    adapter.put("notes/a.md", "old");
    await host(adapter).fs.rename(".ipfs-sync/tmp/new.part", "notes/a.md");
    expect(adapter.text("notes/a.md")).toBe("new");
    expect(adapter.files.has(".ipfs-sync/tmp/new.part")).toBe(false);
    expect(adapter.calls.indexOf("remove notes/a.md")).toBeLessThan(adapter.calls.indexOf("rename .ipfs-sync/tmp/new.part notes/a.md"));

    adapter.put("src.txt", "s");
    await host(adapter).fs.rename("src.txt", "deep/er/dst.txt");
    expect(adapter.text("deep/er/dst.txt")).toBe("s");
  });

  it("leaves the target alone when the rename source is missing", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("notes/a.md", "keep me");
    await expect(host(adapter).fs.rename(".ipfs-sync/tmp/gone.part", "notes/a.md")).rejects.toBeInstanceOf(HostPathError);
    expect(adapter.text("notes/a.md")).toBe("keep me");
    expect(adapter.calls.some((call) => call.startsWith("remove"))).toBe(false);
  });

  it("reports a missing path as undefined for stat and lstat, and removing a missing path succeeds", async () => {
    const adapter = new MemoryAdapter();
    const { fs } = host(adapter);
    expect(await fs.stat("nope.md")).toBeUndefined();
    expect(await fs.lstat("nope.md")).toBeUndefined();
    await expect(fs.remove("nope.md")).resolves.toBeUndefined();
  });

  it("maps a folder to a directory and a file to its size and modification time in milliseconds", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("d/f.md", "abc", 1234);
    const { fs } = host(adapter);
    expect(await fs.lstat("d")).toMatchObject({ kind: "directory" });
    expect(await fs.lstat("d/f.md")).toEqual({ kind: "file", size: 3, mtimeMs: 1234 });
    expect(await fs.list("d")).toEqual([{ name: "f.md", kind: "file", size: 3, mtimeMs: 1234 }]);
  });

  it("does not follow or report links: lstat is stat", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("a.md", "a");
    const { fs } = host(adapter);
    expect(await fs.lstat("a.md")).toEqual(await fs.stat("a.md"));
    expect((await fs.lstat("a.md"))?.kind).not.toBe("symlink");
  });

  it("refuses `..` in every member without touching a file", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("keep.md", "keep");
    adapter.calls.length = 0;
    const { fs } = host(adapter);
    const escape = "a/../../x";
    await expect(fs.append(escape, bytes("x"))).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.lstat(escape)).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.mkdir(escape)).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.remove(escape)).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.readRange(escape, 0, 1)).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.rename("keep.md", escape)).rejects.toBeInstanceOf(HostPathError);
    await expect(fs.rename(escape, "keep.md")).rejects.toBeInstanceOf(HostPathError);
    expect(adapter.calls).toEqual([]);
    expect(adapter.text("keep.md")).toBe("keep");
  });
});

describe("obsidian fs semantics: read cap", () => {
  it("fails a file above the cap naming the file and the cap, while another file is still read", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("big.bin", new Uint8Array(9 * MB));
    adapter.put("small.md", "small");
    const { fs } = host(adapter, 8);
    const error = await fs.read("big.bin").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostReadCapError);
    expect((error as Error).message).toContain("big.bin");
    expect((error as Error).message).toContain("8 MB");
    expect(text(await fs.read("small.md"))).toBe("small");
    // The big file was never loaded.
    expect(adapter.reads).toEqual(["small.md"]);
  });

  it("applies the cap to range reads too, and to nothing that writes", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("big.bin", new Uint8Array(9 * MB));
    const { fs } = host(adapter, 8);
    await expect(fs.readRange("big.bin", 0, 10)).rejects.toBeInstanceOf(HostReadCapError);
    await fs.write("also-big.bin", new Uint8Array(9 * MB));
    expect(adapter.files.get("also-big.bin")?.data.byteLength).toBe(9 * MB);
  });

  it("defaults to 64 MB and lets the next operation read more after the cap is raised", async () => {
    const adapter = new SizedAdapter();
    adapter.claim("large.bin", 100 * MB);
    await expect(host(adapter).fs.read("large.bin")).rejects.toThrowError(/large\.bin.*100 MB.*64 MB/);
    expect(adapter.reads).toEqual([]);
    // Same file, cap raised to 128 MB: the next bridge (built per operation from the settings) reads it.
    expect(text(await host(adapter, 128).fs.read("large.bin"))).toBe("x");
  });

  it("accepts a file exactly at the cap", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("edge.bin", new Uint8Array(8 * MB));
    expect((await host(adapter, 8).fs.read("edge.bin")).byteLength).toBe(8 * MB);
  });
});

describe("obsidian fs semantics: bounded download", () => {
  it("hands a 200 MB download to the adapter in 8 MB chunks, one at a time", async () => {
    const adapter = new CountingAdapter();
    const { fs } = host(adapter);
    const chunk = new Uint8Array(8 * MB);
    const chunks = 25;
    for (let index = 0; index < chunks; index += 1) await fs.append(".ipfs-sync/tmp/big.part", chunk);
    // The first chunk creates the file; every later call extends it. No call ever carries more than one chunk.
    expect(adapter.files.get(".ipfs-sync/tmp/big.part")?.data.byteLength).toBe(8 * MB);
    expect(adapter.appended).toHaveLength(chunks - 1);
    expect(Math.max(...adapter.appended)).toBe(8 * MB);
    expect(adapter.total + 8 * MB).toBe(200 * MB);
  });
});
