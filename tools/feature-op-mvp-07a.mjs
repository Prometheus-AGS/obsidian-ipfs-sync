// Feature operation for mvp-07a (encrypted pull, second device). Fully automated, no operator. Commands:
//   node tools/feature-op-mvp-07a.mjs [options]              the run against the shared node (after the security review of task 6.4; NOT run by task 33)
//   node tools/feature-op-mvp-07a.mjs --dry-run              print the plan and run offline self-checks; sends NO request
//   node tools/feature-op-mvp-07a.mjs --local-stub [--tamper <kind>]   same run against a script-hosted stub node
//   node tools/feature-op-mvp-07a.mjs --cleanup <runid>      opt-in: remove /obsidian-vault-sync/mvp07a-demo/<runid> (files/stat and files/rm -r, nothing else)
// Exit codes: 0 every check passed, 1 a check failed (or crashed), 2 refused or bad usage.
//
// Shape of the run (task 33 of openspec/changes/mvp-07-encrypted-pull-second-device; copied from the mvp-06 operation, nothing imported from it):
//   * Every CLI child talks to a loopback forwarding-only proxy owned by this script. The proxy forwards only an allowlist of /api/v0
//     commands whose path arguments sit below the per-run demo root (/obsidian-vault-sync/mvp07a-demo/<runid>), the owned key
//     `obsidian-vault-sync`, and pin/add or name/publish of CIDs the node reported for the demo root. It has no key/rm, no pin/rm,
//     no files/mv and no route to /obsidian-vault-staging. It records every request and scans request bodies for recorded plaintext.
//     A pull needs only reads (key/list, name/resolve, ls of /ipfs/<cid>, files/stat, files/ls, gateway GET); its slice of the log is audited.
//   * Two simulated devices, A and B, each with its own vault directory, config file and per-user state directory (XDG_STATE_HOME: device
//     id and sequence floor). B starts as an EMPTY directory and pulls. Device A's init generates the passphrase.
//   * The script itself only reads the shared node (files/ls, files/stat, ls, key/list, name/resolve, gateway GET) through a read-only
//     view of the shared client. All writes are the CLI's own (`init`, `publish`), through the proxy.
//   * Hostile objects, the replay by name and the fork run against a script-hosted stub node (the recording fake from tests/helpers),
//     never the shared node; the shared node's name is never repointed to an older root and the proxy never rewrites a response.
//   * Before every child spawn the effective API URL, gateway URL, MFS root and key are computed with the CLI's own config loader, from the
//     exact argv and environment the child will get, and must equal the loopback proxy (or stub), a root inside the demo root and the owned
//     key. User and project config files are not read (an explicit --config, an empty working directory) and the child's environment is
//     an allowlist (PATH, HOME, TMPDIR, LANG, LC_ALL; the IPFS_SYNC_* auth variables on the shared-node path only). The script refuses to run on win32.
//   * The generated passphrase lives only in a 0600 file in a per-run 0700 temp directory outside the repository. It is never printed;
//     child output is scanned for it and redacted.
//
// Layout: this file is the entry. The implementation lives in tools/feature-op-mvp-07a/*.mjs (constants, policy, report, arguments, tamper,
// toolbox, children, proxy, stub-node, workspace, node-view, shared-phase, hostile-phase, audit, dry-run, run). Everything the helper test
// needs is exported from here (tests/unit/feature-op-mvp-07a-helpers.test.ts imports this path).
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./feature-op-mvp-07a/run.mjs";

export * from "./feature-op-mvp-07a/constants.mjs";
export * from "./feature-op-mvp-07a/policy.mjs";
export { parseArguments } from "./feature-op-mvp-07a/arguments.mjs";
export { main };

const isMain = import.meta.main ?? (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
