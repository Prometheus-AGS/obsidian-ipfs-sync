// Release 2 (v0.3.0) procedure helper for mvp-07b (task 4.8).
//   node tools/release-mvp-07.mjs [plan] [--check]   read-only: runs the guard checker and prints its result and the release plan
//   node tools/release-mvp-07.mjs record             writes the LOCAL release record under dist/release/v0.3.0/
// Exit codes: 0 ok, 1 a check failed or the record could not be written, 2 refused or bad usage.
//
// The record is produced only when `node tools/check-guard-preconditions.mjs --json` exits 0 in this same run. There is no
// option that skips, weakens or forces that run, no option that selects another project root, and no variant. The tool
// copies the plugin files and the CLI bundle from the build the checker hashed (dist/, as installed by the checker's
// `--build`), asserts that each copied file has the hash the checker printed, edits no file in the hash scope (the version
// 0.3.0 must already be committed), and re-verifies the checksums it writes. It never runs git or gh, never creates a tag,
// a push, a GitHub release or a publication receipt, and writes nothing outside dist/release/v0.3.0/. Outward steps are
// task 7.4 and each needs the operator's explicit yes for that exact action.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { GUARD_BUILD_FILE, InputEnded, OPERATOR_TRANSCRIPT_FILE, createLineReader, lstatSyncOrNull as lstatOrNull, readGuardBuildState } from "./check-guard-preconditions.mjs";
import { checkDistBundles } from "./hook-isolation.mjs";
import { assemble } from "./release/assemble.mjs";
import { makeRelease2 } from "./release/descriptors.mjs";
import { gatherFacts, sha256 } from "./release/facts.mjs";
import { blockers, renderPlan } from "./release/plan.mjs";
import { Refusal, verifyRecord } from "./release/record.mjs";
import { ATTESTATION, plain, readChecker, renderGuardSection } from "./release/release2.mjs";

const SIGNER_OVERRIDE_VARIABLE = "IPFS_SYNC_ALLOWED_SIGNERS";
const CHECKER_FILE = "check-guard-preconditions.mjs";
const CHECKER_TIMEOUT_MS = 2 * 60 * 60_000;
const CHECKER_MAX_BUFFER = 256 * 1024 * 1024;
const STALE_HINT = "run the checker's --build (node tools/check-guard-preconditions.mjs --build) and start again";
/** The names a release copy has in the output directory, and the build file each must equal. */
const PLUGIN_COPIES = { "main.js": "dist/plugin/main.js", "manifest.json": "dist/plugin/manifest.json", "styles.css": "dist/plugin/styles.css" };
const CLI_BUNDLE = "dist/cli/ipfs-sync.mjs";

export const acknowledgementPhrase = (t8) => `I accept an unsigned review record for ${t8}`;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const byKey = (map) => JSON.stringify(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Runs the checker as a child process, exactly as an operator would, and returns what it printed. */
export function runCheckerProcess(root, environment) {
  const result = spawnSync(process.execPath, [join(root, "tools", CHECKER_FILE), "--json"], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHECKER_TIMEOUT_MS,
    maxBuffer: CHECKER_MAX_BUFFER,
  });
  return { status: result.status ?? 2, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

/* ---------- checks of the project against the checker's result ---------- */

/** dist/.guard-build.json and the files of dist/plugin and dist/cli must be exactly the build the checker just verified. */
function staleDistProblems(root, guard) {
  const problems = [];
  const stale = (why) => void problems.push(`dist/ is stale: ${why}; ${STALE_HINT}`);
  const read = readGuardBuildState(root);
  if (!read.ok) {
    stale(read.reason);
    return problems;
  }
  const { state } = read;
  if (state.schema !== 1 || !isObject(state.files)) {
    stale(`${GUARD_BUILD_FILE} has an unknown shape`);
    return problems;
  }
  if (state.treeSha256 !== guard.treeSha256) stale(`${GUARD_BUILD_FILE} is for tree ${plain(state.treeSha256)}, the checker's tree is ${guard.treeSha256}`);
  if (state.buildSha256 !== guard.buildSha256) stale(`${GUARD_BUILD_FILE} is for build ${plain(state.buildSha256)}, the checker's build is ${guard.buildSha256}`);
  if (state.commit !== guard.buildCommit) stale(`${GUARD_BUILD_FILE} was made from commit ${plain(state.commit)}, the checker built ${guard.buildCommit}`);
  if (byKey(state.files) !== byKey(guard.buildFiles)) stale(`${GUARD_BUILD_FILE} lists other files or other hashes than the checker's build`);
  for (const [path, sum] of Object.entries(guard.buildFiles)) {
    const file = join(root, ...path.split("/"));
    const stats = lstatOrNull(file);
    if (stats === null || !stats.isFile()) stale(`${path} is missing or is not a regular file`);
    else if (sha256(readFileSync(file)) !== sum) stale(`${path} differs from the checker's build`);
  }
  for (const dir of ["dist/plugin", "dist/cli"]) {
    if (!existsSync(join(root, dir))) continue;
    const expected = new Set(Object.keys(guard.buildFiles).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)));
    for (const name of readdirSync(join(root, dir))) if (!expected.has(name)) stale(`${dir}/${name} is not part of the checker's build`);
  }
  return problems;
}

