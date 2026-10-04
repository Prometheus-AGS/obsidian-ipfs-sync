// The phase plan: which phase records which required assertion and which task builds it. Every phase is built (tasks 4.6, 4.7a, 4.7b); a phase that
// does not run, or a scenario that is not selected, records its assertions as failed, never as passed.
import { REQUIRED_ASSERTIONS, Refusal } from "./constants.mjs";

/**
 * Groups: harness (4.6, always run), observed (steps seen in Obsidian, 4.7a, run only with --phases all), script-only (CLI phases, 4.7b).
 * The ids are this script's own list of what it records; assertPlanMatches compares it with the checker's REQUIRED_ASSERTIONS and the
 * kinds come from the checker (never declared here).
 */
export const PHASE_PLAN = Object.freeze(
  [
    { phase: "harness-install", task: "4.6", group: "harness", assertions: ["installed-files-hashed"] },
    { phase: "harness-node-audit", task: "4.6", group: "harness", assertions: ["only-demo-root-and-owned-key-changed"] },
    {
      phase: "obsidian-observed-steps",
      task: "4.7a",
      group: "observed",
      assertions: ["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "first-pull-confirm-shown", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"],
    },
    { phase: "hostile-preparer", task: "4.7b", group: "script-only", assertions: ["tamper-refused-nothing-written"] },
    {
      phase: "script-only-cli-phases",
      task: "4.7b",
      group: "script-only",
      assertions: ["older-root-by-name-refused", "restore-older-version", "fork-resolved", "rewrap-and-accept", "increase-cost", "prune-history", "mass-removal-stopped"],
    },
  ].map((phase) => Object.freeze({ ...phase, assertions: Object.freeze(phase.assertions) })),
);

/** Throws when the plan's ids are not exactly the required ids, each once. */
export function assertPlanMatches(plan, required) {
  const planned = plan.flatMap((phase) => phase.assertions);
  const wanted = required.map(({ id }) => id);
  const missing = wanted.filter((id) => !planned.includes(id));
  const extra = planned.filter((id) => !wanted.includes(id));
  const repeated = planned.filter((id, index) => planned.indexOf(id) !== index);
  if (missing.length + extra.length + repeated.length > 0) {
    throw new Refusal(`the phase plan differs from the checker's REQUIRED_ASSERTIONS (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}; repeated: ${repeated.join(", ") || "none"})`);
  }
}

export const assertPlanMatchesChecker = () => assertPlanMatches(PHASE_PLAN, REQUIRED_ASSERTIONS);

/** The list this script exports and records: the plan's ids with the checker's kinds, in the checker's order. */
export function exportedAssertionList() {
  assertPlanMatchesChecker();
  const planned = new Set(PHASE_PLAN.flatMap((phase) => phase.assertions));
  return REQUIRED_ASSERTIONS.filter(({ id }) => planned.has(id)).map(({ id, kind }) => ({ id, kind }));
}

/** What a run evaluates and what it records as not run. Observed steps need Obsidian and an operator, so --phases script-only skips them. */
export function scopeFor({ phases }) {
  const skipObserved = phases === "script-only";
  const inScope = (phase) => !(skipObserved && phase.group === "observed");
  const run = PHASE_PLAN.filter(inScope).flatMap((phase) => phase.assertions);
  const notRun = PHASE_PLAN.filter((phase) => !inScope(phase)).flatMap((phase) => phase.assertions.map((id) => ({ id, reason: `${phase.phase} (task ${phase.task}) needs Obsidian and an operator; --phases script-only does not run it` })));
  return { run, notRun };
}
