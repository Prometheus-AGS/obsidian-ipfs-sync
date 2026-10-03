import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createNodeHostBridge } from "../../cli/node-host-bridge";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import type { VaultKeys } from "../../src/crypto";
import { createFilesMap, decodeManifestFile, encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { openVault } from "../../src/sync/vault-keys";
import { entryFor } from "../vectors/manifest-helpers";
import { referencePassphrase } from "../vectors/slot-helpers";
import { initDiskVault, referencePassphraseSource } from "./cli-vault";
import { stateEnv } from "./cli-state-env";
import { createFakeNode, type FakeNode } from "./fake-kubo";
import { fakeNodeFetch } from "./fake-kubo-http";

/**
 * A CLI-level two-device rig for `ipfs-sync pull` (mvp-07a task 5.1). Device A is a fixture vault on disk that publishes through
 * `runCli`; device B is an absent directory that pulls through `runCli`. Both talk to one fake node through the real kubo client
 * (`fakeNodeFetch`), so the request trace is what the node would see. Device B has its own per-user state directory (its floor).
 */

export const MFS_ROOT = "/obsidian-vault-sync/cli-pull-test";
export const NOW = new Date("2026-09-30T12:00:00Z");

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface PullOptions {
  /** The answers an interactive terminal would give; absent: the run cannot ask. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly deps?: Partial<CliDeps>;
  /** Pull into this directory instead of device B's. */
  readonly vault?: string;
  /** Leave out `--name`, `--mfs-root`: the caller supplies its own target arguments. */
  readonly bare?: boolean;
}

export interface CliPullRig {
  readonly dir: string;
  readonly vaultA: string;
  readonly vaultB: string;
  /** Device B's per-user state directory (its device id and sequence floor). */
  readonly stateB: string;
  readonly node: FakeNode;
  readonly requests: string[];
  readonly fetchStub: ReturnType<typeof vi.fn>;
  /** Questions the terminal was asked, in order. */
  readonly questions: string[];
  publish(extra?: readonly string[]): Promise<CliResult>;
  pull(extra?: readonly string[], options?: PullOptions): Promise<CliResult>;
  keyId(): string;
  /** The vault keys of the reference vault. */
  keys(): Promise<VaultKeys>;
  /** The manifest the node serves now, decoded. */
  manifest(): Promise<EncryptedManifest>;
  /** Replace the served manifest with one that also lists `paths` (valid entries whose blobs the node does not hold), and point the name at the new root. */
  addManifestPaths(paths: readonly string[]): Promise<EncryptedManifest>;
  /** Point the IPNS name at the node's current MFS root (after the test changed files on the node). */
  repoint(): string;
  dispose(): Promise<void>;
}

function sink(confirm: ((question: string) => Promise<boolean>) | undefined, questions: string[]): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ask = confirm === undefined ? {} : { confirm: async (question: string) => (questions.push(question), confirm(question)) };
  return { io: { out: (text) => void out.push(text), err: (text) => void err.push(text), ...ask }, out, err };
}

