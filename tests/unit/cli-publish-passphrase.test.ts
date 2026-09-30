import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { initDiskVault } from "../helpers/cli-vault";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { createFakeTerminal } from "../helpers/fake-terminal";
import { REJECTED_PHRASES, VALID_PASSPHRASE } from "../vectors/passphrase";
import type { CanonicalPassphrase } from "../../src/crypto";
import { OTHER_PASSPHRASE, otherPassphrase, referencePassphrase } from "../vectors/slot-helpers";

const MFS_ROOT = "/obsidian-vault-sync/cli-passphrase";
const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];
const POSIX_USER = process.getuid?.();

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function sink(): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t) }, out, err };
}

function spellings(passphrase: string): string[] {
  const compact = passphrase.replaceAll("-", "");
  return [passphrase, passphrase.toLowerCase(), compact, compact.toLowerCase()];
}

describe("ipfs-sync publish: unlocking with a passphrase", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-pubpass-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    requests = [];
    fetchStub = vi.fn(fakeNodeFetch(node, requests));
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const publish = async (env: Record<string, string>, extra: string[] = [], overrides: Partial<CliDeps> = {}) => {
    const s = sink();
    const deps: CliDeps = { env, now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent, ...overrides };
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT, ...extra], deps, s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n"), all: [...s.out, ...s.err] };
  };
  const mutating = (): string[] => requests.filter((r) => MUTATING.includes(r));
  const passphraseFile = async (text: string, mode = 0o600): Promise<string> => {
    const path = join(dir, "vault.pass");
    await writeFile(path, text, { mode });
    await chmod(path, mode);
    return path;
  };
  const expectNoSecret = (texts: readonly string[], passphrase: string): void => {
    for (const form of spellings(passphrase)) expect(texts.join("\n")).not.toContain(form);
  };

  describe("with a vault created by init", () => {
    beforeEach(async () => {
      await initDiskVault(vault, MFS_ROOT, node);
    });

    it("unlocks from IPFS_SYNC_PASSPHRASE, and the passphrase appears nowhere in the output or the --show-request trace", async () => {
      const result = await publish({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display.toLowerCase() }, ["--show-request"]);
      expect(result.code).toBe(0);
      expect(result.out).toContain("request POST");
      expectNoSecret(result.all, VALID_PASSPHRASE.display);
    });

    it("unlocks from the 0600 file named by IPFS_SYNC_PASSPHRASE_FILE", async () => {
      const path = await passphraseFile(`${VALID_PASSPHRASE.display}\n`);
      const result = await publish({ IPFS_SYNC_PASSPHRASE_FILE: path }, ["--show-request"]);
      expect(result.code).toBe(0);
      expect(result.err).toBe("");
      expectNoSecret(result.all, VALID_PASSPHRASE.display);
    });

    it("unlocks from the no-echo prompt on a terminal when neither variable is set", async () => {
      const terminal = createFakeTerminal({ answers: [`${VALID_PASSPHRASE.display}\r`] });
      const result = await publish({}, [], { terminal });
      expect(result.code).toBe(0);
      expect(terminal.written).toEqual(["Vault passphrase: ", "\n"]);
      expect(terminal.rawModes).toEqual([true, false]);
      expectNoSecret([...result.all, ...terminal.written], VALID_PASSPHRASE.display);
    });

    it("fails before any request when both variables are set", async () => {
      const path = await passphraseFile(VALID_PASSPHRASE.display);
      const result = await publish({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display, IPFS_SYNC_PASSPHRASE_FILE: path });
      expect(result.code).toBe(1);
      expect(result.err).toContain("exactly one");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("fails before any request with the passphrase-required error when there is no source and no terminal", async () => {
      const result = await publish({});
      expect(result.code).toBe(1);
      expect(result.err).toContain("needs the vault passphrase");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("fails before any request when standard input is not a terminal, even with a terminal object present", async () => {
      const terminal = createFakeTerminal({ inputIsTty: false, answers: [`${VALID_PASSPHRASE.display}\r`] });
      const result = await publish({}, [], { terminal });
      expect(result.code).toBe(1);
      expect(result.err).toContain("needs the vault passphrase");
      expect(terminal.rawModes).toEqual([]);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === "win32").each([0o644, 0o640, 0o604])("refuses a passphrase file with mode %o before any request", async (mode) => {
      const path = await passphraseFile(VALID_PASSPHRASE.display, mode);
      const result = await publish({ IPFS_SYNC_PASSPHRASE_FILE: path });
      expect(result.code).toBe(1);
      expect(result.err).toContain("0600");
      expect(fetchStub).not.toHaveBeenCalled();
      expectNoSecret(result.all, VALID_PASSPHRASE.display);
    });

    it.skipIf(process.platform === "win32")("refuses a symbolic link to a 0600 passphrase file before any request", async () => {
      const real = await passphraseFile(VALID_PASSPHRASE.display);
      const link = join(dir, "link.pass");
      await symlink(real, link);
      const result = await publish({ IPFS_SYNC_PASSPHRASE_FILE: link });
      expect(result.code).toBe(1);
      expect(result.err).toContain("symbolic link");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it.skipIf(POSIX_USER === undefined || process.platform === "win32")("refuses a foreign-owned passphrase file before any request", async () => {
      const path = await passphraseFile(VALID_PASSPHRASE.display);
      const result = await publish({ IPFS_SYNC_PASSPHRASE_FILE: path }, [], { userId: (POSIX_USER ?? 0) + 1 });
      expect(result.code).toBe(1);
      expect(result.err).toContain("another user");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it.each(REJECTED_PHRASES)("refuses %j from each source with the passphrase-format explanation before any request", async (phrase) => {
      const fromFile = await passphraseFile(`${phrase.text}\n`);
      const terminal = createFakeTerminal({ answers: [`${phrase.text}\r`] });
      const results = [
        await publish({ IPFS_SYNC_PASSPHRASE: phrase.text }),
        await publish({ IPFS_SYNC_PASSPHRASE_FILE: fromFile }),
        await publish({}, [], { terminal }),
      ];
      for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.err).toContain("not a valid generated passphrase");
        expect(result.err).toContain("check symbols do not match");
        expect(result.err).toContain("ipfs-sync init");
        expect(result.err).not.toContain(phrase.text);
      }
      expect(terminal.rawModes.at(-1)).toBe(false);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    describe("wiping the canonical passphrase", () => {
      /** A passphrase source that keeps hold of what it handed out, so the test can look at the bytes afterwards. */
      const spy = (make: () => CanonicalPassphrase) => {
        const handed: { bytes?: CanonicalPassphrase; before?: number[] } = {};
        const source = async (): Promise<CanonicalPassphrase> => {
          handed.bytes = make();
          handed.before = [...handed.bytes];
          return handed.bytes;
        };
        return { handed, source };
      };
      const allZero = (bytes: Uint8Array | undefined): boolean => bytes !== undefined && bytes.length > 0 && bytes.every((byte) => byte === 0);

      it("zeroes it after a successful publish", async () => {
        const { handed, source } = spy(referencePassphrase);
        const result = await publish({}, [], { passphrase: source });
        expect(result.code).toBe(0);
        expect(handed.before?.some((byte) => byte !== 0)).toBe(true);
        expect(allZero(handed.bytes)).toBe(true);
      });

      it("zeroes it when the engine refuses (wrong passphrase)", async () => {
        const { handed, source } = spy(otherPassphrase);
        const result = await publish({}, [], { passphrase: source });
        expect(result.code).toBe(1);
        expect(handed.before?.some((byte) => byte !== 0)).toBe(true);
        expect(allZero(handed.bytes)).toBe(true);
      });

      it("zeroes it when the engine throws something the CLI does not report", async () => {
        const { handed, source } = spy(referencePassphrase);
        const failing = new Error("simulated crash");
        vi.stubGlobal("fetch", vi.fn(() => {
          throw failing;
        }));
        const outcome = await publish({}, [], { passphrase: source }).catch((error: unknown) => error);
        expect(handed.bytes).toBeDefined();
        expect(allZero(handed.bytes)).toBe(true);
        expect(outcome === failing || (outcome as { code?: number }).code === 1).toBe(true);
      });
    });

    it("fails before any request and without echoing a valid passphrase that is the wrong one", async () => {
      const result = await publish({ IPFS_SYNC_PASSPHRASE: OTHER_PASSPHRASE });
      expect(result.code).toBe(1);
      expect(fetchStub).not.toHaveBeenCalled();
      expectNoSecret(result.all, OTHER_PASSPHRASE);
    });
  });

  describe("options", () => {
    it.each([["--passphrase", "hunter2-hunter2"], ["--passphrase=hunter2-hunter2"]])("rejects %j as an unknown option that names the sources, without echoing the value", async (...flag) => {
      const result = await publish({}, flag);
      expect(result.code).toBe(2);
      expect(result.err).toContain("unknown option --passphrase");
      expect(result.err).toContain("IPFS_SYNC_PASSPHRASE_FILE");
      expect(result.err).toContain("prompt");
      expect(result.err).not.toContain("hunter2");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("does not treat --passphrase-file as a publish option", async () => {
      const result = await publish({}, ["--passphrase-file", join(dir, "x")]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("only valid for the init command");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("explains the exposure of the environment variable in the help text", async () => {
      const s = sink();
      expect(await runCli(["--help"], { env: {}, now: () => new Date(), readText: readTextIfPresent }, s.io)).toBe(0);
      const help = s.out.join("\n");
      expect(help).toContain("ipfs-sync init <vault>");
      expect(help).toContain("--passphrase-file");
      expect(help).toContain("IPFS_SYNC_PASSPHRASE_FILE");
      expect(help).toMatch(/shell history and CI logs/);
      expect(help).toMatch(/prompt for interactive work and the 0600 file for automation/);
      expect(help).toContain("no --passphrase");
      expect(help).toMatch(/scrollback/);
      expect(help).toMatch(/script and tmux/);
      expect(help).toMatch(/inherited by every child process/);
    });
  });

  describe("without a vault", () => {
    it("refuses on an empty root, names ipfs-sync init, and sends no write", async () => {
      const result = await publish({ IPFS_SYNC_PASSPHRASE: VALID_PASSPHRASE.display });
      expect(result.code).toBe(1);
      expect(result.err).toContain("ipfs-sync init");
      expect(mutating()).toEqual([]);
      expect(node.files.size).toBe(0);
    });
  });
});
