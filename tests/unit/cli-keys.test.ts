import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COST_PRESET_NAMES, UsageError, parseCliArgs } from "../../cli/args";
import { HELP_TEXT } from "../../cli/help-text";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { confirmDowngrade, KEYS_SUBCOMMANDS } from "../../cli/keys-command";
import { createNodeLockContext, createNodeLockFile } from "../../cli/publish-lock-file";
import { runCli, type CliDeps } from "../../cli/run";
import { CryptoError, parseKeySlots, unlockKeySlotsBytes, type CanonicalPassphrase, type VaultKeys } from "../../src/crypto";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { COST_PRESETS, type KeyOperations } from "../../src/sync/key-management";
import { REVOCATION_STATEMENT, SAME_PASSPHRASE_STATEMENT, type RewrapCostPlan } from "../../src/sync/key-management-text";
import { acquirePublishLock } from "../../src/sync/publish-lock";
import { rootFileNames } from "../../src/sync/root-files";
import { canonicalizePassphraseText } from "../../src/crypto";
import { stateEnv } from "../helpers/cli-state-env";
import { MFS_ROOT, NOW, createCliPullRig, historyNames, type CliPullRig, type CliResult } from "../helpers/cli-pull-rig";
import { referencePassphraseSource } from "../helpers/cli-vault";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal";
import { OTHER_PASSPHRASE, referencePassphrase } from "../vectors/slot-helpers";

/**
 * Task 1.4 at the command line: `ipfs-sync keys change-passphrase` and `keys increase-cost` through `runCli`, against the fake node over the real
 * kubo client. The test vault sits at the floor cost, so the real key derivations are short; the one test that raises the cost to the default
 * runs two default-cost derivations and carries the same timeout as the init tests.
 */

const SLOW = 60_000;
const GENERATED = /[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}/;
const KEYSLOTS = `${MFS_ROOT}/keyslots.json`;
const MANIFEST = `${MFS_ROOT}/manifest.enc`;

let rig: CliPullRig;
/** The vault keys as the rig's first publish left them: a rewrap replaces the local copy, which the rig's own helpers then no longer open. */
let vaultKeys: VaultKeys;
beforeEach(async () => {
  rig = await createCliPullRig();
  vaultKeys = await rig.keys();
});
afterEach(async () => {
  await rig.dispose();
});

const configA = (): string => join(rig.dir, "cfg-a", "config.json");
const mutating = (): string[] => rig.requests.filter((request) => ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"].includes(request));
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean => a !== undefined && b !== undefined && a.length === b.length && a.every((byte, index) => byte === b[index]);

interface RunOptions {
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly terminal?: FakeTerminal;
  readonly passphrase?: () => Promise<CanonicalPassphrase | undefined>;
  readonly keyOperations?: KeyOperations;
  readonly questions?: string[];
}

async function keys(args: readonly string[], options: RunOptions = {}): Promise<CliResult & { readonly all: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const ask = options.confirm === undefined ? {} : { confirm: async (question: string) => (options.questions?.push(question), options.confirm?.(question) ?? false) };
  const io: CliIo = { out: (text) => void out.push(text), err: (text) => void err.push(text), ...ask };
  const deps: CliDeps = {
    env: stateEnv(),
    now: () => NOW,
    readText: readTextIfPresent,
    passphrase: options.passphrase ?? referencePassphraseSource,
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.keyOperations === undefined ? {} : { keyOperations: options.keyOperations }),
  };
  const code = await runCli(["keys", ...args], deps, io);
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err] };
}

const target = (): string[] => [rig.vaultA, "--config", configA(), "--mfs-root", MFS_ROOT];
const yes = async (): Promise<boolean> => true;

/** A terminal that answers the "enter it again" prompt with the passphrase it just showed. */
function retypingTerminal(): FakeTerminal {
  const terminal = createFakeTerminal();
  const original = terminal.input.resume.bind(terminal.input);
  terminal.input.resume = () => {
    original();
    queueMicrotask(() => terminal.send(`${shown(terminal)}\r`));
  };
  return terminal;
}
const shown = (terminal: FakeTerminal): string => {
  const found = terminal.written.join("").match(GENERATED);
  if (found === null) throw new Error("the terminal showed no passphrase");
  return found[0];
};
const canonical = (text: string): CanonicalPassphrase => canonicalizePassphraseText(text);

