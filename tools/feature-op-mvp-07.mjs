// Operator-run harness for Release 2 (mvp-07b task 4.6). Commands:
//   node tools/feature-op-mvp-07.mjs [--trigger=manual] [--evidence <dir>]        the operator run on the shared node, two throwaway vaults
//   node tools/feature-op-mvp-07.mjs --phases script-only --owned-key <id>        unattended script-only phases (the iteration-8 feature checkpoint)
//   node tools/feature-op-mvp-07.mjs --verify-only [--tamper-expect]              no Obsidian, no operator; refused by release item B
//   node tools/feature-op-mvp-07.mjs --dry-run | --local-stub                     offline plan and self-checks | a script-hosted stub node
// Exit codes: 0 every evaluated assertion passed, 1 an assertion failed (or crashed), 2 refused or bad usage.
//
// This file is the entry and the module the tests import. The implementation lives in tools/feature-op-mvp-07/*.mjs. It is built on the
// 07a operation (tools/feature-op-mvp-07a/*): the same loopback allow-list proxy confined to a per-run demo root (here mvp07b-demo) and the
// owned key, the same pointer lines and restore text, the same environment allowlist and win32 refusal. It builds nothing: it reads
// dist/.guard-build.json and stops before any request when that is stale. The record and the list of assertion ids it must hold come from
// tools/check-guard-preconditions.mjs (REQUIRED_ASSERTIONS); only a manual run writes the file item B reads.
//
// STATUS: built are the harness (task 4.6), the operator prompts and the machine side of the Obsidian-observed steps (task 4.7a: install check,
// first-pull confirmation and large-blob outcome, each bound to a nonce with a countdown from the operator's ready; an attended run needs a
// terminal, else exit 2; the machine steps run the built CLI as a child process through the confinement proxy) and the hostile preparer and the
// script-only CLI scenarios (task 4.7b: tampered root below <DEMO_ROOT>/tamper, older root by name, restore, fork, rewrap and accept, increase-cost,
// prune-history, and the mass-removal stop last). An assertion that did not run, or whose scenario was not selected, is recorded FAILED.
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./feature-op-mvp-07/run.mjs";

export * from "./feature-op-mvp-07/constants.mjs";
export * from "./feature-op-mvp-07/phases.mjs";
export * from "./feature-op-mvp-07/policy.mjs";
export { parseArguments, USAGE } from "./feature-op-mvp-07/arguments.mjs";
export { installPlugin } from "./feature-op-mvp-07/install.mjs";
export { buildRecord, createTranscript, featureOpsDirectory, prepareOutputDirectory, writeOperatorFiles } from "./feature-op-mvp-07/record.mjs";
export { dryRun, main, run } from "./feature-op-mvp-07/run.mjs";

const isMain = import.meta.main ?? (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
