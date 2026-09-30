import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent, type ConfigDeps } from "../../cli/load-config";
import { runCli } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";

const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];

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
  return { env, now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent };
}

describe("ipfs-sync publish", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-publish-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    requests = [];
    fetchStub = vi.fn(fakeNodeFetch(node, requests));
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publish = async (extra: string[] = [], env: Record<string, string> = {}) => {
    const s = sink();
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", "/obsidian-vault-sync/cli-test", ...extra], deps(env), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n") };
  };

  it("shows publish in the help text", async () => {
    const s = sink();
    expect(await runCli(["--help"], deps(), s.io)).toBe(0);
    expect(s.out.join("\n")).toContain("ipfs-sync publish <vault>");
  });

  it("exits 2 with a usage error when the vault argument is missing or not a directory, sending nothing", async () => {
    const missing = sink();
    expect(await runCli(["publish"], deps(), missing.io)).toBe(2);
    const notDir = sink();
    expect(await runCli(["publish", join(dir, "nope")], deps(), notDir.io)).toBe(2);
    expect(notDir.err.join("\n")).toContain("is not a directory");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a vault without the marker and sends no request", async () => {
    const real = join(dir, "real-vault");
    await mkdir(real);
    await writeFile(join(real, "note.md"), "private");
    const s = sink();
    const code = await runCli(["publish", real, "--config", configPath], deps(), s.io);
    expect(code).toBe(2);
    expect(s.err.join("\n")).toContain("encryption is not available yet");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses the staging root with no request", async () => {
    const s = sink();
    expect(await runCli(["publish", vault, "--mfs-root", "/obsidian-vault-staging", "--config", configPath], deps(), s.io)).toBe(2);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a foreign obsidian-vault key: only key/list is sent, no mutation", async () => {
    node.keys.push({ name: "obsidian-vault", id: "k51foreign" });
    const result = await publish(["--key", "obsidian-vault"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("foreign");
    expect(requests).toEqual(["key/list"]);
    expect(requests.filter((r) => MUTATING.includes(r))).toEqual([]);
  });

  it("publishes a fixture vault, creates the key once and records its ID in the config file", async () => {
    const first = await publish();
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/12 written, 0 removed/);
    expect(first.out).toContain("root CID");
    expect(requests.filter((r) => r === "key/gen")).toHaveLength(1);
    const config = JSON.parse(await readFile(configPath, "utf8")) as { ownedKeys: string[] };
    expect(config.ownedKeys).toEqual([node.keys.find((k) => k.name === "obsidian-vault-sync")?.id]);
    expect(node.published.size).toBe(1);
    expect(first.out).not.toContain(".trash");
    expect([...node.files.keys()].some((p) => p.includes("workspace.json") || p.includes(".trash"))).toBe(false);
  });

  it("sends nothing on an unchanged rerun and exactly one write after one edit", async () => {
    await publish();
    requests.length = 0;
    const same = await publish();
    expect(same.code).toBe(0);
    expect(same.out).toContain("0 written, 0 removed");
    expect(requests).toEqual(["key/list"]);

    await writeFile(join(vault, "inbox.md"), "edited note\n");
    requests.length = 0;
    const edited = await publish();
    expect(edited.out).toContain("1 written, 0 removed");
    expect(requests.filter((r) => r === "files/write")).toHaveLength(3);
    expect(requests.filter((r) => r === "key/gen")).toEqual([]);
    expect(requests.filter((r) => r === "name/publish")).toHaveLength(1);
  });

  it("stops before writing and prints the key ID when the config file cannot be updated", async () => {
    await mkdir(join(dir, "cfg"));
    await chmod(join(dir, "cfg"), 0o500);
    const result = await publish();
    await chmod(join(dir, "cfg"), 0o700);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--owned-key");
    expect(requests.filter((r) => MUTATING.includes(r))).toEqual(["key/gen"]);
  });

  it("never persists --owned-key to the config file", async () => {
    node.keys.push({ name: "obsidian-vault", id: "k51adopted" });
    const result = await publish(["--key", "obsidian-vault", "--owned-key", "k51adopted"]);
    expect(result.code).toBe(0);
    expect(requests).not.toContain("key/gen");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });
});
