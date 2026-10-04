import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError, parseCliArgs } from "../../cli/args";
import { HELP_TEXT } from "../../cli/help-text";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { createNodeHostBridge } from "../../cli/node-host-bridge";
import { createNodeLockContext, createNodeLockFile } from "../../cli/publish-lock-file";
import { runCli, type CliDeps } from "../../cli/run";
import { canonicalizePassphraseText, type VaultKeys } from "../../src/crypto";
import { historyFileName } from "../../src/sync/history-names";
import { PRUNE_QUESTION } from "../../src/sync/prune-history-text";
import { acquirePublishLock } from "../../src/sync/publish-lock";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { stateEnv } from "../helpers/cli-state-env";
import { MFS_ROOT, NOW, createCliPullRig, historyNames, type CliPullRig, type CliResult } from "../helpers/cli-pull-rig";
import { referencePassphraseSource } from "../helpers/cli-vault";
import { seedHistory, type SeededHistory } from "../helpers/prune-rig";
import { OTHER_PASSPHRASE } from "../vectors/slot-helpers";

/**
 * Task 1.6 at the command line: `ipfs-sync prune-history` through `runCli`, against the fake node over the real kubo client. The node holds 40 sequences
 * and two forked files (42 history files); `--keep 35` removes the 7 oldest. The newest 20 are genuine manifests, the older ones bytes that authenticate as nothing.
 */

const TOTAL = 40;
const FORKS = [35, 40] as const;
const KEEP = "35";
const MANIFEST = `${MFS_ROOT}/manifest.enc`;
const KEYSLOTS = `${MFS_ROOT}/keyslots.json`;

let rig: CliPullRig;
let vaultKeys: VaultKeys;
let seed: SeededHistory;

beforeEach(async () => {
  rig = await createCliPullRig();
  vaultKeys = await rig.keys();
  const host = createNodeHostBridge({ root: rig.vaultA, env: stateEnv(), now: () => NOW.getTime() });
  seed = await seedHistory({ node: rig.node, kv: host.kv, mfsRoot: MFS_ROOT, keys: vaultKeys, total: TOTAL, forks: FORKS });
  rig.repoint();
  rig.requests.length = 0;
  rig.node.calls.length = 0;
});
afterEach(async () => {
  await rig.dispose();
});

const configA = (): string => join(rig.dir, "cfg-a", "config.json");
const target = (): string[] => [rig.vaultA, "--config", configA(), "--mfs-root", MFS_ROOT];
const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];
const mutating = (): string[] => rig.requests.filter((request) => MUTATING.includes(request));
const journalFile = (): string => join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).maintenance);
const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;

interface RunOptions {
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly questions?: string[];
}

