// Release 1 (v0.2.0) procedure helper for mvp-05.
//   node tools/release-mvp-05.mjs [plan] [options]     read-only: prints the release plan (default)
//   node tools/release-mvp-05.mjs record [options]     writes the LOCAL release record (edits versions, builds)
// Exit codes: 0 ok, 1 a check failed, 2 refused or bad usage.
// The tool never runs git or gh, never creates a tag, push, release or publication receipt.
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_OUT, FEATURE_OP_FILE } from "./release/constants.mjs";
import { gatherFacts } from "./release/facts.mjs";
import { renderPlan } from "./release/plan.mjs";
import { Refusal, runRecord } from "./release/record.mjs";

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

const USAGE = `usage: node tools/release-mvp-05.mjs [plan|record] [options]

modes
  plan     (default) read-only. Prints the version bump, files, CLI tarball list, SHA-256 checksums,
           release notes, the ordered outward steps as text (NOT RUN), preconditions and open items.
  record   writes the local release record under --out. Edits manifest.json and package.json,
           runs "pnpm build", copies artifacts, writes the tarball, SHA256SUMS, release-notes.md and
           evidence.json, then re-verifies the checksums. Refuses when preconditions fail.

options
  --root <dir>          project root (default: the repository containing this tool)
  --out <dir>           record output directory, relative to root (default: ${DEFAULT_OUT})
  --feature-op <file>   feature-operation result (default: <root>/${FEATURE_OP_FILE})
  --evidence <path[=observed result]>
                        record only, repeatable: screenshot, recording or notes file and what it shows
  --no-build            record only: skip "pnpm build"; dist/plugin/manifest.json must already match
  --check               plan only: exit 1 when a record precondition is unmet
  -h, --help            this text

exit codes: 0 ok, 1 failed check, 2 refused or usage error
The tool never runs git or gh, and never creates a tag, push, GitHub release or publication receipt.`;

function parse(argv) {
  const opts = { mode: "plan", evidence: [], noBuild: false, check: false };
  const valued = { "--root": "root", "--out": "out", "--feature-op": "featureOp" };
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
  return opts;
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
  const featureOpPath = opts.featureOp ? resolve(root, opts.featureOp) : undefined;
  try {
    if (opts.mode === "plan") {
      const { text, blockerCount } = renderPlan(gatherFacts(root, { featureOpPath }), { outDir: opts.out ?? DEFAULT_OUT });
      out(text);
      return opts.check && blockerCount > 0 ? 1 : 0;
    }
    return runRecord({ root, outRel: opts.out, featureOpPath, evidenceSpecs: opts.evidence, noBuild: opts.noBuild, out });
  } catch (error) {
    if (error instanceof Refusal) {
      err(`refused: record preconditions not met\n${error.message}`);
      return 2;
    }
    err(`failed: ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
