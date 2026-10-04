import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { NODE_ENV } from "../helpers/cli-state-env";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { ManifestFormatError } from "../../src/sync/encrypted-manifest";
import { createFakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";

vi.mock("../../src/sync/key-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sync/key-management")>()),
  prepareRewrap: vi.fn(async () => {
    throw new ManifestFormatError("path", 'manifest path "a/very/long/path" exceeds the limits of this build');
  }),
}));

const NOW = new Date("2026-10-03T12:00:00Z");

describe("ipfs-sync keys: an authentic manifest this build refuses to read (1.4 note d, review N-01)", () => {
  let vault: string;
  let configPath: string;
  const mutations: string[] = [];

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ipfs-sync-keys-format-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 2);
    const node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, "/obsidian-vault-sync/keys-format-test", node);
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, mutations)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed with its own words, not the publisher's 'newer or incompatible version', and says what it blocks", async () => {
    const err: string[] = [];
    const io: CliIo = { out: () => undefined, err: (t) => void err.push(t) };
    const deps: CliDeps = { env: { ...NODE_ENV }, now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
    const code = await runCli(["keys", "increase-cost", vault, "--config", configPath, "--mfs-root", "/obsidian-vault-sync/keys-format-test", "--cost", "standard", "--accept-no-revocation"], deps, io);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("refuses to read");
    expect(text).toContain("can neither change its passphrase nor prune its history");
    expect(text).not.toContain("newer or incompatible version");
    expect(text).toContain("Nothing was changed");
    expect(mutations.filter((request) => ["files/write", "files/rm", "pin/add", "name/publish"].includes(request))).toEqual([]);
  });
});