describe("the arguments", () => {
  it("knows the subcommands and the three flags, and keeps the cost names in step with the presets", () => {
    expect([...KEYS_SUBCOMMANDS]).toEqual(["change-passphrase", "increase-cost", "accept-slots", "discard"]);
    expect([...COST_PRESET_NAMES].sort()).toEqual(Object.keys(COST_PRESETS).sort());
    const parsed = parseCliArgs(["keys", "increase-cost", "/vault", "--cost", "high", "--accept-no-revocation", "--allow-downgrade"]);
    expect(parsed.command).toBe("keys");
    expect(parsed.operands).toEqual(["increase-cost", "/vault"]);
    expect(parsed.keys).toEqual({ cost: "high", acceptNoRevocation: true, allowDowngrade: true });
    expect(parseCliArgs(["publish", "/vault"]).keys).toEqual({ cost: undefined, acceptNoRevocation: false, allowDowngrade: false });
    expect(() => parseCliArgs(["keys", "increase-cost", "/vault", "--cost", "extreme"])).toThrow(UsageError);
  });

  it("documents the keys commands, their flags and the statements in the help text", () => {
    for (const phrase of ["ipfs-sync keys change-passphrase <vault>", "ipfs-sync keys increase-cost <vault>", "--cost standard|high", "--accept-no-revocation", "--allow-downgrade"]) {
      expect(HELP_TEXT, phrase).toContain(phrase);
    }
    expect(HELP_TEXT).toMatch(/does not revoke/i);
    // The plugin asks for a cost above the default on its manual paths; its timer and catch-up pull never ask.
    expect(HELP_TEXT).not.toMatch(/no approval dialog/);
    expect(HELP_TEXT).toMatch(/timer and catch-up pull/);
  });

  it.each([
    [[], /keys needs a subcommand and the vault directory/],
    [["change-passphrase"], /keys needs a subcommand and the vault directory/],
    [["rotate", "/vault"], /unknown keys subcommand "rotate"/],
    [["increase-cost", "/vault", "extra"], /keys needs a subcommand and the vault directory/],
  ])("exits 2 for %j without sending a request", async (args, message) => {
    const result = await keys(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(rig.requests).toEqual([]);
  });

  it("exits 2 when increase-cost has no --cost", async () => {
    const result = await keys(["increase-cost", ...target(), "--accept-no-revocation"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--cost/);
    expect(rig.requests).toEqual([]);
  });

  it.each([["--cost", "high"], ["--accept-no-revocation"], ["--allow-downgrade"]])("refuses %s on another command", async (...flag) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["publish", rig.vaultA, "--config", configA(), "--mfs-root", MFS_ROOT, ...flag], { env: stateEnv(), now: () => NOW, readText: readTextIfPresent }, { out: (t) => void out.push(t), err: (t) => void err.push(t) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("only valid for the keys command");
    expect(rig.requests).toEqual([]);
  });

  it("refuses a passphrase on the command line, by name", async () => {
    const result = await keys(["change-passphrase", ...target(), "--passphrase", "AAAAA-AAAAA"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--passphrase");
    expect(result.err).not.toContain("AAAAA-AAAAA");
  });

  it("change-passphrase without a terminal and without --passphrase-file is a usage error before any request", async () => {
    const result = await keys(["change-passphrase", ...target(), "--accept-no-revocation"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/terminal to show the new passphrase|--passphrase-file/);
    expect(rig.requests).toEqual([]);
  });

  it("increase-cost refuses --passphrase-file: it generates no passphrase", async () => {
    const result = await keys(["increase-cost", ...target(), "--cost", "standard", "--passphrase-file", join(rig.dir, "x.pass"), "--accept-no-revocation"]);
    expect(result.code).toBe(2);
    expect(rig.requests).toEqual([]);
  });

  it("a run that cannot ask and was not given --accept-no-revocation is a usage error before any request", async () => {
    const result = await keys(["increase-cost", ...target(), "--cost", "standard"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--accept-no-revocation");
    expect(rig.requests).toEqual([]);
  });
});

describe("a held lock", () => {
  it("refuses with the lock text and changes nothing", async () => {
    const lock = await acquirePublishLock(createNodeLockFile(rig.vaultA), createNodeLockContext(() => NOW.getTime()));
    try {
      const result = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"]);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/lock/i);
      expect(mutating()).toEqual([]);
      expect(rig.node.files.get(KEYSLOTS)).toBeDefined();
    } finally {
      await lock.release();
    }
  });
});

describe("increase-cost", () => {
  it("raises the cost under the same passphrase, states what it does not revoke, and leaves the manifest and the sequence alone", { timeout: SLOW }, async () => {
    const manifestBefore = rig.node.files.get(MANIFEST);
    const historyBefore = historyNames(rig.node);
    const rootBefore = rig.node.cidOf(MFS_ROOT);
    const questions: string[] = [];
    const result = await keys(["increase-cost", ...target(), "--cost", "standard"], { confirm: yes, questions });
    expect(result.err).not.toMatch(/failed/);
    expect(result.code).toBe(0);

    // The statements come before the question, and the question itself repeats that nothing is revoked.
    expect(result.out).toContain(REVOCATION_STATEMENT);
    expect(result.out).toContain(SAME_PASSPHRASE_STATEMENT);
    expect(result.out).toMatch(/cost of the new slot: 64 MiB, 3 iterations/);
    expect(result.out).toMatch(/four key derivations/);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/still open this vault/);
    expect(result.out.indexOf(REVOCATION_STATEMENT)).toBeGreaterThanOrEqual(0);

    const onNode = rig.node.files.get(KEYSLOTS) as Uint8Array;
    const document = parseKeySlots(onNode);
    expect(document.slots).toHaveLength(1);
    expect(document.slots[0]).toMatchObject({ kdf: { m: 65_536, t: 3 } });
    expect((await unlockKeySlotsBytes(onNode, referencePassphrase())).keys.vaultId).toBe(vaultKeys.vaultId);
    expect(bytesEqual(rig.node.files.get(MANIFEST), manifestBefore)).toBe(true);
    expect(historyNames(rig.node)).toEqual(historyBefore);
    expect((await decodeManifestFile(vaultKeys, rig.node.files.get(MANIFEST) as Uint8Array)).sequence).toBe(1);
    expect(rig.node.cidOf(MFS_ROOT)).not.toBe(rootBefore);
    expect(result.out).toMatch(/sequence\s+1 \(unchanged/);
    expect(await stat(join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).maintenance)).catch(() => undefined)).toBeUndefined();

    // The next publish, with nothing changed, writes nothing: the record names the new root.
    rig.requests.length = 0;
    const idle = await rig.publish();
    expect(idle.code).toBe(0);
    expect(idle.out).toContain("nothing changed");
    expect(mutating()).toEqual([]);
  });

  it("refuses a cost that is not higher than the current one and changes nothing", async () => {
    const floorCost = (parseKeySlots(rig.node.files.get(KEYSLOTS) as Uint8Array).slots[0] as { kdf: { m: number; t: number } }).kdf;
    expect(floorCost.m).toBeLessThan(COST_PRESETS.standard.m);
    const first = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"]);
    expect(first.code).toBe(0);
    rig.requests.length = 0;
    const again = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/not higher/);
    expect(mutating()).toEqual([]);
  }, SLOW * 2);

  it("a wrong current passphrase is the one unlock failure and changes nothing", async () => {
    const result = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"], { passphrase: async () => canonical(OTHER_PASSPHRASE) });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/wrong passphrase/);
    expect(mutating()).toEqual([]);
    expect(rig.node.files.get(KEYSLOTS)).toBeDefined();
  });

  it("no passphrase source is a refusal before any request", async () => {
    const result = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"], { passphrase: async () => undefined });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/passphrase/);
    expect(rig.requests).toEqual([]);
  });

  it("declining the confirmation changes nothing and exits 1", async () => {
    const result = await keys(["increase-cost", ...target(), "--cost", "standard"], { confirm: async () => false });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not confirmed/);
    expect(mutating()).toEqual([]);
  });

  it("a node that is ahead of this device is refused with the pull instruction", async () => {
    // The node moves to sequence 2 while this device's record stays at sequence 1.
    const stateFile = join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).state);
    const stateAt1 = await readFile(stateFile);
    await writeFile(join(rig.vaultA, "later.md"), "later\n");
    expect((await rig.publish()).code).toBe(0);
    await writeFile(stateFile, stateAt1);
    rig.requests.length = 0;
    const result = await keys(["increase-cost", ...target(), "--cost", "standard", "--accept-no-revocation"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/pull/i);
    expect(mutating()).toEqual([]);
  });
});

describe("change-passphrase", () => {
  it("shows the new passphrase once on the terminal, takes it back, and the old passphrase then fails on the node's file", async () => {
    const terminal = retypingTerminal();
    const previousRoot = rig.node.cidOf(MFS_ROOT) as string;
    const previousSlots = rig.node.files.get(KEYSLOTS) as Uint8Array;
    const result = await keys(["change-passphrase", ...target()], { terminal, confirm: yes });
    expect(result.err).not.toMatch(/failed/);
    expect(result.code).toBe(0);
    const fresh = shown(terminal);
    expect(terminal.rawModes.at(-1)).toBe(false);
    // The passphrase is on the terminal, and nowhere else.
    expect(result.all.join("\n")).not.toContain(fresh);
    expect(result.all.join("\n")).not.toContain(fresh.replaceAll("-", ""));

    const onNode = rig.node.files.get(KEYSLOTS) as Uint8Array;
    expect(parseKeySlots(onNode).slots).toHaveLength(1);
    expect((await unlockKeySlotsBytes(onNode, canonical(fresh))).keys.vaultId).toBe(vaultKeys.vaultId);
    await expect(unlockKeySlotsBytes(onNode, referencePassphrase())).rejects.toMatchObject({ code: "wrong-passphrase-or-damaged-slot" });
    // The old passphrase still opens the copy in the previous root and the bytes the vault had before.
    expect((await unlockKeySlotsBytes(previousSlots, referencePassphrase())).keys.vaultId).toBe(vaultKeys.vaultId);
    expect(rig.node.cidOf(`/ipfs/${previousRoot}/keyslots.json`)).toBeDefined();
    expect(result.out).toContain(REVOCATION_STATEMENT);
    expect(result.out).not.toContain(SAME_PASSPHRASE_STATEMENT);
    expect((await decodeManifestFile(vaultKeys, rig.node.files.get(MANIFEST) as Uint8Array)).sequence).toBe(1);
  });

  it("a retyped passphrase that does not match ends the command with nothing changed", async () => {
    const terminal = createFakeTerminal({ answers: [`${OTHER_PASSPHRASE}\r`] });
    const result = await keys(["change-passphrase", ...target()], { terminal, confirm: yes });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/does not match/);
    expect(result.err).toMatch(/nothing was changed/);
    expect(mutating()).toEqual([]);
    expect(terminal.rawModes.at(-1)).toBe(false);
  });

  it("writes the generated passphrase to a new 0600 file with --passphrase-file and prints only the path", async () => {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "new.pass");
    const result = await keys(["change-passphrase", ...target(), "--passphrase-file", path, "--accept-no-revocation"]);
    expect(result.err).not.toMatch(/ipfs-sync: keys failed/);
    expect(result.code).toBe(0);
    const text = (await readFile(path, "utf8")).trim();
    expect(text).toMatch(new RegExp(`^${GENERATED.source}$`));
    expect(result.all.join("\n")).not.toContain(text);
    expect(result.out).toContain(path);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    const onNode = rig.node.files.get(KEYSLOTS) as Uint8Array;
    expect((await unlockKeySlotsBytes(onNode, canonical(text))).keys.vaultId).toBe(vaultKeys.vaultId);
  });

  it("does not leave the new passphrase file behind when the command fails before anything reached the node", async () => {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "new.pass");
    const keyOperations: KeyOperations = {
      rewrap: async () => {
        throw new CryptoError("invalid-argument", "the rewrap failed");
      },
      unlock: async () => {
        throw new Error("not reached");
      },
    };
    const result = await keys(["change-passphrase", ...target(), "--passphrase-file", path, "--accept-no-revocation"], { keyOperations });
    expect(result.code).toBe(1);
    expect(mutating()).toEqual([]);
    expect(await stat(path).catch(() => undefined)).toBeUndefined();
  });

  it("a wrong current passphrase creates no passphrase file and no journal", async () => {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "new.pass");
    const result = await keys(["change-passphrase", ...target(), "--passphrase-file", path, "--accept-no-revocation"], { passphrase: async () => canonical(OTHER_PASSPHRASE) });
    expect(result.code).toBe(1);
    expect(await stat(path).catch(() => undefined)).toBeUndefined();
    expect(mutating()).toEqual([]);
  });
});

