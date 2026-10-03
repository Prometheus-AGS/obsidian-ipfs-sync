import type { EncryptedManifest } from "./encrypted-manifest";
import { belowSequenceFloor, nodeManifestMissing, nodeManifestUnreadable, sequenceAhead, sequenceBehind, sequenceFork, type PublishRefusedError } from "./publish-refusals";
import type { RootState } from "./root-state";
import type { FloorEntry } from "./sequence-floor";

/**
 * The sequence rules of a publish: the node's authenticated manifest against this device's record. Only equal
 * sequences with the same snapshot proceed. Everything else is a named refusal; `--repair` (see repair.ts) can
 * lift behind, ahead and a missing or unreadable `manifest.enc` under its conditions, and never a fork.
 */

export type SequenceVerdict =
  /** No record here and nothing on the node: the first publish to this root. */
  | { readonly kind: "first-publish" }
  | { readonly kind: "in-sync" }
  /** The node serves an older manifest than this device published. */
  | { readonly kind: "behind"; readonly node: number; readonly local: number }
  /** The node is ahead of this device's record, or this device has no record. */
  | { readonly kind: "ahead"; readonly node: number; readonly local: number | undefined }
  /** Same sequence, different snapshot: another publisher wrote there. */
  | { readonly kind: "fork"; readonly sequence: number }
  /** This device published here, and the node no longer has a manifest. */
  | { readonly kind: "node-manifest-missing" }
  /** The node has a `manifest.enc` that does not authenticate or is cut short. */
  | { readonly kind: "node-manifest-unreadable" };

export function classifySequence(local: RootState | undefined, node: EncryptedManifest | undefined): SequenceVerdict {
  if (node === undefined) return local === undefined ? { kind: "first-publish" } : { kind: "node-manifest-missing" };
  if (local === undefined) return { kind: "ahead", node: node.sequence, local: undefined };
  if (node.sequence < local.sequence) return { kind: "behind", node: node.sequence, local: local.sequence };
  if (node.sequence > local.sequence) return { kind: "ahead", node: node.sequence, local: local.sequence };
  return node.rootCID === local.manifest.rootCID ? { kind: "in-sync" } : { kind: "fork", sequence: node.sequence };
}

/** The verdicts that stop a publish unless `--repair` applies. */
export type RefusingVerdict = Exclude<SequenceVerdict, { readonly kind: "first-publish" | "in-sync" }>;

export function refusalFor(verdict: RefusingVerdict): PublishRefusedError {
  switch (verdict.kind) {
    case "behind":
      return sequenceBehind(verdict.node, verdict.local);
    case "ahead":
      return sequenceAhead(verdict.node, verdict.local);
    case "fork":
      return sequenceFork(verdict.sequence);
    case "node-manifest-missing":
      return nodeManifestMissing();
    case "node-manifest-unreadable":
      return nodeManifestUnreadable();
  }
}

/**
 * A publish starts from this device's own record. If the device has accepted a higher sequence of the vault (its sequence floor) than
 * that record holds, or has no record at all, publishing from here would go out below the floor and every device that holds the floor
 * would refuse it (review-final A-02: a wiped device state, a node that shows no `manifest.enc`, or a pull that raised the floor and
 * stopped before its state). Throws `sequence-below-floor`, which says to pull first. A host that keeps no floor passes `undefined`.
 */
export function assertNotBelowFloor(floor: FloorEntry | undefined, state: RootState | undefined): void {
  if (floor !== undefined && (state === undefined || state.sequence < floor.sequence)) throw belowSequenceFloor(floor.sequence, state?.sequence);
}

/** Throw the refusal for a verdict that does not allow a publish; return for `first-publish` and `in-sync`. */
export function assertSequenceAllowsPublish(verdict: SequenceVerdict): void {
  if (verdict.kind !== "first-publish" && verdict.kind !== "in-sync") throw refusalFor(verdict);
}
