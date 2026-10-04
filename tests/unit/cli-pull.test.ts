import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent, type ConfigDeps } from "../../cli/load-config";
import { runCli } from "../../cli/run";

/**
 * `ipfs-sync pull` invocation rules that do not need a published vault: the help text, the operands, the flag checks, the
 * destination guard and the target check. The decrypting pull itself is covered by `cli-pull-encrypted.test.ts`. Task 3.1b of
 * mvp-07b removed the plaintext reader's flags (`--allow-plaintext-v1`, `--manifest-file`); they are unknown options now.
 */

const IPNS_NAME = "k51qzi5uqu5dtestpullname0000000000000000000000000000";

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

function deps(env: Record<string, string> = {}): ConfigDeps {
  return { env, now: () => new Date(2026, 8, 29, 12, 0, 0), readText: readTextIfPresent };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** A stub node that answers only `key/list`. Every request is recorded as `METHOD /path`. */
function stubNode(requests: string[]) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v0/key/list") return json({ Keys: [{ Name: "obsidian-vault-sync", Id: IPNS_NAME }] });
    return new Response("nope", { status: 404 });
  };
}

describe("ipfs-sync pull", () => {
  let dir: string;
  let vault: string;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-pull-"));
    vault = join(dir, "vault");
    requests = [];
    fetchStub = vi.fn(stubNode(requests));
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  const pull = async (extra: string[] = [], target: string = vault) => {
    const s = sink();
    const code = await runCli(["pull", target, "--name", IPNS_NAME, ...extra], deps(), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n") };
  };

  it("lists pull and its flags in the help text, without the removed plaintext flags", async () => {
    const s = sink();
    expect(await runCli(["pull", "--help"], deps(), s.io)).toBe(0);
    const help = s.out.join("\n");
    expect(help).toContain("ipfs-sync pull <vault>");
    for (const flag of ["--name", "--manifest ", "--root-cid", "--owned-key", "--config", "--show-request"]) expect(help).toContain(flag);
    for (const removed of ["--allow-plaintext-v1", "--manifest-file"]) expect(help).not.toContain(removed);
    expect(help).not.toMatch(/plaintext \(version 1\) manifest is read/);
  });

  it("exits 2 without a request when the vault argument is missing", async () => {
    const s = sink();
    expect(await runCli(["pull"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("pull needs exactly one argument");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("exits 2 without a request for a bad --name, a bad --manifest or --root-cid together with --manifest", async () => {
    const badName = sink();
    expect(await runCli(["pull", vault, "--name", "../x"], deps(), badName.io)).toBe(2);
    expect((await pull(["--manifest", "../x"])).code).toBe(2);
    const both = await pull(["--root-cid", "bafyrootone000000000000", "--manifest", "bafytreeone000000000000"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("mutually exclusive");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("rejects the pull-only flags on other commands", async () => {
    const s = sink();
    expect(await runCli(["publish", vault, "--name", IPNS_NAME], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("only valid for the pull command");
  });

  it.each([["--allow-plaintext-v1"], ["--manifest-file", "manifest.json"]])("rejects %s as an unknown option on pull and on publish, before any request", async (...argv: string[]) => {
    const onPull = await pull(argv);
    expect(onPull.code).toBe(2);
    expect(onPull.err).toMatch(/[Uu]nknown option/);
    expect(onPull.err).toContain(argv[0] ?? "");
    const s = sink();
    expect(await runCli(["publish", vault, ...argv], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toMatch(/[Uu]nknown option/);
    expect(fetchStub).not.toHaveBeenCalled();
    await expect(readFile(join(vault, ".ipfs-sync-fixture"))).rejects.toThrow();
  });

  it("exits 2 asking for --name when the default key is not owned", async () => {
    const s = sink();
    const code = await runCli(["pull", vault], deps(), s.io);
    expect(code).toBe(2);
    expect(s.err.join("\n")).toContain("pass --name");
    expect(requests).toEqual(["POST /api/v0/key/list"]);
  });

  it("refuses a non-empty directory without the marker before any request", async () => {
    await mkdir(vault);
    await writeFile(join(vault, "private.md"), "my real notes");
    const result = await pull();
    expect(result.code).toBe(2);
    expect(result.err).toContain("Pull into a populated directory without a fixture marker stays disabled in this build");
    expect(result.err).not.toContain("arrives in a later release");
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await readFile(join(vault, "private.md"), "utf8")).toBe("my real notes");
  });
});
