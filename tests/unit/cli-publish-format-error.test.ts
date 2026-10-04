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

vi.mock("../../src/sync/publish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sync/publish")>()),
  publishVault: vi.fn(async () => {
    throw new ManifestFormatError("version", 'manifest field "version" is not a version this build knows');
  }),
}));

const NOW = new Date("2026-09-30T12:00:00Z");

describe("ipfs-sync publish: an authentic manifest this build does not recognise (N3-01)", () => {
  let vault: string;
  let configPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ipfs-sync-format-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 2);
    const node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, "/obsidian-vault-sync/format-test", node);
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, [])));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exits 1 with a clear update message instead of a stack trace", async () => {
    const err: string[] = [];
    const io: CliIo = { out: () => undefined, err: (t) => void err.push(t) };
    const deps: CliDeps = { env: { ...NODE_ENV }, now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", "/obsidian-vault-sync/format-test"], deps, io);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("written by a newer or incompatible version");
    expect(text).toContain("update ipfs-sync");
  });
});
