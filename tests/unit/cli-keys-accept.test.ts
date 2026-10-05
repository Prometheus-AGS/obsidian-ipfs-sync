import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError, parseCliArgs } from "../../cli/args";
import { HELP_TEXT } from "../../cli/help-text";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { confirmAcceptDowngrade, KEYS_SUBCOMMANDS } from "../../cli/keys-command";
import { createNodeLockContext, createNodeLockFile } from "../../cli/publish-lock-file";
import { runCli, type CliDeps } from "../../cli/run";
import { canonicalizePassphraseText, parseKeySlots, type CanonicalPassphrase } from "../../src/crypto";
import { ACCEPT_RESIDUAL_STATEMENT } from "../../src/sync/key-management-text";
import { acquirePublishLock } from "../../src/sync/publish-lock";
import { rootFileNames } from "../../src/sync/root-files";
import { NODE_ENV, stateEnv } from "../helpers/cli-state-env";
import { MFS_ROOT, NOW, createCliPullRig, historyNames, type CliPullRig, type CliResult } from "../helpers/cli-pull-rig";
import { referencePassphraseSource } from "../helpers/cli-vault";
import { OTHER_PASSPHRASE } from "../vectors/slot-helpers";

/**
 * Task 1.5 at the command line: `ipfs-sync keys accept-slots` and `keys discard` through `runCli`, against the fake node over the real kubo client.
 * Device A rewraps (the vault of the rig); device B is the directory a first pull created, still holding the old key-slot copy. The test vault sits at
 * the floor cost, so the real derivations are short.
 */

const SLOW = 60_000;
const KEYSLOTS = `${MFS_ROOT}/keyslots.json`;
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);

let rig: CliPullRig;
beforeEach(async () => {
  rig = await createCliPullRig();
});
afterEach(async () => {
  await rig.dispose();
});

