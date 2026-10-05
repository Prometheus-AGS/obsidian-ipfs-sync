// Delta review A-L4: every fs mutation (write, mkdir, rename, append) picks its directory mode by ONE rule: owner-only for the state folder, compared by
// fold key (so `.Ipfs-Sync/x` is the state folder too), and the platform default everywhere else. A pulled note folder must not become 0700, and a
// differently-cased name of the state folder must still get the symbolic-link check.
import { mkdtemp, mkdir, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostPathError, createNodeHostBridge } from "../../cli/node-host-bridge";
import type { HostBridge } from "../../src/core/host-bridge";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

let root: string;
let host: HostBridge;
/** The mode a plain `mkdir` gives under this umask: what a note folder must have. */
let defaultMode: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ipfs-sync-host4-"));
  host = createNodeHostBridge({ root, env: {}, now: () => 1 });
  await mkdir(join(root, "reference"));
  defaultMode = await modeOf(join(root, "reference"));
  await rm(join(root, "reference"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The directory entry of the state folder as the file system names it (`.ipfs-sync`, or the differently-cased one on a case-sensitive volume). */
async function stateEntries(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.toLowerCase() === ".ipfs-sync");
}

describe("the mode of a directory a write, mkdir, rename or append creates (A-L4)", () => {
  it("note folders get the platform default, whichever call creates them", async () => {
    await host.fs.write("notes/deep/a.md", bytes("a"));
    await host.fs.mkdir("made/deep");
    await host.fs.append("appended/deep/log.txt", bytes("x"));
    await host.fs.rename("notes/deep/a.md", "moved/deep/a.md");
    for (const directory of ["notes", "notes/deep", "made", "made/deep", "appended", "appended/deep", "moved", "moved/deep"]) {
      expect(await modeOf(join(root, directory)), directory).toBe(defaultMode);
    }
    expect(defaultMode & 0o077, "the default mode is not owner-only here, so the assertion above is meaningful").not.toBe(0);
  });

  it.each([".ipfs-sync/sub/deep/f.json", ".Ipfs-Sync/sub/deep/f.json", ".IPFS-SYNC/sub/deep/f.json", ".ipfs-sync/f.json"])(
    "write(%j) creates the state folder and everything below it owner-only",
    async (path) => {
      await host.fs.write(path, bytes("s"));
      const [entry] = await stateEntries();
      expect(entry).toBeDefined();
      const folder = join(root, entry ?? "");
      expect(await modeOf(folder)).toBe(0o700);
      const parts = path.split("/").slice(1, -1);
      for (let depth = 1; depth <= parts.length; depth++) expect(await modeOf(join(folder, ...parts.slice(0, depth))), parts.slice(0, depth).join("/")).toBe(0o700);
    },
  );

  it.each([
    ["write", async (h: HostBridge) => h.fs.write(".Ipfs-Sync/a/f", bytes("1"))],
    ["mkdir", async (h: HostBridge) => h.fs.mkdir(".Ipfs-Sync/a/b")],
    ["append", async (h: HostBridge) => h.fs.append(".Ipfs-Sync/a/f", bytes("1"))],
    ["rename", async (h: HostBridge) => (await h.fs.write("src.txt", bytes("1")), h.fs.rename("src.txt", ".Ipfs-Sync/a/f"))],
  ])("%s into a differently-cased state folder name is owner-only too", async (_name, run) => {
    await run(host);
    const [entry] = await stateEntries();
    expect(await modeOf(join(root, entry ?? ""))).toBe(0o700);
    expect(await modeOf(join(root, entry ?? "", "a"))).toBe(0o700);
  });

  it("a folder that only starts with the state folder's name is an ordinary folder", async () => {
    await host.fs.write(".ipfs-sync.md/x.md", bytes("1"));
    await host.fs.write("x/.ipfs-sync/y.md", bytes("1"));
    expect(await modeOf(join(root, ".ipfs-sync.md"))).toBe(defaultMode);
    expect(await modeOf(join(root, "x/.ipfs-sync"))).toBe(defaultMode);
  });
});

describe("a symbolic-link state folder is refused under any casing of its name (A-L4)", () => {
  it.each([".ipfs-sync/f", ".Ipfs-Sync/f", ".IPFS-SYNC/sub/f"])("write(%j) is refused and writes nothing through the link", async (path) => {
    const elsewhere = await mkdtemp(join(tmpdir(), "ipfs-sync-host4-link-"));
    try {
      await symlink(elsewhere, join(root, ".ipfs-sync"));
      await expect(host.fs.write(path, bytes("s"))).rejects.toBeInstanceOf(HostPathError);
      await expect(host.fs.mkdir(path)).rejects.toBeInstanceOf(HostPathError);
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
