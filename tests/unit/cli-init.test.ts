import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { canonicalizePassphraseText } from "../../src/crypto";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal";
import { OTHER_PASSPHRASE } from "../vectors/slot-helpers";

const MFS_ROOT = "/obsidian-vault-sync/init-test";
const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];
const GENERATED = /[A-Z2-7]{5}(?:-[A-Z2-7]{5}){4}/;
const POSIX_USER = process.getuid?.();
/** Default-cost key derivation (64 MiB, 3 passes) runs for real in the tests that create a vault. */
const SLOW = 60_000;

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

/** The secret in every form a leak could take. */
function spellings(passphrase: string): string[] {
  const compact = passphrase.replaceAll("-", "");
  return [passphrase, passphrase.toLowerCase(), compact, compact.toLowerCase()];
}

function expectNoSecret(texts: readonly string[], passphrase: string): void {
  const haystack = texts.join("\n");
  for (const form of spellings(passphrase)) expect(haystack).not.toContain(form);
}

describe("ipfs-sync init", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-init-"));
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

  const deps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
    env: {},
    now: () => new Date("2026-09-30T12:00:00Z"),
    readText: readTextIfPresent,
    ...overrides,
  });
  const init = async (extra: string[] = [], overrides: Partial<CliDeps> = {}) => {
    const s = sink();
    const code = await runCli(["init", vault, "--mfs-root", MFS_ROOT, ...extra], deps(overrides), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n"), all: [...s.out, ...s.err] };
  };
  const publish = async (env: Record<string, string>, extra: string[] = [], overrides: Partial<CliDeps> = {}) => {
    const s = sink();
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT, ...extra], deps({ env, ...overrides }), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n"), all: [...s.out, ...s.err] };
  };
  const passphraseFile = (): string => join(dir, "secret", "vault.pass");
  const prepareSecretDir = async (): Promise<void> => {
    await mkdir(join(dir, "secret"), { mode: 0o700 });
  };
  const mutating = (): string[] => requests.filter((r) => MUTATING.includes(r));
  const keySlotsOnNode = (): boolean => node.files.has(`${MFS_ROOT}/keyslots.json`);
  const localCopies = async (): Promise<string[]> => (await readdir(join(vault, ".ipfs-sync")).catch(() => [])).filter((name) => name.startsWith("keyslots."));

  describe("with --passphrase-file", () => {
    it("creates the file 0600, prints only the path, sends the consequence text to standard error, and creates the vault", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      const path = passphraseFile();
      const result = await init(["--passphrase-file", path, "--show-request"]);
      expect(result.code).toBe(0);

      const content = await readFile(path, "utf8");
      expect(content).toMatch(new RegExp(`^${GENERATED.source}\\n$`));
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      const passphrase = content.trim();

      expect(result.out).toContain(`passphrase file  ${path}`);
      expect(result.err).toContain("no recovery");
      expect(result.err).toContain("password manager");
      expectNoSecret(result.all, passphrase);

      expect(keySlotsOnNode()).toBe(true);
      expect(await localCopies()).toHaveLength(1);
      expect(requests).not.toContain("name/publish");
      expect(mutating()).toEqual(["files/write"]);
      // The file's passphrase is a valid generated one.
      expect(() => canonicalizePassphraseText(passphrase)).not.toThrow();
    });

    it("lets publish unlock the new vault from that file and publish it", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      const path = passphraseFile();
      expect((await init(["--passphrase-file", path])).code).toBe(0);
      const published = await publish({ IPFS_SYNC_PASSPHRASE_FILE: path });
      expect(published.code).toBe(0);
      expect(published.out).toContain("sequence  1");
      expectNoSecret(published.all, (await readFile(path, "utf8")).trim());
    });

    it("refuses an existing file before any request and leaves it untouched", async () => {
      await prepareSecretDir();
      const path = passphraseFile();
      await writeFile(path, "precious\n", { mode: 0o600 });
      const result = await init(["--passphrase-file", path]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("already exists");
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe("precious\n");
      expect(await localCopies()).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("refuses a symbolic link at the path (dangling or not) before any request", async () => {
      await prepareSecretDir();
      const target = join(dir, "secret", "target.pass");
      const dangling = join(dir, "secret", "dangling.pass");
      const live = join(dir, "secret", "live.pass");
      await symlink(target, dangling);
      await writeFile(join(dir, "secret", "real.pass"), "x\n", { mode: 0o600 });
      await symlink(join(dir, "secret", "real.pass"), live);
      for (const path of [dangling, live]) {
        const result = await init(["--passphrase-file", path]);
        expect(result.code).toBe(1);
        expect(result.err).toContain("symbolic link");
      }
      expect(fetchStub).not.toHaveBeenCalled();
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(dir, "secret", "real.pass"), "utf8")).toBe("x\n");
    });

    it.skipIf(process.platform === "win32")("refuses a directory that is a symbolic link before any request", async () => {
      await prepareSecretDir();
      await symlink(join(dir, "secret"), join(dir, "linked"));
      const result = await init(["--passphrase-file", join(dir, "linked", "vault.pass")]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("symbolic link");
      expect(fetchStub).not.toHaveBeenCalled();
      await expect(stat(passphraseFile())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.skipIf(POSIX_USER === undefined || process.platform === "win32")("refuses a directory owned by another user before any request", async () => {
      await prepareSecretDir();
      const result = await init(["--passphrase-file", passphraseFile()], { userId: (POSIX_USER ?? 0) + 1 });
      expect(result.code).toBe(1);
      expect(result.err).toContain("owned by another user");
      expect(fetchStub).not.toHaveBeenCalled();
      await expect(stat(passphraseFile())).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a missing directory before any request", async () => {
      const result = await init(["--passphrase-file", join(dir, "nowhere", "vault.pass")]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("does not exist");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("says plainly on a system without POSIX modes that no mode check exists", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      const result = await init(["--passphrase-file", passphraseFile()], { platform: "win32", userId: undefined });
      expect(result.code).toBe(0);
      expect(result.err).toContain("Windows has no POSIX mode check");
      expect(result.err).toContain("inherits the access list of its folder");
      // Said once, and before the file is reported as written.
      expect(result.err.split("Windows has no POSIX mode check")).toHaveLength(2);
      expect(result.err.indexOf("Windows has no POSIX mode check")).toBeLessThan(result.err.indexOf("was generated and written"));
      expectNoSecret(result.all, (await readFile(passphraseFile(), "utf8")).trim());
    });

    it("ignores a passphrase in the environment, both variables included, and says so", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      const path = passphraseFile();
      const result = await init(["--passphrase-file", path], {
        env: { IPFS_SYNC_PASSPHRASE: OTHER_PASSPHRASE, IPFS_SYNC_PASSPHRASE_FILE: join(dir, "not-read") },
      });
      expect(result.code).toBe(0);
      expect(result.err).toContain("IPFS_SYNC_PASSPHRASE is set and ignored");
      const generated = (await readFile(path, "utf8")).trim();
      expect(generated.replaceAll("-", "")).not.toBe(OTHER_PASSPHRASE);
      expectNoSecret(result.all, OTHER_PASSPHRASE);
      expectNoSecret(result.all, generated);
    });

    it("refuses a root that holds anything at all, not only key slots or a manifest, before the file is created", async () => {
      await prepareSecretDir();
      node.files.set(`${MFS_ROOT}/old-note.md`, new Uint8Array([1]));
      const result = await init(["--passphrase-file", passphraseFile()]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("is not empty");
      expect(mutating()).toEqual([]);
      await expect(stat(passphraseFile())).rejects.toMatchObject({ code: "ENOENT" });
      expect(await localCopies()).toEqual([]);
    });

    it("does not delete or change the file when the root already holds a vault", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      node.files.set(`${MFS_ROOT}/keyslots.json`, new Uint8Array([1, 2, 3]));
      const result = await init(["--passphrase-file", passphraseFile()]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("already holds a vault");
      expect(mutating()).toEqual([]);
      await expect(stat(passphraseFile())).rejects.toMatchObject({ code: "ENOENT" });
      expect(await localCopies()).toEqual([]);
    });

    it("refuses to create a second vault on a device that holds a key-slot copy, before any request", { timeout: SLOW }, async () => {
      await prepareSecretDir();
      expect((await init(["--passphrase-file", passphraseFile()])).code).toBe(0);
      requests.length = 0;
      fetchStub.mockClear();
      const second = await init(["--passphrase-file", join(dir, "secret", "second.pass")]);
      expect(second.code).toBe(1);
      expect(second.err).toContain("already holds a key-slot copy");
      expect(fetchStub).not.toHaveBeenCalled();
      await expect(stat(join(dir, "secret", "second.pass"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("without a source of passphrase", () => {
    it("fails as a usage error before any request when there is neither a terminal nor --passphrase-file", async () => {
      const result = await init();
      expect(result.code).toBe(2);
      expect(result.err).toContain("--passphrase-file");
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("fails when standard input is a terminal but standard error is not, since it cannot show the passphrase safely", async () => {
      const terminal = createFakeTerminal({ outputIsTty: false });
      const result = await init([], { terminal });
      expect(result.code).toBe(1);
      expect(result.err).toContain("--passphrase-file");
      expect(terminal.written).toEqual([]);
      expect(mutating()).toEqual([]);
    });

    it("refuses a vault that is not a fixture vault before any request", async () => {
      await rm(join(vault, ".ipfs-sync-fixture"));
      const result = await init(["--passphrase-file", passphraseFile()]);
      expect(result.code).toBe(2);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe("on a terminal", () => {
    const shownPassphrase = (terminal: FakeTerminal): string => {
      const shown = terminal.written.join("").match(GENERATED);
      if (shown === null) throw new Error("no passphrase was shown");
      return shown[0];
    };
    /** A terminal that answers the confirmation prompt with the passphrase it just showed, typed the way a user might. */
    const confirming = (form: (shown: string) => string): FakeTerminal => {
      const terminal = createFakeTerminal();
      const original = terminal.input.resume.bind(terminal.input);
      terminal.input.resume = () => {
        original();
        queueMicrotask(() => terminal.send(`${form(shownPassphrase(terminal))}\r`));
      };
      return terminal;
    };

    it("shows the generated passphrase once with the no-recovery text, takes it again, creates the vault", { timeout: SLOW }, async () => {
      const terminal = confirming((shown) => shown.replaceAll("-", "").toLowerCase());
      const result = await init([], { terminal });
      expect(result.code).toBe(0);

      const screen = terminal.written.join("");
      const shown = shownPassphrase(terminal);
      expect(screen.split(shown)).toHaveLength(2);
      expect(screen).toContain("password manager");
      expect(screen).toContain("There is no recovery");
      expect(screen).toContain("not case-sensitive");
      expect(screen).toContain("Enter the passphrase again to confirm: ");
      // Shown 5x5, indented, on a line of its own.
      expect(screen).toMatch(new RegExp(`\\n    ${GENERATED.source}\\n`));
      expectNoSecret(result.all, shown);
      expect(terminal.rawModes).toEqual([true, false]);
      expect(terminal.listeners()).toBe(0);
      expect(keySlotsOnNode()).toBe(true);
      expect(await localCopies()).toHaveLength(1);
    });

    it("creates nothing and sends nothing when the passphrase is entered again wrongly", async () => {
      const terminal = createFakeTerminal({ answers: [`${OTHER_PASSPHRASE}\r`] });
      const result = await init([], { terminal });
      expect(result.code).toBe(1);
      expect(result.err).toContain("does not match");
      expect(mutating()).toEqual([]);
      expect(keySlotsOnNode()).toBe(false);
      expect(await localCopies()).toEqual([]);
      expect(terminal.rawModes.at(-1)).toBe(false);
      expectNoSecret(result.all, shownPassphrase(terminal));
    });

    it("creates nothing when the entry again has a typo (failed check) or is not a passphrase at all", async () => {
      for (const typed of ["HEZVI-DN7IB-GLQIX-B5L7V-ARDHD", "Correct Horse Battery Staple", ""]) {
        const terminal = createFakeTerminal({ answers: [`${typed}\r`] });
        const result = await init([], { terminal });
        expect(result.code).toBe(1);
        expect(result.err).toMatch(/does not match|is not valid/);
      }
      expect(mutating()).toEqual([]);
      expect(await localCopies()).toEqual([]);
    });

    it("creates nothing when the user presses Ctrl-C at the confirmation", async () => {
      const terminal = createFakeTerminal({ answers: ["\u0003"] });
      const result = await init([], { terminal });
      expect(result.code).toBe(1);
      expect(result.err).toContain("aborted");
      expect(terminal.rawModes).toEqual([true, false]);
      expect(mutating()).toEqual([]);
      expect(await localCopies()).toEqual([]);
    });

    it("inspects the root before showing anything: a root that holds a vault never sees the passphrase or the prompt", async () => {
      node.files.set(`${MFS_ROOT}/keyslots.json`, new Uint8Array([1, 2, 3]));
      const terminal = createFakeTerminal();
      const result = await init([], { terminal });
      expect(result.code).toBe(1);
      expect(result.err).toContain("already holds a vault");
      expect(terminal.written).toEqual([]);
      expect(terminal.rawModes).toEqual([]);
      expect(mutating()).toEqual([]);
    });

    it("ignores a passphrase in the environment and generates its own", { timeout: SLOW }, async () => {
      const terminal = confirming((shown) => shown);
      const result = await init([], { terminal, env: { IPFS_SYNC_PASSPHRASE: OTHER_PASSPHRASE } });
      expect(result.code).toBe(0);
      expect(shownPassphrase(terminal).replaceAll("-", "")).not.toBe(OTHER_PASSPHRASE);
      expect(result.err).toContain("ignored");
    });
  });
});
