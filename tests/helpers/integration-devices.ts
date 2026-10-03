import { createSyncEventBus } from "../../src/core/events";
import { createFolderKv } from "../../src/plugin/obsidian-kv";
import type { HostBridge } from "../../src/core/host-bridge";
import { blobNameFor } from "../../src/crypto";
import { createDeviceIdProvider } from "../../src/sync/device-store";
import type { EncryptedPullOutcome } from "../../src/sync/encrypted-pull";
import { createFilesMap, encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import type { PullStageResult } from "../../src/sync/encrypted-pull-stage";
import { withTokenCheck } from "../../src/sync/lock-token-check";
import { publishVault, type PublishClient, type PublishOptions, type PublishResult } from "../../src/sync/publish";
import { acquirePublishLock, type LockContext, type LockFile } from "../../src/sync/publish-lock";
import { lockHeld } from "../../src/sync/publish-refusals";
import { readRootState, type RootState } from "../../src/sync/root-state";
import { MUTATING_REQUEST, newPuller, pointNameAt, resetNodeTrace, servedRoot, type Puller } from "./encrypted-pull-rig";
import { NodeKilled, type FakeNode } from "./fake-kubo";
import { createMemoryHost, type MemoryHost } from "./memory-host";
import { KEY, ROOT, createRig, seedVault, type Rig } from "./publish-rig";
import { runVaultPull, vaultTexts, type StageOverrides } from "./pull-stage-rig";

/**
 * Two devices over one recording fake node for the integration suite of mvp-07a task 6.1. Every publish takes the real
 * `publish.lock` (an in-memory lock file with the engine's own token check), raises the real sequence floor in its own
 * device store and carries a real device id; every pull is the production `pullEncryptedVault`. Nothing here replaces a
 * guard: the files of a directory, its records, its floor and its lock are the ones the engines read and write.
 */

export const DAILY = "Daily/2026-09-30.md";
export const PLAN = "Projects/Secret Merger/Quarterly plan.md";
export const BINARY = "attachment.bin";
export const ALL_FILES = [BINARY, DAILY, PLAN].sort();

/** A read of a blob: `GET <tree cid>/<two letters>/<52-character blob name>`. */
export const BLOB_GET = /^GET \S+\/[a-z2-7]{2}\/[a-z2-7]{52}/;

export interface PublishRun {
  /** Another client for this run (a wrapper that acts in the middle of the publish). */
  readonly client?: PublishClient;
  /** Another host for this run (a wrapper that dies at a chosen write). */
  readonly host?: HostBridge;
  /** Runs right after the lock is taken and before the engine starts: where another process may take it over. */
  readonly afterLock?: (file: LockFile) => void;
  /** The lock context of this run. The default treats the recorded process as dead, so a lock left by a crash is taken over; pass a context whose process is alive to meet a live holder. */
  readonly lockContext?: LockContext;
  /** The process dies when the host throws NodeKilled: its lock file stays behind, as a crashed process leaves it. */
  readonly dies?: boolean;
}

export interface Device {
  readonly label: string;
  readonly host: MemoryHost;
  readonly puller: Puller;
  /** The host a publish sees: the rig's counting host for device A, the host itself for the others. */
  readonly publishHost: HostBridge;
  /** One publish under the real lock. The marker must say `fixture` (see `allowPublish`). */
  publish(overrides?: Partial<PublishOptions>, run?: PublishRun): Promise<PublishResult>;
  /** One pull of `from`'s node (default: the shared one) into this directory. */
  pull(overrides?: StageOverrides, from?: Rig): Promise<EncryptedPullOutcome<PullStageResult>>;
  /** Vault files, path to text. */
  texts(): Record<string, string>;
  state(): Promise<RootState | undefined>;
  /** The documented hand step: a directory made by a pull publishes only after its marker says `fixture`. */
  allowPublish(): void;
  /** The `device` value of a manifest this installation publishes, once it has published. */
  deviceLabel(): Promise<string>;
}

export interface Devices {
  readonly rig: Rig;
  readonly node: FakeNode;
  readonly a: Device;
  readonly b: Device;
}

export function deviceOf(rig: Rig, host: MemoryHost, label: string, publishHost: HostBridge = host, puller: Puller = newPuller(host)): Device {
  const { store, locks } = puller;
  const self: Device = {
    label,
    host,
    puller,
    publishHost,
    publish: async (overrides = {}, run = {}) => {
      const checked = withTokenCheck(locks.file);
      const lock = await acquirePublishLock(checked.file, run.lockContext ?? locks.ctx);
      let crashed = false;
      try {
        run.afterLock?.(locks.file);
        return await publishVault(
          {
            client: run.client ?? rig.node.client,
            host: run.host ?? publishHost,
            bus: createSyncEventBus(),
            deviceId: createDeviceIdProvider(store),
            deviceStore: store,
            beforeFirstWrite: async () => {
              if (!(await checked.verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
            },
          },
          {
            mfsRoot: ROOT,
            keyName: KEY,
            ownedKeys: rig.owned,
            recordOwnedKey: async (id) => void (rig.owned.includes(id) ? undefined : rig.owned.push(id)),
            passphrase: rig.passphrase,
            assertHeld: () => lock.assertHeld(),
            ...overrides,
          },
        );
      } catch (error) {
        crashed = run.dies === true && error instanceof NodeKilled;
        throw error;
      } finally {
        if (!crashed) await lock.release();
      }
    },
    pull: (overrides, from = rig) => runVaultPull(from, puller, overrides),
    texts: () => vaultTexts(host),
    state: () => readRootState(host.kv, ROOT),
    allowPublish: () => host.put(".ipfs-sync-fixture", "fixture\n"),
    deviceLabel: async () => {
      const state = await readRootState(host.kv, ROOT);
      return state?.manifest.device ?? label;
    },
  };
  return self;
}

export interface DevicesOptions {
  /** More files for device A's vault, before its first publish. */
  readonly seed?: (host: MemoryHost) => void;
  /** Leave device A unpublished (the vault is initialised only). */
  readonly publish?: boolean;
  /**
   * Keep device B's records as files under `.ipfs-sync/` (the layout of the CLI and the plugin hosts, where `abandon` moves
   * them) instead of in the memory host's separate key-value map. The production folder key-value store does it.
   */
  readonly bRecordsInFiles?: boolean;
}

/** Device A has published sequence 1 of the seeded vault; device B is an empty directory with its own store and lock. */
export async function createDevices(options: DevicesOptions = {}): Promise<Devices> {
  const rig = createRig({ env: { IPFS_SYNC_DEVICE: "device-a" } });
  seedVault(rig.host);
  options.seed?.(rig.host);
  await rig.init();
  const a = deviceOf(rig, rig.host, "device-a", rig.killableHost);
  if (options.publish !== false) {
    await a.publish();
    servedRoot(rig.node);
  }
  const bHost = createMemoryHost({ env: { IPFS_SYNC_DEVICE: "device-b" } });
  if (options.bRecordsInFiles === true) Object.defineProperty(bHost, "kv", { value: createFolderKv(bHost.fs) });
  const b = deviceOf(rig, bHost, "device-b");
  resetNodeTrace(rig.node);
  return { rig, node: rig.node, a, b };
}

/** A edits a note and publishes (the clock moves so the mtime changes); the trace is reset and the served root is registered. */
export async function editAndPublish(rig: Rig, device: Device, edits: Record<string, string>, run?: PublishRun): Promise<PublishResult> {
  device.host.clock += 60_000;
  for (const [path, text] of Object.entries(edits)) device.host.put(path, text);
  const result = await device.publish({}, run);
  servedRoot(rig.node);
  resetNodeTrace(rig.node);
  return result;
}

/**
 * The node serves the real manifest plus entries for `paths` (valid entries with the real keyed blob names, whose blobs the node
 * does not hold): what an older build, or a compromised device holding the key, could publish. The file is replaced in the MFS
 * root and the name is pointed at the new root. Returns the forged manifest.
 */
export async function addManifestEntries(rig: Rig, paths: readonly string[]): Promise<EncryptedManifest> {
  const keys = await rig.keys();
  const real = await rig.manifest();
  const template = Object.values(real.files)[0];
  if (template === undefined) throw new Error("the vault has no file");
  const files = createFilesMap(Object.entries(real.files));
  for (const [index, path] of paths.entries()) files[path] = { ...template, blob: await blobNameFor(keys, path), fileId: (index + 1).toString(16).padStart(32, "0") };
  const forged: EncryptedManifest = { ...real, files };
  rig.node.files.set(`${ROOT}/manifest.enc`, (await encodeManifestFile(keys, forged)).file);
  pointNameAt(rig.node);
  resetNodeTrace(rig.node);
  return forged;
}

/** Requests that changed the node. */
export const mutatingCalls = (node: FakeNode): string[] => node.calls.filter((line) => MUTATING_REQUEST.test(line));

/** Blob reads in the node's trace. */
export const blobReads = (node: FakeNode): string[] => node.calls.filter((line) => BLOB_GET.test(line));

/** Vault files that sync (not the configuration folder, the trash or the embeddings folder), path to text. */
export function syncedTexts(device: Pick<Device, "texts">): Record<string, string> {
  return Object.fromEntries(Object.entries(device.texts()).filter(([path]) => !/^(\.obsidian|\.trash|\.smart-env)\//.test(path)));
}

/** Part files and conflict copies left in the state folder's tmp: a finished pull leaves none. */
export const leftovers = (host: MemoryHost): string[] => [...host.files.keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"));

/** The stored bytes of a vault file, for byte-for-byte comparison. */
export function bytesOf(host: MemoryHost, path: string): readonly number[] | undefined {
  const file = host.files.get(path);
  return file === undefined ? undefined : [...file.data];
}