describe("the downgrade question", () => {
  const plan: RewrapCostPlan = { current: { m: 131_072, t: 4, p: 1 }, next: { m: 65_536, t: 3, p: 1 }, raises: false, downgrade: true };
  const sinkOf = () => {
    const err: string[] = [];
    return { io: { out: () => undefined, err: (t: string) => void err.push(t) } satisfies CliIo, err };
  };

  it("asks with both costs and proceeds only on a yes", async () => {
    const questions: string[] = [];
    const { io } = sinkOf();
    const asking: CliIo = { ...io, confirm: async (question) => (questions.push(question), true) };
    expect(await confirmDowngrade(asking, plan, false)).toBe(true);
    expect(questions[0]).toContain("128 MiB, 4 iterations");
    expect(questions[0]).toContain("64 MiB, 3 iterations");
    expect(await confirmDowngrade({ ...io, confirm: async () => false }, plan, false)).toBe(false);
  });

  it("without a terminal it proceeds only with --allow-downgrade", async () => {
    const { io } = sinkOf();
    expect(await confirmDowngrade(io, plan, false)).toBe(false);
    expect(await confirmDowngrade(io, plan, true)).toBe(true);
  });

  it("asks nothing when the cost does not fall", async () => {
    const { io } = sinkOf();
    expect(await confirmDowngrade(io, { ...plan, downgrade: false, raises: true }, false)).toBe(true);
  });
});

