import type { DroppedEntry } from "./publish-plan";

/**
 * The mass-removal guard's arithmetic (mvp-07b design decision 6). Pure: it takes the facts of a planned publish and says
 * whether the removals are too many to run unconfirmed. The engine acts on the answer.
 *
 * Removals caused by the exclusion list (baseline paths that the effective exclusion list now matches, for example the
 * `.obsidian/*` entries of an older build on the first publish after the exclusion change) are listed apart and count in
 * neither the numerator nor the denominator. Carried entries that stay are ordinary entries of the baseline and are
 * therefore kept entries in the denominator.
 *
 * Stated limits (W-15, W-14): removing 49 percent of the entries is silent, and the publisher does not detect silent
 * per-file corruption of unchanged files by someone with write access to the node.
 */

/** Fewer entries than this cannot exceed half: the only stop is removing every entry. */
const HALF_RULE_MIN_ENTRIES = 2;

export interface RemovalFacts {
  /** Every path of the baseline manifest, carried entries included. Empty when there is no baseline (first publish). */
  readonly before: readonly string[];
  /** Baseline paths that are gone from the vault or now excluded (carried entries are not among them). */
  readonly removed: readonly string[];
  /** Carried entries that leave the manifest (excluded here, or an unsafe path shape). */
  readonly dropped: readonly DroppedEntry[];
  /** The effective exclusion matcher of this run. */
  readonly excluded: (path: string) => boolean;
}

export interface RemovalAssessment {
  /** Removals caused by the exclusion list, sorted: reported, never counted. */
  readonly exclusionDriven: readonly string[];
  /** The removals that count (the numerator), sorted. */
  readonly others: readonly string[];
  /** Entries before the publish without the exclusion-driven group and without dropped unsafe entries (the denominator). */
  readonly remaining: number;
  /** True when the others equal every remaining entry, or exceed half of at least two. */
  readonly stop: boolean;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function assessRemovals(facts: RemovalFacts): RemovalAssessment {
  const exclusionDriven = [...facts.removed.filter((path) => facts.excluded(path)), ...facts.dropped.map((entry) => entry.path).filter((path) => facts.excluded(path))].sort(byPath);
  // A dropped carried entry that the exclusion list does not match left for its unsafe shape: no honest publisher wrote it, so it is neither a removal nor an entry.
  const unsafe = new Set(facts.dropped.map((entry) => entry.path).filter((path) => !facts.excluded(path)));
  const excludedSet = new Set(exclusionDriven);
  const others = facts.removed.filter((path) => !excludedSet.has(path)).sort(byPath);
  const remaining = facts.before.filter((path) => !excludedSet.has(path) && !unsafe.has(path)).length;
  const everything = remaining > 0 && others.length === remaining;
  const overHalf = remaining >= HALF_RULE_MIN_ENTRIES && others.length * 2 > remaining;
  return { exclusionDriven, others, remaining, stop: everything || overHalf };
}
