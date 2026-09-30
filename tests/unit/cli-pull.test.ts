import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent, type ConfigDeps } from "../../cli/load-config";
import { runCli } from "../../cli/run";
import { IPNS_NAME, decode, seedRemote } from "../helpers/pull-fixtures";

const TREE = "bafytreeone000000000000";
const ROOT = "bafyrootone000000000000";
const FILES = { "notes/a.md": "alpha", "notes/b.md": "bravo", "c.md": "charlie" };
const NODE_READS = ["/api/v0/name/resolve", "/api/v0/key/list"];

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

/** A stub node: name/resolve, key/list and gateway GETs. Every request is recorded as `METHOD /path`. */
function stubNode(objects: Map<string, Uint8Array>, names: Map<string, string>, requests: string[]) {
  return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v0/name/resolve") {
      const name = (url.searchParams.get("arg") ?? "").replace("/ipns/", "");
      const path = names.get(name);
      return path === undefined ? new Response(JSON.stringify({ Message: "could not resolve name", Code: 0, Type: "error" }), { status: 500 }) : json({ Path: path });
    }
    if (url.pathname === "/api/v0/key/list") return json({ Keys: [{ Name: "obsidian-vault-sync", Id: IPNS_NAME }] });
    if (url.pathname.startsWith("/ipfs/")) {
      const found = objects.get(decodeURIComponent(url.pathname.slice("/ipfs/".length)));
      return found === undefined ? new Response("not found", { status: 404 }) : new Response(Uint8Array.from(found), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
}

describe("ipfs-sync pull", () => {
  let dir: string;
  let vault: string;
  let objects: Map<string, Uint8Array>;
  let names: Map<string, string>;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-pull-"));
    vault = join(dir, "vault");
    objects = new Map();
    names = new Map();
    requests = [];
    fetchStub = vi.fn(stubNode(objects, names, requests));
    vi.stubGlobal("fetch", fetchStub);
    await seedRemote({ objects, names }, FILES, { tree: TREE, root: ROOT });
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

  it("lists pull and its flags in the help text", async () => {
    const s = sink();
    expect(await runCli(["pull", "--help"], deps(), s.io)).toBe(0);
    const help = s.out.join("\n");
    expect(help).toContain("ipfs-sync pull <vault>");
    for (const flag of ["--name", "--manifest ", "--manifest-file", "--owned-key", "--config", "--show-request"]) expect(help).toContain(flag);
  });

  it("exits 2 without a request when the vault argument is missing", async () => {
    const s = sink();
    expect(await runCli(["pull"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("pull needs exactly one argument");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("exits 2 without a request for conflicting selectors, a bad --name, a bad --manifest or a missing manifest file", async () => {
    const conflicting = await pull(["--manifest", TREE, "--manifest-file", join(dir, "m.json")]);
    expect(conflicting.code).toBe(2);
    expect(conflicting.err).toContain("mutually exclusive");
    const badName = sink();
    expect(await runCli(["pull", vault, "--name", "../x"], deps(), badName.io)).toBe(2);
    expect((await pull(["--manifest", "../x"])).code).toBe(2);
    const missingFile = await pull(["--manifest-file", join(dir, "absent.json")]);
    expect(missingFile.code).toBe(2);
    expect(missingFile.err).toContain("cannot read --manifest-file");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("rejects the pull-only flags on other commands", async () => {
    const s = sink();
    expect(await runCli(["publish", vault, "--name", IPNS_NAME], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("only valid for the pull command");
  });

  it("pulls a fresh directory: summary line, exit 0, files present, marker present, reads only", async () => {
    const result = await pull();
    expect(result.code).toBe(0);
    expect(result.out).toContain("3 fetched, 0 unchanged, 0 conflicts, 0 failed, 0 remote-deleted, 0 locally modified");
    expect(decode(await readFile(join(vault, "notes", "a.md")))).toBe("alpha");
    expect((await stat(join(vault, ".ipfs-sync-fixture"))).isFile()).toBe(true);
    expect(requests.filter((r) => r.startsWith("POST ")).every((r) => NODE_READS.includes(r.slice(5)))).toBe(true);
    expect(requests.filter((r) => !r.startsWith("POST ")).every((r) => r.startsWith("GET /ipfs/"))).toBe(true);
    expect(await readdir(join(vault, ".ipfs-sync", "tmp"))).toEqual([]);
  });

  it("re-pulls with 0 fetched and keeps the modification times", async () => {
    await pull();
    const before = (await stat(join(vault, "c.md"))).mtimeMs;
    const again = await pull();
    expect(again.code).toBe(0);
    expect(again.out).toContain("0 fetched, 3 unchanged");
    expect((await stat(join(vault, "c.md"))).mtimeMs).toBe(before);
  });

  it("resolves the owned key when --name is absent (key/list, then name/resolve)", async () => {
    const s = sink();
    const code = await runCli(["pull", vault, "--owned-key", IPNS_NAME], deps(), s.io);
    expect(code).toBe(0);
    expect(requests.slice(0, 2)).toEqual(["POST /api/v0/key/list", "POST /api/v0/name/resolve"]);
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
    expect(result.err).toContain("encryption is not available yet");
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await readFile(join(vault, "private.md"), "utf8")).toBe("my real notes");
  });

  it("keeps a conflicting local edit as a copy and exits 0", async () => {
    await pull();
    await writeFile(join(vault, "notes", "a.md"), "LOCAL edit");
    await seedRemote({ objects, names }, { ...FILES, "notes/a.md": "REMOTE" }, { tree: "bafytreetwo000000000000", root: "bafyroottwo000000000000", previousRoot: ROOT });
    const result = await pull();
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 fetched, 2 unchanged, 1 conflicts, 0 failed");
    expect(result.out).toContain("conflict notes/a.md -> notes/a (ipfs conflict 2026-09-29).md");
    expect(await readFile(join(vault, "notes", "a.md"), "utf8")).toBe("REMOTE");
    expect(await readFile(join(vault, "notes", "a (ipfs conflict 2026-09-29).md"), "utf8")).toBe("LOCAL edit");
  });

  it("exits 1 with the counts when a file fails verification (edited local manifest)", async () => {
    const manifestPath = join(dir, "edited-manifest.json");
    const manifest = JSON.parse(decode(objects.get(`${ROOT}/manifest.json`)));
    manifest.files["notes/b.md"].sha256 = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await pull(["--manifest-file", manifestPath]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("2 fetched, 0 unchanged, 0 conflicts, 1 failed");
    expect(result.err).toContain("notes/b.md");
    await expect(stat(join(vault, "notes", "b.md"))).rejects.toThrow();
    expect(await readdir(join(vault, ".ipfs-sync", "tmp"))).toEqual([]);
  });

  it("prints the exclusion-list warning on stderr and still exits 0", async () => {
    await seedRemote({ objects, names }, FILES, { tree: TREE, root: ROOT, excludes: "b".repeat(64) });
    const result = await pull();
    expect(result.code).toBe(0);
    expect(result.err).toContain("warning: the exclusion lists differ");
    expect(result.err).toContain("b".repeat(64));
  });

  it("does not follow a symlinked directory in the vault and exits 1", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await mkdir(vault);
    await writeFile(join(vault, ".ipfs-sync-fixture"), "marker");
    await symlink(outside, join(vault, "notes"));
    const result = await pull();
    expect(result.code).toBe(1);
    expect(result.out).toContain("1 fetched");
    expect(result.out).toContain("2 failed");
    expect(await readdir(outside)).toEqual([]);
  });

  it("traces requests with credentials redacted under --show-request", async () => {
    const result = await pull(["--show-request", "--auth", "bearer", "--auth-token", "sekret-token-123"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("request POST https://ipfs.prometheusags.ai/api/v0/name/resolve");
    expect(result.out).not.toContain("sekret-token-123");
    expect(result.err).not.toContain("sekret-token-123");
  });
});
