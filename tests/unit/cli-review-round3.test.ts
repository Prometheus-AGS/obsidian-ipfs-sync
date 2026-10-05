// Review round 3, CLI items C-M1 to C-M4 and C-L1, C-L2, C-L4. Everything runs in process against temporary directories; `fetch` is a stub that
// fails the test when a request is made, because every case here must be refused before the first one.
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError, parseCliArgs } from "../../cli/args";
import { HELP_TEXT } from "../../cli/help-text";
import { createProcessIo, type CliIo } from "../../cli/io";
import { loadSyncConfig, readTextIfPresent, type ConfigDeps } from "../../cli/load-config";
import { createNodeHostBridge } from "../../cli/node-host-bridge";
import { passphraseFileInsideVault } from "../../cli/passphrase-file";
import { createNodeLockFile } from "../../cli/publish-lock-file";
import { installRequestTrace } from "../../cli/request-trace";
import { runCli, type CliDeps } from "../../cli/run";
import { runStatus } from "../../cli/status-command";
import { ConfigError, resolveSyncConfig } from "../../src/core/config";
import { escapeNodeText } from "../../src/kubo";
import { stateEnv, NODE_ENV } from "../helpers/cli-state-env";

const ESC = String.fromCharCode(0x1b);
const NOW = new Date("2026-10-05T12:00:00Z");

