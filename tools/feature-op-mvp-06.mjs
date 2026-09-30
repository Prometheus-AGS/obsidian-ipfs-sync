// Feature operation for mvp-06 (encrypted vault publish). Fully automated, no operator. Commands:
//   node tools/feature-op-mvp-06.mjs [options]              the run against the shared node (task 6.2)
//   node tools/feature-op-mvp-06.mjs --dry-run              print the plan and run offline self-checks; sends NO request
//   node tools/feature-op-mvp-06.mjs --local-stub [--tamper <kind>]   same run against a script-hosted stub node (task 6.1 verify)
//   node tools/feature-op-mvp-06.mjs --cleanup <runid>      opt-in: remove /obsidian-vault-sync/mvp06-demo/<runid> (files/rm, nothing else)
// Exit codes: 0 every check passed, 1 a check failed (or crashed), 2 refused or bad usage.
//
// Shape of the run (design.md "Feature Operation"):
//   * Every CLI child talks to a loopback forwarding-only proxy owned by this script. The proxy forwards only an allowlist
//     of /api/v0 commands whose path arguments sit below the per-run demo root (/obsidian-vault-sync/mvp06-demo/<runid>),
//     the owned key `obsidian-vault-sync`, and pin/add or name/publish of CIDs the node reported for the demo root. It has
//     no key/rm, no pin/rm and no route to /obsidian-vault-staging. It records every request, scans request bodies for
//     recorded plaintext, and injects the mid-publish connection drops.
//   * The script itself only reads the shared node (files/ls, files/stat, ls, key/list, name/resolve, gateway GET) through a
//     read-only view of the shared client. All writes are the CLI's own (`init`, `publish`), through the proxy.
//   * The hostile-object phase runs against a script-hosted stub node (the recording fake from tests/helpers), never the
//     shared node.
//   * Before every child spawn the effective API URL is computed with the CLI's own config loader, from the exact argv and
//     environment the child will get, and must equal the loopback proxy (or stub). User and project config files are not
//     read (an explicit --config, an empty working directory) and IPFS_SYNC_* variables other than auth are stripped.
//   * The generated passphrase lives only in a 0600 file in a per-run 0700 temp directory outside the repository. It is never
//     printed; child output is scanned for it and redacted.
//
// Layout: this file is the entry. The implementation lives in tools/feature-op-mvp-06/*.mjs (constants, policy, report, arguments, toolbox,
// children, proxy, stub-node, workspace, inspection, shared-phase, hostile-phase, dry-run, run). Everything the file exported before the split is
// still exported from here (tests/unit/feature-op-mvp-06-helpers.test.ts imports this path).
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./feature-op-mvp-06/run.mjs";

export * from "./feature-op-mvp-06/constants.mjs";
export * from "./feature-op-mvp-06/policy.mjs";
export { parseArguments } from "./feature-op-mvp-06/arguments.mjs";
export { main };

const isMain = import.meta.main ?? (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
