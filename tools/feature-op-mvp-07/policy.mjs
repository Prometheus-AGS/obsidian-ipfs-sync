// Pure policy of the mvp-07b operator-run harness: run identifiers, the real-vault refusal, the run mode and the record file names,
// and the stale-dist guard. Proxy policy, pointer lines and the restore text are 07a's and are re-exported unchanged.
import { isAbsolute, join, resolve, sep } from "node:path";
import { BUILD_OUTPUTS } from "../check-guard-preconditions.mjs";
import { firstLine, isOutsideRepo, isValidRunId, isWithin, realpathLoose, sha256 } from "../feature-op-mvp-07a/policy.mjs";
import { DEMO_PARENT, OPERATOR_RECORD_FILE, OPERATOR_TRANSCRIPT_FILE, RUN_ID_PATTERN, Refusal } from "./constants.mjs";

export {
  PULL_READ_COMMANDS,
  RPC_ALLOWLIST,
  bestEffortPostRun,
  childEnv,
  decideRequest,
  firstLine,
  formatPointerLine,
  formatPostRunLine,
  isAllowedUpstream,
  isOutsideRepo,
  isValidRunId,
  isWithin,
  mutationLogProblems,
  newRunId,
  realpathLoose,
  resolvePreviousPointer,
  restoreInstruction,
  sha256,
  win32Refusal,
} from "../feature-op-mvp-07a/policy.mjs";

export function demoRootFor(runId) {
  if (!isValidRunId(runId)) throw new Refusal(`run identifier "${String(runId).slice(0, 40)}" does not match ${RUN_ID_PATTERN}`);
  return `${DEMO_PARENT}/${runId}`;
}

// The operator's real vault. The only use of this path in the harness is the guard below that refuses it.
const FORBIDDEN_VAULT_ROOT = "/Users/gqadonis/obsidian";
const inRealVault = (path) => path === FORBIDDEN_VAULT_ROOT || path.startsWith(`${FORBIDDEN_VAULT_ROOT}${sep}`);

/** Every directory the harness writes or installs into (throwaway vaults, work, output, evidence) passes this: absolute, outside the repository, outside the real vault. */
export function assertThrowawayPath(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Refusal(`${label} must be an absolute path, got "${String(path).slice(0, 80)}"`);
  if (!isOutsideRepo(path)) throw new Refusal(`refusing ${label} ${path}: it is inside the repository (the delivery freeze fingerprints it)`);
  if ([resolve(path), realpathLoose(path)].some(inRealVault)) throw new Refusal(`refusing ${label} ${path}: it is inside the operator's real vault`);
}

/**
 * The label a result carries, and the only thing that decides whether item B can ever accept it: verify-only first, then script-only,
 * then a script-hosted stub; a bare run on the shared node is the only "manual" one.
 */
export function runMode({ phases, verifyOnly, localStub }) {
  if (verifyOnly) return "verify-only";
  if (phases === "script-only") return "script-only";
  return localStub ? "local-stub" : "manual";
}

/** Only a manual run writes the names item B reads; every other mode writes beside them and cannot overwrite an operator's record. */
export function recordNamesFor(mode) {
  if (mode === "manual") return { record: OPERATOR_RECORD_FILE, transcript: OPERATOR_TRANSCRIPT_FILE };
  return {
    record: OPERATOR_RECORD_FILE.replace(/\.json$/, `.${mode}.json`),
    transcript: OPERATOR_TRANSCRIPT_FILE.replace(/\.transcript\.log$/, `.${mode}.transcript.log`),
  };
}

const BUILD_COMMAND = "node tools/check-guard-preconditions.mjs --build";

/**
 * The stale-dist guard. The harness builds nothing: dist/.guard-build.json (written by the checker's --build) must equal the present
 * tree T, and every build output on disk must hold the bytes the state vouches for. `readState` and `computeTree` are the checker's
 * readGuardBuildState and computeTreeHash; `hashFile` returns the sha256 of a file or undefined when it is absent.
 * Returns { ok: true, state } or { ok: false, reason }.
 */
export function guardBuildRefusal({ root, readState, computeTree, hashFile }) {
  const refuse = (reason) => ({ ok: false, reason: `${reason}; run \`${BUILD_COMMAND}\` and re-run (this script never builds)` });
  const read = readState(root);
  if (!read.ok) return refuse(`dist is not vouched for: ${read.reason}`);
  const state = read.state;
  let tree;
  try {
    tree = computeTree({ root });
  } catch (error) {
    return refuse(`the present tree cannot be hashed (${firstLine(error instanceof Error ? error.message : String(error))})`);
  }
  if (!tree.ok) return refuse(`the present tree cannot be hashed: ${(tree.failures ?? []).slice(0, 3).map((failure) => `${failure.code}: ${failure.detail}`).join("; ")}`);
  if (tree.treeSha256 !== state.treeSha256) return refuse(`the tree changed since the build (dist was built for ${String(state.treeSha256).slice(0, 8)}, the tree is ${tree.treeSha256.slice(0, 8)})`);
  const files = typeof state.files === "object" && state.files !== null ? state.files : {};
  const problems = [];
  for (const output of BUILD_OUTPUTS) {
    const vouched = files[output.path];
    const onDisk = hashFile(join(root, ...output.path.split("/")));
    if (vouched === undefined && onDisk === undefined) {
      if (output.required) problems.push(`${output.path} is missing`);
    } else if (vouched !== onDisk) {
      problems.push(`${output.path} is ${onDisk === undefined ? "absent" : "not the file the build state vouches for"}`);
    }
  }
  return problems.length === 0 ? { ok: true, state } : refuse(`dist/ differs from its build state: ${problems.join("; ")}`);
}
