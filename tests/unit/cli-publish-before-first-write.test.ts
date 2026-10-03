import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { encodeLock } from "../../src/sync/publish-lock";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";
import { stateEnv } from "../helpers/cli-state-env";

/** Task 2.3 (CLI side): the token is re-read over the lock file right before the engine's first write. */

const NOW = new Date("2026-09-30T12:00:00Z");
const ROOT = "/obsidian-vault-sync/hook-test";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

function sink(): { readonly io: CliIo; readonly err: string[] } {
  const err: string[] = [];
  return { io: { out: () => undefined, err: (text) => void err.push(text) }, err };
}

function deps(): CliDeps {
  return { env: stateEnv(), now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
}

describe("ipfs-sync publish: the token hook", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let fire: (() => Promise<void>) | undefined;

  const lockPath = (): string => join(vault, ".ipfs-sync", "publish.lock");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-hook-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, ROOT, node);
    node.calls.length = 0;
    fire = undefined;
    const serve = fakeNodeFetch(node, []);
    // The first request of the run triggers `fire` once, before it is answered: the lock is replaced after it was taken.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const pending = fire;
        fire = undefined;
        await pending?.();
        return serve(input, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publish = async (): Promise<{ readonly code: number; readonly err: string }> => {
    const s = sink();
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", ROOT], deps(), s.io);
    return { code, err: s.err.join("\n") };
  };

  it("a lock file replaced after it was taken and before the first request is a lock-held refusal with no write, and the rival's file is kept", async () => {
    const rival = encodeLock({ token: "rival", pid: 7, host: "other-host", time: NOW.getTime() });
    fire = async () => writeFile(lockPath(), rival);
    const result = await publish();
    expect(result.code).toBe(1);
    expect(result.err).toContain("another publish is running in this vault");
    expect(node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(await readFile(lockPath(), "utf8")).toContain('"token":"rival"');
  }, 30_000);

  it("a lock file that is still ours lets the publish through", async () => {
    const result = await publish();
    expect(result.code).toBe(0);
    expect(node.calls.filter((call) => MUTATING.test(call)).length).toBeGreaterThan(0);
  }, 30_000);
});
