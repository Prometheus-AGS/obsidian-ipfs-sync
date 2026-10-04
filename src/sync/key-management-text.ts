import { KDF_ITERATIONS_DEFAULT, KDF_MEMORY_DEFAULT_KIB, describeKdfCost, exceedsDefaultCost, type KdfParams } from "../crypto";
import type { MaintenanceRead } from "./maintenance-journal";
import type { SlotDowngrade } from "./slot-acceptance";

/**
 * The words of key management that a person must read before a rewrap is confirmed (mvp-07b spec key-management, "Old passphrases and
 * copies keep working"). One place, so the command line (`cli/keys-command.ts`) and the plugin dialogs say the same thing. Fixed text:
 * nothing here is taken from the node.
 */

export type RewrapKind = "change-passphrase" | "increase-cost";

/** The cost of the slot a rewrap replaces and of the one it writes. */
export interface RewrapCostPlan {
  /** The largest memory and iteration count over the slots an unlock tries (the cost no rewrap may fall below silently). */
  readonly current: KdfParams;
  readonly next: KdfParams;
  /** Memory or iterations are higher than the current slot's. */
  readonly raises: boolean;
  /** Memory or iterations are lower than the current slot's: needs an explicit confirmation that shows both costs. */
  readonly downgrade: boolean;
}

export const REVOCATION_STATEMENT =
  "This does not revoke anything. The old passphrase, and every old copy of the key-slot file, including the copies inside earlier pinned roots on the node and in any backup, still open this vault. Only re-encrypting the vault under a new vault key would revoke access, and this version does not do that.";

export const SAME_PASSPHRASE_STATEMENT =
  "The passphrase stays the same. Raising the cost protects only the new slot: it does not protect against an attacker who already holds the old slot at the old cost, because the old cheaper slot in earlier roots is unaffected and still opens the vault.";

export const PHONE_STATEMENT = "Slower devices, phones above all, unlock more slowly the higher the cost is, and a phone may not be able to unlock a cost this high.";

export const OTHER_DEVICES_STATEMENT =
  'Every other device keeps refusing to pull or publish until it accepts the changed key slots ("ipfs-sync keys accept-slots", with the new passphrase).';

const DEFAULT_COST = `${KDF_MEMORY_DEFAULT_KIB / 1024} MiB, ${KDF_ITERATIONS_DEFAULT} iterations`;

/** Said only when the new slot costs more than the default: the devices that cannot answer a cost question refuse to unlock. */
export function highCostStatement(next: KdfParams): string {
  return (
    `A cost of ${describeKdfCost(next)} is above the default (${DEFAULT_COST}). A run that cannot ask you to approve it refuses to unlock this vault: ` +
    "a command-line run without a terminal, and the plugin's auto-publish timer and catch-up pull, which never ask. The plugin's manual actions (pull, Resolve fork, Restore, a manual publish through the unlock dialog, and the key actions) show an approval dialog. " +
    "A run that cannot ask needs a terminal or a manual plugin action to unlock it."
  );
}

export function derivationsStatement(next: KdfParams): string {
  return (
    `This takes four key derivations on this device, each needing about ${next.m / 1024} MiB of memory: the current passphrase twice ` +
    "(once to open the vault, once inside the rewrap, because the vault key cannot be read back out of it), then the new slot, then a test unlock of the new slot after it is published."
  );
}

export function costLine(plan: RewrapCostPlan): string {
  return `cost of the new slot: ${describeKdfCost(plan.next)} (the current slot: ${describeKdfCost(plan.current)})`;
}

/** The question asked before a rewrap goes to a cost below the current one. Shows both costs. */
export function downgradeQuestion(plan: RewrapCostPlan): string {
  return `The new cost (${describeKdfCost(plan.next)}) is lower than the current cost (${describeKdfCost(plan.current)}). A lower cost makes the new slot cheaper to attack by guessing. Continue with the lower cost?`;
}

/** Everything that is printed before the confirmation works, in order. */
export function rewrapStatements(kind: RewrapKind, plan: RewrapCostPlan): readonly string[] {
  const lines = [
    kind === "change-passphrase"
      ? "Change passphrase: a new passphrase is generated and a new key slot wraps the same vault key. The vault content is not re-encrypted."
      : "Increase cost: a new key slot with a higher key-derivation cost wraps the same vault key, under the same passphrase. The vault content is not re-encrypted.",
    costLine(plan),
    derivationsStatement(plan.next),
    PHONE_STATEMENT,
    REVOCATION_STATEMENT,
  ];
  if (kind === "increase-cost") lines.push(SAME_PASSPHRASE_STATEMENT);
  if (exceedsDefaultCost(plan.next)) lines.push(highCostStatement(plan.next));
  lines.push(OTHER_DEVICES_STATEMENT);
  return lines;
}

/* ---------- accept-slots and discard (mvp-07b task 1.5) ---------- */

