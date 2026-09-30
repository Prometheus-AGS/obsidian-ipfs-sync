import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";
import type { Baseline } from "./publish-plan";
import { authorizeRepair, type ConfirmRepair } from "./repair";
import type { RootState } from "./root-state";
import { classifySequence, refusalFor, type SequenceVerdict } from "./sequence-rules";

/**
 * Where a publish starts from: the manifest the node must be compared with, and the sequence the next manifest
 * carries. In step (`first-publish`, `in-sync`) the baseline is this device's own record. When the node disagrees
 * with it, only an explicit `--repair` under its conditions continues (see repair.ts):
 *
 *  - node BEHIND this device (an older genuine manifest was put back): this device's record stays the baseline;
 *  - node AHEAD, or this device's record missing or older (a restored backup): the node's authenticated manifest
 *    is the baseline and the local modification times are dropped, so every file is hashed again instead of being
 *    trusted against a record that describes another state.
 *
 * Either way the next sequence is the greater of the two plus one.
 */

export interface SequenceInput {
  readonly kv: Pick<HostKv, "delete">;
  readonly mfsRoot: string;
  readonly state: RootState | undefined;
  /** The node's `manifest.enc`, already authenticated; undefined when the node has none. */
  readonly node: EncryptedManifest | undefined;
  /** `manifest.enc` exists on the node but does not authenticate or is cut short. */
  readonly nodeUnreadable?: boolean;
  /** The highest sequence known from this device's state or an interrupted publish; undefined when it has neither. */
  readonly recordSequence?: number | undefined;
  readonly vaultId: string;
  readonly nodeKeySlots: Bytes | undefined;
  readonly localKeySlots: Bytes;
  readonly repair: boolean;
  readonly confirmRepair: ConfirmRepair | undefined;
}

export interface SequenceDecision {
  readonly baseline: Baseline | undefined;
  readonly nextSequence: number;
  /** True after a repair: the next manifest is published even if no file changed. */
  readonly repaired: boolean;
}

const ownBaseline = (state: RootState): Baseline => ({ manifest: state.manifest, mtimes: state.mtimes });

function verdictFor(input: SequenceInput): SequenceVerdict {
  if (input.nodeUnreadable === true) return { kind: "node-manifest-unreadable" };
  if (input.node === undefined && input.recordSequence !== undefined) return { kind: "node-manifest-missing" };
  return classifySequence(input.state, input.node);
}

export async function decideSequence(input: SequenceInput): Promise<SequenceDecision> {
  const { state } = input;
  const verdict = verdictFor(input);
  if (verdict.kind === "first-publish" || verdict.kind === "in-sync") {
    return { baseline: state === undefined ? undefined : ownBaseline(state), nextSequence: (state?.sequence ?? 0) + 1, repaired: false };
  }
  if (!input.repair) throw refusalFor(verdict);
  const plan = await authorizeRepair(
    input.kv,
    input.mfsRoot,
    { verdict, local: state, node: input.node, recordSequence: input.recordSequence, vaultId: input.vaultId, nodeKeyslots: input.nodeKeySlots, localKeyslots: input.localKeySlots },
    input.confirmRepair,
  );
  const baseline: Baseline | undefined =
    plan.kind === "ahead" && input.node !== undefined ? { manifest: input.node, mtimes: {} } : state === undefined ? undefined : ownBaseline(state);
  return { baseline, nextSequence: plan.nextSequence, repaired: true };
}