/** Test-only sentinels in the bytes about to be shipped (the checker's item D scans its own export; this scans what is hashed here). */
async function sentinelProblems(root) {
  try {
    const scan = await checkDistBundles({ root });
    return [...scan.violations.map((item) => `a test-only sentinel is in a shipped bundle: ${plain(item)}`), ...scan.missing.map((item) => `${plain(item)} was not scanned because it is missing`)];
  } catch (error) {
    return [`the bundle sentinel scan could not run: ${plain(error.message)}`];
  }
}

/** Every release copy equals the hash the checker printed for the build file it comes from. */
function shippedByteProblems(built, facts, guard) {
  const problems = [];
  for (const file of built.files) {
    const source = PLUGIN_COPIES[file.name];
    if (source === undefined) continue;
    if (!Object.hasOwn(guard.buildFiles, source)) problems.push(`${file.name} is shipped but ${source} is not in the checker's build`);
    else if (file.sha256 !== guard.buildFiles[source]) problems.push(`${file.name} would ship with sha256 ${file.sha256}, the checker's build has ${guard.buildFiles[source]}`);
  }
  for (const [name, source] of Object.entries(PLUGIN_COPIES)) {
    if (Object.hasOwn(guard.buildFiles, source) && !built.files.some((file) => file.name === name)) problems.push(`${name} is in the checker's build but would not ship`);
  }
  if (facts.cli === null || facts.cli.sha256 !== guard.buildFiles[CLI_BUNDLE]) problems.push(`${CLI_BUNDLE} is absent or differs from the checker's build, so the CLI tarball would not hold the verified bundle`);
  return problems;
}

/** The three build-file groups on disk right now against the checker's hashes (run again after the copies are written). */
function onDiskProblems(root, guard) {
  return Object.entries(guard.buildFiles).flatMap(([path, sum]) => {
    const file = join(root, ...path.split("/"));
    return existsSync(file) && sha256(readFileSync(file)) === sum ? [] : [`${path} changed while the record was written`];
  });
}

/* ---------- the typed acknowledgement ---------- */

/** Reads one line from a terminal input stream (the checker's line reader) and detaches again. */
async function readOneLine(input) {
  const reader = createLineReader(input);
  try {
    return await reader.next();
  } finally {
    reader.close();
  }
}

/** True only when a terminal is attached on both streams and the operator types the exact phrase. */
async function acknowledge({ terminal, guard, err }) {
  const a = guard.itemA;
  if (terminal === undefined || terminal.input?.isTTY !== true || terminal.output?.isTTY !== true) {
    err(`refused: the review record is unsigned (git-history form) and the release needs a typed acknowledgement, which needs a terminal on standard input and output`);
    return false;
  }
  const phrase = acknowledgementPhrase(guard.t8);
  terminal.output.write(
    [
      "The review record for this tree is unsigned: nothing but git history binds it to the tree.",
      `tree T8: ${guard.t8}`,
      `last commit that touched the review record (E): ${a.commit}`,
      `commits that touched the review record: ${a.commitCount}`,
      "The review record, the operator-run record and the phone-timing record are attestations, not proofs.",
      `To write the release record, type exactly: ${phrase}`,
      "> ",
    ].join("\n"),
  );
  try {
    const line = await readOneLine(terminal.input);
    if (line === phrase) return true;
    err("refused: what was typed is not the required phrase; no release record was written");
    return false;
  } catch (error) {
    if (error instanceof InputEnded) {
      err("refused: the terminal input ended before the phrase was typed; no release record was written");
      return false;
    }
    throw error;
  }
}