async function prune(args: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ask = options.confirm === undefined ? {} : { confirm: async (question: string) => (options.questions?.push(question), options.confirm?.(question) ?? false) };
  const io: CliIo = { out: (text) => void out.push(text), err: (text) => void err.push(text), ...ask };
  const deps: CliDeps = { env: stateEnv(), now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
  const code = await runCli(["prune-history", ...args], deps, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;

describe("the arguments", () => {
  it("knows --keep, --dry-run and --yes-prune, and only for prune-history", () => {
    const parsed = parseCliArgs(["prune-history", "/vault", "--keep", "100", "--yes-prune"]);
    expect(parsed.command).toBe("prune-history");
    expect(parsed.operands).toEqual(["/vault"]);
    expect(parsed.prune).toEqual({ keep: 100, dryRun: false, yesPrune: true });
    expect(parseCliArgs(["publish", "/vault"]).prune).toEqual({ keep: undefined, dryRun: false, yesPrune: false });
    expect(() => parseCliArgs(["prune-history", "/vault", "--keep", "0"])).toThrow(UsageError);
    expect(() => parseCliArgs(["prune-history", "/vault", "--keep", "twenty"])).toThrow(UsageError);
    expect(() => parseCliArgs(["prune-history", "/vault", "--keep", "1.5"])).toThrow(UsageError);
  });

  it("documents the command, its flags, the 20 floor and its exit codes in the help text", () => {
    for (const phrase of ["ipfs-sync prune-history <vault> --keep <n>", "--dry-run", "--yes-prune", "the newest 20 are always kept", "withholds or plants files"]) {
      expect(HELP_TEXT, phrase).toContain(phrase);
    }
    expect(HELP_TEXT).toMatch(/For prune-history, 0 also means nothing to remove or a dry run/);
  });

  it.each([
    [[], /prune-history needs exactly one argument/],
    [["/vault", "extra"], /prune-history needs exactly one argument/],
    [["/vault"], /prune-history needs --keep/],
    [["/vault", "--keep", "0"], /--keep needs a positive whole number/],
    [["/vault", "--keep", "30", "--dry-run", "--yes-prune"], /exclude each other/],
  ])("exits 2 for %j without sending a request", async (args, message) => {
    const result = await prune(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(rig.requests).toEqual([]);
  });

  it.each([["--keep", "30"], ["--dry-run"], ["--yes-prune"]])("refuses %s on another command", async (...flag) => {
    const err: string[] = [];
    const code = await runCli(["publish", rig.vaultA, "--config", configA(), "--mfs-root", MFS_ROOT, ...flag], { env: stateEnv(), now: () => NOW, readText: readTextIfPresent }, { out: () => undefined, err: (t) => void err.push(t) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("only valid for the prune-history command");
    expect(rig.requests).toEqual([]);
  });

  it("a run that cannot ask and was given neither --yes-prune nor --dry-run is a usage error before any request", async () => {
    const result = await prune([...target(), "--keep", KEEP]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--yes-prune");
    expect(rig.requests).toEqual([]);
  });
});

describe("a dry run", () => {
  it("prints the plan and the removal set, writes nothing, and takes no lock", async () => {
    // A held lock would refuse a real run; the dry run does not touch it.
    const lock = await acquirePublishLock(createNodeLockFile(rig.vaultA), createNodeLockContext(() => NOW.getTime()));
    try {
      const before = historyNames(rig.node);
      const localBefore = (await readdir(join(rig.vaultA, ".ipfs-sync"))).sort();
      const result = await prune([...target(), "--keep", KEEP, "--dry-run"]);
      expect((await readdir(join(rig.vaultA, ".ipfs-sync"))).sort()).toEqual(localBefore);
      expect(result.err).not.toMatch(/failed/);
      expect(result.code).toBe(0);
      expect(result.out).toContain("Prune history: 7 of the 42 history files");
      expect(result.out).toMatch(/2 files share a sequence with another file/);
      expect(result.out).toMatch(/sequence 1 to 7/);
      expect(result.out.match(/would remove  /g)).toHaveLength(7);
      for (const name of before.slice(0, 7)) expect(result.out).toContain(name);
      expect(result.out).toMatch(/dry run: nothing was removed, written or published, and no lock was taken/);
      expect(mutating()).toEqual([]);
      expect(historyNames(rig.node)).toEqual(before);
    } finally {
      await lock.release();
    }
  });

  it("still refuses a node whose history cannot be trusted, with the same words as a real run", async () => {
    for (const sequence of [TOTAL, TOTAL - 1]) rig.node.files.delete(`${MFS_ROOT}/manifests/${historyFileName(sequence, seed.manifest.rootCID)}`);
    const result = await prune([...target(), "--keep", KEEP, "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/withheld/);
    expect(mutating()).toEqual([]);
  });
});

describe("a prune", () => {
  it("with --yes-prune removes the 7 oldest files, publishes once, and leaves the manifest, the key slots and the sequence alone", async () => {
    const before = historyNames(rig.node);
    const manifestBefore = new Uint8Array(rig.node.files.get(MANIFEST) as Uint8Array);
    const slotsBefore = new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array);
    const currentBefore = rig.node.cidOf(`${MFS_ROOT}/current`);
    const result = await prune([...target(), "--keep", KEEP, "--yes-prune"]);
    expect(result.err).not.toMatch(/failed/);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Prune history: 7 of the 42 history files");
    expect(result.out).toMatch(/pruned           removed 7 history files; 35 stay/);
    expect(result.out).toMatch(/sequence         40 \(unchanged/);
    expect(historyNames(rig.node)).toEqual(before.slice(7));
    expect(rig.requests.filter((request) => request === "files/rm")).toHaveLength(7);
    expect(mutating().filter((request) => request !== "files/rm")).toEqual(["pin/add", "name/publish"]);
    expect(new Uint8Array(rig.node.files.get(MANIFEST) as Uint8Array)).toEqual(manifestBefore);
    expect(new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array)).toEqual(slotsBefore);
    expect(rig.node.cidOf(`${MFS_ROOT}/current`)).toBe(currentBefore);
    expect(await exists(journalFile())).toBe(false);
    const host = createNodeHostBridge({ root: rig.vaultA, env: stateEnv(), now: () => NOW.getTime() });
    const state = await readRootState(host.kv, MFS_ROOT);
    expect(state?.rootCid).toBe(rig.node.published.get(rig.keyId())?.replace("/ipfs/", ""));
    expect(state?.sequence).toBe(TOTAL);
  });

  it("asks once, after the plan, and removes on a yes", async () => {
    const questions: string[] = [];
    const result = await prune([...target(), "--keep", KEEP], { confirm: yes, questions });
    expect(result.code).toBe(0);
    expect(questions).toEqual([PRUNE_QUESTION]);
    expect(result.out.indexOf("Prune history:")).toBeLessThan(result.out.indexOf("pruned "));
    expect(historyNames(rig.node)).toHaveLength(35);
  });

  it("removes nothing when the question is declined, and exits 1", async () => {
    const before = historyNames(rig.node);
    const result = await prune([...target(), "--keep", KEEP], { confirm: no });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not confirmed; nothing was changed/);
    expect(mutating()).toEqual([]);
    expect(historyNames(rig.node)).toEqual(before);
    expect(await exists(journalFile())).toBe(false);
  });

  it("with nothing to remove says so, asks nothing and writes nothing", async () => {
    const questions: string[] = [];
    const result = await prune([...target(), "--keep", "100"], { confirm: yes, questions });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Nothing to prune/);
    expect(questions).toEqual([]);
    expect(mutating()).toEqual([]);
  });

  it("--keep 5 is raised to 20 and the plan says so", async () => {
    const result = await prune([...target(), "--keep", "5", "--yes-prune"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/--keep 5 was raised to 20/);
    expect(historyNames(rig.node)).toHaveLength(20);
  });
});

describe("a refusal removes nothing", () => {
  it("a held lock", async () => {
    const lock = await acquirePublishLock(createNodeLockFile(rig.vaultA), createNodeLockContext(() => NOW.getTime()));
    try {
      const result = await prune([...target(), "--keep", KEEP, "--yes-prune"]);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/lock/i);
      expect(mutating()).toEqual([]);
    } finally {
      await lock.release();
    }
  });

  it("an unfinished publish on this device", async () => {
    await mkdir(join(rig.vaultA, ".ipfs-sync"), { recursive: true });
    await writeFile(join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).journal), "{}");
    const result = await prune([...target(), "--keep", KEEP, "--yes-prune"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/unfinished publish/);
    expect(mutating()).toEqual([]);
  });

  it("a newest entry that does not authenticate", async () => {
    rig.node.files.set(`${MFS_ROOT}/manifests/${historyFileName(TOTAL, seed.manifest.rootCID)}`, new Uint8Array(70).fill(9));
    const result = await prune([...target(), "--keep", KEEP, "--yes-prune"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/does not authenticate/);
    expect(mutating()).toEqual([]);
  });

  it("a name that is not a history file, shown escaped and never removed", async () => {
    const evil = "evil‮\u0007name.enc";
    rig.node.files.set(`${MFS_ROOT}/manifests/${evil}`, new Uint8Array([1]));
    const result = await prune([...target(), "--keep", KEEP, "--yes-prune"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not history files/);
    expect(result.err).toContain("\\u202e");
    // The raw characters never reach the terminal, and the file is still there.
    expect(result.err).not.toContain("‮");
    expect(result.err).not.toContain("\u0007");
    expect(mutating()).toEqual([]);
    expect(rig.node.files.has(`${MFS_ROOT}/manifests/${evil}`)).toBe(true);
  });

  it.each([
    ["no passphrase is available", async () => undefined],
    ["the passphrase is wrong", async () => canonicalizePassphraseText(OTHER_PASSPHRASE)],
  ])("%s: nothing is changed and no journal is left", async (_label, passphrase) => {
    const err: string[] = [];
    const code = await runCli(
      ["prune-history", ...target(), "--keep", KEEP, "--yes-prune"],
      { env: stateEnv(), now: () => NOW, readText: readTextIfPresent, passphrase },
      { out: () => undefined, err: (t) => void err.push(t) },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/passphrase/i);
    expect(mutating()).toEqual([]);
    expect(await exists(journalFile())).toBe(false);
  });
});

describe("an interrupted prune is finished by running the command again", () => {
  /** A run killed by the node after `after` mutations: the journal stays; the error may be the kill itself or a client error around it. */
  async function killedRun(after: number, args: readonly string[]): Promise<void> {
    rig.node.mutations = 0;
    rig.node.killAfterMutation = after;
    await prune(args).then(
      () => undefined,
      () => undefined,
    );
    rig.node.killAfterMutation = undefined;
  }

  it.each([
    [1, "after the first removal"],
    [5, "in the middle of the removals"],
    [7, "after the last removal"],
    [8, "after the pin"],
    [9, "after name/publish"],
  ])("killed %i mutation(s) in (%s): publish and pull are paused, and the same command finishes it with one publication", async (after) => {
    const args = [...target(), "--keep", KEEP, "--yes-prune"];
    const before = historyNames(rig.node);
    await killedRun(after, args);
    expect(await exists(journalFile())).toBe(true);

    // Publish and pull are paused, naming the ways out.
    const blocked = await rig.publish();
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("keys discard");
    expect(blocked.err).toContain("prune-history");

    // A fresh prune with other numbers does not start another one: it finishes the pending one.
    rig.requests.length = 0;
    const second = await prune([...target(), "--keep", "100", "--yes-prune"]);
    expect(second.err).not.toMatch(/failed/);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/finishing the interrupted history prune/);
    expect(second.out).toMatch(/7 history files were removed/);
    expect(historyNames(rig.node)).toEqual(before.slice(7));
    expect(await exists(journalFile())).toBe(false);
    expect(rig.requests.filter((request) => request === "name/publish").length).toBeLessThanOrEqual(1);
    // Publish is no longer paused, and with nothing changed it writes nothing.
    rig.requests.length = 0;
    const published = await rig.publish();
    expect(published.err).not.toMatch(/failed/);
    expect(published.code).toBe(0);
    expect(mutating()).toEqual([]);
  });
});
