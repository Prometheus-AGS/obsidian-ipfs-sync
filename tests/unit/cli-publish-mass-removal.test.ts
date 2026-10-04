import { mkdtemp, readdir, rm } from "node:fs/promises";
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
import { stateEnv } from "../helpers/cli-state-env";

const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];
const MFS_ROOT = "/obsidian-vault-sync/cli-removal";

function sink(confirm?: (question: string) => Promise<boolean>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (text) => void out.push(text), err: (text) => void err.push(text), ...(confirm === undefined ? {} : { confirm }) };
  return { io, out, err };
}

const deps = (): CliDeps => ({ env: stateEnv(), now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent, passphrase: referencePassphraseSource });

describe("ipfs-sync publish: --allow-mass-removal", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-removal-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, MFS_ROOT, node);
    requests = [];
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, requests)));
    expect((await run([])).code).toBe(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = async (extra: string[], confirm?: (question: string) => Promise<boolean>) => {
    const s = sink(confirm);
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT, ...extra], deps(), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n") };
  };
  const mutating = (): number => requests.filter((request) => MUTATING.some((name) => request.includes(name))).length;

  /** The vault directory emptied (or unmounted): every non-hidden entry gone; the hidden marker and state folder stay. */
  async function emptyVault(): Promise<void> {
    for (const entry of await readdir(vault)) if (!entry.startsWith(".")) await rm(join(vault, entry), { recursive: true });
  }

  it("is only valid for the publish command and is listed in the help", async () => {
    const s = sink();
    expect(await runCli(["status", "--allow-mass-removal"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("--allow-mass-removal is only valid for the publish command");
    const help = sink();
    expect(await runCli(["--help"], deps(), help.io)).toBe(0);
    expect(help.out.join("\n")).toContain("--allow-mass-removal");
  });

  it("stops an emptied vault without a terminal: exit 1, the count and the unmounted hint, nothing sent", async () => {
    await emptyVault();
    const before = mutating();

    const result = await run([]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/would remove \d+ of \d+ entries/);
    expect(result.err).toContain("--allow-mass-removal");
    expect(mutating()).toBe(before);
  });

  it("asks at the terminal, stops on a no and proceeds on a yes", async () => {
    await emptyVault();
    const questions: string[] = [];
    const before = mutating();

    expect((await run([], async (question) => (questions.push(question), false))).code).toBe(1);
    expect(mutating()).toBe(before);
    expect((await run([], async (question) => (questions.push(question), question.includes("remove")))).code).toBe(0);
    expect(questions.some((question) => /remove \d+ of \d+ entries/.test(question))).toBe(true);
  });

  it("proceeds with --allow-mass-removal and never asks", async () => {
    await emptyVault();
    const questions: string[] = [];
    const result = await run(["--allow-mass-removal"], async (question) => (questions.push(question), false));
    expect(result.code).toBe(0);
    expect(questions).toEqual([]);
  });
});
