import { assertMfsMutationPath } from "../core/config";
import type { Bytes } from "../core/host-bridge";
import { NAME_RESOLVE_DHT_TIMEOUT, classifyResolveFailure, type KuboClient } from "../kubo";
import { writeBytesToMfs } from "./chunked-write";
import type { CommitNode, NameReading } from "./commit-ports";
import { historyFileName } from "./history-names";
import { assertNameUnmoved } from "./name-recheck";
import { MANIFEST_READ_CAP, readFileIfPresent, statIfPresent, type NodeReadClient } from "./node-reader";
import { publicationKeyChanged, remoteObjectInvalid } from "./publish-refusals";

/**
 * The adapter between the commit protocol's narrow node port and the shared kubo client. Reads are bounded
 * (stat before read, 64 MiB cap enforced while streaming) and every write stays inside the MFS root and asks
 * `beforeWrite` first, which is where the publish lock is checked. The pin and the name publication receive
 * exactly the root CID string they are given, never an MFS path.
 */

export type CommitClient = NodeReadClient & Pick<KuboClient, "filesWrite" | "pinAdd" | "namePublish" | "keyList" | "nameResolve">;

export interface CommitNodeConfig {
  readonly client: CommitClient;
  readonly mfsRoot: string;
  /** The IPNS key name to publish under; the caller has already established that it is owned. */
  readonly key: string;
  readonly ttl: string;
  /** The ID of the key as verified earlier in this run (empty while unknown). Checked again right before `name/publish`. */
  readonly keyId: () => string;
  /** This run generated the key: a name that has just come into being is not read before `name/publish`. */
  readonly keyCreated: () => boolean;
  readonly beforeWrite: () => void;
}

/** What a name can resolve to that this adapter will build an `/ipfs/` path from: a CID's alphabet, nothing that could add a path segment. */
const READABLE_ROOT = /^[A-Za-z0-9]{10,128}$/;

/** `/ipfs/<cid>` as the bare CID; a path of another shape is kept whole, so it can only ever differ from a CID. */
function rootOfPath(path: string): string {
  return path.startsWith("/ipfs/") ? path.slice("/ipfs/".length) : path;
}

/** The history file of one snapshot: `manifests/<16-digit sequence>-<cid>.enc`. Legacy unprefixed names are read by listings, never written. */
function historyPath(mfsRoot: string, sequence: number, rootCid: string): string {
  try {
    return `${mfsRoot}/manifests/${historyFileName(sequence, rootCid)}`;
  } catch (error) {
    if (error instanceof RangeError) throw remoteObjectInvalid("a snapshot identifier");
    throw error;
  }
}

export function createCommitNode(config: CommitNodeConfig): CommitNode {
  const { client, mfsRoot } = config;
  const write = async (path: string, bytes: Bytes, label: string): Promise<void> => {
    config.beforeWrite();
    await writeBytesToMfs(client, assertMfsMutationPath(path), bytes, label);
  };
  /** One `name/resolve` of the publication key (nocache, bounded `dht-timeout`), classified. A read. */
  const resolveName = async (): Promise<NameReading | undefined> => {
    const id = config.keyId();
    if (id === "") return undefined;
    try {
      return { kind: "value", root: rootOfPath(await client.nameResolve(`/ipns/${id}`, { dhtTimeout: NAME_RESOLVE_DHT_TIMEOUT })) };
    } catch (error) {
      return classifyResolveFailure(error);
    }
  };
  return {
    resolveName,
    currentCid: async () => (await statIfPresent(client, `${mfsRoot}/current`))?.cid,
    readManifestFile: () => readFileIfPresent(client, `${mfsRoot}/manifest.enc`, "manifest.enc", MANIFEST_READ_CAP),
    readManifestFileAt: async (rootCid) =>
      READABLE_ROOT.test(rootCid) ? readFileIfPresent(client, `/ipfs/${rootCid}/manifest.enc`, "manifest.enc", MANIFEST_READ_CAP) : undefined,
    writeManifestFile: (bytes) => write(`${mfsRoot}/manifest.enc`, bytes, "manifest.enc"),
    readHistoryFile: (sequence, rootCid) => readFileIfPresent(client, historyPath(mfsRoot, sequence, rootCid), "a history file", MANIFEST_READ_CAP),
    writeHistoryFile: (sequence, rootCid, bytes) => write(historyPath(mfsRoot, sequence, rootCid), bytes, "a history file"),
    rootCid: async () => (await client.filesStat(mfsRoot)).cid,
    pinRoot: async (rootCid) => {
      config.beforeWrite();
      await client.pinAdd(rootCid);
    },
    publishRoot: async (rootCid, start) => {
      config.beforeWrite();
      // The key list is read immediately before the publication: a key swapped on the node during a long run must not be published under.
      const expected = config.keyId();
      const found = (await client.keyList()).find((key) => key.name === config.key);
      if (found === undefined || expected === "" || found.id !== expected) throw publicationKeyChanged(config.key);
      // Then the name is read again: if it moved since this publish started, another device may have published, and this one must not overwrite it.
      if (start !== undefined && !config.keyCreated()) assertNameUnmoved(start, await resolveName(), rootCid);
      await client.namePublish(config.key, rootCid, config.ttl);
    },
  };
}