/** What a command-line accept cannot prove. Said before the passphrase is used, and again by the docs: a cold run holds no vault key to compare with. */
export const ACCEPT_RESIDUAL_STATEMENT =
  "What this check does not prove: that the manifest authenticates under the key these slots unlock shows that the two files belong together, " +
  "not that the key is this vault's original one. A node that also knows the passphrase you type could serve key slots and a manifest under its own key " +
  "with this vault's id, and a command-line run holds no key to compare them with (a plugin session that already holds the vault's key refuses that). " +
  "The sequence check and the cost comparison are the other defences; freshness is not proven either, because any genuine slot file of the vault passes.";

export const ACCEPT_NO_FLOOR_STATEMENT =
  "Accepting replaces only this device's key-slot copy and its recorded hash. It pulls no file and does not raise the sequence floor; run pull afterwards.";

export const ACCEPT_ONE_ROOT_STATEMENT =
  "Both files are read from one root of the node (the name is resolved once, or the root you name). The key slots must unlock with the passphrase you give, " +
  "manifest.enc of that same root must authenticate under the key they unlock and name the same vault, and its sequence must pass the same rollback checks as a pull.";

export const ACCEPT_DROPS_PENDING_STATEMENT =
  "A key-management operation left unfinished on this device (a rewrap or a prune) is dropped by this action, and a key-slot file this device wrote into the shared tree on the node is taken back out. " +
  "To finish such an operation instead, run the same keys command again.";

export const ACCEPT_RESTORE_STATEMENT =
  "You named an explicit root. If it holds older key slots than the node's current ones, this device's copy will match that older root and not the node's current file: " +
  "publish and a pull by name stay refused until you accept the current key slots again (keys accept-slots without --root-cid).";

/** Everything printed before the passphrase is used, in order. `root-cid` adds the statement about the older root. */
export function acceptStatements(target: "name" | "root-cid"): readonly string[] {
  return [
    "Accept key slots: this device's key-slot copy is replaced by the key-slot file of one root on the node, after the checks below.",
    ACCEPT_ONE_ROOT_STATEMENT,
    ACCEPT_RESIDUAL_STATEMENT,
    ACCEPT_NO_FLOOR_STATEMENT,
    ACCEPT_DROPS_PENDING_STATEMENT,
    ...(target === "root-cid" ? [ACCEPT_RESTORE_STATEMENT] : []),
  ];
}

/** The question asked before a cheaper slot replaces the copy. Shows both costs. */
export function acceptDowngradeQuestion(downgrade: SlotDowngrade): string {
  return (
    `The incoming key slot (${describeKdfCost(downgrade.incoming)}) is cheaper to attack by guessing than this device's copy (${describeKdfCost(downgrade.current)}). ` +
    "Replace the copy with it?"
  );
}

/** The cost of the slots an accept will derive, for the cost question of a slot above the default. */
export function acceptCostQuestion(costs: readonly KdfParams[]): string {
  return `The key slots on the node cost ${costs.map(describeKdfCost).join(" and ")} to unlock, above the default. Continue?`;
}

export const DISCARD_QUESTION = "Discard the unfinished operation on this device?";

/** What dropping the pending key-management journal costs, by kind and phase. Printed before the confirmation works. */
export function discardStatements(read: MaintenanceRead): readonly string[] {
  if (read.kind === "none") return ["There is nothing to discard: no key-management operation is pending on this device."];
  if (read.kind === "damaged") {
    return [
      "A key-management journal on this device cannot be read, so it cannot be known what the operation did. Discarding removes the file only: nothing on the node can be taken back.",
      "If publish then refuses because the node's key-slot file differs from this device's copy, the shared tree on the node may still hold a key-slot file this device wrote.",
    ];
  }
  const { journal } = read;
  if (journal.type === "prune") {
    return [
      "A history prune did not finish on this device. Discarding it forgets the record only: the history files it already removed from the shared tree stay removed there, and the next publish from any device publishes without them. Earlier pinned roots still hold them.",
    ];
  }
  if (journal.phase === "published" || journal.phase === "local-updated") {
    return [
      `A key-slot rewrap reached the "${journal.phase}" phase: the node's name already serves its new key-slot file. Discarding forgets that on this device and writes nothing to the node.`,
      "The old passphrase no longer opens the node's current key-slot file, only the NEW passphrase does (the old one still opens the files in earlier roots). This device's copy is still the old one, so it keeps refusing until you run keys accept-slots with the NEW passphrase.",
      "Do not discard if you did not save the new passphrase.",
    ];
  }
  return [
    `A key-slot rewrap did not finish on this device (it had reached "${journal.phase}") and was not published, so the new passphrase it would have used never took effect and the old one is unchanged.`,
    "If this device wrote its new key-slot file into the shared tree on the node and that file is still there, the file the name serves is written back in its place; the published root itself is not changed.",
  ];
}
