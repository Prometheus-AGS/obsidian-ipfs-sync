import { assertMfsMutationPath } from "../core/config";
import type { Bytes } from "../core/host-bridge";
import { isMissingPathError, type KuboClient, type MfsEntry } from "../kubo";
import { writeBytesToMfs } from "./chunked-write";
import { createCommitNode, type CommitClient, type CommitNodeConfig } from "./commit-node";
import type { CommitNode } from "./commit-ports";
import { listHistory, type HistoryView } from "./history-check";
import { isHistoryName } from "./history-names";
import { isCidToken } from "./local-record";
import { KEYSLOTS_READ_CAP, MANIFEST_READ_CAP, readFileIfPresent, readRemoteFile } from "./node-reader";
import { remoteObjectInvalid } from "./publish-refusals";

/**
 * The node port of a key-management operation (a rewrap or a history prune). It is the commit node's reads, pin and name publication
 * (`createCommitNode`, not re-implemented: the pin and the name publication receive exactly the root CID string, the key list is read
 * right before `name/publish`, and the name is read again there) plus the two writes these operations make to the shared MFS tree:
 * `keyslots.json`, and the removal of one history file. Every write stays inside the MFS root and asks `beforeWrite` first, which is
 * where `publish.lock` is checked (the 07a standard: the caller passes `lock.assertHeld`).
 */

export type MaintenanceClient = CommitClient & Pick<KuboClient, "filesRm" | "ipfsLs">;

export interface MaintenanceNodeConfig extends Omit<CommitNodeConfig, "client"> {
  readonly client: MaintenanceClient;
}

export interface MaintenanceNode extends Pick<CommitNode, "resolveName" | "readManifestFile" | "readManifestFileAt" | "rootCid" | "pinRoot" | "publishRoot"> {
  /** Bytes of `<mfsRoot>/keyslots.json` (at most 16 KiB), or undefined when absent. */
  readKeySlotsFile(): Promise<Bytes | undefined>;
  /** Bytes of `keyslots.json` inside the immutable root `rootCid`, or undefined when that root has none or is not a CID this port reads. */
  readKeySlotsFileAt(rootCid: string): Promise<Bytes | undefined>;
  writeKeySlotsFile(bytes: Bytes): Promise<void>;
  /** Remove one file under `<mfsRoot>/manifests/` (a history name, one path segment, non-recursive). A name that is already gone is a no-op. */
  removeHistoryFile(name: string): Promise<void>;
  /** The listing of `<mfsRoot>/manifests/` (a read); `overflow` when the node holds more entries than the client lists. */
  listHistory(): Promise<HistoryView>;
  /** The listing of `manifests/` inside the immutable root `rootCid`, or undefined when that root has none or is not a CID this port reads. */
  listHistoryAt(rootCid: string): Promise<readonly MfsEntry[] | undefined>;
  /** The bytes of one history entry of a listing, refused above the manifest cap before and while they are read. */
  readHistoryEntry(entry: MfsEntry): Promise<Bytes>;
}

export function createMaintenanceNode(config: MaintenanceNodeConfig): MaintenanceNode {
  const { client, mfsRoot } = config;
  const commit = createCommitNode(config);
  return {
    resolveName: commit.resolveName,
    readManifestFile: commit.readManifestFile,
    readManifestFileAt: commit.readManifestFileAt,
    rootCid: commit.rootCid,
    pinRoot: commit.pinRoot,
    publishRoot: commit.publishRoot,
    readKeySlotsFile: () => readFileIfPresent(client, `${mfsRoot}/keyslots.json`, "keyslots.json", KEYSLOTS_READ_CAP),
    readKeySlotsFileAt: async (rootCid) => (isCidToken(rootCid) ? readFileIfPresent(client, `/ipfs/${rootCid}/keyslots.json`, "keyslots.json", KEYSLOTS_READ_CAP) : undefined),
    writeKeySlotsFile: async (bytes) => {
      config.beforeWrite();
      await writeBytesToMfs(client, assertMfsMutationPath(`${mfsRoot}/keyslots.json`), bytes, "keyslots.json");
    },
    removeHistoryFile: async (name) => {
      // A name from a journal is checked again here: nothing but a history file name can become a path.
      if (!isHistoryName(name)) throw remoteObjectInvalid("a history file name");
      config.beforeWrite();
      try {
        await client.filesRm(assertMfsMutationPath(`${mfsRoot}/manifests/${name}`));
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    },
    listHistory: () => listHistory(client, mfsRoot),
    listHistoryAt: async (rootCid) => {
      if (!isCidToken(rootCid)) return undefined;
      try {
        return await client.ipfsLs(`/ipfs/${rootCid}/manifests`);
      } catch (error) {
        if (isMissingPathError(error)) return undefined;
        throw error;
      }
    },
    readHistoryEntry: (entry) => readRemoteFile(client, entry, "a history entry", MANIFEST_READ_CAP),
  };
}
