// Command-line arguments and the usage text of the mvp-07b operator-run harness.
import { resolve } from "node:path";
import { DEMO_PARENT, KEY, OPERATOR_RECORD_FILE, PHASE_MODES, Refusal } from "./constants.mjs";
import { assertThrowawayPath } from "./policy.mjs";

export const USAGE = `usage: node tools/feature-op-mvp-07.mjs [options]
  (no option)             the operator run against the shared node under ${DEMO_PARENT}/<runid>, two throwaway vaults, --trigger=manual
  --phases <all|script-only>
                          script-only: no operator prompts, no countdown, no Obsidian-observed steps; unattended against the shared node
                          (cadence entry: node tools/feature-op-mvp-07.mjs --phases script-only --owned-key <id>). Its result is marked
                          phases: script-only, is written beside the operator file, and release item B refuses it
  --owned-key <id>        key ID you confirm is yours, if ${KEY} exists on the node but is not in the per-machine config
  --accept-unresolved-pointer
                          shared-node run only: continue when the previous IPNS pointer of ${KEY} could not be read after retries (default: refuse)
  --trigger=manual        who runs the Obsidian steps (the only supported value)
  --verify-only           no Obsidian and no operator: the CLI stands in; the result is marked verifyOnly and refused by item B
  --tamper-expect         with --verify-only: expect one wrong installed-file hash; the run must exit 1 (proves the assertions bite)
  --evidence <dir>        a directory the operator saves screenshots or notes in; its path is recorded (repeatable); never inside the repository
  --dry-run               print the plan and the assertion list and run offline self-checks; sends no request, opens no socket
  --local-stub            use a script-hosted stub node as the target instead of the shared node
  --dist-dir <dir>        with --local-stub only: install and hash the plugin and CLI of this build directory (plugin/, cli/) instead of dist/
  --out-dir <dir>         with --local-stub only: write the result here instead of <per-user state dir>/feature-ops (never inside the repository)
  --keep-work             keep the per-run temp directory
The result goes to <per-user state dir>/feature-ops/ next to its transcript; only a manual run writes ${OPERATOR_RECORD_FILE}.
exit codes: 0 every evaluated assertion passed, 1 an assertion failed, 2 refused or bad usage`;

export function parseArguments(argv) {
  const opts = { phases: "all", verifyOnly: false, tamperExpect: false, localStub: false, dryRun: false, trigger: "manual", ownedKey: undefined, acceptUnresolvedPointer: false, distDir: undefined, outDir: undefined, evidence: [], keepWork: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const given = inline ?? argv[++i];
      if (given === undefined) throw new Refusal(`${flag} needs a value`);
      return given;
    };
    if (flag === "--phases") opts.phases = value();
    else if (flag === "--owned-key") opts.ownedKey = value();
    else if (flag === "--trigger") opts.trigger = value();
    else if (flag === "--evidence") opts.evidence = [...opts.evidence, resolve(value())];
    else if (flag === "--dist-dir") opts.distDir = resolve(value());
    else if (flag === "--out-dir") opts.outDir = resolve(value());
    else if (flag === "--verify-only") opts.verifyOnly = true;
    else if (flag === "--tamper-expect") opts.tamperExpect = true;
    else if (flag === "--accept-unresolved-pointer") opts.acceptUnresolvedPointer = true;
    else if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--local-stub") opts.localStub = true;
    else if (flag === "--keep-work") opts.keepWork = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Refusal(`unknown option "${argv[i]}"`);
  }
  if (!PHASE_MODES.includes(opts.phases)) throw new Refusal(`--phases must be one of ${PHASE_MODES.join(", ")}`);
  if (opts.trigger !== "manual") throw new Refusal(`--trigger must be manual, got "${opts.trigger}" (Obsidian's own CLI route is unproven)`);
  if (opts.tamperExpect && !opts.verifyOnly) throw new Refusal("--tamper-expect only makes sense with --verify-only");
  if (opts.outDir !== undefined && !opts.localStub) throw new Refusal("--out-dir is allowed only with --local-stub: a run against the shared node writes to the per-user directory item B reads from");
  if (opts.distDir !== undefined && !opts.localStub) throw new Refusal("--dist-dir drives a build outside dist/, which is allowed only against a script-hosted stub: it needs --local-stub");
  if (opts.acceptUnresolvedPointer && (opts.localStub || opts.dryRun)) throw new Refusal("--accept-unresolved-pointer applies only to the shared-node run (the stub path never refuses on an unresolved pointer)");
  if (opts.outDir !== undefined) assertThrowawayPath(opts.outDir, "--out-dir");
  for (const dir of opts.evidence) assertThrowawayPath(dir, "--evidence");
  return opts;
}
