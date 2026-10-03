import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";

/**
 * One reading of the publication name (`name/resolve` with `nocache` and a bounded `dht-timeout`), already classified.
 * `root` is the CID the name points at (the `/ipfs/` prefix removed). `failed` carries whether the node reported a
 * routing timeout (`timedOut`) or anything else it could not answer.
 */
export type NameReading =
  | { readonly kind: "value"; readonly root: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly timedOut: boolean };

/**
 * What the publication name pointed at when a publish started: a CID, or `null` for "no record". `firstPublish` is
 * true when the vault has no manifest on the node and no local state (a routing timeout then counts as not found).
 */
export interface NameStart {
  readonly root: string | null;
  readonly firstPublish: boolean;
}

/** The sequence floor the commit protocol raises just before it writes the local state (floor first, then state). */
export interface FloorPort {
  raise(vaultId: string, sequence: number, identity: string): Promise<void>;
}

/**
 * What the commit and resume steps need from the outside. The node port is narrow on purpose: it names the few
 * objects the protocol touches, and the adapter over the shared kubo client (encrypted-transfer) is responsible
 * for bounding every read (stat before read, size caps) and for keeping every write inside the MFS root.
 */
export interface CommitNode {
  /**
   * Resolve the publication name now. `undefined` when the key's ID is not known yet (the key does not exist), so there is
   * no name to read. A read, never a write.
   */
  resolveName(): Promise<NameReading | undefined>;
  /** CID of `<mfsRoot>/current`, or undefined when it does not exist. */
  currentCid(): Promise<string | undefined>;
  /** Bytes of `<mfsRoot>/manifest.enc`, or undefined when absent. Larger than the manifest cap is an error, not a truncation. */
  readManifestFile(): Promise<Bytes | undefined>;
  /**
   * Bytes of `manifest.enc` inside the immutable root `rootCid` (read through `/ipfs/<rootCid>/manifest.enc`), or undefined when that
   * root has none or is not a CID this port will read. Used only to learn what the root a failed name re-check resolved holds.
   */
  readManifestFileAt(rootCid: string): Promise<Bytes | undefined>;
  writeManifestFile(bytes: Bytes): Promise<void>;
  /** Bytes of `<mfsRoot>/manifests/<16-digit sequence>-<rootCid>.enc`, or undefined when absent. Legacy unprefixed names are not addressed here. */
  readHistoryFile(sequence: number, rootCid: string): Promise<Bytes | undefined>;
  writeHistoryFile(sequence: number, rootCid: string, bytes: Bytes): Promise<void>;
  /** CID of `<mfsRoot>` right now (the value that would be pinned and published). */
  rootCid(): Promise<string>;
  /** `pin/add` of exactly this CID string. */
  pinRoot(rootCid: string): Promise<void>;
  /**
   * `name/publish` of exactly this CID string under the publication key. With `start`, the name is read again right
   * before the publication (after the key check) and the publication is refused when it moved since the publish
   * started: see `name-recheck.ts`. A key created by this run is not read.
   */
  publishRoot(rootCid: string, start?: NameStart): Promise<void>;
}

/** What the snapshot must look like when it is read back through its immutable root. */
export interface SnapshotExpectation {
  readonly manifest: EncryptedManifest;
  /** The exact `manifest.enc` bytes that were written; the history file must equal them. */
  readonly manifestFile: Bytes;
}

export interface CommitDeps {
  readonly node: CommitNode;
  readonly kv: Pick<HostKv, "get" | "set" | "delete">;
  /** Authenticate and decode `manifest.enc` under the unlocked vault keys. Throws when it does not authenticate. */
  readonly decodeManifest: (bytes: Bytes) => Promise<EncryptedManifest>;
  /** Encrypt a manifest as `manifest.enc` under the unlocked vault keys (a fresh file every call). */
  readonly encodeManifest: (manifest: EncryptedManifest) => Promise<Bytes>;
  /**
   * Read the snapshot back through the immutable root and throw `ReadBackError` on any mismatch (the root's
   * entries, `manifests/` names, `manifest.enc`, the key-slot file, the CID of `current`, the history bytes, and
   * for a publish that wrote blobs, the CIDs of those blobs). Any other error is a failure to read, not a verdict.
   */
  readonly verifySnapshot: (rootCid: string, expected: SnapshotExpectation) => Promise<void>;
  readonly now: () => number;
  /**
   * The device-local sequence floor. `finishPublish` raises it immediately before it writes the state, for a fresh and for a
   * resumed publish alike; `adopt` never does. Absent when the host keeps no floor.
   */
  readonly floor?: FloorPort;
}

/** The identity of the publish target, checked against the journal and the local state. */
export interface PublishTarget {
  readonly mfsRoot: string;
  /** The publication key to pin and publish under (an owned key, checked by the caller). */
  readonly key: string;
  readonly vaultId: string;
  /** sha256 of the local key-slot copy in force. */
  readonly keyslotsSha256: string;
}
