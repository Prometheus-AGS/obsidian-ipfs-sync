import { parseHistoryName } from "./history-names";
import { HISTORY_KEEP_FLOOR, type PrunePlan } from "./prune-history";

/**
 * The words of `prune-history` that a person must read before a removal is confirmed. One place, so the command line (`cli/prune-command.ts`) and a plugin
 * action say the same thing. Fixed text built from counts and sequences: nothing here is a name or any other text the node chose.
 */

export const PRUNE_QUESTION = "Remove these history files from the node's working tree?";

export const PRUNE_KEEPS_STATEMENT =
  "manifest.enc, keyslots.json, current/ and the sequence are not touched. Earlier published roots stay pinned and fetchable with their history as it was; only the working tree changes.";

export const PRUNE_RESTORE_STATEMENT =
  'A removed version can no longer be restored through the current root with "pull --manifest"; restore it from an earlier root with "pull --root-cid".';

/** The lowest and highest sequence among the prefixed names of the removal set, or undefined when it holds none. */
function removedRange(removals: readonly string[]): { readonly lowest: number; readonly highest: number } | undefined {
  const sequences = removals.flatMap((name) => {
    const sequence = parseHistoryName(name)?.sequence;
    return sequence === undefined ? [] : [sequence];
  });
  if (sequences.length === 0) return undefined;
  return { lowest: Math.min(...sequences), highest: Math.max(...sequences) };
}

export interface PruneStatementInput {
  readonly plan: PrunePlan;
  /** History files that were decrypted and checked before this is shown. */
  readonly checked: number;
  /** The sequence of the node's manifest (the newest history file carries it). */
  readonly sequence: number;
}

/** The sentence for a plan that removes nothing. */
export function nothingToPrune(plan: PrunePlan): string {
  return (
    `Nothing to prune: manifests/ holds ${plan.total} history file${plan.total === 1 ? "" : "s"} and at least ${Math.max(plan.keepEffective, HISTORY_KEEP_FLOOR)} are kept` +
    `${plan.floorApplied ? ` (--keep ${plan.keepRequested} was raised to ${HISTORY_KEEP_FLOOR})` : ""}. Nothing was changed.`
  );
}

/** Everything printed before the confirmation works, in order. Only for a plan that removes something. */
export function pruneStatements(input: PruneStatementInput): readonly string[] {
  const { plan } = input;
  const lines = [`Prune history: ${plan.removals.length} of the ${plan.total} history files in manifests/ on the node would be removed from its working tree; ${plan.kept.length} stay.`];
  if (plan.floorApplied) lines.push(`--keep ${plan.keepRequested} was raised to ${HISTORY_KEEP_FLOOR}: at least the newest ${HISTORY_KEEP_FLOOR} history files are always kept.`);
  const range = removedRange(plan.removals);
  if (range !== undefined) lines.push(`The sequence-prefixed files to remove are sequence ${range.lowest} to ${range.highest}.`);
  if (plan.legacyTotal > 0) {
    lines.push(
      `${plan.legacyTotal} of the files use the older name format without a sequence (${plan.legacyRemoved} would be removed, ${plan.legacyKept} stay). Their order is unknown, ` +
        "so they count as the oldest, and the ones that stay are chosen by name, an arbitrary order.",
    );
  }
  if (plan.duplicateFiles > 0) {
    lines.push(`${plan.duplicateFiles} file${plan.duplicateFiles === 1 ? " shares" : "s share"} a sequence with another file (a fork leaves such files); every file counts as one.`);
  }
  lines.push(
    `Checked before this question: the newest ${input.checked} history files decrypt under this vault's key (derived from the passphrase you gave) and each agrees with its name; ` +
      `the newest is sequence ${input.sequence}, the sequence of the node's manifest.`,
  );
  lines.push(PRUNE_KEEPS_STATEMENT, PRUNE_RESTORE_STATEMENT);
  return lines;
}
