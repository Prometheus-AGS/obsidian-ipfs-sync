// Release 3 (v0.4.0) procedure helper for mvp-10 (task 5.1).
//   node tools/release-mvp-10.mjs [plan] [--demo-record <file>] [--check]   read-only: prints the release plan (default)
//   node tools/release-mvp-10.mjs record --demo-record <file> [options]     writes the LOCAL release record
// Exit codes: 0 ok, 1 a check failed, 2 refused or bad usage.
//
// The demo record is the evidence (spec release-3: a release record without the demo evidence is not produced).
// `record` refuses without --demo-record, and the file must carry an unambiguous pass verdict — the
// feature-operation convention every release tool here shares (readFeatureOp in tools/release/facts.mjs: a boolean
// passed/ok/pass true, or status pass/passed/ok). `record` bumps manifest.json and package.json to 0.4.0 — the only
// edit this change makes to them — and runs "pnpm build". The tool never runs git or gh, never creates a tag, push,
// GitHub release or publication receipt.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { RELEASE_3, makeRelease3 } from "./release/descriptors.mjs";
import { gatherFacts } from "./release/facts.mjs";
import { renderPlan } from "./release/plan.mjs";
import { Refusal, runRecord } from "./release/record.mjs";

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

const USAGE = `usage: node tools/release-mvp-10.mjs [plan|record] [options]

modes
  plan     (default) read-only. Prints the version bump, files, CLI tarball list, SHA-256 checksums,
           release notes, the ordered outward steps as text (NOT RUN), preconditions and open items.
  record   writes the local release record under --out. Bumps manifest.json and package.json to 0.4.0,
           runs "pnpm build", copies artifacts, writes the tarball, SHA256SUMS, release-notes.md and
           evidence.json, then re-verifies the checksums. Requires --demo-record; refuses without it.

options
  --root <dir>            project root (default: the repository containing this tool)
  --out <dir>             record output directory, relative to root (default: ${RELEASE_3.outDir})
  --demo-record <file>    the operator-run real-vault demo record: a JSON document with an unambiguous
                          pass verdict ("passed": true or "status": "pass"). Required for record; with
                          plan it folds the demo into the printed notes and preconditions.
  --mobile-outcome <text> the recorded outcome of the optional mobile attempt (task 3.3); omit it when
                          the attempt was not run, and the notes will say so. Needs --demo-record.
  --evidence <path[=observed result]>
                          record only, repeatable: extra evidence file and what it shows
  --no-build              record only: skip "pnpm build"; dist/plugin/manifest.json must already match
  --check                 plan only: exit 1 when a record precondition is unmet
  -h, --help              this text

exit codes: 0 ok, 1 failed check, 2 refused or usage error
The tool never runs git or gh, and never creates a tag, push, GitHub release or publication receipt.`;

function parse(argv) {
  const opts = { mode: "plan", evidence: [], noBuild: false, check: false };
  const valued = { "--root": "root", "--out": "out", "--demo-record": "demoRecord", "--mobile-outcome": "mobileOutcome" };
  const rest = [...argv];
  let modeSeen = false;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "-h" || arg === "--help") return { ...opts, help: true };
    if (arg === "--no-build") opts.noBuild = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--evidence" || valued[arg]) {
      const value = rest.shift();
      if (value === undefined || value.startsWith("--")) throw new Refusal(`${arg} needs a value`);
      if (arg === "--evidence") opts.evidence.push(value);
      else opts[valued[arg]] = value;
    } else if (!arg.startsWith("-") && !modeSeen && ["plan", "record"].includes(arg)) {
      opts.mode = arg;
      modeSeen = true;
    } else throw new Refusal(`unknown argument: ${arg}`);
  }
  if (opts.mode === "plan" && (opts.evidence.length || opts.noBuild)) throw new Refusal("--evidence and --no-build apply to record only");
  if (opts.mode === "record" && opts.check) throw new Refusal("--check applies to plan only");
  if (opts.mode === "record" && opts.demoRecord === undefined) {
    throw new Refusal("record needs --demo-record <file>: the demo record is the evidence of this release, and a release record without it is not produced");
  }
  if (opts.mobileOutcome !== undefined && opts.demoRecord === undefined) throw new Refusal("--mobile-outcome needs --demo-record");
  return opts;
}

// The demo context the descriptor's texts close over: null when no demo record was supplied. The record itself is
// read again by gatherFacts (as the feature-operation file) and by the record step (as a hashed evidence file).
function demoContext(root, opts) {
  if (opts.demoRecord === undefined) return null;
  const path = resolve(root, opts.demoRecord);
  if (!existsSync(path)) throw new Refusal(`the demo record does not exist: ${path}`);
  try {
    readFileSync(path);
  } catch (error) {
    throw new Refusal(`the demo record is unreadable: ${error.message}`);
  }
  return { recordPath: opts.demoRecord, mobileOutcome: opts.mobileOutcome ?? null };
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const root = resolve(opts.root ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    const demo = demoContext(root, opts);
    const descriptor = makeRelease3(demo);
    const featureOpPath = opts.demoRecord ? resolve(root, opts.demoRecord) : undefined;
    if (opts.mode === "plan") {
      const { text, blockerCount } = renderPlan(gatherFacts(root, { featureOpPath, descriptor }), { descriptor, outDir: opts.out ?? descriptor.outDir });
      out(text);
      return opts.check && blockerCount > 0 ? 1 : 0;
    }
    const evidenceSpecs = [`${opts.demoRecord}=operator-run real-vault round-trip demo record (mvp-10 tasks 3.1 to 3.3)`, ...opts.evidence];
    return runRecord({ descriptor, root, outRel: opts.out, featureOpPath, evidenceSpecs, noBuild: opts.noBuild, out });
  } catch (error) {
    if (error instanceof Refusal) {
      err(`refused: record preconditions not met\n${error.message}`);
      return 2;
    }
    err(`failed: ${error.message}`);
    return 1;
  }
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === here) process.exitCode = await main();
