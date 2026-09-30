import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";

/**
 * What `init --passphrase-file` does with the file it created when a later step fails. `openVault` is wrapped so a test can
 * make it fail before the local key-slot copy exists, or after it was written, or change the node while it runs.
 */
const control = vi.hoisted(() => ({
  mode: "real" as "real" | "fail-before" | "fail-after",
  beforeFailure: undefined as (() => Promise<void>) | undefined,
  afterReal: undefined as (() => void) | undefined,
}));

vi.mock("../../src/sync/vault-keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sync/vault-keys")>();
  return {
    ...actual,
    openVault: async (input: Parameters<typeof actual.openVault>[0]) => {
      if (control.mode === "fail-before") {
        await control.beforeFailure?.();
        throw new actual.VaultKeysError("locked", "simulated failure before the key-slot copy was written");
      }
      const opened = await actual.openVault(input);
      control.afterReal?.();
      if (control.mode === "fail-after") throw new actual.VaultKeysError("locked", "simulated failure after the key-slot copy was written");
      return opened;
    },
  };
});

const MFS_ROOT = "/obsidian-vault-sync/init-cleanup";
const SLOW = 60_000;
const POSIX = process.platform !== "win32" && process.getuid?.() !== 0;

describe("ipfs-sync init --passphrase-file: what happens to the file when a later step fails", () => {
  let dir: string;
  let vault: string;
  let secret: string;
  let node: FakeNode;
  let requests: string[];

  beforeEach(async () => {
    control.mode = "real";
    control.beforeFailure = undefined;
    control.afterReal = undefined;
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-init-clean-"));
    vault = join(dir, "vault");
    secret = join(dir, "secret");
    await mkdir(secret, { mode: 0o700 });
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    requests = [];
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, requests)));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await chmod(secret, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  const passFile = (): string => join(secret, "vault.pass");
  const localCopies = async (): Promise<string[]> => (await readdir(join(vault, ".ipfs-sync")).catch(() => [])).filter((name) => name.startsWith("keyslots."));
  const exists = async (path: string): Promise<boolean> => (await stat(path).catch(() => undefined)) !== undefined;
  const init = async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t) };
    const deps: CliDeps = { env: {}, now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent };
    const code = await runCli(["init", vault, "--mfs-root", MFS_ROOT, "--passphrase-file", passFile()], deps, io);
    return { code, err: err.join("\n"), out: out.join("\n") };
  };

  it("removes the file when the vault could not be created and no key-slot copy exists", async () => {
    control.mode = "fail-before";
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err).toContain("simulated failure before the key-slot copy was written");
    expect(await exists(passFile())).toBe(false);
    expect(await localCopies()).toEqual([]);
  });

  it.skipIf(!POSIX)("still reports the original error when the file cannot be removed, and says the file is left", async () => {
    control.mode = "fail-before";
    control.beforeFailure = async () => {
      await chmod(secret, 0o500);
    };
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err).toContain("simulated failure before the key-slot copy was written");
    expect(result.err).toContain("could not remove the unused passphrase file");
    expect(await exists(passFile())).toBe(true);
  });

  it("keeps the file when the failure comes after the key-slot copy was written", { timeout: SLOW }, async () => {
    control.mode = "fail-after";
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err).toContain("simulated failure after the key-slot copy was written");
    expect(result.err).toContain("was kept");
    expect(await localCopies()).toHaveLength(1);
    expect(await readFile(passFile(), "utf8")).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){4}\n$/);
    expect(requests.filter((r) => r === "files/write")).toEqual([]);
  });

  it("keeps the file when the key slots did not reach the node", { timeout: SLOW }, async () => {
    const real = fakeNodeFetch(node, requests);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => (String(input).includes("/files/write") ? new Response("no", { status: 500 }) : real(input, init))),
    );
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err).toContain("did not reach the node");
    expect(await localCopies()).toHaveLength(1);
    expect(await exists(passFile())).toBe(true);
  });

  it("looks at the root again before writing: a vault that appeared meanwhile is not overwritten, and the file is kept", { timeout: SLOW }, async () => {
    const planted = new Uint8Array([9, 9, 9]);
    control.afterReal = () => void node.files.set(`${MFS_ROOT}/keyslots.json`, planted);
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err).toContain("already holds a vault");
    expect(result.err).toContain("changed while the key was derived");
    expect(requests.filter((r) => r === "files/write")).toEqual([]);
    expect(node.files.get(`${MFS_ROOT}/keyslots.json`)).toEqual(planted);
    expect(await exists(passFile())).toBe(true);
  });
});
