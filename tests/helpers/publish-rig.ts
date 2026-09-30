import { createSyncEventBus, type FileChangedEvent, type PublishCompleteEvent } from "../../src/core/events";
import type { HostBridge, HostKv } from "../../src/core/host-bridge";
import type { CanonicalPassphrase, VaultKeys } from "../../src/crypto";
import { decodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { POOL_DEFAULT_CONCURRENCY } from "../../src/sync/pool";
import { publishVault, type PublishOptions, type PublishResult } from "../../src/sync/publish";
import { openVault } from "../../src/sync/vault-keys";
import { referencePassphrase } from "../vectors/slot-helpers";
import { NodeKilled, createFakeNode, restoreNode, snapshotNode, type FakeNode, type NodeSnapshot } from "./fake-kubo";
import { createMemoryHost, type MemoryHost } from "./memory-host";
import { initVault } from "./vault-init";

export const ROOT = "/obsidian-vault-sync/enc-test";
export const KEY = "obsidian-vault-sync";

/** Words that must never reach the node in the clear. */
export const SECRET_TITLE = "Quarterly plan";
export const SECRET_FOLDER = "Secret Merger";
export const SECRET_WORD = "zebra-quokka-unicorn";

export const decodeText = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

export interface Rig {
  readonly host: MemoryHost;
  readonly node: FakeNode;
  readonly events: { readonly changed: FileChangedEvent[]; readonly completed: PublishCompleteEvent[] };
  readonly passphrase: CanonicalPassphrase;
  /** IDs of publication keys recorded so far; passed to every publish as the owned keys. */
  readonly owned: string[];
  /** Create the vault the way `ipfs-sync init` will: the local copy and `keyslots.json` on the node, no manifest. */
  init(): Promise<void>;
  publish(overrides?: Partial<PublishOptions>): Promise<PublishResult>;
  /** The vault keys, opened from the local key-slot copy (one derivation, cached). */
  keys(): Promise<VaultKeys>;
  /** The manifest the node currently serves, authenticated and decoded. */
  manifest(): Promise<EncryptedManifest>;
  /** The host the engine sees: local state changes count as steps of the node's mutation clock, so a kill can land between any two. */
  readonly killableHost: HostBridge;
}

export interface RigOptions {
  readonly marker?: boolean;
  readonly env?: Record<string, string>;
  readonly node?: FakeNode;
  /** Concurrent writes the publish transfer may run. Defaults to the real pool size; pass 1 only for a property that is serial by nature. */
  readonly concurrency?: number;
}

function countingHost(host: MemoryHost, node: FakeNode): HostBridge {
  const step = (): void => {
    node.mutations += 1;
    if (node.killAfterMutation !== undefined && node.mutations >= node.killAfterMutation) throw new NodeKilled(node.mutations);
  };
  const kv: HostKv = {
    get: (key) => host.kv.get(key),
    list: (prefix) => host.kv.list(prefix),
    set: async (key, value) => {
      await host.kv.set(key, value);
      step();
    },
    delete: async (key) => {
      await host.kv.delete(key);
      step();
    },
  };
  return {
    fs: host.fs,
    net: host.net,
    kv,
    agent: host.agent,
    timeNow: () => host.timeNow(),
    envRead: (name) => host.envRead(name),
    shellExec: (request) => host.shellExec(request),
  };
}

export function createRig(options: RigOptions = {}): Rig {
  const host = createMemoryHost({ env: { IPFS_SYNC_DEVICE: "test-device", ...options.env } });
  if (options.marker !== false) host.put(".ipfs-sync-fixture", "fixture\n");
  const node = options.node ?? createFakeNode();
  const bus = createSyncEventBus();
  const events = { changed: [] as FileChangedEvent[], completed: [] as PublishCompleteEvent[] };
  bus.on("file.changed", (event) => void events.changed.push(event));
  bus.on("publish.complete", (event) => void events.completed.push(event));
  const owned: string[] = [];
  const killableHost = countingHost(host, node);
  const passphrase = referencePassphrase();
  let opened: Promise<VaultKeys> | undefined;
  const keys = (): Promise<VaultKeys> =>
    (opened ??= openVault({
      fs: host.fs,
      mfsRoot: ROOT,
      passphrase,
      local: { hasState: false },
      node: { fetchKeySlots: async () => node.files.get(`${ROOT}/keyslots.json`), manifestPresent: async () => true },
    }).then((vault) => vault.keys));

  return {
    host,
    node,
    events,
    passphrase,
    owned,
    killableHost,
    init: () => initVault(host.fs, node, ROOT),
    keys,
    manifest: async () => decodeManifestFile(await keys(), node.files.get(`${ROOT}/manifest.enc`) ?? new Uint8Array()),
    publish: (overrides = {}) =>
      publishVault(
        { client: node.client, host: killableHost, bus },
        {
          mfsRoot: ROOT,
          keyName: KEY,
          ownedKeys: owned,
          recordOwnedKey: async (id) => void owned.push(id),
          // The real default: the transfer runs its small files this many at a time, so the tests exercise the concurrent path.
          concurrency: options.concurrency ?? POOL_DEFAULT_CONCURRENCY,
          passphrase,
          ...overrides,
        },
      ),
  };
}

/** A small fixture vault whose titles, folder and body words are secret. */
export function seedVault(host: MemoryHost): void {
  host.put(`Projects/${SECRET_FOLDER}/${SECRET_TITLE}.md`, `The ${SECRET_WORD} merger closes in the third quarter.\n`, 1000);
  host.put("Daily/2026-09-30.md", `# Notes\nCall about ${SECRET_WORD}.\n`, 1000);
  host.put("attachment.bin", new Uint8Array([1, 2, 3, 4, 5]), 1000);
  host.put(".trash/old.md", "trash", 1000);
  host.put(".obsidian/workspace.json", "{}", 1000);
}

/** The MFS paths of the blobs currently under `current/`. */
export function blobPaths(node: FakeNode): string[] {
  return [...node.files.keys()].filter((path) => /\/current\/[a-z2-7]{2}\/[a-z2-7]{52}$/.test(path)).sort();
}

/** A rig's whole state (vault files, local records, node), so a test can start many runs from the same point. */
export interface RigSnapshot {
  readonly files: readonly (readonly [string, Uint8Array, number])[];
  readonly kv: readonly (readonly [string, Uint8Array])[];
  readonly node: NodeSnapshot;
  readonly owned: readonly string[];
}

export function snapshotRig(rig: Rig): RigSnapshot {
  return {
    files: [...rig.host.files].map(([path, file]) => [path, Uint8Array.from(file.data), file.mtimeMs] as const),
    kv: [...rig.host.kvStore].map(([key, value]) => [key, Uint8Array.from(value)] as const),
    node: snapshotNode(rig.node),
    owned: [...rig.owned],
  };
}

export function restoreRig(snapshot: RigSnapshot, options: Omit<RigOptions, "node" | "marker"> = {}): Rig {
  const rig = createRig({ ...options, marker: false, node: restoreNode(snapshot.node) });
  for (const [path, data, mtimeMs] of snapshot.files) rig.host.put(path, Uint8Array.from(data), mtimeMs);
  for (const [key, value] of snapshot.kv) rig.host.kvStore.set(key, Uint8Array.from(value));
  rig.owned.push(...snapshot.owned);
  return rig;
}
