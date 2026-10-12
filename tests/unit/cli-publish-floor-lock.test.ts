import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceStoreDirectory } from "../../cli/device-store-node";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { NODE_ENV } from "../helpers/cli-state-env";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { SEQUENCE_FLOOR_FILE } from "../../src/sync/sequence-floor";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";

/**
 * review-final A-08 (confirmation read): the CLI publish must raise the sequence floor inside the device store's `exclusive`
 * section. The engine tests pass their own store; this test goes through `runCli` with the real per-user directory, which is
 * where the wiring (`deviceStoreFor`) lives and where an unlocked wrapper slipped through.
 */

const MFS_ROOT = "/obsidian-vault-sync/floor-lock-test";
const NOW = new Date("2026-09-30T12:00:00Z");
const HOLD_MS = 250;

describe("ipfs-sync publish raises the floor under the device store lock (A-08)", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let stateHome: string;
  let node: FakeNode;
  let released: number | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-floor-lock-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    stateHome = join(dir, "state");
    await writeFixtureVault(vault, 2);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, MFS_ROOT, node);
    released = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Another process takes the device store lock at the moment the name is published, and gives it up HOLD_MS later. */
  function holdLockAtNamePublish(directory: string): void {
    const requests: string[] = [];
    const inner = fakeNodeFetch(node, requests);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const response = await inner(input, init);
        if (requests.at(-1) === "name/publish" && released === undefined) {
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const lock = join(directory, ".store.lock");
          writeFileSync(lock, "pid 1\n", { mode: 0o600 });
          released = 0;
          setTimeout(() => {
            released = Date.now();
            void rm(lock, { force: true });
          }, HOLD_MS);
        }
        return response;
      }),
    );
  }

  it("waits for a lock another process holds before it writes the floor", async () => {
    const env = { ...NODE_ENV, XDG_STATE_HOME: stateHome };
    const directory = deviceStoreDirectory(env);
    holdLockAtNamePublish(directory);
    const err: string[] = [];
    const io: CliIo = { out: () => undefined, err: (text) => void err.push(text) };
    const deps: CliDeps = { env, now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", MFS_ROOT], deps, io);
    expect(err.join("\n")).toBe("");
    expect(code).toBe(0);
    expect(released).toBeGreaterThan(0);
    const floor = await stat(join(directory, SEQUENCE_FLOOR_FILE));
    // Unlocked, the floor is written within milliseconds of the name publication, long before the lock is released.
    expect(floor.mtimeMs).toBeGreaterThanOrEqual((released ?? Infinity) - 5);
    expect((await readdir(directory)).sort()).toEqual(["device-id", "history", SEQUENCE_FLOOR_FILE]);
  });
});
