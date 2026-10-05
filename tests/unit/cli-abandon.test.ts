import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { runAbandon } from "../../cli/abandon-command";
import { DeviceStoreError } from "../../src/sync/device-store";
import { SEQUENCE_FLOOR_FILE, SequenceFloorError, raiseFloor } from "../../src/sync/sequence-floor";
import { rootDigest } from "../../src/sync/vault-keys";
import { expectDiscardCaveat } from "../helpers/abandon-discard-text";
import { stateEnv } from "../helpers/cli-state-env";
import { createNodeDeviceStore, deviceStoreDirectory } from "../../cli/device-store-node";

const MFS_ROOT = "/obsidian-vault-sync/abandon-test";
const OTHER_ROOT = "/obsidian-vault-sync/other-root";
const NOW = new Date("2026-09-30T12:00:00Z");

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly prompts: string[];
}

/** `answers`: what the terminal user types, one per prompt; undefined means the run has no terminal. */
function sink(answers?: readonly (string | undefined)[]): Sink {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const queue = [...(answers ?? [])];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ...(answers === undefined ? {} : { prompt: async (label: string) => (prompts.push(label), queue.shift()) }),
  };
  return { io, out, err, prompts };
}

describe("ipfs-sync abandon", () => {
  let dir: string;
  let vault: string;
  let digest: string;
  let otherDigest: string;
  let fetchStub: ReturnType<typeof vi.fn>;

  const stateFile = (kind: string, h = digest): string => join(vault, ".ipfs-sync", `${kind}.${h}.json`);
  const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-abandon-"));
    vault = join(dir, "vault");
    await writeFixtureVault(vault, 2);
    digest = await rootDigest(MFS_ROOT);
    otherDigest = await rootDigest(OTHER_ROOT);
    await mkdir(join(vault, ".ipfs-sync"), { recursive: true });
    for (const kind of ["keyslots", "state", "journal"]) {
      await writeFile(stateFile(kind), `${kind}-body`);
      await writeFile(stateFile(kind, otherDigest), `other-${kind}`);
    }
    fetchStub = vi.fn(async () => {
      throw new Error("abandon must not send a request");
    });
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const deps = (): CliDeps => ({ env: {}, now: () => NOW, readText: readTextIfPresent });
  const abandon = async (io: Sink, extra: string[] = []) => runCli(["abandon", vault, "--mfs-root", MFS_ROOT, ...extra], deps(), io.io);

  async function backupDirs(): Promise<string[]> {
    return (await readdir(join(vault, ".ipfs-sync"))).filter((name) => name.startsWith("abandoned-"));
  }

  it("moves the copy, state and journal into a backup after the word is typed, and sends no request", async () => {
    const s = sink(["abandon"]);
    expect(await abandon(s)).toBe(0);
    const backups = await backupDirs();
    expect(backups).toEqual([`abandoned-${digest}-${NOW.getTime()}`]);
    const backup = join(vault, ".ipfs-sync", backups[0] ?? "");
    for (const kind of ["keyslots", "state", "journal"]) {
      expect(await exists(stateFile(kind))).toBe(false);
      expect(await readFile(join(backup, `${kind}.json`), "utf8")).toBe(`${kind}-body`);
    }
    expect(fetchStub).not.toHaveBeenCalled();
    const text = s.out.join("\n");
    expect(text).toContain(`.ipfs-sync/abandoned-${digest}-${NOW.getTime()}`);
    expect(text).toContain("not contacted");
    expect(s.prompts).toEqual(['Type "abandon" to confirm: ']);
    expect(await exists(join(vault, ".ipfs-sync", "publish.lock"))).toBe(false);
  });

  it("lists the three consequences and the files it will move before it asks", async () => {
    const s = sink(["nope"]);
    await abandon(s);
    const text = s.out.join("\n");
    expect(text).toContain("keeps a backup");
    expect(text).toContain("Nothing on the node is changed or deleted");
    expect(text).toContain("empty MFS root");
    for (const kind of ["keyslots", "state", "journal"]) expect(text).toContain(`.ipfs-sync/${kind}.${digest}.json`);
  });

  it("accepts the word in any case with surrounding blanks, as the plugin's dialog does", async () => {
    expect(await abandon(sink(["  ABANDON \n"]))).toBe(0);
    expect(await exists(stateFile("keyslots"))).toBe(false);
  });

  it.each([["something else"], ["abandon this vault"], [""], [undefined]])("moves nothing when %j is typed", async (typed) => {
    const s = sink([typed]);
    expect(await abandon(s)).toBe(1);
    expect(s.err.join("\n")).toContain("nothing was moved");
    for (const kind of ["keyslots", "state", "journal"]) expect(await exists(stateFile(kind))).toBe(true);
    expect(await backupDirs()).toEqual([]);
  });

  it("without a terminal it moves nothing and asks for --yes-abandon (usage error)", async () => {
    const s = sink();
    expect(await abandon(s)).toBe(2);
    expect(s.err.join("\n")).toContain("--yes-abandon");
    expect(await exists(stateFile("keyslots"))).toBe(true);
    expect(await backupDirs()).toEqual([]);
  });

  it("with --yes-abandon it moves without a prompt", async () => {
    const s = sink();
    expect(await abandon(s, ["--yes-abandon"])).toBe(0);
    expect(await exists(stateFile("state"))).toBe(false);
    expect(await backupDirs()).toHaveLength(1);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("leaves another MFS root's files where they are", async () => {
    await abandon(sink(["abandon"]));
    for (const kind of ["keyslots", "state", "journal"]) expect(await readFile(stateFile(kind, otherDigest), "utf8")).toBe(`other-${kind}`);
  });

  it("moves only what exists and reports how many files", async () => {
    await rm(stateFile("journal"));
    const s = sink(["abandon"]);
    expect(await abandon(s)).toBe(0);
    expect(s.out.join("\n")).toContain("2 files moved");
  });

  describe("R5-M1: every file kind abandonVault moves is previewed and counted", () => {
    const ALL_KINDS = ["keyslots", "state", "journal", "maintenance"] as const;

    it("names all four kinds in the preview and moves all four", async () => {
      await writeFile(stateFile("maintenance"), "maintenance-body");
      const s = sink(["abandon"]);
      expect(await abandon(s)).toBe(0);
      const text = s.out.join("\n");
      for (const kind of ALL_KINDS) expect(text).toContain(`will move .ipfs-sync/${kind}.${digest}.json`);
      expect(text).toContain("4 files moved");
      const backup = join(vault, ".ipfs-sync", (await backupDirs())[0] ?? "");
      expect(await readFile(join(backup, "maintenance.json"), "utf8")).toBe("maintenance-body");
      expect(await exists(stateFile("maintenance"))).toBe(false);
    });

    it.each(ALL_KINDS)("a vault whose only local file is the %s file previews it and abandons (not 'nothing to move')", async (only) => {
      for (const kind of ["keyslots", "state", "journal"]) await rm(stateFile(kind));
      await writeFile(stateFile(only), `${only}-body`);
      const s = sink(["abandon"]);
      expect(await abandon(s)).toBe(0);
      expect(s.out.join("\n")).toContain(`will move .ipfs-sync/${only}.${digest}.json`);
      expect(s.out.join("\n")).toContain("1 file moved");
      expect(s.err.join("\n")).not.toContain("holds no");
      const backup = join(vault, ".ipfs-sync", (await backupDirs())[0] ?? "");
      expect(await readFile(join(backup, `${only}.json`), "utf8")).toBe(`${only}-body`);
    });

    it("says before asking that a pending rewrap or prune is dropped, its node write is not withdrawn, and keys discard withdraws only an unpublished rewrap (R6-M2)", async () => {
      const s = sink(["nope"]);
      await abandon(s);
      const text = s.out.join("\n");
      expect(text.replace(/\s+/g, " ")).toContain("ipfs-sync keys discard");
      expectDiscardCaveat(text);
    });
  });

  describe("R6-L4: no terminal and no --yes-abandon is a usage error before anything else", () => {
    it("exits 2 with the --yes-abandon hint when the root holds nothing to move", async () => {
      const s = sink();
      const code = await runCli(["abandon", vault, "--mfs-root", "/obsidian-vault-sync/unknown-root"], deps(), s.io);
      expect(code).toBe(2);
      expect(s.err.join("\n")).toContain("--yes-abandon");
      expect(s.err.join("\n")).not.toContain("holds no");
      expect(await backupDirs()).toEqual([]);
    });

    it("keeps exit 1 for nothing to move with --yes-abandon", async () => {
      const s = sink();
      const code = await runCli(["abandon", vault, "--mfs-root", "/obsidian-vault-sync/unknown-root", "--yes-abandon"], deps(), s.io);
      expect(code).toBe(1);
      expect(s.err.join("\n")).toContain("holds no");
    });

    it("keeps exit 1 for nothing to move on a terminal, and does not prompt", async () => {
      const s = sink(["abandon"]);
      const code = await runCli(["abandon", vault, "--mfs-root", "/obsidian-vault-sync/unknown-root"], deps(), s.io);
      expect(code).toBe(1);
      expect(s.prompts).toEqual([]);
    });
  });

  describe("R6-M3: an unusable device store does not block the move", () => {
    const VAULT_ID = "e".repeat(32);

    it("with no HOME (the per-user directory cannot be located) it still abandons and says the floor could not be read", async () => {
      await writeFile(stateFile("state"), JSON.stringify({ vaultId: VAULT_ID }));
      const s = sink(["abandon"]);
      expect(await abandon(s)).toBe(0);
      for (const kind of ["keyslots", "state", "journal"]) expect(await exists(stateFile(kind))).toBe(false);
      const text = s.out.join("\n");
      expect(text).toContain("3 files moved");
      expect(text).toContain("sequence floor kept: not read");
      expect(text).toContain("could not be read");
      expect(text).not.toContain("HOME");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it.each([
      ["a DeviceStoreError", new DeviceStoreError("secret-path-1")],
      ["a generic Error", new Error("secret-path-2")],
      ["a SequenceFloorError", new SequenceFloorError("secret-path-3")],
    ])("%s from the store: all files move, fixed text, no message", async (_label, failure) => {
      await writeFile(stateFile("state"), JSON.stringify({ vaultId: VAULT_ID }));
      const deviceStore = {
        get: async () => {
          throw failure;
        },
        set: async () => undefined,
      };
      const s = sink(["abandon"]);
      const code = await runAbandon({ config: { mfsRoot: MFS_ROOT }, io: s.io, vaultPath: vault, env: {}, now: () => NOW, yesAbandon: false, deviceStore });
      expect(code).toBe(0);
      for (const kind of ["keyslots", "state", "journal"]) expect(await exists(stateFile(kind))).toBe(false);
      expect(s.out.join("\n")).toContain("could not be read");
      expect([...s.out, ...s.err].join("\n")).not.toContain("secret-path");
    });
  });

  describe("R6-M4: a rename that fails after the first is reported as a partial move", () => {
    const OS_WORDS = /EISDIR|ENOTEMPTY|EEXIST|EPERM|errno|rename|syscall/i;

    async function block(kind: string): Promise<string> {
      const backup = join(vault, ".ipfs-sync", `abandoned-${digest}-${NOW.getTime()}`);
      const target = join(backup, `${kind}.json`);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "occupied"), "x");
      return target;
    }

    it.each([
      ["the second", "state", ["keyslots"], "1 of 3"],
      ["the third", "journal", ["keyslots", "state"], "2 of 3"],
    ])("failing %s rename: exit 1, the fixed statement, no operating-system text", async (_label, blocked, movedKinds, counts) => {
      await block(blocked);
      const s = sink(["abandon"]);
      expect(await abandon(s)).toBe(1);
      const err = s.err.join("\n");
      expect(err).toContain(`${counts} files were moved. Run abandon again to move the rest.`);
      expect(err).not.toMatch(OS_WORDS);
      expect(err).not.toContain(vault);
      for (const kind of ["keyslots", "state", "journal"]) expect(await exists(stateFile(kind)), kind).toBe(!movedKinds.includes(kind));
      expect(s.out.join("\n")).not.toContain("abandoned        ");
      expect(await exists(join(vault, ".ipfs-sync", "publish.lock"))).toBe(false);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("the fourth of four fails: 3 of 4, and a second run moves the rest", async () => {
      await writeFile(stateFile("maintenance"), "maintenance-body");
      const target = await block("maintenance");
      const s = sink(["abandon"]);
      expect(await abandon(s)).toBe(1);
      expect(s.err.join("\n")).toContain("3 of 4 files were moved. Run abandon again to move the rest.");
      expect(await exists(stateFile("maintenance"))).toBe(true);
      await rm(target, { recursive: true, force: true });
      const again = sink(["abandon"]);
      expect(await abandon(again)).toBe(0);
      expect(again.out.join("\n")).toContain("1 file moved");
      expect(await exists(stateFile("maintenance"))).toBe(false);
      expect(await readFile(join(vault, ".ipfs-sync", `abandoned-${digest}-${NOW.getTime()}`, "maintenance.json"), "utf8")).toBe("maintenance-body");
    });

    it("a failure before any file moved keeps today's behaviour (not the partial statement)", async () => {
      await block("keyslots");
      const s = sink(["abandon"]);
      await abandon(s).then(
        () => undefined,
        () => undefined,
      );
      expect(s.err.join("\n")).not.toContain("files were moved");
      for (const kind of ["keyslots", "state", "journal"]) expect(await exists(stateFile(kind))).toBe(true);
    });
  });

  it("reports that there is nothing to abandon for a root this device does not know, exit 1, no backup folder", async () => {
    const s = sink(["abandon"]);
    const code = await runCli(["abandon", vault, "--mfs-root", "/obsidian-vault-sync/unknown-root"], deps(), s.io);
    expect(code).toBe(1);
    expect(s.err.join("\n")).toContain("nothing was moved");
    expect(s.prompts).toEqual([]);
    expect(await backupDirs()).toEqual([]);
  });

  it("refuses a directory that does not exist and an MFS root outside the allowed area", async () => {
    expect(await runCli(["abandon", join(dir, "missing"), "--mfs-root", MFS_ROOT], deps(), sink(["abandon"]).io)).toBe(2);
    const s = sink(["abandon"]);
    expect(await runCli(["abandon", vault, "--mfs-root", "/somewhere-else"], deps(), s.io)).toBe(2);
    expect(await exists(stateFile("keyslots"))).toBe(true);
  });

  it("needs exactly one operand and rejects --yes-abandon on other commands", async () => {
    const none = sink();
    expect(await runCli(["abandon"], deps(), none.io)).toBe(2);
    expect(none.err.join("\n")).toContain("abandon needs exactly one argument");
    const other = sink();
    expect(await runCli(["publish", vault, "--yes-abandon"], deps(), other.io)).toBe(2);
    expect(other.err.join("\n")).toContain("--yes-abandon is only valid for the abandon command");
  });

  describe("sequence floor", () => {
    const VAULT_ID = "e".repeat(32);
    // No node is named: abandon is local-only and must work without one.
    const { IPFS_SYNC_RPC_URL: _rpc, IPFS_SYNC_GATEWAY_URL: _gateway, ...env } = stateEnv();
    const floorPath = join(deviceStoreDirectory(env), SEQUENCE_FLOOR_FILE);

    async function seedFloor(sequence: number): Promise<void> {
      await writeFile(stateFile("state"), JSON.stringify({ vaultId: VAULT_ID }));
      await raiseFloor(createNodeDeviceStore({ directory: deviceStoreDirectory(env) }), VAULT_ID, { sequence, identity: "1".repeat(64), at: 1000 });
    }

    it("prints 'sequence floor kept: N' and leaves the floor file byte-identical", async () => {
      await seedFloor(5);
      const before = await readFile(floorPath);
      const s = sink(["abandon"]);
      expect(await runCli(["abandon", vault, "--mfs-root", MFS_ROOT], { ...deps(), env }, s.io)).toBe(0);
      expect(s.out).toContain("sequence floor kept: 5");
      expect(await readFile(floorPath)).toEqual(before);
      expect(await exists(stateFile("state"))).toBe(false);
    });

    it("says none when this device has no floor for the vault", async () => {
      await writeFile(stateFile("state"), JSON.stringify({ vaultId: "f".repeat(32) }));
      const s = sink(["abandon"]);
      expect(await runCli(["abandon", vault, "--mfs-root", MFS_ROOT], { ...deps(), env }, s.io)).toBe(0);
      expect(s.out.join("\n")).toContain("sequence floor kept: none");
    });

    it("reports a damaged floor file as unreadable and does not change it", async () => {
      await seedFloor(5);
      await writeFile(floorPath, "{not json");
      const s = sink(["abandon"]);
      expect(await runCli(["abandon", vault, "--mfs-root", MFS_ROOT], { ...deps(), env }, s.io)).toBe(0);
      expect(s.out.join("\n")).toContain("sequence floor kept: unreadable");
      expect(await readFile(floorPath, "utf8")).toBe("{not json");
      await rm(floorPath);
    });
  });

  it("is in the help text", async () => {
    const s = sink();
    expect(await runCli(["--help"], deps(), s.io)).toBe(0);
    const help = s.out.join("\n");
    expect(help).toContain("ipfs-sync abandon <vault>");
    expect(help).toContain("--yes-abandon");
  });
});