describe("an interrupted run is finished by running the command again", () => {
  /** A run killed by the node after `after` mutations: the journal stays; the error may be the kill itself or a client error around it. */
  async function killedRun(after: number, args: readonly string[]): Promise<void> {
    rig.node.mutations = 0;
    rig.node.killAfterMutation = after;
    await keys(args).then(
      () => undefined,
      () => undefined,
    );
    rig.node.killAfterMutation = undefined;
  }
  const journalFile = (): string => join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).maintenance);

  it.each([
    [1, "after the key-slot file was written"],
    [2, "after the pin"],
    [3, "after name/publish"],
  ])("killed %i mutation(s) in (%s): publish and pull are paused, and the same command finishes it with the one slot", async (after) => {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700 });
    const args = ["change-passphrase", ...target(), "--passphrase-file", join(directory, "new.pass"), "--accept-no-revocation"];
    await killedRun(after, args);
    expect(await stat(journalFile()).catch(() => undefined)).toBeDefined();
    const slotsAfterKill = new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array);

    // Publish and pull are paused, naming both ways out.
    const blocked = await rig.publish();
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("keys discard");
    expect(blocked.err).toContain("keys accept-slots");

    rig.requests.length = 0;
    const second = await keys(["change-passphrase", ...target(), "--accept-no-revocation"], { confirm: yes });
    expect(second.err).not.toMatch(/failed/);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/finish/i);
    // Never a second slot: the file the node holds after the kill is the file it holds now, and the local copy equals it.
    const finalSlots = rig.node.files.get(KEYSLOTS) as Uint8Array;
    expect(bytesEqual(finalSlots, slotsAfterKill)).toBe(true);
    expect(parseKeySlots(finalSlots).slots).toHaveLength(1);
    const copy = await readFile(join(rig.vaultA, ".ipfs-sync", rootFileNames(MFS_ROOT).keyslots));
    expect(bytesEqual(new Uint8Array(copy), finalSlots)).toBe(true);
    expect(await stat(journalFile()).catch(() => undefined)).toBeUndefined();
    expect(second.out).toMatch(/new passphrase was not tested again/);
    // The vault publishes again under the new slot.
    const text = (await readFile(join(directory, "new.pass"), "utf8")).trim();
    expect((await unlockKeySlotsBytes(finalSlots, canonical(text))).keys.vaultId).toBe(vaultKeys.vaultId);
  });

  it("a lost race is refused naming keys discard and keys accept-slots", async () => {
    const directory = join(rig.dir, "secret");
    await mkdir(directory, { mode: 0o700 });
    const args = ["change-passphrase", ...target(), "--passphrase-file", join(directory, "new.pass"), "--accept-no-revocation"];
    await killedRun(1, args);
    const rival = new Uint8Array(rig.node.files.get(KEYSLOTS) as Uint8Array);
    rival[rival.length - 3] = (rival[rival.length - 3] ?? 0) ^ 1;
    rig.node.files.set(KEYSLOTS, rival);
    const result = await keys(["change-passphrase", ...target(), "--accept-no-revocation"], { confirm: yes });
    expect(result.code).toBe(1);
    expect(result.err).toContain("keys discard");
    expect(result.err).toContain("keys accept-slots");
  });
});
