import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";

const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];
const MFS_ROOT = "/obsidian-vault-sync/cli-test";

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function sink(confirm?: (question: string) => Promise<boolean>): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t), ...(confirm === undefined ? {} : { confirm }) }, out, err };
}

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return { env: {}, now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent, passphrase: referencePassphraseSource, ...overrides };
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
    await initDiskVault(vault, MFS_ROOT, node);
    requests = [];
    fetchStub = vi.fn(fakeNodeFetch(node, requests));
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publish = async (extra: string[] = [], overrides: Partial<CliDeps> = {}) => {
    const s = sink();
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT, ...extra], deps(overrides), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n") };
  };
  const mutating = (): string[] => requests.filter((r) => MUTATING.includes(r));

  it("shows publish, --repair and the encryption requirement in the help text", async () => {
    const s = sink();
    expect(await runCli(["--help"], deps(), s.io)).toBe(0);
    const help = s.out.join("\n");
    expect(help).toContain("ipfs-sync publish <vault>");
    expect(help).toContain("--repair");
    expect(help).toContain("--recover-slots");
    expect(help).toContain("ipfs-sync init");
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
    expect(s.err.join("\n")).toContain("not yet independently reviewed or verified in Obsidian");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses to publish without a passphrase, sends no request, and says so", async () => {
    const result = await publish([], { passphrase: undefined });
    expect(result.code).toBe(1);
    expect(result.err).toContain("passphrase");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses the staging root with no request", async () => {
    const s = sink();
    expect(await runCli(["publish", vault, "--mfs-root", "/obsidian-vault-staging", "--config", configPath], deps(), s.io)).toBe(2);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a foreign obsidian-vault key after reading the node: no mutation is sent", async () => {
    node.keys.push({ name: "obsidian-vault", id: "k51foreign" });
    const result = await publish(["--key", "obsidian-vault"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("foreign");
    expect(requests).toContain("key/list");
    expect(mutating()).toEqual([]);
  });

  it("publishes a fixture vault encrypted, creates the key once and records its ID in the config file", async () => {
    const first = await publish();
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/12 written, 0 removed/);
    expect(first.out).toContain("root CID");
    expect(first.out).toContain("sequence  1");
    expect(requests.filter((r) => r === "key/gen")).toHaveLength(1);
    const config = JSON.parse(await readFile(configPath, "utf8")) as { ownedKeys: string[] };
    expect(config.ownedKeys).toEqual([node.keys.find((k) => k.name === "obsidian-vault-sync")?.id]);
    expect(node.published.size).toBe(1);
    expect(first.out).not.toContain(".trash");
    const paths = [...node.files.keys()].join("\n");
    for (const name of ["workspace.json", ".trash", "welcome", "daily", "alpha", "diagram", "inbox", "manifest.json"]) expect(paths).not.toContain(name);
    expect([...node.requests].some((request) => request.line.includes("welcome") || request.line.includes("alpha"))).toBe(false);
  });

  it("sends nothing but reads on an unchanged rerun, and exactly one blob plus the manifest after one edit", async () => {
    await publish();
    requests.length = 0;
    const same = await publish();
    expect(same.code).toBe(0);
    expect(same.out).toContain("0 written, 0 removed");
    expect(mutating()).toEqual([]);

    await writeFile(join(vault, "inbox.md"), "edited note\n");
    requests.length = 0;
    const edited = await publish();
    expect(edited.out).toContain("1 written, 0 removed");
    expect(requests.filter((r) => r === "files/write")).toHaveLength(3); // the blob, manifest.enc, its history file
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
    expect(mutating()).toEqual(["key/gen"]);
  });

  it("never persists --owned-key to the config file", async () => {
    node.keys.push({ name: "obsidian-vault", id: "k51adopted" });
    const result = await publish(["--key", "obsidian-vault", "--owned-key", "k51adopted"]);
    expect(result.code).toBe(0);
    expect(requests).not.toContain("key/gen");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });
});

describe("ipfs-sync publish: --repair, --recover-slots, --allow-full-reupload", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-repair-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, MFS_ROOT, node);
    requests = [];
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, requests)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = async (extra: string[], confirm?: (question: string) => Promise<boolean>) => {
    const s = sink(confirm);
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT, ...extra], deps(), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n") };
  };

  it("are only valid for the publish command", async () => {
    for (const flag of ["--repair", "--recover-slots", "--allow-full-reupload"]) {
      const s = sink();
      expect(await runCli(["status", flag], deps(), s.io)).toBe(2);
      expect(s.err.join("\n")).toContain(`${flag} is only valid for the publish command`);
    }
  });

  it("--repair lifts a behind refusal: the older manifest is replaced by a new one at the next sequence", async () => {
    expect((await run([])).code).toBe(0);
    const older = Uint8Array.from(node.files.get(`${MFS_ROOT}/manifest.enc`) as Uint8Array);
    await writeFile(join(vault, "inbox.md"), "second version\n");
    expect((await run([])).code).toBe(0);
    node.files.set(`${MFS_ROOT}/manifest.enc`, older);

    const refused = await run([]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--repair");
    const repaired = await run(["--repair"]);
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain("sequence  3");
  });

  it("--repair for the ahead case asks first, and a run that cannot ask refuses", async () => {
    expect((await run([])).code).toBe(0);
    await rmState();
    const noTerminal = await run(["--repair"]);
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.err).toContain("confirmation");

    const questions: string[] = [];
    const declined = await run(["--repair"], async (question) => (questions.push(question), false));
    expect(declined.code).toBe(1);
    expect(questions[0]).toMatch(/discarded/);

    const accepted = await run(["--repair"], async () => true);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("sequence  2");
  });

  async function rmState(): Promise<void> {
    const { readdir, rm } = await import("node:fs/promises");
    for (const name of await readdir(join(vault, ".ipfs-sync"))) if (name.startsWith("state.")) await rm(join(vault, ".ipfs-sync", name));
  }
});
