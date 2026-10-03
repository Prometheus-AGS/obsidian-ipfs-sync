import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createFakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";
import { stateEnv } from "../helpers/cli-state-env";

const MFS_ROOT = "/obsidian-vault-sync/path-limit-test";
const MUTATING = ["files/write", "files/rm", "key/gen", "pin/add", "name/publish"];

describe("ipfs-sync publish: a local path over a limit (review-final N-01)", () => {
  let vault: string;
  let configPath: string;
  let requests: string[];

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ipfs-sync-pathlimit-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 2);
    const node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, MFS_ROOT, node);
    requests = [];
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, requests)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exits 1 naming the local file and the limit, says the vault was not published, and does not blame the node", async () => {
    const deep = join(vault, ...Array.from({ length: 129 }, () => "d"));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "note.md"), "deep");
    const err: string[] = [];
    const io: CliIo = { out: () => undefined, err: (text) => void err.push(text) };
    const deps: CliDeps = { env: stateEnv(), now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent, passphrase: referencePassphraseSource };
    requests.length = 0;
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT], deps, io);
    const text = err.join("\n");
    expect(code).toBe(1);
    expect(text).toContain("d/d/d/d/");
    expect(text).toMatch(/128 segments/);
    expect(text).toContain("was not published");
    expect(text).not.toMatch(/newer or incompatible|update ipfs-sync/);
    expect(requests.filter((request) => MUTATING.includes(request))).toEqual([]);
  });
});