/* ---------- the record ---------- */

const insideRoot = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

function describeFile(path) {
  const info = lstatOrNull(path);
  return info !== null && info.isFile() ? { path, exists: true, sha256: sha256(readFileSync(path)) } : { path, exists: false, sha256: null };
}

function buildEvidence({ descriptor, root, facts, guard, built, checkerResult, acknowledgement, createdAt }) {
  const a = guard.itemA;
  const reviewPath = resolve(root, a.recordPath);
  const review = insideRoot(root, reviewPath) ? describeFile(reviewPath) : { path: a.recordPath, exists: false, sha256: null };
  const operator = describeFile(guard.itemB.recordPath);
  const transcript = describeFile(join(dirname(guard.itemB.recordPath), OPERATOR_TRANSCRIPT_FILE));
  const timing = describeFile(guard.itemC.recordPath);
  const c = guard.itemC;
  return {
    schemaVersion: 2,
    version: descriptor.version,
    tag: descriptor.tag,
    repository: descriptor.repo,
    createdAt,
    source: { branch: facts.git.branch, commit: facts.git.commit, checkedCommit: guard.commit, workingTreeInspected: false },
    artifacts: built.files.map(({ name, size, sha256: sum }) => ({ name, size, sha256: sum })),
    cliTarballContents: built.tarball?.contents ?? [],
    checker: {
      command: "node tools/check-guard-preconditions.mjs --json",
      exitCode: 0,
      pass: true,
      outputSha256: sha256(checkerResult.stdout),
      treeSha256: guard.treeSha256,
      t8: guard.t8,
      treeFileCount: guard.treeFileCount,
      commit: guard.commit,
      buildSha256: guard.buildSha256,
      buildCommit: guard.buildCommit,
      buildFiles: guard.buildFiles,
    },
    reviewRecord: {
      path: a.recordPath,
      form: a.form,
      ...(a.form === "git-history" ? { commit: a.commit, commitCount: a.commitCount } : { signerFingerprint: a.signerFingerprint }),
      sha256: review.sha256,
      unreadCount: a.unreadCount,
      unread: a.unread,
      accepted: a.accepted,
    },
    operatorRecord: { path: operator.path, sha256: operator.sha256, transcriptPath: transcript.path, transcriptSha256: transcript.sha256, finishedAt: guard.itemB.finishedAt },
    timingRecord: {
      path: timing.path,
      sha256: timing.sha256,
      form: c.form,
      timingMeasured: c.timingMeasured,
      ...(c.timingMeasured ? { device: c.device, os: c.os, seconds: c.seconds, longestGapMs: c.longestGapMs } : {}),
      ...(c.signerFingerprint === undefined ? {} : { signerFingerprint: c.signerFingerprint }),
    },
    documents: guard.documents,
    toolVersions: { releaseToolNode: process.version, checkerNode: guard.nodeVersion, checkerPnpm: guard.pnpmVersion },
    acknowledgement,
    attestation: ATTESTATION,
    claims: descriptor.claims({ descriptor, facts, evidence: [], files: built.files }),
    unverified: built.unverified,
    publication: { status: "pending", receipt: null, reason: "Local record only. No merge, tag, push or release was made by this tool, and the cadence publication receipt was not produced." },
  };
}

