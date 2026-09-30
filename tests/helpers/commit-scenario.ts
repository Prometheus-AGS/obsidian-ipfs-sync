import { sha256 } from "@noble/hashes/sha2.js";
import { toBase32Lower, type VaultKeys } from "../../src/crypto";
import type { Bytes } from "../../src/core/host-bridge";
import type { CommitDeps, CommitNode, PublishTarget, SnapshotExpectation } from "../../src/sync/commit-ports";
import { createFilesMap, decodeManifestFile, encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { sha256Hex } from "../../src/sync/hash";
import { ReadBackError } from "../../src/sync/publish-refusals";
import { buildRootState, writeRootState, type RootState } from "../../src/sync/root-state";
import { sameBytes } from "../../src/sync/same-bytes";
import { createMemoryHost, type MemoryHost } from "./memory-host";
import { ROOT_CID, entryFor, keysFrom } from "../vectors/manifest-helpers";

export const MFS_ROOT = "/obsidian-vault-sync/commit-test";
export const KEY = "obsidian-vault-sync";
export const KEYSLOTS_SHA = "c".repeat(64);

/** A CIDv1-shaped string derived from text, so equal inputs give equal CIDs. */
export function cidFor(text: string): string {
  return `b${toBase32Lower(sha256(new TextEncoder().encode(text)))}`;
}

/** Thrown by the fault injection after the named step completed: the process "dies" there. */
export class Killed extends Error {
  constructor(readonly step: string) {
    super(`killed after ${step}`);
    this.name = "Killed";
  }
}

export const STEPS = [
  "journal-write",
  "manifest-write",
  "history-write",
  "root-cid",
  "verify",
  "pin",
  "publish",
  "state-write",
  "journal-delete",
] as const;
export type Step = (typeof STEPS)[number];

/** The node's mutable state for one MFS root, as far as the commit protocol can see it. */
export class FakeCommitNode implements CommitNode {
  manifestFile: Bytes | undefined;
  readonly history = new Map<string, Bytes>();
  current: string | undefined;
  /** Objects planted at the top level of the root (must be absent at read-back). */
  readonly topLevelExtras: string[] = [];
  readonly pins: string[] = [];
  readonly publishes: string[] = [];
  manifestWrites = 0;
  historyWrites = 0;
  calls: string[] = [];

  currentCid = async (): Promise<string | undefined> => this.current;
  readManifestFile = async (): Promise<Bytes | undefined> => this.manifestFile;
  writeManifestFile = async (bytes: Bytes): Promise<void> => {
    this.calls.push("manifest-write");
    this.manifestWrites += 1;
    this.manifestFile = bytes;
  };
  readHistoryFile = async (rootCid: string): Promise<Bytes | undefined> => this.history.get(rootCid);
  writeHistoryFile = async (rootCid: string, bytes: Bytes): Promise<void> => {
    this.calls.push("history-write");
    this.historyWrites += 1;
    this.history.set(rootCid, bytes);
  };
  rootCid = async (): Promise<string> => {
    this.calls.push("root-cid");
    const parts = [this.current ?? "-", this.manifestFile === undefined ? "-" : await sha256Hex(this.manifestFile), [...this.history.keys()].sort().join(","), this.topLevelExtras.join(",")];
    return cidFor(parts.join("|"));
  };
  pinRoot = async (rootCid: string): Promise<void> => {
    this.calls.push("pin");
    this.pins.push(rootCid);
  };
  publishRoot = async (rootCid: string): Promise<void> => {
    this.calls.push("publish");
    this.publishes.push(rootCid);
  };

  /** Someone adds an object under `current/` while the publisher is down: its CID changes. */
  plantUnderCurrent(): void {
    this.current = cidFor(`${this.current ?? "-"}|planted`);
  }

  /** The read-back a real adapter performs, in miniature: every check that can fail a snapshot. */
  verify = async (_rootCid: string, expected: SnapshotExpectation): Promise<void> => {
    this.calls.push("verify");
    if (this.current !== expected.manifest.rootCID) throw new ReadBackError("current differs from the manifest");
    if (this.topLevelExtras.length > 0) throw new ReadBackError("unexpected top-level entry");
    if (this.manifestFile === undefined || !sameBytes(this.manifestFile, expected.manifestFile)) throw new ReadBackError("manifest.enc differs");
    const history = this.history.get(expected.manifest.rootCID);
    if (history === undefined || !sameBytes(history, expected.manifestFile)) throw new ReadBackError("history file differs");
  };
}

export interface Scenario {
  readonly keys: VaultKeys;
  readonly host: MemoryHost;
  readonly node: FakeCommitNode;
  readonly target: PublishTarget;
  /** The completed publish at sequence 1 (what the local state and the node both hold before the test's publish). */
  readonly state1: RootState;
  readonly manifest1: EncryptedManifest;
  readonly file1: Bytes;
  readonly deps: CommitDeps;
  /** Manifest and encrypted file for `sequence`, over the given paths, with the current tree set to a fresh CID. */
  next(sequence: number, paths: readonly string[]): Promise<{ manifest: EncryptedManifest; file: Bytes }>;
}

const BASE_PATHS = ["notes/a.md", "notes/b.md"] as const;

export async function buildManifest(keys: VaultKeys, sequence: number, paths: readonly string[], rootCID: string): Promise<EncryptedManifest> {
  const files = createFilesMap();
  for (const path of paths) files[path] = await entryFor(keys, path, ROOT_CID);
  return {
    version: 2,
    vaultId: keys.vaultId,
    sequence,
    rootCID,
    publishedAt: "2026-09-30T12:00:00.000Z",
    device: "test-device",
    excludesHash: "b".repeat(64),
    files,
  };
}

/** Wrap deps so the process "dies" right after `step` completes. Only the commit tail's ports can be hit. */
export function killAfter(deps: CommitDeps, step: Step): CommitDeps {
  const dieAfter = (name: Step): void => {
    if (name === step) throw new Killed(step);
  };
  const after = <A extends unknown[], R>(name: Step, call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    const result = await call(...args);
    dieAfter(name);
    return result;
  };
  return {
    ...deps,
    node: {
      currentCid: deps.node.currentCid,
      readManifestFile: deps.node.readManifestFile,
      readHistoryFile: deps.node.readHistoryFile,
      writeManifestFile: after("manifest-write", deps.node.writeManifestFile),
      writeHistoryFile: after("history-write", deps.node.writeHistoryFile),
      rootCid: after("root-cid", deps.node.rootCid),
      pinRoot: after("pin", deps.node.pinRoot),
      publishRoot: after("publish", deps.node.publishRoot),
    },
    verifySnapshot: after("verify", deps.verifySnapshot),
    kv: {
      get: deps.kv.get,
      set: async (key, value) => {
        await deps.kv.set(key, value);
        if (key.startsWith("journal.")) dieAfter("journal-write");
        if (key.startsWith("state.")) dieAfter("state-write");
      },
      delete: async (key) => {
        await deps.kv.delete(key);
        if (key.startsWith("journal.")) dieAfter("journal-delete");
      },
    },
  };
}

/** A vault whose sequence-1 publish completed: state, node manifest, history file and current tree all agree. */
export async function scenario(): Promise<Scenario> {
  const keys = await keysFrom(0x20, 0x50);
  const host = createMemoryHost();
  const node = new FakeCommitNode();
  const target: PublishTarget = { mfsRoot: MFS_ROOT, key: KEY, vaultId: keys.vaultId, keyslotsSha256: KEYSLOTS_SHA };

  const tree1 = cidFor("tree-1");
  const manifest1 = await buildManifest(keys, 1, BASE_PATHS, tree1);
  const { file: file1 } = await encodeManifestFile(keys, manifest1);
  node.current = tree1;
  node.manifestFile = file1;
  node.history.set(tree1, file1);
  const state1 = buildRootState({
    mfsRoot: MFS_ROOT,
    key: KEY,
    rootCid: cidFor("root-1"),
    vaultId: keys.vaultId,
    keyslotsSha256: KEYSLOTS_SHA,
    sequence: 1,
    manifest: manifest1,
    mtimes: { "notes/a.md": 1, "notes/b.md": 1 },
  });
  await writeRootState(host.kv, state1);
  node.manifestWrites = 0;
  node.historyWrites = 0;

  const deps: CommitDeps = {
    node,
    kv: host.kv,
    decodeManifest: (bytes) => decodeManifestFile(keys, bytes),
    encodeManifest: async (manifest) => (await encodeManifestFile(keys, manifest)).file,
    verifySnapshot: node.verify,
    now: () => Date.UTC(2026, 8, 30, 12, 0, 0),
  };
  return {
    keys,
    host,
    node,
    target,
    state1,
    manifest1,
    file1,
    deps,
    next: async (sequence, paths) => {
      const tree = cidFor(`tree-${sequence}-${paths.join(",")}`);
      node.current = tree;
      const manifest = await buildManifest(keys, sequence, paths, tree);
      return { manifest, file: (await encodeManifestFile(keys, manifest)).file };
    },
  };
}
