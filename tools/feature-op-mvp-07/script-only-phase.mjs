// Phase script-only-cli-phases (tasks 4.7a and 4.7b): the CLI scenarios of design decision 11 step 8, then the mass-removal stop of step 7, which runs
// LAST because its --allow-mass-removal publish empties the run's main demo vault. Each scenario lives on its own MFS root below the demo root (see
// scenario-kit.mjs) and records checks against its assertion ids; an assertion whose scenario was not selected (a test-only context option) fails.
import { COST, FORK, OLDER_ROOT, PRUNE, REWRAP, RESTORE, costScenario, forkScenario, pruneScenario, replayScenario, rewrapScenario } from "./cli-scenarios.mjs";
import { runMassRemoval } from "./machine-steps.mjs";
import { PHASE_PLAN } from "./phases.mjs";
import { makeRecorder } from "./recorder.mjs";

const PHASE_NAME = "script-only-cli-phases";
const MASS_REMOVAL_ID = "mass-removal-stopped";
/** Scenario name to its function and the assertion ids it feeds, in the order they run. */
const SCENARIOS = [
  ["replay", replayScenario, [OLDER_ROOT, RESTORE]],
  ["fork", forkScenario, [FORK]],
  ["keys", rewrapScenario, [REWRAP]],
  ["cost", costScenario, [COST]],
  ["prune", (S, recorder) => pruneScenario(S, recorder, S.machine.pruneRounds), [PRUNE]],
];

export async function scriptOnlyCliPhase(S) {
  const plan = PHASE_PLAN.find((entry) => entry.phase === PHASE_NAME);
  const recorder = makeRecorder(S);
  for (const [name, scenario] of SCENARIOS) if (S.machine.scenarios.includes(name)) await scenario(S, recorder);
  const results = new Map(plan.assertions.filter((id) => id !== MASS_REMOVAL_ID).map((id) => [id, recorder.verdictFor(id)]));
  for (const [name, , ids] of SCENARIOS) {
    if (S.machine.scenarios.includes(name)) continue;
    for (const id of ids) results.set(id, { id, passed: false, detail: `the ${name} scenario was not selected (a test-only context option)` });
  }
  const mass = S.machine.scenarios.includes("mass") ? await runMassRemoval(S) : [{ id: MASS_REMOVAL_ID, passed: false, detail: "the mass scenario was not selected (a test-only context option)" }];
  return [...plan.assertions.filter((id) => id !== MASS_REMOVAL_ID).map((id) => results.get(id)), ...mass];
}