function writeRecord({ root, outDir, built, notes, evidence }) {
  mkdirSync(outDir, { recursive: true });
  for (const file of built.files) {
    if (file.bytes) writeFileSync(join(outDir, file.name), file.bytes);
    else copyFileSync(join(root, "dist", "plugin", file.name), join(outDir, file.name));
  }
  const sums = [...built.files].sort((a, b) => a.name.localeCompare(b.name)).map((file) => `${file.sha256}  ${file.name}\n`).join("");
  writeFileSync(join(outDir, "SHA256SUMS"), sums);
  writeFileSync(join(outDir, "release-notes.md"), notes);
  writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

const refusal = (err, lines) => {
  err(`refused: record preconditions not met\n${lines.map((line) => `- ${line}`).join("\n")}`);
  return 2;
};

async function plan({ root, out, check, checked, status }) {
  const guard = checked.guard;
  const descriptor = makeRelease2(guard);
  const operatorPath = checked.doc?.items?.B?.evidence?.recordPath;
  const facts = gatherFacts(root, { featureOpPath: typeof operatorPath === "string" ? operatorPath : undefined, descriptor });
  const rendered = renderPlan(facts, { descriptor, outDir: descriptor.outDir });
  out(renderGuardSection(checked, status));
  out(rendered.text);
  return check && (rendered.blockerCount > 0 || !checked.ok) ? 1 : 0;
}

async function record({ root, out, err, terminal, checked, checkerResult }) {
  if (!checked.ok) return refusal(err, ["the guard checker did not pass in this run, so no release record was written", ...checked.problems]);
  const guard = checked.guard;
  const descriptor = makeRelease2(guard);
  const facts = gatherFacts(root, { featureOpPath: guard.itemB.recordPath, descriptor });
  const outDir = resolve(root, descriptor.outDir);
  const problems = [...staleDistProblems(root, guard), ...blockers(facts, descriptor)];
  if (existsSync(outDir) && readdirSync(outDir).length > 0) problems.push(`Output directory is not empty: ${outDir}`);
  if (problems.length > 0) return refusal(err, problems);

  const scanProblems = await sentinelProblems(root);
  const built = assemble(facts, { descriptor });
  const byteProblems = shippedByteProblems(built, facts, guard);
  if (scanProblems.length + byteProblems.length > 0) return refusal(err, [...scanProblems, ...byteProblems]);

  let acknowledgement = null;
  if (guard.itemA.form === "git-history") {
    if (!(await acknowledge({ terminal, guard, err }))) return 2;
    acknowledgement = { typed: true, phrase: acknowledgementPhrase(guard.t8), t8: guard.t8 };
  }
  const createdAt = new Date().toISOString();
  const evidence = buildEvidence({ descriptor, root, facts, guard, built, checkerResult, acknowledgement, createdAt });
  writeRecord({ root, outDir, built, notes: built.notes, evidence });
  const moved = onDiskProblems(root, guard);
  if (moved.length > 0) {
    rmSync(outDir, { recursive: true, force: true });
    return refusal(err, moved);
  }
  return verifyRecord({ root, outDir, out });
}

/**
 * `plan` prints the checker result and the release plan and writes nothing. `record` writes the local release record.
 * `runChecker`, `terminal` and `environment` are injection points for tests; the command line passes none of them.
 */
export async function runRelease2({ mode, root, out, err, environment = process.env, terminal, runChecker = runCheckerProcess, check = false }) {
  try {
    if (environment[SIGNER_OVERRIDE_VARIABLE] !== undefined) {
      err(`refused: ${SIGNER_OVERRIDE_VARIABLE} is set; no environment variable selects the allowed-signers file or the trust directory, unset it`);
      return 2;
    }
    const checkerResult = await runChecker(root, environment);
    const checked = readChecker(checkerResult);
    if (mode === "plan") return await plan({ root, out, check, checked, status: checkerResult.status });
    return await record({ root, out, err, terminal, checked, checkerResult });
  } catch (error) {
    if (error instanceof Refusal) return refusal(err, [error.message]);
    err(`failed: ${plain(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
}

/* ---------- command line ---------- */

const USAGE = `usage: node tools/release-mvp-07.mjs [plan|record] [options]

modes
  plan     (default) read-only. Runs the guard checker (node tools/check-guard-preconditions.mjs --json) and prints its
           result, the files and checksums a record would hold, the release notes, the ordered outward steps as text
           (NOT RUN), the preconditions and the open items. Writes nothing.
  record   writes the local release record under dist/release/v0.3.0/ only when the guard checker passes in this same
           run and dist/ is the build the checker verified. With an unsigned (git-history) review record it asks for a
           typed acknowledgement and needs a terminal.

options
  --check   plan only: exit 1 when the checker fails or a record precondition is unmet
  -h, --help

exit codes: 0 ok, 1 failed check, 2 refused or usage error
The tool never runs git or gh, and never creates a merge, tag, push, GitHub release or publication receipt.`;

function parse(argv) {
  const opts = { mode: "plan", check: false };
  let modeSeen = false;
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { ...opts, help: true };
    if (arg === "--check") opts.check = true;
    else if ((arg === "plan" || arg === "record") && !modeSeen) {
      opts.mode = arg;
      modeSeen = true;
    } else throw new Refusal(`unknown argument: ${arg}`);
  }
  if (opts.mode === "record" && opts.check) throw new Refusal("--check applies to plan only");
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return runRelease2({
    mode: opts.mode,
    root,
    check: opts.check,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    terminal: { input: process.stdin, output: process.stdout },
  });
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === here) process.exitCode = await main();