const configA = (): string => join(rig.dir, "cfg-a", "config.json");
const mutating = (): string[] => rig.requests.filter((request) => ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"].includes(request));
const canonical = (text: string): CanonicalPassphrase => canonicalizePassphraseText(text);

interface RunOptions {
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly passphrase?: () => Promise<CanonicalPassphrase | undefined>;
  readonly questions?: string[];
}

async function keysOn(vault: string, env: Record<string, string>, args: readonly string[], options: RunOptions = {}): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const ask = options.confirm === undefined ? {} : { confirm: async (question: string) => (options.questions?.push(question), options.confirm?.(question) ?? false) };
  const io: CliIo = { out: (text) => void out.push(text), err: (text) => void err.push(text), ...ask };
  const deps: CliDeps = { env: { ...NODE_ENV, ...env }, now: () => NOW, readText: readTextIfPresent, passphrase: options.passphrase ?? referencePassphraseSource };
  const code = await runCli(["keys", args[0] as string, vault, ...args.slice(1)], deps, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** On device A, with its config. */
const onA = (args: readonly string[], options: RunOptions = {}) => keysOn(rig.vaultA, stateEnv(), [...args, "--config", configA(), "--mfs-root", MFS_ROOT], options);
/** On device B, which owns no key and reaches the name by its ID. */
const onB = (args: readonly string[], options: RunOptions = {}) => keysOn(rig.vaultB, { XDG_STATE_HOME: rig.stateB }, [...args, "--mfs-root", MFS_ROOT], options);

const yes = async (): Promise<boolean> => true;
const newSource = async (): Promise<CanonicalPassphrase> => canonical(OTHER_PASSPHRASE);

/** Device A changes its passphrase to a generated one, written to a file; returns that passphrase. */
async function aChangesPassphrase(): Promise<string> {
  const directory = join(rig.dir, "secret");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = join(directory, "new.pass");
  const result = await onA(["change-passphrase", "--passphrase-file", path, "--accept-no-revocation"]);
  expect(result.err).not.toMatch(/failed/);
  expect(result.code).toBe(0);
  return (await readFile(path, "utf8")).trim();
}

const stateDir = (vault: string): string => join(vault, ".ipfs-sync");
const copyOf = async (vault: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(stateDir(vault), rootFileNames(MFS_ROOT).keyslots)));

describe("the arguments", () => {
  it("knows the four subcommands and the discard flag", () => {
    expect([...KEYS_SUBCOMMANDS]).toEqual(["change-passphrase", "increase-cost", "accept-slots", "discard"]);
    expect(parseCliArgs(["keys", "discard", "/vault", "--yes-discard"]).yesDiscard).toBe(true);
    expect(parseCliArgs(["keys", "discard", "/vault"]).yesDiscard).toBe(false);
    const accept = parseCliArgs(["keys", "accept-slots", "/vault", "--root-cid", "bafyaaaaaaaaaaaa", "--allow-rollback", "--allow-downgrade"]);
    expect(accept.pull.rootCid).toBe("bafyaaaaaaaaaaaa");
    expect(accept.pull.allowRollback).toBe(true);
    expect(accept.keys.allowDowngrade).toBe(true);
  });

  it("documents both commands, their flags and the residual statement in the help text", () => {
    for (const phrase of ["ipfs-sync keys accept-slots <vault>", "ipfs-sync keys discard <vault>", "--yes-discard", "--root-cid", "--allow-rollback"]) {
      expect(HELP_TEXT, phrase).toContain(phrase);
    }
    expect(HELP_TEXT).toMatch(/also knows the passphrase/);
    expect(HELP_TEXT).toMatch(/does not raise the sequence floor/);
  });

  it.each([
    [["accept-slots", "--allow-rollback"], /--allow-rollback needs --root-cid/],
    [["accept-slots", "--root-cid", "bafyaaaaaaaaaaaa", "--name", "k51aaaaaaaaaaaa"], /--name and --root-cid exclude each other/],
    [["accept-slots", "--cost", "high"], /--cost/],
    [["accept-slots", "--accept-no-revocation"], /--accept-no-revocation/],
    [["accept-slots", "--yes-discard"], /--yes-discard/],
    [["accept-slots", "--passphrase-file", "/tmp/never"], /--passphrase-file/],
    [["discard", "--root-cid", "bafyaaaaaaaaaaaa"], /--root-cid/],
    [["discard", "--allow-downgrade"], /--allow-downgrade/],
    [["discard", "--cost", "high"], /--cost/],
    [["change-passphrase", "--root-cid", "bafyaaaaaaaaaaaa"], /--root-cid/],
    [["increase-cost", "--cost", "high", "--yes-discard"], /--yes-discard/],
  ])("exits 2 for %j before any request", async (args, message) => {
    const result = await onA(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(rig.requests).toEqual([]);
  });

  it("refuses --yes-discard on another command", async () => {
    const err: string[] = [];
    const code = await runCli(["publish", rig.vaultA, "--yes-discard"], { env: stateEnv(), now: () => NOW, readText: readTextIfPresent }, { out: () => undefined, err: (text) => void err.push(text) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--yes-discard");
  });
});

describe("accept-slots on the second device", () => {
  /** B pulls the vault as A published it, then A changes the passphrase. */
  async function afterRewrap(): Promise<{ readonly fresh: string; readonly previousRoot: string; readonly previousSlots: Uint8Array }> {
    expect((await rig.pull(["--accept-first-pull"])).code).toBe(0);
    const previousRoot = rig.node.cidOf(MFS_ROOT) as string;
    const previousSlots = new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array);
    const fresh = await aChangesPassphrase();
    rig.repoint();
    rig.requests.length = 0;
    return { fresh, previousRoot, previousSlots };
  }

  it("after A's rewrap B refuses to pull naming the action; accept with the new passphrase replaces the copy from the one root, and the pull then works", { timeout: SLOW * 2 }, async () => {
    const { fresh } = await afterRewrap();
    const refused = await rig.pull([]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("keys accept-slots");

    rig.requests.length = 0;
    const result = await onB(["accept-slots", "--name", rig.keyId()], { passphrase: async () => canonical(fresh) });
    expect(result.err).not.toMatch(/failed/);
    expect(result.code).toBe(0);
    expect(result.out).toContain(ACCEPT_RESIDUAL_STATEMENT);
    expect(result.out).toMatch(/does not raise the sequence floor/);
    expect(result.out).toMatch(/accepted/);
    expect(bytesEqual(await copyOf(rig.vaultB), rig.node.files.get(KEYSLOTS))).toBe(true);
    expect(parseKeySlots(await copyOf(rig.vaultB)).slots).toHaveLength(1);
    // The name is resolved once; nothing on the node is written.
    expect(rig.requests.filter((request) => request === "name/resolve")).toHaveLength(1);
    expect(mutating()).toEqual([]);

    const pulled = await rig.pull([], { deps: { passphrase: async () => canonical(fresh) } });
    expect(pulled.err).not.toMatch(/accept-slots/);
    expect(pulled.code).toBe(0);
  });

  it("a wrong passphrase is the one unlock failure: nothing changes on the node or in B's copy", { timeout: SLOW }, async () => {
    await afterRewrap();
    const before = await copyOf(rig.vaultB);
    // The old passphrase is a valid passphrase and the wrong one for the new slot.
    const result = await onB(["accept-slots", "--name", rig.keyId()], { passphrase: referencePassphraseSource });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/wrong passphrase|passphrase/i);
    expect(mutating()).toEqual([]);
    expect(bytesEqual(await copyOf(rig.vaultB), before)).toBe(true);
  });

  it("no passphrase source is a refusal before any request", async () => {
    expect((await rig.pull(["--accept-first-pull"])).code).toBe(0);
    rig.requests.length = 0;
    const result = await onB(["accept-slots", "--name", rig.keyId()], { passphrase: async () => undefined });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/passphrase/);
    expect(rig.requests).toEqual([]);
  });

  it("without --name and without an owned key the name cannot be chosen, and the run says to pass one", { timeout: SLOW }, async () => {
    await afterRewrap();
    const result = await onB(["accept-slots"], { passphrase: newSource });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/--name/);
    expect(mutating()).toEqual([]);
  });

  it("a restore by --root-cid is refused by pull naming accept-slots with the root and the flag, works through accept, and --manifest on a current copy needs no accept", { timeout: SLOW * 3 }, async () => {
    // Sequences 1 and 2, then B holds the vault at 2 and A rewraps. The root of sequence 1 is the older root to restore.
    const oldRoot = rig.node.cidOf(MFS_ROOT) as string;
    await writeFile(join(rig.vaultA, "second.md"), "second\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    expect((await rig.pull(["--accept-first-pull"])).code).toBe(0);
    const first = historyNames(rig.node).find((name) => name.startsWith("0000000000000001-")) as string;
    const firstTree = /^\d{16}-([a-z0-9]+)\.enc$/.exec(first)?.[1] as string;
    const fresh = await aChangesPassphrase();
    rig.repoint();
    rig.requests.length = 0;

    // Restoring the older root while B's copy is stale is refused by accept's own rules, so first B accepts the current slots.
    const stale = await rig.pull(["--manifest", firstTree, "--allow-rollback"]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("keys accept-slots");
    expect(stale.err).not.toContain("--root-cid");
    expect((await onB(["accept-slots", "--name", rig.keyId()], { passphrase: async () => canonical(fresh) })).code).toBe(0);

    // A history entry under the current root: no accept is needed on a device that holds the current copy.
    const restored = await rig.pull(["--manifest", firstTree, "--allow-rollback"], { deps: { passphrase: async () => canonical(fresh) } });
    expect(restored.err).not.toMatch(/accept-slots/);
    expect(restored.code).toBe(0);

    // An explicit older root: the pull names accept-slots with the root and the flag; accept with the flag, under the old passphrase, makes the pull work.
    const refused = await rig.pull(["--mfs-root", MFS_ROOT, "--root-cid", oldRoot, "--allow-rollback"], { bare: true, deps: { passphrase: async () => canonical(fresh) } });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("keys accept-slots");
    expect(refused.err).toContain(`--root-cid ${oldRoot}`);
    expect(refused.err).toContain("--allow-rollback");
    const noFlag = await onB(["accept-slots", "--root-cid", oldRoot], { passphrase: referencePassphraseSource });
    expect(noFlag.code).toBe(1);
    expect(noFlag.err).toMatch(/rollback/i);
    const accepted = await onB(["accept-slots", "--root-cid", oldRoot, "--allow-rollback"], { passphrase: referencePassphraseSource });
    expect(accepted.err).not.toMatch(/failed/);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toMatch(/publish and a pull by name stay refused/);
    const after = await rig.pull(["--mfs-root", MFS_ROOT, "--root-cid", oldRoot, "--allow-rollback"], { bare: true });
    expect(after.err).not.toMatch(/accept-slots/);
    expect(after.code).toBe(0);
  });

});

describe("the downgrade question of accept", () => {
  const downgrade = { current: { m: 65_536, t: 3, p: 1 }, incoming: { m: 19_456, t: 2, p: 1 } };
  const sinkOf = () => ({ out: () => undefined, err: () => undefined }) satisfies CliIo;

  it("asks with both costs and proceeds only on a yes", async () => {
    const questions: string[] = [];
    const asking: CliIo = { ...sinkOf(), confirm: async (question) => (questions.push(question), true) };
    expect(await confirmAcceptDowngrade(asking, downgrade, false)).toBe(true);
    expect(questions[0]).toContain("64 MiB, 3 iterations");
    expect(questions[0]).toContain("19 MiB, 2 iterations");
    expect(await confirmAcceptDowngrade({ ...sinkOf(), confirm: async () => false }, downgrade, false)).toBe(false);
  });

  it("without a terminal it proceeds only with --allow-downgrade", async () => {
    expect(await confirmAcceptDowngrade(sinkOf(), downgrade, false)).toBe(false);
    expect(await confirmAcceptDowngrade(sinkOf(), downgrade, true)).toBe(true);
  });

  it("asks nothing when there is no downgrade", async () => {
    expect(await confirmAcceptDowngrade(sinkOf(), undefined, false)).toBe(true);
  });
});

describe("a held lock", () => {
  it.each([[["accept-slots", "--name", "k51aaaaaaaaaaaa"]], [["discard", "--yes-discard"]]])("%j refuses with the lock text and changes nothing", async (args) => {
    const lock = await acquirePublishLock(createNodeLockFile(rig.vaultA), createNodeLockContext(() => NOW.getTime()));
    try {
      const result = await onA(args, { passphrase: newSource });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/lock/i);
      expect(mutating()).toEqual([]);
    } finally {
      await lock.release();
    }
  });
});

describe("discard", () => {
  const journalFile = (): string => join(stateDir(rig.vaultA), rootFileNames(MFS_ROOT).maintenance);

  /** A change-passphrase killed after the key-slot file reached the shared tree: the journal stays, the name is unchanged. */
  async function interrupted(): Promise<Uint8Array> {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700, recursive: true });
    const before = new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array);
    rig.node.mutations = 0;
    rig.node.killAfterMutation = 1;
    await onA(["change-passphrase", "--passphrase-file", join(directory, "new.pass"), "--accept-no-revocation"]).then(
      () => undefined,
      () => undefined,
    );
    rig.node.killAfterMutation = undefined;
    expect(await stat(journalFile()).catch(() => undefined)).toBeDefined();
    expect(bytesEqual(rig.node.files.get(KEYSLOTS), before)).toBe(false);
    rig.requests.length = 0;
    return before;
  }

  it("says what it drops, asks, takes this device's file back out of the shared tree, removes the journal, and publish and pull work again", { timeout: SLOW }, async () => {
    const before = await interrupted();
    expect((await rig.publish()).err).toContain("keys discard");
    const questions: string[] = [];
    const result = await onA(["discard"], { confirm: yes, questions });
    expect(result.err).not.toMatch(/failed/);
    expect(result.code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(result.out).toMatch(/was not published/);
    expect(result.out).toMatch(/taken back out|written back/);
    expect(bytesEqual(rig.node.files.get(KEYSLOTS), before)).toBe(true);
    expect(await stat(journalFile()).catch(() => undefined)).toBeUndefined();
    const published = await rig.publish();
    expect(published.err).not.toMatch(/failed/);
    expect(published.code).toBe(0);
    expect(published.out).toContain("nothing changed");
  });

  it("without a terminal it needs --yes-discard, and with it removes the journal", { timeout: SLOW }, async () => {
    await interrupted();
    const refused = await onA(["discard"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--yes-discard");
    expect(await stat(journalFile()).catch(() => undefined)).toBeDefined();
    expect(mutating()).toEqual([]);
    const done = await onA(["discard", "--yes-discard"]);
    expect(done.code).toBe(0);
    expect(await stat(journalFile()).catch(() => undefined)).toBeUndefined();
  });

  it("a declined confirmation changes nothing and exits 1", { timeout: SLOW }, async () => {
    await interrupted();
    const result = await onA(["discard"], { confirm: async () => false });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not confirmed/);
    expect(mutating()).toEqual([]);
    expect(await stat(journalFile()).catch(() => undefined)).toBeDefined();
  });

  it("with nothing pending says so, exits 0 and sends no request", async () => {
    const result = await onA(["discard"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/nothing to discard/);
    expect(rig.requests).toEqual([]);
  });

  it("removes a journal that cannot be read, saying that nothing on the node can be taken back", async () => {
    await mkdir(stateDir(rig.vaultA), { recursive: true });
    await writeFile(journalFile(), "{ torn");
    const result = await onA(["discard", "--yes-discard"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/cannot be read/);
    expect(mutating()).toEqual([]);
    expect(await stat(journalFile()).catch(() => undefined)).toBeUndefined();
    expect((await rig.publish()).code).toBe(0);
  });

  it("every other keys command is refused on a damaged journal but accept-slots and discard are not", async () => {
    await writeFile(journalFile(), "{ torn");
    const blocked = await onA(["increase-cost", "--cost", "standard", "--accept-no-revocation"]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("keys discard");
    expect((await onA(["discard", "--yes-discard"])).code).toBe(0);
  });
});
