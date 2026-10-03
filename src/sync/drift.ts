import { KuboResponseTooLargeError, type MfsEntry } from "../kubo";
import type { EncryptedManifestFile } from "./encrypted-manifest";
import { listIfPresent, type NodeReadClient } from "./node-reader";
import { runPool } from "./pool";
import { prefixFolderTooLarge } from "./publish-refusals";

/**
 * The baseline check with diagnosis (spec: encrypted-publish, "Baseline check diagnoses before it rewrites").
 * When the node's `current/` is not the tree the last manifest recorded, the publisher lists the prefix folders
 * once (`files/ls -l`, which carries each child's CID) and compares them with the recorded blob CIDs. Only blobs
 * that are missing or differ are rewritten. Names shaped like this tool's own blobs (`xx/<52 base32>`) that are
 * not in the new manifest are removed; everything else is an anomaly and is reported and left alone. Nothing
 * outside `current/` is ever touched here.
 */

const BLOB_FILE = /^[a-z2-7]{52}$/;

/** The blobs on the node, keyed `xx/<name>` to CID, and the entries that are not blobs. */
export interface BlobListing {
  readonly blobs: ReadonlyMap<string, string>;
  readonly anomalies: readonly string[];
}

export interface Diagnosis {
  /** Vault paths whose recorded blob is missing or has another CID on the node. */
  readonly rewrite: readonly string[];
  /** `xx/<name>` of blob-shaped files that the new manifest does not list and that this publish may remove. */
  readonly strays: readonly string[];
  /**
   * `xx/<name>` of blob-shaped files the new manifest does not list but that are left alone because another device may
   * own them (see `DeviceGuard`). Empty when the guard allows removal. Also part of `anomalies`, so they are reported.
   */
  readonly held: readonly string[];
  /** Entries in `current/` that are not blob-shaped, and the `held` blobs: reported and left in place. */
  readonly anomalies: readonly string[];
}

/**
 * What the drift path knows about other publishers (spec: second-device-publish, "The drift path does not delete
 * another device's blobs"). Strays are removed only when no other device was ever seen and the node's latest
 * manifest names this device. Concurrent publishes remain detected only at a later pull: a device that has never seen
 * another device's manifest is not protected, and the first overlap can still make the other device's read-back fail
 * (that publish fails and is retried). No node-side marker exists.
 */
export interface DeviceGuard {
  /** The manifest `device` value this publish writes. */
  readonly device: string;
  /** The state's `devicesSeen` (this device's own value included). */
  readonly devicesSeen: readonly string[];
  /** The `device` of the node's latest authenticated manifest, or undefined when the node has none. */
  readonly nodeDevice: string | undefined;
}

/** May the blob-shaped names the new manifest does not list be removed? Only a lone publisher may remove them. */
export function mayRemoveStrays(guard: DeviceGuard): boolean {
  const otherKnown = guard.devicesSeen.some((seen) => seen !== guard.device);
  return !otherKnown && guard.nodeDevice === guard.device;
}

function classify(prefix: string, entry: MfsEntry, blobs: Map<string, string>, anomalies: string[]): void {
  const key = `${prefix}/${entry.name}`;
  if (entry.type === "file" && BLOB_FILE.test(entry.name) && entry.name.startsWith(prefix)) blobs.set(key, entry.cid);
  else anomalies.push(key);
}

/** One prefix folder. More than 2,000 entries (planted, since a vault spreads over 1,024 folders) is refused by name, before any write. */
async function listFolder(client: NodeReadClient, mfsRoot: string, folder: string): Promise<readonly MfsEntry[]> {
  try {
    return (await listIfPresent(client, `${mfsRoot}/current/${folder}`)) ?? [];
  } catch (error) {
    if (error instanceof KuboResponseTooLargeError) throw prefixFolderTooLarge(folder);
    throw error;
  }
}

/** List every prefix folder of `current/` (a bounded number in flight) and sort what is found into blobs and anomalies. */
export async function listCurrentBlobs(
  client: NodeReadClient,
  mfsRoot: string,
  folders: readonly MfsEntry[],
  concurrency?: number,
): Promise<BlobListing> {
  const blobs = new Map<string, string>();
  const anomalies: string[] = [];
  const outcome = await runPool(
    folders,
    async (folder) => ({ folder: folder.name, entries: await listFolder(client, mfsRoot, folder.name) }),
    concurrency,
  );
  const failure = outcome.failures[0];
  if (failure !== undefined) throw failure.error;
  for (const { value } of outcome.completed) for (const entry of value.entries) classify(value.folder, entry, blobs, anomalies);
  return { blobs, anomalies: anomalies.sort() };
}

const nodeKey = (blob: string): string => `${blob.slice(0, 2)}/${blob}`;

/**
 * Compare the node's blobs with the entries the new manifest keeps unchanged (`kept`, by vault path) and with the
 * node names it will contain (`manifestNames`, kept, carried and to-be-written alike: a carried entry's blob is named).
 * Without a `guard` every unnamed blob is a stray (the single-publisher flow); with one, `mayRemoveStrays` decides
 * whether they are strays or are held back and reported.
 */
export function diagnose(
  listing: BlobListing,
  kept: ReadonlyMap<string, EncryptedManifestFile>,
  manifestNames: ReadonlySet<string>,
  guard?: DeviceGuard,
): Diagnosis {
  const rewrite = [...kept]
    .filter(([, entry]) => listing.blobs.get(nodeKey(entry.blob)) !== entry.cid)
    .map(([path]) => path)
    .sort();
  const unnamed = [...listing.blobs.keys()].filter((key) => !manifestNames.has(key.slice(3))).sort();
  if (guard === undefined || mayRemoveStrays(guard)) return { rewrite, strays: unnamed, held: [], anomalies: listing.anomalies };
  return { rewrite, strays: [], held: unnamed, anomalies: [...listing.anomalies, ...unnamed].sort() };
}
