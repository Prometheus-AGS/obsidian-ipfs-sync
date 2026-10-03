import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostPathError, createNodeHostBridge } from "../../cli/node-host-bridge";
import { assertParentInsideRoot, isInside } from "../../cli/realpath-guard";
import type { HostBridge } from "../../src/core/host-bridge";
import { findSymlink } from "../../src/sync/symlink-guard";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** Every directory here is a fresh mkdtemp under the OS temp directory; cleanup removes only those. */
describe("node host realpath containment (mvp-07 task 3.2)", () => {
  let base: string;
  let root: string;
  let outside: string;
  let host: HostBridge;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "ipfs-sync-realpath-"));
    root = join(base, "vault");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "untouched");
    host = createNodeHostBridge({ root });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const outsideListing = async (): Promise<readonly string[]> => (await readdir(outside)).sort();

  describe("a symlinked folder pointing outside the vault", () => {
    beforeEach(async () => {
      await symlink(outside, join(root, "escape"));
    });

    it("refuses write and leaves the outside directory unchanged", async () => {
      await expect(host.fs.write("escape/pwn.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("untouched");
    });

    it("refuses write below a directory that does not exist yet and creates nothing through the link", async () => {
      await expect(host.fs.write("escape/new/deep/pwn.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
    });

    it("refuses write below an existing directory reached through the link", async () => {
      await mkdir(join(outside, "sub"));
      await expect(host.fs.write("escape/sub/pwn.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      expect(await readdir(join(outside, "sub"))).toEqual([]);
    });

    it("refuses mkdir, append and remove through the link", async () => {
      await expect(host.fs.mkdir("escape/made")).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.append("escape/log.txt", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.remove("escape/keep.txt")).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("untouched");
    });

    it("refuses a rename whose destination is below the link and keeps the source", async () => {
      await host.fs.write("tmp/a.part", bytes("payload"));
      await expect(host.fs.rename("tmp/a.part", "escape/a.md")).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
      expect(await readFile(join(root, "tmp", "a.part"), "utf8")).toBe("payload");
    });

    it("refuses a rename whose source is below the link", async () => {
      await expect(host.fs.rename("escape/keep.txt", "taken.md")).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
    });

    it("names the vault-relative path and not the resolved outside location", async () => {
      const error = await host.fs.write("escape/pwn.md", bytes("x")).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HostPathError);
      const message = (error as Error).message;
      expect(message).toContain('"escape/pwn.md"');
      expect(message).not.toContain(await realpath(outside));
    });

    it("still reads and stats through the link as before (containment guards mutation only)", async () => {
      expect(await host.fs.stat("escape/keep.txt")).toMatchObject({ kind: "file", size: 9 });
    });
  });

  describe("a symlink inside the vault pointing inside the vault", () => {
    beforeEach(async () => {
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "alias"));
    });

    it("is refused by the lstat prefix walk, which stays in place", async () => {
      expect(await findSymlink(host.fs, "alias/x.md")).toBe("alias");
      expect(await findSymlink(host.fs, "real/x.md")).toBeUndefined();
    });

    it("is not an escape: the realpath guard alone lets the write land in the real folder", async () => {
      await host.fs.write("alias/x.md", bytes("inside"));
      expect(await readFile(join(root, "real", "x.md"), "utf8")).toBe("inside");
      expect(await outsideListing()).toEqual(["keep.txt"]);
    });
  });

  describe("the vault root itself", () => {
    it("may be a symlink: writes land in the real directory and the prefix walk does not flag the root", async () => {
      const linkedRoot = join(base, "vault-link");
      await symlink(root, linkedRoot);
      const linked = createNodeHostBridge({ root: linkedRoot });
      await linked.fs.write("notes/a.md", bytes("through the root link"));
      await linked.fs.rename("notes/a.md", "notes/b.md");
      expect(await readFile(join(root, "notes", "b.md"), "utf8")).toBe("through the root link");
      expect(await findSymlink(linked.fs, "notes/b.md")).toBeUndefined();
    });

    it("still refuses a folder link that leaves a symlinked root", async () => {
      const linkedRoot = join(base, "vault-link");
      await symlink(root, linkedRoot);
      await symlink(outside, join(root, "escape"));
      const linked = createNodeHostBridge({ root: linkedRoot });
      await expect(linked.fs.write("escape/pwn.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      expect(await outsideListing()).toEqual(["keep.txt"]);
    });

    it("may be missing: the first write creates it", async () => {
      const fresh = createNodeHostBridge({ root: join(base, "not-yet", "vault") });
      await fresh.fs.write("a.md", bytes("first"));
      expect(await readFile(join(base, "not-yet", "vault", "a.md"), "utf8")).toBe("first");
    });

    it("accepts mkdir of the root path itself", async () => {
      await expect(host.fs.mkdir("")).resolves.toBeUndefined();
    });
  });

  describe("ordinary and degenerate parents", () => {
    it("writes nested files, creating parents, and replaces an existing file", async () => {
      await host.fs.write("a/b/c.md", bytes("one"));
      await host.fs.write("a/b/c.md", bytes("two"));
      expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("two");
    });

    it("refuses a dangling symlink as a parent component", async () => {
      await symlink(join(base, "does-not-exist"), join(root, "dangling"));
      await expect(host.fs.write("dangling/x.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      expect(await readdir(base)).not.toContain("does-not-exist");
    });

    it("refuses a symlink loop as a parent component", async () => {
      await symlink(join(root, "loop-b"), join(root, "loop-a"));
      await symlink(join(root, "loop-a"), join(root, "loop-b"));
      await expect(host.fs.write("loop-a/x.md", bytes("x"))).rejects.toBeInstanceOf(HostPathError);
    });

    it("lets the operating system report a file used as a directory", async () => {
      await host.fs.write("plain.md", bytes("file"));
      const failure = await host.fs.write("plain.md/child.md", bytes("x")).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(HostPathError);
    });
  });

  describe("a symlink inside the vault pointing at a protected folder (B1-04a)", () => {
    it.each([
      [".obsidian/plugins", "link-plugins"],
      [".ipfs-sync", "link-state"],
      [".git", "link-git"],
      [".Obsidian/plugins", "link-folded"],
    ])("refuses a destination write through a link to %s and writes nothing there", async (target, name) => {
      await mkdir(join(root, target), { recursive: true });
      await symlink(join(root, target), join(root, name));
      await expect(host.fs.write(`${name}/evil.js`, bytes("x"))).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.rename(".ipfs-sync/none.part", `${name}/evil.js`)).rejects.toThrow();
      expect(await readdir(join(root, target))).toEqual([]);
    });

    it("still lets the engine write and rename its own temp files under .ipfs-sync/tmp onto an ordinary destination", async () => {
      await host.fs.write(".ipfs-sync/tmp/one.part", bytes("payload"));
      await host.fs.append(".ipfs-sync/tmp/one.part", bytes("!"));
      await host.fs.rename(".ipfs-sync/tmp/one.part", "notes/a.md");
      expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("payload!");
      await host.fs.remove(".ipfs-sync/tmp/none.part");
    });
  });

  describe("assertParentInsideRoot and isInside", () => {
    it("does not treat a sibling that shares the root's name as a prefix as inside", async () => {
      const sibling = join(base, "vault-evil");
      await mkdir(sibling);
      await symlink(sibling, join(root, "sib"));
      await expect(assertParentInsideRoot(root, join(root, "sib", "x.md"), "sib/x.md")).rejects.toBeInstanceOf(HostPathError);
      expect(isInside("/v/vault", "/v/vault-evil")).toBe(false);
      expect(isInside("/v/vault", "/v/vault")).toBe(true);
      expect(isInside("/v/vault", "/v/vault/a/b")).toBe(true);
      expect(isInside("/v/vault", "/v")).toBe(false);
      expect(isInside("/", "/etc")).toBe(true);
    });
  });
});