function sink(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => void out.push(text), err: (text) => void err.push(text) }, out, err };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("no request expected");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function cli(argv: readonly string[], env: Record<string, string> = stateEnv(), files: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = sink();
  const deps: CliDeps = { env, now: () => NOW, readText: async (path) => files[path] ?? readTextIfPresent(path) };
  const code = await runCli(argv, deps, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("secrets are not accepted on the command line (C-M1)", () => {
  it.each([
    [["--auth-password", "hunter2-secret"], "IPFS_SYNC_AUTH_PASSWORD"],
    [["--auth-password=hunter2-secret"], "IPFS_SYNC_AUTH_PASSWORD"],
    [["--auth-token", "tok-secret"], "IPFS_SYNC_AUTH_TOKEN"],
    [["--auth-token=tok-secret"], "IPFS_SYNC_AUTH_TOKEN"],
    [["--auth-header-value", "hv-secret"], "IPFS_SYNC_AUTH_HEADER_VALUE"],
    [["--auth-header-value=hv-secret"], "IPFS_SYNC_AUTH_HEADER_VALUE"],
  ])("refuses %j with exit 2, names the variable and does not echo the value", async (flags, variable) => {
    expect(() => parseCliArgs(["status", ...flags])).toThrow(UsageError);
    const result = await cli(["status", ...flags]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(variable);
    expect(result.err).not.toMatch(/secret/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps --auth, --auth-user and --auth-header-name", () => {
    const args = parseCliArgs(["status", "--auth", "basic", "--auth-user", "alice", "--auth-header-name", "X-Key"]);
    expect(args.flagsLayer.auth).toEqual({ scheme: "basic", user: "alice", password: undefined, token: undefined, headerName: "X-Key", headerValue: undefined });
  });

  it("the help text no longer lists the three flags and points at the environment", () => {
    expect(HELP_TEXT).not.toMatch(/--auth-password <|--auth-token <|--auth-header-value </);
    expect(HELP_TEXT).toContain("IPFS_SYNC_AUTH_PASSWORD");
  });
});

describe("a config file found in the working directory does not steer a credential (C-M2)", () => {
  const FILE = JSON.stringify({ rpc: { url: "https://evil.example" } });
  const GATEWAY_FILE = JSON.stringify({ gateway: { url: "https://evil.example" } });
  const NO_URL_FILE = JSON.stringify({ mfsRoot: "/obsidian-vault-sync/x" });
  const CREDENTIAL = { IPFS_SYNC_AUTH_SCHEME: "bearer", IPFS_SYNC_AUTH_TOKEN: "static-token" };

  function deps(env: Record<string, string>, files: Record<string, string>): ConfigDeps {
    return { env, now: () => NOW, readText: async (path) => files[path] };
  }

  it("refuses an implicit file that sets rpc.url while a global credential is configured, and says how to proceed", async () => {
    const error = await loadSyncConfig(parseCliArgs(["status"]), deps({ IPFS_SYNC_GATEWAY_URL: "https://gw.example", ...CREDENTIAL }, { "ipfs-sync.config.json": FILE })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain("--config");
    expect((error as Error).message).not.toContain("static-token");
    expect((error as Error).message).not.toContain("evil.example");
  });

  it("refuses the same for gateway.url, and for a credential given by flag", async () => {
    await expect(loadSyncConfig(parseCliArgs(["status"]), deps({ IPFS_SYNC_RPC_URL: "https://rpc.example", ...CREDENTIAL }, { "ipfs-sync.config.json": GATEWAY_FILE }))).rejects.toBeInstanceOf(ConfigError);
    await expect(
      loadSyncConfig(parseCliArgs(["status", "--auth", "bearer"]), deps({ IPFS_SYNC_GATEWAY_URL: "https://gw.example", IPFS_SYNC_AUTH_TOKEN: "t" }, { "ipfs-sync.config.json": FILE })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("exits 2 through the command line", async () => {
    const result = await cli(["status"], { IPFS_SYNC_GATEWAY_URL: "https://gw.example", ...CREDENTIAL }, { "ipfs-sync.config.json": FILE });
    expect(result.code).toBe(2);
    expect(result.err).toContain("--config");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an explicitly passed --config is unchanged", async () => {
    const config = await loadSyncConfig(parseCliArgs(["status", "--config", "mine.json"]), deps({ IPFS_SYNC_GATEWAY_URL: "https://gw.example", ...CREDENTIAL }, { "mine.json": FILE }));
    expect(config.rpc.baseUrl).toBe("https://evil.example");
  });

  it("does not refuse without a credential, when the file sets no URL, or when the URL is overridden by the environment or a flag", async () => {
    const files = { "ipfs-sync.config.json": FILE };
    await expect(loadSyncConfig(parseCliArgs(["status"]), deps({ IPFS_SYNC_GATEWAY_URL: "https://gw.example" }, files))).resolves.toBeDefined();
    await expect(loadSyncConfig(parseCliArgs(["status"]), deps({ ...NODE_ENV, ...CREDENTIAL }, { "ipfs-sync.config.json": NO_URL_FILE }))).resolves.toBeDefined();
    await expect(loadSyncConfig(parseCliArgs(["status"]), deps({ ...NODE_ENV, ...CREDENTIAL }, files))).resolves.toBeDefined();
    await expect(
      loadSyncConfig(parseCliArgs(["status", "--rpc-url", "https://flag.example"]), deps({ IPFS_SYNC_GATEWAY_URL: "https://flag.example", ...CREDENTIAL }, files)),
    ).resolves.toBeDefined();
  });
});

describe("the state folder is never reached through a symbolic link (C-M3)", () => {
  let dir: string;
  let vault: string;
  let elsewhere: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-r3-"));
    vault = join(dir, "vault");
    elsewhere = join(dir, "elsewhere");
    await mkdir(vault);
    await mkdir(elsewhere, { mode: 0o755 });
    await chmod(elsewhere, 0o755);
    await writeFile(join(elsewhere, "keep.txt"), "untouched");
    await symlink(elsewhere, join(vault, ".ipfs-sync"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function expectElsewhereUntouched(): Promise<void> {
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
    expect((await stat(elsewhere)).mode & 0o777).toBe(0o755);
  }

  const commands: readonly (readonly [string, () => readonly string[]])[] = [
    ["publish", () => ["publish", vault, "--config", join(dir, "c.json")]],
    ["init", () => ["init", vault, "--passphrase-file", join(dir, "pp.txt")]],
    ["keys", () => ["keys", "change-passphrase", vault, "--config", join(dir, "c.json"), "--passphrase-file", join(dir, "pp2.txt")]],
    ["prune-history", () => ["prune-history", vault, "--keep", "30", "--dry-run", "--config", join(dir, "c.json")]],
    ["pull --list-versions", () => ["pull", vault, "--list-versions"]],
  ];

  it.each(commands)("%s is refused with exit 2 before a request, and nothing is written or changed outside the vault", async (_name, argv) => {
    const result = await cli(argv());
    expect(result.code).toBe(2);
    expect(result.err).toContain(".ipfs-sync");
    expect(result.err).toMatch(/symbolic link/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectElsewhereUntouched();
  });

  it("a link to a folder inside the vault is refused as well", async () => {
    await rm(join(vault, ".ipfs-sync"));
    await mkdir(join(vault, "notes"));
    await symlink(join(vault, "notes"), join(vault, ".ipfs-sync"));
    const result = await cli(["publish", vault, "--config", join(dir, "c.json")]);
    expect(result.code).toBe(2);
    expect(await readdir(join(vault, "notes"))).toEqual([]);
  });

  it("the kv store refuses to read, write, list or delete through the link, and does not chmod the target", async () => {
    const host = createNodeHostBridge({ root: vault });
    await expect(host.kv.set("state.json", new Uint8Array([1]))).rejects.toThrow(/symbolic link/);
    await expect(host.kv.get("state.json")).rejects.toThrow(/symbolic link/);
    await expect(host.kv.delete("state.json")).rejects.toThrow(/symbolic link/);
    await expect(host.kv.list("")).rejects.toThrow(/symbolic link/);
    await expectElsewhereUntouched();
  });

  it("the host's file writes under the state folder are refused too", async () => {
    const host = createNodeHostBridge({ root: vault });
    await expect(host.fs.write(".ipfs-sync/tmp/a.part", new Uint8Array([1]))).rejects.toThrow();
    await expect(host.fs.mkdir(".ipfs-sync/tmp")).rejects.toThrow();
    await expectElsewhereUntouched();
  });

  it("the lock file refuses to be created, read, replaced, moved aside or removed through the link", async () => {
    const lock = createNodeLockFile(vault);
    await expect(lock.createExclusive(new Uint8Array([1]))).rejects.toThrow(/symbolic link/);
    await expect(lock.read()).rejects.toThrow(/symbolic link/);
    await expect(lock.write(new Uint8Array([1]))).rejects.toThrow(/symbolic link/);
    await expect(lock.moveAside()).rejects.toThrow(/symbolic link/);
    await expect(lock.remove()).rejects.toThrow(/symbolic link/);
    await expectElsewhereUntouched();
  });
});

describe("the state folder is created owner-only (C-M3)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-r3-mode-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

  it("by the lock file", async () => {
    await createNodeLockFile(dir).createExclusive(new Uint8Array([1]));
    expect(await mode(join(dir, ".ipfs-sync"))).toBe(0o700);
  });

  it("by the host's mkdir, append and rename", async () => {
    const host = createNodeHostBridge({ root: dir });
    await host.fs.mkdir(".ipfs-sync/tmp");
    expect(await mode(join(dir, ".ipfs-sync"))).toBe(0o700);
    expect(await mode(join(dir, ".ipfs-sync", "tmp"))).toBe(0o700);
    await host.fs.append(".ipfs-sync/deep/log", new Uint8Array([1]));
    expect(await mode(join(dir, ".ipfs-sync", "deep"))).toBe(0o700);
    await host.fs.mkdir("notes");
    expect((await lstat(join(dir, "notes"))).isDirectory()).toBe(true);
  });
});

describe("text a node chose is escaped on standard output (C-M4)", () => {
  it("escapeNodeText also escapes zero-width characters, the soft hyphen, the byte order mark and the tag block", () => {
    const tag = String.fromCodePoint(0xe0041);
    expect(escapeNodeText(`a​b‌c‍d⁠e﻿f­g${tag}h`)).toBe("a\\u200bb\\u200cc\\u200dd\\u2060e\\ufefff\\u00adg\\u{e0041}h");
    expect(escapeNodeText("plain café 日本")).toBe("plain café 日本");
    expect(escapeNodeText(`${ESC}[2J`)).toBe("\\u001b[2J");
  });

  it("createProcessIo().out strips terminal control characters per line and keeps the line breaks", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      createProcessIo().out(`first ${ESC}[2Jline‮\nsecond\u0007 line`);
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toBe("first ?[2Jline?\nsecond? line\n");
  });

  it("status prints an MFS entry named with escape sequences escaped", async () => {
    const hostile = `${ESC}[31mred${ESC}]0;title\u0007​`;
    const { io, out } = sink();
    const config = resolveSyncConfig([{ rpc: { url: "https://rpc.example" }, gateway: { url: "https://gw.example" } }], NOW);
    const client = {
      id: async () => ({ peerId: `peer${ESC}[0m`, agentVersion: "kubo", protocols: [] }),
      version: async () => ({ version: "0.40.0", commit: "abc" }),
      filesLs: async () => [{ name: hostile, type: "file", size: 1, cid: "bafyabc" }],
      keyList: async () => [{ name: "obsidian-vault-sync", id: "k51" }],
      filesStat: async () => {
        throw new Error("stop");
      },
      filesWrite: async () => undefined,
      filesRm: async () => undefined,
      gatewayFetch: async () => new Uint8Array(),
    };
    await runStatus({ config, client: client as never, io });
    const text = out.join("\n");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("​");
    expect(text).toContain("\\u001b[31mred\\u001b]0;title\\u0007\\u200b");
    expect(text).toContain("peer\\u001b[0m");
  });
});

describe("a run without a terminal cannot be asked (C-L2)", () => {
  function withTty(value: boolean | undefined, run: () => void): void {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    try {
      run();
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", original);
    }
  }

  it("omits confirm and prompt when standard input is not a terminal", () => {
    withTty(undefined, () => {
      const io = createProcessIo();
      expect(io.confirm).toBeUndefined();
      expect(io.prompt).toBeUndefined();
    });
    withTty(false, () => {
      const io = createProcessIo();
      expect(io.confirm).toBeUndefined();
      expect(io.prompt).toBeUndefined();
    });
  });

  it("offers them when standard input and standard output are terminals (round 4, A-L1: both)", () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      withTty(true, () => {
        const io = createProcessIo();
        expect(io.confirm).toBeTypeOf("function");
        expect(io.prompt).toBeTypeOf("function");
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", original);
    }
  });

  it("an unattended keys change-passphrase, increase-cost and prune-history without the explicit flag exit 2 before a request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ipfs-sync-r3-tty-"));
    try {
      const vault = join(dir, "vault");
      await mkdir(vault);
      const config = ["--config", join(dir, "c.json")];
      for (const argv of [
        ["keys", "change-passphrase", vault, ...config, "--passphrase-file", join(dir, "pp.txt")],
        ["keys", "increase-cost", vault, ...config, "--cost", "high"],
        ["prune-history", vault, "--keep", "30", ...config],
      ]) {
        const { io, err } = sink(); // the same shape createProcessIo gives a run without a terminal: no confirm, no prompt
        const code = await runCli(argv, { env: stateEnv(), now: () => NOW, readText: readTextIfPresent }, io);
        expect(code, argv.join(" ")).toBe(2);
        expect(err.join("\n")).toMatch(/terminal|--accept-no-revocation|--yes-prune/);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("--show-request redacts the credential names of both endpoints (C-L1)", () => {
  it("redacts the gateway's header when the gateway origin has the RPC URL as a prefix", async () => {
    const config = resolveSyncConfig(
      [
        {
          rpc: { url: "https://host", auth: { scheme: "bearer", token: "rpc-token" } },
          gateway: { url: "https://host:8443", auth: { scheme: "header", headerName: "X-Gateway-Key", headerValue: "gw-secret" } },
        },
      ],
      NOW,
    );
    const { io, out } = sink();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("")) as typeof fetch;
    const restore = installRequestTrace(config, io);
    try {
      await fetch("https://host:8443/ipfs/bafyabc", { headers: { "X-Gateway-Key": "gw-secret", Authorization: "Bearer rpc-token", "X-Other": "visible" } });
    } finally {
      restore();
      globalThis.fetch = original;
    }
    const text = out.join("\n");
    expect(text).not.toContain("gw-secret");
    expect(text).not.toContain("rpc-token");
    expect(text).toContain("visible");
  });
});

describe("a passphrase file inside the vault is refused (C-L4)", () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-r3-pp-"));
    vault = join(dir, "vault");
    await mkdir(join(vault, "notes"), { recursive: true });
    await symlink(join(vault, "notes"), join(dir, "link-to-notes"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("answers by where the path really is, including through a link and for a file that does not exist yet", async () => {
    expect(await passphraseFileInsideVault(vault, join(vault, "pp.txt"))).toBe(true);
    expect(await passphraseFileInsideVault(vault, join(vault, "notes", "new", "pp.txt"))).toBe(true);
    expect(await passphraseFileInsideVault(vault, join(dir, "link-to-notes", "pp.txt"))).toBe(true);
    expect(await passphraseFileInsideVault(vault, join(dir, "outside.txt"))).toBe(false);
    expect(await passphraseFileInsideVault(vault, join(dir, "vault-sibling", "pp.txt"))).toBe(false);
  });

  it("init --passphrase-file inside the vault exits 2 with a fixed message, before a request, and creates nothing", async () => {
    const target = join(vault, "pp.txt");
    const result = await cli(["init", vault, "--passphrase-file", target]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/passphrase file/);
    expect(result.err).toMatch(/inside the vault/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(vault)).toEqual(["notes"]);
  });

  it("IPFS_SYNC_PASSPHRASE_FILE inside the vault exits 2 for publish and pull", async () => {
    const env = stateEnv({ IPFS_SYNC_PASSPHRASE_FILE: join(vault, "notes", "pp.txt") });
    for (const argv of [["publish", vault, "--config", join(dir, "c.json")], ["pull", vault]]) {
      const result = await cli(argv, env);
      expect(result.code, argv[0]).toBe(2);
      expect(result.err).toMatch(/inside the vault/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
