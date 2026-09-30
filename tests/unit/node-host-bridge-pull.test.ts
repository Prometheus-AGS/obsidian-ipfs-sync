import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostPathError, createNodeHostBridge } from "../../cli/node-host-bridge";
import type { HostBridge } from "../../src/core/host-bridge";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

describe("node host bridge: lstat, rename and append (mvp-03 additions)", () => {
  let root: string;
  let outside: string;
  let host: HostBridge;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-host-pull-"));
    outside = await mkdtemp(join(tmpdir(), "ipfs-sync-host-outside-"));
    host = createNodeHostBridge({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("lstat reports a symlink as itself, files, directories and missing paths", async () => {
    await host.fs.write("a.md", bytes("abc"));
    await symlink(join(root, "a.md"), join(root, "link.md"));
    await symlink(outside, join(root, "linked-dir"));
    expect(await host.fs.lstat("a.md")).toMatchObject({ kind: "file", size: 3 });
    expect(await host.fs.lstat("link.md")).toMatchObject({ kind: "symlink" });
    expect(await host.fs.lstat("linked-dir")).toMatchObject({ kind: "symlink" });
    expect(await host.fs.lstat("missing")).toBeUndefined();
    expect(await host.fs.lstat("a.md/below")).toBeUndefined();
    await mkdir(join(root, "dir"));
    expect(await host.fs.lstat("dir")).toMatchObject({ kind: "directory", size: 0 });
  });

  it("append creates the file and its parents, then extends it", async () => {
    await host.fs.append("deep/er/t.part", bytes("ab"));
    await host.fs.append("deep/er/t.part", bytes("cd"));
    expect(await readFile(join(root, "deep", "er", "t.part"), "utf8")).toBe("abcd");
  });

  it("rename creates parents, replaces a file and replaces a symlink itself without touching its target", async () => {
    await host.fs.write("tmp/x.part", bytes("new"));
    await host.fs.rename("tmp/x.part", "notes/sub/x.md");
    expect(await readFile(join(root, "notes", "sub", "x.md"), "utf8")).toBe("new");

    await writeFile(join(outside, "target.txt"), "target");
    await symlink(join(outside, "target.txt"), join(root, "l.md"));
    await host.fs.write("tmp/y.part", bytes("replacement"));
    await host.fs.rename("tmp/y.part", "l.md");
    expect((await lstat(join(root, "l.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "l.md"), "utf8")).toBe("replacement");
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("target");
  });

  it("refuses traversal on the new members like on the old ones", async () => {
    await expect(host.fs.lstat("../x")).rejects.toBeInstanceOf(HostPathError);
    await expect(host.fs.append("/abs", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
    await expect(host.fs.rename("a", "../b")).rejects.toBeInstanceOf(HostPathError);
  });
});
