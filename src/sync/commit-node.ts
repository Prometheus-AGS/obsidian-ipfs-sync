import { assertMfsMutationPath } from "../core/config";
import type { Bytes } from "../core/host-bridge";
import type { KuboClient } from "../kubo";
import { writeBytesToMfs } from "./chunked-write";
import type { CommitNode } from "./commit-ports";
import { MANIFEST_READ_CAP, readFileIfPresent, statIfPresent, type NodeReadClient } from "./node-reader";
import { publicationKeyChanged, remoteObjectInvalid } from "./publish-refusals";

/**
 * The adapter between the commit protocol's narrow node port and the shared kubo client. Reads are bounded
 * (stat before read, 64 MiB cap enforced while streaming) and every write stays inside the MFS root and asks
 * `beforeWrite` first, which is where the publish lock is checked. The pin and the name publication receive
 * exactly the root CID string they are given, never an MFS path.
 */

export type CommitClient = NodeReadClient & Pick<KuboClient, "filesWrite" | "pinAdd" | "namePublish" | "keyList">;

export interface CommitNodeConfig {
  readonly client: CommitClient;
  readonly mfsRoot: string;
  /** The IPNS key name to publish under; the caller has already established that it is owned. */
  readonly key: string;
  readonly ttl: string;
  /** The ID of the key as verified earlier in this run (empty while unknown). Checked again right before `name/publish`. */
  readonly keyId: () => string;
  readonly beforeWrite: () => void;
}

/** A CID as it appears in `manifests/<cid>.enc` and in paths: letters and digits only, bounded. */
const CID_IN_PATH = /^[A-Za-z0-9]{10,128}$/;

function historyPath(mfsRoot: string, rootCid: string): string {
  if (!CID_IN_PATH.test(rootCid)) throw remoteObjectInvalid("a snapshot identifier");
  return `${mfsRoot}/manifests/${rootCid}.enc`;
}

export function createCommitNode(config: CommitNodeConfig): CommitNode {
  const { client, mfsRoot } = config;
  const write = async (path: string, bytes: Bytes, label: string): Promise<void> => {
    config.beforeWrite();
    await writeBytesToMfs(client, assertMfsMutationPath(path), bytes, label);
  };
  return {
    currentCid: async () => (await statIfPresent(client, `${mfsRoot}/current`))?.cid,
    readManifestFile: () => readFileIfPresent(client, `${mfsRoot}/manifest.enc`, "manifest.enc", MANIFEST_READ_CAP),
    writeManifestFile: (bytes) => write(`${mfsRoot}/manifest.enc`, bytes, "manifest.enc"),
    readHistoryFile: (rootCid) => readFileIfPresent(client, historyPath(mfsRoot, rootCid), "a history file", MANIFEST_READ_CAP),
    writeHistoryFile: (rootCid, bytes) => write(historyPath(mfsRoot, rootCid), bytes, "a history file"),
    rootCid: async () => (await client.filesStat(mfsRoot)).cid,
    pinRoot: async (rootCid) => {
      config.beforeWrite();
      await client.pinAdd(rootCid);
    },
    publishRoot: async (rootCid) => {
      config.beforeWrite();
      // The key list is read immediately before the publication: a key swapped on the node during a long run must not be published under.
      const expected = config.keyId();
      const found = (await client.keyList()).find((key) => key.name === config.key);
      if (found === undefined || expected === "" || found.id !== expected) throw publicationKeyChanged(config.key);
      await client.namePublish(config.key, rootCid, config.ttl);
    },
  };
}