/** A fixture vault published once by device A (sequence 1), and device B's directory still absent. */
export async function createCliPullRig(options: { readonly publish?: boolean } = {}): Promise<CliPullRig> {
  const dir = await mkdtemp(join(tmpdir(), "ipfs-sync-cli-pull-"));
  const vaultA = join(dir, "vault-a");
  const vaultB = join(dir, "vault-b");
  const stateB = join(dir, "state-b");
  const configA = join(dir, "cfg-a", "config.json");
  const node = createFakeNode([{ name: "self", id: "k51self" }]);
  const requests: string[] = [];
  const questions: string[] = [];
  const fetchStub = vi.fn(fakeNodeFetch(node, requests));
  await writeFixtureVault(vaultA, 3);
  await initDiskVault(vaultA, MFS_ROOT, node);
  vi.stubGlobal("fetch", fetchStub);

  const depsFor = (env: Record<string, string>, overrides: Partial<CliDeps> = {}): CliDeps => ({
    env,
    now: () => NOW,
    readText: readTextIfPresent,
    passphrase: referencePassphraseSource,
    ...overrides,
  });

  const keyId = (): string => {
    const key = node.keys.find((candidate) => candidate.name === "obsidian-vault-sync");
    if (key === undefined) throw new Error("the publication key was not created: publish first");
    return key.id;
  };
  const keys = async (): Promise<VaultKeys> => {
    const host = createNodeHostBridge({ root: vaultA, env: {}, now: () => Date.now() });
    const opened = await openVault({
      fs: host.fs,
      mfsRoot: MFS_ROOT,
      passphrase: referencePassphrase(),
      local: { hasState: false },
      node: { fetchKeySlots: async () => node.files.get(`${MFS_ROOT}/keyslots.json`), manifestPresent: async () => true },
    });
    return opened.keys;
  };
  const repoint = (): string => {
    const root = node.cidOf(MFS_ROOT);
    if (root === undefined) throw new Error("the MFS root does not exist");
    node.published.set(keyId(), `/ipfs/${root}`);
    return root;
  };
  const manifest = async (): Promise<EncryptedManifest> => decodeManifestFile(await keys(), node.files.get(`${MFS_ROOT}/manifest.enc`) ?? new Uint8Array());

  const rig: CliPullRig = {
    dir,
    vaultA,
    vaultB,
    stateB,
    node,
    requests,
    fetchStub,
    questions,
    keyId,
    keys,
    manifest,
    repoint,
    publish: async (extra = []) => {
      const s = sink(undefined, questions);
      const code = await runCli(["publish", vaultA, "--config", configA, "--mfs-root", MFS_ROOT, ...extra], depsFor(stateEnv()), s.io);
      return { code, out: s.out.join("\n"), err: s.err.join("\n") };
    },
    pull: async (extra = [], pullOptions = {}) => {
      const s = sink(pullOptions.confirm, questions);
      const target = pullOptions.bare === true ? [] : ["--mfs-root", MFS_ROOT, "--name", keyId()];
      const code = await runCli(["pull", pullOptions.vault ?? vaultB, ...target, ...extra], depsFor({ XDG_STATE_HOME: stateB }, pullOptions.deps), s.io);
      return { code, out: s.out.join("\n"), err: s.err.join("\n") };
    },
    addManifestPaths: async (paths) => {
      const current = await manifest();
      const vaultKeys = await keys();
      const files = createFilesMap();
      for (const [path, entry] of Object.entries(current.files)) files[path] = entry;
      for (const path of paths) files[path] = await entryFor(vaultKeys, path);
      const forged: EncryptedManifest = { ...current, files };
      const { file } = await encodeManifestFile(vaultKeys, forged);
      node.files.set(`${MFS_ROOT}/manifest.enc`, file);
      repoint();
      return forged;
    },
    dispose: async () => {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    },
  };
  if (options.publish !== false) {
    const published = await rig.publish();
    if (published.code !== 0) throw new Error(`the rig's publish failed: ${published.err}`);
    // `publish` reads the root while it works; make sure the name serves the root of the finished MFS tree.
    repoint();
    requests.length = 0;
    node.calls.length = 0;
  }
  return rig;
}

/** Every file below `directory`, relative path to bytes as text, skipping the state folder and the marker. Absent directory: `undefined`. */
export async function vaultFiles(directory: string): Promise<Record<string, string> | undefined> {
  if (!(await stat(directory).then(() => true, () => false))) return undefined;
  const files: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (path === ".ipfs-sync" || path === ".ipfs-sync-fixture") continue;
      if (entry.isDirectory()) await walk(path);
      else files[path] = await readFile(join(directory, path), "utf8");
    }
  };
  await walk("");
  return files;
}

/** The published files of a fixture vault on disk (what a pull must reproduce): everything outside `.obsidian/`, `.trash/` and the state folder. */
export async function publishedFiles(vaultA: string): Promise<Record<string, string>> {
  const all = (await vaultFiles(vaultA)) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([path]) => !path.startsWith(".obsidian/") && !path.startsWith(".trash/")));
}

/** The history file names under the node's `manifests/` folder, sorted. */
export function historyNames(node: FakeNode): string[] {
  const prefix = `${MFS_ROOT}/manifests/`;
  return [...node.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort();
}

/** The pieces of a result that explain a failure, for `expect(summary(result)).toEqual(...)`. */
export function summary(result: CliResult): { readonly code: number; readonly err: string } {
  return { code: result.code, err: result.err };
}
