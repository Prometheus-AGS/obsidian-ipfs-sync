import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";

/**
 * What the commit and resume steps need from the outside. The node port is narrow on purpose: it names the few
 * objects the protocol touches, and the adapter over the shared kubo client (encrypted-transfer) is responsible
 * for bounding every read (stat before read, size caps) and for keeping every write inside the MFS root.
 */
export interface CommitNode {
  /** CID of `<mfsRoot>/current`, or undefined when it does not exist. */
  currentCid(): Promise<string | undefined>;
  /** Bytes of `<mfsRoot>/manifest.enc`, or undefined when absent. Larger than the manifest cap is an error, not a truncation. */
  readManifestFile(): Promise<Bytes | undefined>;
  writeManifestFile(bytes: Bytes): Promise<void>;
  /** Bytes of `<mfsRoot>/manifests/<rootCid>.enc`, or undefined when absent. */
  readHistoryFile(rootCid: string): Promise<Bytes | undefined>;
  writeHistoryFile(rootCid: string, bytes: Bytes): Promise<void>;
  /** CID of `<mfsRoot>` right now (the value that would be pinned and published). */
  rootCid(): Promise<string>;
  /** `pin/add` of exactly this CID string. */
  pinRoot(rootCid: string): Promise<void>;
  /** `name/publish` of exactly this CID string under the publication key. */
  publishRoot(rootCid: string): Promise<void>;
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
