import type { Bytes } from "../core/host-bridge";
import type { CommitNode } from "./commit-ports";
import type { EncryptedManifest } from "./encrypted-manifest";
import { isUnreadableManifest } from "./manifest-auth";
import { nodeManifestUnreadable, noVault } from "./publish-refusals";
import type { RootState } from "./root-state";
import { assertNotBelowFloor, classifySequence, refusalFor } from "./sequence-rules";
import type { FloorEntry } from "./sequence-floor";

/**
 * The up-to-date and floor check of the operations that rewrite the node's shared tree without publishing a manifest (a key-slot rewrap,
 * a history prune). One helper for both, so they cannot drift apart (07b task 1.3).
 *
 * The device is up to date when the node's authenticated `manifest.enc` is the one its record holds (`classifySequence` says
 * `in-sync`: same sequence, same snapshot). `complete` is not required: these operations read no local vault file. The sequence floor
 * term is required: a record equal to the node's but below the floor is a rolled-back node (review-final A-02), which a rewrap or a
 * prune would republish; `assertNotBelowFloor` refuses that. The refusals are the publisher's own (`refusalFor`), so the words match.
 */

export interface UpToDateInput {
  readonly node: Pick<CommitNode, "readManifestFile">;
  /** Authenticate and decode `manifest.enc` under the unlocked vault keys; throws when it does not authenticate. */
  readonly decodeManifest: (bytes: Bytes) => Promise<EncryptedManifest>;
  /** This device's record of the root; undefined before the first publish or pull. */
  readonly state: RootState | undefined;
  /** The device's sequence floor for the vault; undefined when the host keeps none. */
  readonly floor: FloorEntry | undefined;
}

export interface UpToDate {
  readonly manifest: EncryptedManifest;
  /** The exact bytes of the node's `manifest.enc` that were checked (kept for the re-read that follows the name start). */
  readonly manifestFile: Bytes;
  readonly state: RootState;
}

export async function assertUpToDate(input: UpToDateInput): Promise<UpToDate> {
  assertNotBelowFloor(input.floor, input.state);
  const raw = await input.node.readManifestFile();
  let manifest: EncryptedManifest | undefined;
  if (raw !== undefined) {
    try {
      manifest = await input.decodeManifest(raw);
    } catch (error) {
      if (isUnreadableManifest(error)) throw nodeManifestUnreadable();
      throw error;
    }
  }
  const verdict = classifySequence(input.state, manifest);
  // Nothing published here and nothing recorded: there is no vault to change.
  if (verdict.kind === "first-publish") throw noVault();
  if (verdict.kind !== "in-sync") throw refusalFor(verdict);
  return { manifest: manifest as EncryptedManifest, manifestFile: raw as Bytes, state: input.state as RootState };
}
