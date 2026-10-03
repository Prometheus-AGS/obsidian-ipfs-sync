import type { Bytes, HostKv } from "../core/host-bridge";
import type { EncryptedManifest } from "./encrypted-manifest";
import { deleteJournal } from "./journal";
import { repairAheadRefused, repairDeclined, repairRefused } from "./publish-refusals";
import type { RootState } from "./root-state";
import { sameBytes } from "./same-bytes";
import type { FloorEntry } from "./sequence-floor";
import { assertNotBelowFloor, type SequenceVerdict } from "./sequence-rules";

/**
 * The explicit `--repair` action for a state refusal. It is allowed only when the node's manifest authenticates,
 * belongs to the same vault, and the node's key-slot file equals this device's copy byte for byte, and either
 * the node is behind this device (an older genuine manifest was put back) or this device's record is missing or
 * older than the node (for example a restored backup). It then publishes at the greater of the two sequences
 * plus one (and never at or below the sequence floor), through the normal drift path. The ahead case discards other publishers' changes, so it warns and
 * asks. Without these conditions the only recovery is the abandon action and a new MFS root.
 *
 * A node whose `manifest.enc` is absent or does not authenticate (for example a write that was cut short) has no
 * sequence to compare: the repair is allowed when this device has a record of publishing there (a local state or an
 * interrupted publish) and the node's key-slot file equals this device's copy; it always asks, then writes a new
 * manifest.enc at this device's sequence plus one.
 *
 * The ahead case is narrower than it was: a device that catches up does so by pulling. `--repair` refuses it when a
 * sequence floor exists for the vault (this device accepted a manifest of it before, whatever happened to its state
 * folder), when the local state decodes for the vault, and for a device with no state and no floor (a new device). It
 * stays available only for a state file that exists and does not decode, with no floor, behind its confirmation.
 */

export interface RepairFacts {
  readonly verdict: SequenceVerdict;
  readonly local: RootState | undefined;
  /** The node's manifest, already authenticated by the caller. Undefined when it could not be authenticated or is absent. */
  readonly node: EncryptedManifest | undefined;
  /** The highest sequence this device knows it published to this root (local state, or an interrupted publish); undefined when it has no record. */
  readonly recordSequence?: number | undefined;
  /** The vault the caller unlocked. */
  readonly vaultId: string;
  readonly nodeKeyslots: Bytes | undefined;
  readonly localKeyslots: Bytes | undefined;
  /** The sequence floor kept for `vaultId` in the device-local store, when there is one. */
  readonly floor?: FloorEntry | undefined;
  /** A state file exists for this root and does not decode (so `local` is undefined). */
  readonly stateUndecodable?: boolean | undefined;
}

export interface RepairPlan {
  readonly kind: "behind" | "ahead" | "rebuild";
  /** The sequence the next manifest carries. */
  readonly nextSequence: number;
  /** Set for the ahead case: what will be lost. The caller must get a yes before continuing. */
  readonly warning: string | undefined;
}

/** Ask the user; true means go on. */
export type ConfirmRepair = (warning: string) => Promise<boolean>;

function aheadWarning(node: number, local: number | undefined, next: number): string {
  const seen = local === undefined ? "this device has no record of a publish to this root" : `this device's record is at sequence ${local}`;
  return (
    `The node's manifest is at sequence ${node} and ${seen}. Repairing publishes this vault at sequence ${next}. ` +
    "Changes made by any other publisher since then will be discarded. Pulling first is the safer route: cancel, run pull, then publish."
  );
}

/** The ahead case under `--repair`: only an undecodable state with no floor may continue (to the confirmation). */
function assertAheadRepairable(facts: RepairFacts): void {
  if (facts.floor !== undefined) {
    throw repairAheadRefused(`this device already accepted sequence ${facts.floor.sequence} of this vault (its sequence floor), so the node being ahead means another device published`);
  }
  if (facts.local !== undefined) throw repairAheadRefused("this device has a usable record of this vault, so the node being ahead means another device published");
  if (facts.stateUndecodable !== true) throw repairAheadRefused("this device has no record of this vault yet (a new device)");
}

function rebuildWarning(next: number): string {
  return (
    `The node's manifest.enc is missing or does not authenticate. Repairing writes a new manifest.enc at sequence ${next} from this device's files; ` +
    "whatever the node held there cannot be recovered."
  );
}

/** Decide whether a repair is allowed and what it would do. Pure; throws `repair-refused` with the reason. */
export function planRepair(facts: RepairFacts): RepairPlan {
  const { verdict, local, node } = facts;
  const rebuild = verdict.kind === "node-manifest-missing" || verdict.kind === "node-manifest-unreadable";
  if (!rebuild && verdict.kind !== "behind" && verdict.kind !== "ahead") {
    throw repairRefused(verdict.kind === "fork" ? "another publisher wrote a different manifest at the same sequence" : "the sequences do not need repairing");
  }
  if (!rebuild && node === undefined) throw repairRefused("the node's manifest is missing or does not authenticate");
  if (rebuild && facts.recordSequence === undefined) throw repairRefused("this device has no record of publishing to this root (no local state and no interrupted publish)");
  if (node !== undefined && node.vaultId !== facts.vaultId) throw repairRefused("the node's manifest belongs to another vault");
  if (local !== undefined && local.vaultId !== facts.vaultId) throw repairRefused("this device's record belongs to another vault");
  if (verdict.kind === "ahead") assertAheadRepairable(facts);
  // A rebuild starts from this device's own record: with none, or one below the floor, it would write below what the device already accepted.
  if (rebuild) assertNotBelowFloor(facts.floor, local);
  if (facts.localKeyslots === undefined) throw repairRefused("this device has no copy of the key-slot file to compare");
  if (facts.nodeKeyslots === undefined || !sameBytes(facts.nodeKeyslots, facts.localKeyslots)) {
    throw repairRefused("the node's key-slot file differs from this device's copy");
  }
  // The floor is a sequence this device accepted, possibly in another directory or through a pull that did not finish: never publish at or below it.
  const nextSequence = Math.max(local?.sequence ?? 0, node?.sequence ?? 0, facts.recordSequence ?? 0, facts.floor?.sequence ?? 0) + 1;
  if (rebuild) return { kind: "rebuild", nextSequence, warning: rebuildWarning(nextSequence) };
  return {
    kind: verdict.kind as "behind" | "ahead",
    nextSequence,
    warning: verdict.kind === "ahead" ? aheadWarning(node?.sequence ?? 0, local?.sequence, nextSequence) : undefined,
  };
}

/**
 * Plan the repair, get the confirmation the ahead case needs, and drop any journal (the repair supersedes an
 * interrupted publish; the drift path reconciles whatever it left on the node). A run that cannot ask
 * (`confirm` undefined) is refused for the ahead case rather than assumed to agree.
 */
export async function authorizeRepair(
  kv: Pick<HostKv, "delete">,
  mfsRoot: string,
  facts: RepairFacts,
  confirm: ConfirmRepair | undefined,
): Promise<RepairPlan> {
  const plan = planRepair(facts);
  if (plan.warning !== undefined) {
    if (confirm === undefined) throw repairRefused("it needs a confirmation and this run cannot ask for one");
    if (!(await confirm(plan.warning))) throw repairDeclined();
  }
  await deleteJournal(kv, mfsRoot);
  return plan;
}
