import { expect } from "vitest";
import { encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import {
  encryptedPull,
  type EncryptedPullDeps,
  type EncryptedPullOptions,
  type EncryptedPullOutcome,
  type PullStop,
  type VerifiedPull,
} from "../../src/sync/encrypted-pull";
import { LOCK_HEARTBEAT_MS, type LockContext, type LockFile } from "../../src/sync/publish-lock";
import { manifestFor } from "../vectors/manifest-helpers";
import { createMemoryDeviceStore, type MemoryDeviceStore } from "./memory-device-store";
import { createMemoryHost, type MemoryHost } from "./memory-host";
import type { FakeNode } from "./fake-kubo";
import { KEY, ROOT, seedVault, createRig, type Rig } from "./publish-rig";

/** Test helpers for the decrypting pull (mvp-07a 4.6a): a second device, a lock stand-in and ways to forge what the node serves. */

export const NOW = 1_800_000_000_000;

/** A request that changes the node. Everything else the recording node logs (`keyList`, `stat`, `ls`, `ipfs-ls`, `nameResolve`, `GET`) is a read. */
export const MUTATING_REQUEST = /^(write|rm|pin|publish|keyGen) /;

export interface LockRig {
  readonly file: LockFile & { bytes: Uint8Array<ArrayBuffer> | undefined; creates: number };
  readonly ctx: LockContext & { time: number; ticks: (() => void)[]; stopped: number };
}

/** An in-memory `publish.lock` and a lock context whose heartbeat is driven by the test. */
export function lockRig(host = "host-a"): LockRig {
  const file: LockRig["file"] = {
    bytes: undefined,
    creates: 0,
    createExclusive: async (bytes) => {
      file.creates += 1;
      if (file.bytes !== undefined) return false;
      file.bytes = bytes;
      return true;
    },
    read: async () => file.bytes,
    write: async (bytes) => {
      file.bytes = bytes;
    },
    remove: async () => {
      file.bytes = undefined;
    },
    moveAside: async () => {
      const moved = file.bytes;
      file.bytes = undefined;
      return moved === undefined ? undefined : { bytes: moved, discard: async () => undefined };
    },
  };
  let tokens = 0;
  const ctx: LockRig["ctx"] = {
    time: NOW,
    ticks: [],
    stopped: 0,
    now: () => ctx.time,
    pid: 4242,
    host,
    newToken: () => `pull-token-${(tokens += 1)}`,
    isProcessAlive: () => false,
    every: (ms, task) => {
      expect(ms).toBe(LOCK_HEARTBEAT_MS);
      ctx.ticks.push(task);
      return () => {
        ctx.stopped += 1;
      };
    },
  };
  return { file, ctx };
}

export interface Puller {
  readonly host: MemoryHost;
  readonly store: MemoryDeviceStore;
  readonly locks: LockRig;
  /** Every `VerifiedPull` the stage received. */
  readonly staged: VerifiedPull[];
}

/** A second device: its own directory, device store and lock. Pass an existing host to pull again into the same directory. */
export function newPuller(host: MemoryHost = createMemoryHost(), store: MemoryDeviceStore = createMemoryDeviceStore()): Puller {
  return { host, store, locks: lockRig(), staged: [] };
}

export interface RunOverrides {
  readonly options?: Partial<EncryptedPullOptions>;
  readonly deps?: Partial<EncryptedPullDeps<string>>;
}

/** One pull of `rig`'s node by `puller`. By default: the name target, the reference passphrase, `--accept-first-pull`. */
export function runPull(rig: Rig, puller: Puller, overrides: RunOverrides = {}): Promise<EncryptedPullOutcome<string>> {
  return encryptedPull<string>(
    {
      client: rig.node.client,
      host: puller.host,
      deviceStore: puller.store,
      lockFile: puller.locks.file,
      lockContext: puller.locks.ctx,
      now: () => NOW,
      stage: async (verified) => {
        puller.staged.push(verified);
        return "staged";
      },
      ...overrides.deps,
    },
    {
      mfsRoot: ROOT,
      keyName: KEY,
      ownedKeys: rig.owned,
      target: { kind: "name" },
      flags: {},
      passphrase: rig.passphrase,
      acceptFirstPull: true,
      ...overrides.options,
    },
  );
}

export function stopOf<R>(outcome: EncryptedPullOutcome<R>): PullStop {
  if (outcome.kind !== "stopped") throw new Error(`expected a stop, the pull ${outcome.kind}`);
  return outcome.stop;
}

export function verifiedOf<R>(outcome: EncryptedPullOutcome<R>): VerifiedPull {
  if (outcome.kind !== "completed") throw new Error(`expected the pull to complete, it stopped: ${outcome.stop.reason}: ${outcome.stop.message}`);
  return outcome.verified;
}

/** Nothing was written anywhere: no vault file, no record, no floor, and the stage never ran. */
export function expectNothingWritten(puller: Puller): void {
  expect(puller.host.mutations).toEqual([]);
  expect(puller.host.kvStore.size).toBe(0);
  expect(puller.store.writes).toEqual([]);
  expect(puller.staged).toEqual([]);
}

/** Every request the recording node saw is a read. */
export function expectOnlyReads(node: FakeNode): void {
  expect(node.calls.filter((line) => MUTATING_REQUEST.test(line))).toEqual([]);
}

/** The IPNS key ID of the publication key. */
export function keyIdOf(node: FakeNode): string {
  const key = node.keys.find((candidate) => candidate.name === KEY);
  if (key === undefined) throw new Error("the publication key was not created");
  return key.id;
}

/** The root CID of the node's current MFS root. Reading it registers the blocks, so `/ipfs/<root>` keeps working after later changes. */
export function currentRoot(node: FakeNode): string {
  const cid = node.cidOf(ROOT);
  if (cid === undefined) throw new Error("the MFS root does not exist");
  return cid;
}

/** Point the IPNS name at `root`, or at the node's current MFS root. */
export function pointNameAt(node: FakeNode, root: string = currentRoot(node)): string {
  node.published.set(keyIdOf(node), `/ipfs/${root}`);
  return root;
}

/** The root the name serves now. Also registers the root's blocks, so `/ipfs/<root>` stays readable after later publishes. */
export function servedRoot(node: FakeNode): string {
  const root = currentRoot(node);
  expect(node.published.get(keyIdOf(node))).toBe(`/ipfs/${root}`);
  return root;
}

/** A vault published once (sequence 1) by device A. The request trace is reset. */
export async function publishedOnce(options: { readonly env?: Record<string, string>; readonly seed?: (rig: Rig) => void } = {}): Promise<Rig> {
  const rig = createRig(options.env === undefined ? {} : { env: options.env });
  seedVault(rig.host);
  options.seed?.(rig);
  await rig.init();
  await rig.publish();
  servedRoot(rig.node);
  resetNodeTrace(rig.node);
  return rig;
}

/** Edit one note and publish again (sequence + 1). Returns the new root. */
export async function publishAgain(rig: Rig, text = "A second edition of the daily note.\n"): Promise<string> {
  rig.host.clock += 60_000;
  rig.host.put("Daily/2026-09-30.md", text);
  await rig.publish();
  const root = servedRoot(rig.node);
  resetNodeTrace(rig.node);
  return root;
}

export function resetNodeTrace(node: FakeNode): void {
  node.calls.length = 0;
  node.requests.length = 0;
  node.mutations = 0;
}

/**
 * Make the node serve an authenticated manifest of the test's own making (as a compromised device holding the vault key
 * could): the same vault, any paths, any header fields. Replaces `manifest.enc` in the MFS root and republishes the name.
 */
export async function forgeManifest(rig: Rig, paths: readonly string[], overrides: Partial<EncryptedManifest> = {}): Promise<EncryptedManifest> {
  const keys = await rig.keys();
  const manifest = await manifestFor(keys, paths, overrides);
  const { file } = await encodeManifestFile(keys, manifest);
  rig.node.files.set(`${ROOT}/manifest.enc`, file);
  pointNameAt(rig.node);
  resetNodeTrace(rig.node);
  return manifest;
}
