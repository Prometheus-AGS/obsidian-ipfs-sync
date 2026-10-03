// Command-line arguments and the usage text.
import { resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_OUT, DEMO_PARENT, KEY, RUN_ID_PATTERN, Refusal, TAMPER_KINDS } from "./constants.mjs";
import { isOutsideRepo, isValidRunId, realpathLoose, staleBuildRefusal } from "./policy.mjs";

// ======================================================================================================================
// Arguments
// ======================================================================================================================

export const USAGE = `usage: node tools/feature-op-mvp-07a.mjs [options]
  (no option)             run against the shared node under ${DEMO_PARENT}/<runid> (needs a fresh \`pnpm build\`)
  --dry-run               print the plan, the RPC allowlist and run offline self-checks; sends no request, opens no socket
  --local-stub            use a script-hosted stub node as the target instead of the shared node (no contact with the shared node)
  --tamper <kind>         with --local-stub: alter one input so exactly the matching check must fail (exit 1 expected)
                          kinds: ${TAMPER_KINDS.join(", ")}
  --cleanup <runid>       opt-in: recursively remove ${DEMO_PARENT}/<runid> (runid must match ${RUN_ID_PATTERN}); with --dry-run only prints
  --owned-key <id>        key ID you confirm is yours, if ${KEY} exists on the node but is not in ${CONFIG_FILE}
  --accept-unresolved-pointer
                          shared-node run only: continue when the previous IPNS pointer of ${KEY} could not be read after retries (default: refuse)
  --out <file>            where to write the result (default ${DEFAULT_OUT}); never inside the repository (checked on the real path)
  --keep-work             keep the per-run temp directory (it holds the throwaway vault's passphrase file)
  --cli <file>            with --local-stub only: drive this built entry point instead of dist/cli/ipfs-sync.mjs (a bundle built outside dist)
  --allow-stale-build     with --local-stub or --dry-run only: do not refuse when the built entry point is older than cli/ or src/ (refused on the shared-node path)
exit codes: 0 all checks passed, 1 a check failed, 2 refused or bad usage`;

export function parseArguments(argv) {
  const opts = { dryRun: false, localStub: false, tamper: undefined, cleanup: undefined, ownedKey: undefined, out: DEFAULT_OUT, keepWork: false, allowStaleBuild: false, cli: undefined, acceptUnresolvedPointer: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const given = inline ?? argv[++i];
      if (given === undefined) throw new Refusal(`${flag} needs a value`);
      return given;
    };
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--local-stub") opts.localStub = true;
    else if (flag === "--tamper") opts.tamper = value();
    else if (flag === "--cleanup") opts.cleanup = value();
    else if (flag === "--owned-key") opts.ownedKey = value();
    else if (flag === "--out") opts.out = resolve(value());
    else if (flag === "--cli") opts.cli = resolve(value());
    else if (flag === "--keep-work") opts.keepWork = true;
    else if (flag === "--accept-unresolved-pointer") opts.acceptUnresolvedPointer = true;
    else if (flag === "--allow-stale-build") opts.allowStaleBuild = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Refusal(`unknown option "${argv[i]}"`);
  }
  if (opts.tamper !== undefined && !TAMPER_KINDS.includes(opts.tamper)) throw new Refusal(`--tamper must be one of ${TAMPER_KINDS.join(", ")}`);
  if (opts.tamper !== undefined && !opts.localStub) throw new Refusal("--tamper alters a stub node's contents, so it needs --local-stub");
  if (opts.cleanup !== undefined && (opts.localStub || opts.tamper !== undefined)) throw new Refusal("--cleanup removes a shared-node demo folder; it cannot be combined with --local-stub or --tamper");
  if (opts.cleanup !== undefined && !isValidRunId(opts.cleanup)) throw new Refusal(`--cleanup needs a run identifier matching ${RUN_ID_PATTERN}`);
  if (opts.cli !== undefined && !opts.localStub) throw new Refusal("--cli drives a build outside dist, which is allowed only against a script-hosted stub: it needs --local-stub (the shared-node path always drives dist/cli/ipfs-sync.mjs)");
  if (opts.acceptUnresolvedPointer && (opts.localStub || opts.dryRun || opts.cleanup !== undefined)) throw new Refusal("--accept-unresolved-pointer applies only to the shared-node run (the stub path never refuses on an unresolved pointer)");
  const stale = staleBuildRefusal(opts);
  if (stale !== undefined) throw new Refusal(stale);
  opts.out = realpathLoose(opts.out);
  if (!isOutsideRepo(opts.out)) throw new Refusal(`refusing to write the result into the repository (${opts.out}); the delivery freeze fingerprints the repo`);
  return opts;
}
