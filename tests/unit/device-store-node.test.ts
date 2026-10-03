import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeDeviceStore, deviceStoreDirectory } from "../../cli/device-store-node";
import { DEVICE_ID_FILE, DeviceStoreError, loadDeviceId, type DeviceStore } from "../../src/sync/device-store";
import { raiseFloor, readFloor } from "../../src/sync/sequence-floor";

const posixOnly = process.platform === "win32" ? describe.skip : describe;
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

describe("device store directory", () => {
  it("follows the platform conventions and XDG_STATE_HOME", () => {
    expect(deviceStoreDirectory({ HOME: "/home/u" }, "linux")).toBe("/home/u/.local/state/ipfs-sync");
    expect(deviceStoreDirectory({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support/ipfs-sync");
    expect(deviceStoreDirectory({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local\\ipfs-sync");
    expect(deviceStoreDirectory({ HOME: "/home/u", XDG_STATE_HOME: "/state" }, "linux")).toBe("/state/ipfs-sync");
    expect(deviceStoreDirectory({ HOME: "/Users/u", XDG_STATE_HOME: "/state" }, "darwin")).toBe("/state/ipfs-sync");
  });

  it("refuses a missing or relative base instead of guessing a directory", () => {
    expect(() => deviceStoreDirectory({}, "linux")).toThrow(DeviceStoreError);
    expect(() => deviceStoreDirectory({ HOME: "relative" }, "linux")).toThrow(DeviceStoreError);
    expect(() => deviceStoreDirectory({ XDG_STATE_HOME: "state" }, "linux")).toThrow(DeviceStoreError);
  });
});

posixOnly("node device store", () => {
  let root: string;
  let directory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-devstore-"));
    directory = join(root, "ipfs-sync");
  });

  it("creates the directory 0700 and files 0600, round trips bytes, and leaves no temporary file", async () => {
    const store = createNodeDeviceStore({ directory });
    expect(await store.get("a.json")).toBeUndefined();
    await store.set("a.json", text("one"));
    await store.set("a.json", text("two"));
    expect(new TextDecoder().decode(await store.get("a.json"))).toBe("two");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "a.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["a.json"]);
  });

  it("keeps the id and the floor across store instances (a new process)", async () => {
    const first = createNodeDeviceStore({ directory });
    const id = await loadDeviceId(first);
    await raiseFloor(first, "c".repeat(32), { sequence: 3, identity: "d".repeat(64), at: 1 });
    const second = createNodeDeviceStore({ directory });
    expect(await loadDeviceId(second)).toBe(id);
    expect((await readFloor(second, "c".repeat(32)))?.sequence).toBe(3);
    expect(await readFile(join(directory, DEVICE_ID_FILE), "utf8")).toContain(id);
  });

  it("refuses a symlinked directory and writes nothing through it", async () => {
    const target = join(root, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    const store = createNodeDeviceStore({ directory });
    await expect(store.set("a.json", text("x"))).rejects.toThrow(/symbolic link/);
    await expect(store.get("a.json")).rejects.toThrow(/symbolic link/);
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses a symlinked entry for reads and writes", async () => {
    const store = createNodeDeviceStore({ directory });
    await store.set("keep.json", text("secret"));
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(directory, "linked.json"));
    await expect(store.get("linked.json")).rejects.toThrow(/symbolic link/);
    await expect(store.set("linked.json", text("x"))).rejects.toThrow(/symbolic link/);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("refuses a directory owned by another uid (simulated)", async () => {
    await mkdir(directory, { mode: 0o700 });
    const actual = (await lstat(directory)).uid;
    const store = createNodeDeviceStore({ directory, uid: actual + 1 });
    await expect(store.get("a.json")).rejects.toThrow(/another user/);
    await expect(store.set("a.json", text("x"))).rejects.toThrow(/another user/);
  });

  it("refuses an entry owned by another uid (simulated) and a directory open to other users", async () => {
    const store = createNodeDeviceStore({ directory });
    await store.set("a.json", text("x"));
    const owner = (await lstat(join(directory, "a.json"))).uid;
    await expect(createNodeDeviceStore({ directory, uid: owner + 1 }).get("a.json")).rejects.toThrow(/another user/);
    await chmod(directory, 0o755);
    await expect(store.get("a.json")).rejects.toThrow(/accessible to other users/);
  });

  it("refuses names that could leave the directory", async () => {
    const store = createNodeDeviceStore({ directory });
    for (const name of ["../x", "a/b", ".hidden", "A.json", ""]) await expect(store.set(name, text("x"))).rejects.toThrow(DeviceStoreError);
  });

  describe("raiseFloor across processes (review-final A-08)", () => {
    const VAULT_A = "a".repeat(32);
    const VAULT_B = "b".repeat(32);
    const ENTRY = { identity: "e".repeat(64), at: 1 } as const;

    /** Holds each floor read, after it returned, until both writers have read or 300 ms passed: without a lock both read the same old file. */
    function gatedPair(): readonly [DeviceStore, DeviceStore] {
      let arrived = 0;
      let open: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (open = resolve));
      const timer = setTimeout(open, 300);
      const gate = async (): Promise<void> => {
        arrived += 1;
        if (arrived >= 2) {
          clearTimeout(timer);
          open();
        }
        await released;
      };
      const make = (): DeviceStore => {
        const inner = createNodeDeviceStore({ directory });
        return {
          ...inner,
          get: async (name) => {
            const bytes = await inner.get(name);
            if (name === "sequence-floor.json") await gate();
            return bytes;
          },
        };
      };
      return [make(), make()];
    }

    it("two processes raising the floor of different vaults at the same moment both keep their raise", async () => {
      const [first, second] = gatedPair();
      await Promise.all([raiseFloor(first, VAULT_A, { sequence: 4, ...ENTRY }), raiseFloor(second, VAULT_B, { sequence: 7, ...ENTRY })]);
      const reader = createNodeDeviceStore({ directory });
      expect((await readFloor(reader, VAULT_A))?.sequence).toBe(4);
      expect((await readFloor(reader, VAULT_B))?.sequence).toBe(7);
    });

    it("leaves no lock file behind, on success or when the merge fails, and keeps the directory 0700 and the files 0600", async () => {
      const store = createNodeDeviceStore({ directory });
      await raiseFloor(store, VAULT_A, { sequence: 2, ...ENTRY });
      await expect(raiseFloor(store, "not-hex", { sequence: 2, ...ENTRY })).rejects.toThrow();
      await store.set("sequence-floor.json", text("{ not json"));
      await expect(raiseFloor(store, VAULT_A, { sequence: 3, ...ENTRY })).rejects.toThrow(/damaged/);
      expect((await readdir(directory)).sort()).toEqual(["sequence-floor.json"]);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "sequence-floor.json"))).mode & 0o777).toBe(0o600);
    });

    it("refuses a symbolic link in the place of the lock and writes nothing through it", async () => {
      const store = createNodeDeviceStore({ directory });
      await store.set("probe.json", text("x"));
      const outside = join(root, "outside-lock");
      await writeFile(outside, "outside");
      await symlink(outside, join(directory, ".store.lock"));
      await expect(raiseFloor(store, VAULT_A, { sequence: 2, ...ENTRY })).rejects.toThrow(/symbolic link/);
      expect(await readFile(outside, "utf8")).toBe("outside");
      expect(await store.get("sequence-floor.json")).toBeUndefined();
    });

    it("takes over a lock whose owner died long ago (stale), and removes it afterwards", async () => {
      const store = createNodeDeviceStore({ directory });
      await store.set("probe.json", text("x"));
      const lock = join(directory, ".store.lock");
      await writeFile(lock, "pid 1\n", { mode: 0o600 });
      const old = new Date(Date.now() - 10 * 60_000);
      await utimes(lock, old, old);
      await raiseFloor(store, VAULT_A, { sequence: 2, ...ENTRY });
      expect((await readFloor(store, VAULT_A))?.sequence).toBe(2);
      expect((await readdir(directory)).sort()).toEqual(["probe.json", "sequence-floor.json"]);
    });

    it("a live lock that does not clear within the wait stops the raise with a message that names the lock, and never proceeds without it", async () => {
      const store = createNodeDeviceStore({ directory, lockWaitMs: 150 });
      await store.set("probe.json", text("x"));
      await writeFile(join(directory, ".store.lock"), "pid 1\n", { mode: 0o600 });
      await expect(raiseFloor(store, VAULT_A, { sequence: 2, ...ENTRY })).rejects.toThrow(/another ipfs-sync process.*\.store\.lock/);
      expect(await store.get("sequence-floor.json")).toBeUndefined();
      expect(await readFile(join(directory, ".store.lock"), "utf8")).toBe("pid 1\n");
    });
  });
});
