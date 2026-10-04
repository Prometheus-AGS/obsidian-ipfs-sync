// Phone-timing recorder for item C of the guard-evidence checker (openspec/changes/mvp-07b-keys-history-guard-release-2,
// task 4.5, design 9 "Phone timing (item C)" and 10, spec guard-evidence "Item C").
//
//   node tools/record-phone-timing.mjs measured     the values the plugin command "IPFS Sync: Measure key derivation time" shows
//   node tools/record-phone-timing.mjs acceptance   the operator accepts the timing as unmeasured for this tree and build
//   node tools/record-phone-timing.mjs statement    writes the text to sign with the enrolled key; run again after signing
//
// Terminal only: standard input and output must both be terminals, else exit 2 before anything is read or written. A terminal
// and a nonce stop pipes and accidents; they do not stop a program that drives a pseudo-terminal, and the docs say so. The
// tool never touches the system pasteboard and asks for no secret: the values are a device label, an OS label, two numbers, a
// yes or no and sixteen hex characters.
//
// The file names, the parameters, the thresholds, the phrase and the state-directory rule are IMPORTED from the checker, so the
// recorder and the checker cannot drift. What is written is judged by the checker's own `checkPhoneTiming` straight after the
// write, and the result is printed. The recorder refuses (exit 2) unless `dist/` is current: `dist/.guard-build.json` must name
// the present tree T, and `dist/plugin/main.js` must hash to the value that file records. The typed 16-character prefix is
// checked against the hash of that local `main.js` and the FULL local hash is recorded; the recorder never prints the local
// prefix on the measured path, so the operator has to read it off the phone.
//
// Exit codes: 0 written (and the checker passes it, or, for a first `statement` run, the text to sign was written), 1 the
// operator's input was refused (wrong nonce, wrong prefix, `completed: no`, a value over a threshold, input ended; nothing
// written), 2 usage or environment (no terminal, stale `dist/`, an unsafe folder, a symbolic link).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_OUTPUTS,
  CheckerEnvironmentError,
  FEATURE_OPS_DIRECTORY,
  GUARD_BUILD_FILE,
  InputEnded,
  PHONE_ACCEPTANCE_PHRASE,
  PHONE_TIMING_MAX_GAP_MS,
  PHONE_TIMING_MAX_SECONDS,
  PHONE_TIMING_PARAMETERS,
  PHONE_TIMING_RECORD_FILE,
  PHONE_TIMING_STATEMENT_FILE,
  REVIEW_NAMESPACE,
  checkPhoneTiming,
  computeTreeHash,
  createLineReader,
  lstatSyncOrNull as lstatOrNull,
  perUserStateDir,
  plain,
  randomNonce,
  readGuardBuildState,
} from "./check-guard-preconditions.mjs";

/* ---------- constants of the recorder ---------- */

const PLUGIN_MAIN_JS = BUILD_OUTPUTS.map((output) => output.path).find((path) => path.endsWith("/plugin/main.js"));
/** The plugin command shows, and the checker's signed form names, the first 16 hex characters of the `main.js` hash. */
const BUILD_PREFIX_LENGTH = 16;
const LABEL_MAX_LENGTH = 80;
const BUILD_COMMAND = "node tools/check-guard-preconditions.mjs --build";
const KINDS = Object.freeze(["measured", "acceptance", "statement"]);
const USAGE = `usage: node tools/record-phone-timing.mjs ${KINDS.join("|")}   (terminal only)\n`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The operator's input was refused: exit 1, nothing written. */
class Refusal extends Error {}

/* ---------- checks before anything is typed ---------- */

function requireTerminal(terminal) {
  if (terminal === undefined || terminal.input.isTTY !== true || terminal.output.isTTY !== true) {
    throw new CheckerEnvironmentError("the recorder needs a terminal on standard input and standard output; nothing was written");
  }
}

/**
 * The tree and the local `main.js` hash, after the stale-`dist/` check: `dist/.guard-build.json` (written by `--build`) must name
 * the present tree T, and `dist/plugin/main.js`, a regular file, must hash to the value that file records for it. Throws a
 * CheckerEnvironmentError that names the cure.
 */
function inspectBuild(root, computeTree) {
  const stale = (reason) => new CheckerEnvironmentError(`dist/ is not current: ${reason}; run ${BUILD_COMMAND} and then this tool again`);
  const tree = computeTree({ root });
  if (!tree.ok) throw stale(`the tree hash T cannot be computed (${tree.failures.map((item) => item.code).join(", ")})`);
  const read = readGuardBuildState(root);
  if (!read.ok) throw stale(read.reason);
  const { state } = read;
  if (state.treeSha256 !== tree.treeSha256) throw stale(`${GUARD_BUILD_FILE} was written for another tree than the present one`);
  const recorded = state.files?.[PLUGIN_MAIN_JS];
  if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) throw stale(`${GUARD_BUILD_FILE} records no hash for ${PLUGIN_MAIN_JS}`);
  const mainPath = join(root, ...PLUGIN_MAIN_JS.split("/"));
  const mainStats = lstatOrNull(mainPath);
  if (mainStats === null || !mainStats.isFile()) throw stale(`${PLUGIN_MAIN_JS} is missing or not a regular file`);
  const local = sha256(readFileSync(mainPath));
  if (local !== recorded) throw stale(`${PLUGIN_MAIN_JS} differs from the build ${GUARD_BUILD_FILE} describes`);
  return { tree, mainSha256: local, prefix: local.slice(0, BUILD_PREFIX_LENGTH) };
}

const ownerAndModeProblem = (stats, wantedMode, label) => {
  if (typeof process.getuid !== "function") return undefined;
  if (stats.uid !== process.getuid()) return `${label} is owned by uid ${stats.uid}, not by the current user`;
  const mode = stats.mode & 0o777;
  return mode === wantedMode ? undefined : `${label} has mode ${mode.toString(8).padStart(4, "0")}, expected ${wantedMode.toString(8).padStart(4, "0")}`;
};

/**
 * Where the files go, checked without writing: an existing `feature-ops` folder must be a real directory owned by the current
 * user with mode 0700, and an existing file this run would replace must be a regular file (never a link).
 */
function planFolder(environment, fileNames) {
  const stateDirectory = perUserStateDir(environment);
  const directory = join(stateDirectory, FEATURE_OPS_DIRECTORY);
  const stats = lstatOrNull(directory);
  if (stats !== null) {
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new CheckerEnvironmentError(`${directory} is a symbolic link or not a directory; nothing was written`);
    const problem = ownerAndModeProblem(stats, 0o700, directory);
    if (problem !== undefined) throw new CheckerEnvironmentError(`${problem}; fix it and run this tool again, nothing was written`);
  }
  for (const name of fileNames) {
    const file = lstatOrNull(join(directory, name));
    if (file !== null && (file.isSymbolicLink() || !file.isFile())) throw new CheckerEnvironmentError(`${join(directory, name)} is a symbolic link or not a regular file; nothing was written`);
  }
  return { stateDirectory, directory };
}

/** Creates the state directory and the folder 0700 where they are missing (the umask does not get a say). */
function ensureFolder({ stateDirectory, directory }) {
  if (lstatOrNull(stateDirectory) === null) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
  }
  if (lstatOrNull(directory) === null) mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
}

/** Temporary file, mode 0600, then rename: the target is either the old file or the whole new one. */
function atomicWrite(target, text) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // nothing to remove
    }
    throw error;
  }
}

/* ---------- validation of typed values ---------- */

/** A device or OS label: one line of printable text, so that what the checker prints back cannot move the cursor. */
function label(name, value) {
  const text = value.trim();
  if (text === "") throw new Refusal(`${name} must not be empty`);
  if (text.length > LABEL_MAX_LENGTH) throw new Refusal(`${name} is longer than ${LABEL_MAX_LENGTH} characters`);
  if (plain(text) !== text) throw new Refusal(`${name} contains control or direction characters; type plain text`);
  return text;
}

/** A plain decimal number with an optional unit suffix, as the plugin prints it (`1.14`, `21 ms`); no exponent, sign or word. */
function decimal(name, value, unit) {
  const found = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:${unit})?$`, "i").exec(value.trim());
  if (found === null) throw new Refusal(`${name}: ${JSON.stringify(plain(value.trim()).slice(0, 40))} is not a plain number (the plugin shows, for example, 1.14 or 21 ms)`);
  return Number(found[1]);
}

function measuredValues({ device, os, seconds, gap, completed }) {
  const flag = completed.trim().toLowerCase();
  if (flag !== "yes" && flag !== "no") throw new Refusal("completed: answer yes or no, as the plugin shows it");
  if (flag === "no") throw new Refusal("completed is no: a derivation that did not finish is not a measurement; run the plugin command again, nothing was written");
  const secondsValue = decimal("seconds", seconds, "s");
  const gapValue = decimal("longest gap", gap, "ms");
  if (!(secondsValue > 0 && secondsValue < PHONE_TIMING_MAX_SECONDS)) {
    throw new Refusal(`seconds ${secondsValue} is not greater than 0 and under ${PHONE_TIMING_MAX_SECONDS}: item C cannot pass with this measurement (record an acceptance instead, or fix the cost); nothing was written`);
  }
  if (!(gapValue >= 0 && gapValue < PHONE_TIMING_MAX_GAP_MS)) {
    throw new Refusal(`gap ${gapValue} ms is not under ${PHONE_TIMING_MAX_GAP_MS} ms: item C cannot pass with this measurement; nothing was written`);
  }
  return { device: label("device", device), os: label("OS", os), seconds: secondsValue, longestGapMs: gapValue };
}

function buildPrefixTyped(value, local) {
  const typed = value.replace(/\s+/g, "").toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${BUILD_PREFIX_LENGTH}}$`).test(typed)) throw new Refusal(`build hash: type the ${BUILD_PREFIX_LENGTH} hex characters the plugin shows (groups of four are fine)`);
  if (!local.startsWith(typed)) {
    throw new Refusal(`the typed build hash is not the start of the hash of the local ${PLUGIN_MAIN_JS}; the phone runs another build than this tree built; nothing was written`);
  }
}

/* ---------- the three forms ---------- */

const acceptanceStatement = (t8, prefix) => `Phone timing accepted as unmeasured for tree ${t8} and plugin build ${prefix}.`;
const signedStatementText = (t8, prefix) => `Phone timing for tree ${t8}, plugin build ${prefix}: the operator accepts the phone timing as unmeasured for this tree and build.\n`;
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** Prompts for the nonce a second time and requires it to match. */
async function retypeNonce(session) {
  const typed = (await session.ask("Retype the nonce: ")).trim();
  if (typed !== session.nonce) throw new Refusal("the retyped nonce does not match; nothing was written");
}

async function collectMeasured(session, build) {
  session.say(`Phone timing, measured form, for tree ${build.tree.t8}.\nnonce: ${session.nonce}\nType the values the plugin command "IPFS Sync: Measure key derivation time" shows on the phone.\n`);
  const device = await session.ask("Platform shown by the plugin (device): ");
  const os = await session.ask("OS version of the phone: ");
  const seconds = await session.ask("Seconds: ");
  const gap = await session.ask("Longest event-loop gap: ");
  const completed = await session.ask("Completed (yes or no): ");
  const values = measuredValues({ device, os, seconds, gap, completed });
  buildPrefixTyped(await session.ask("Build hash (first 16 characters): "), build.mainSha256);
  session.say(`device: ${plain(values.device)}\nOS: ${plain(values.os)}\nseconds: ${values.seconds}\nlongest gap: ${values.longestGapMs} ms\n`);
  await retypeNonce(session);
  return {
    fileName: PHONE_TIMING_RECORD_FILE,
    text: `${JSON.stringify({
      schema: 1,
      kind: "measured",
      completed: true,
      parameters: PHONE_TIMING_PARAMETERS,
      seconds: values.seconds,
      longestGapMs: values.longestGapMs,
      device: values.device,
      os: values.os,
      nonceVerified: true,
      finishedAt: new Date(session.now).toISOString(),
      pluginMainJsSha256: build.mainSha256,
    }, null, 2)}\n`,
  };
}

async function collectAcceptance(session, build) {
  session.say(
    `Phone timing, acceptance without a measurement, for tree ${build.tree.t8} and plugin build ${build.prefix}.\n` +
      "The release notes will list the phone timing as unverified.\n" +
      `nonce: ${session.nonce}\nTo accept, type exactly: ${PHONE_ACCEPTANCE_PHRASE}\n`,
  );
  if ((await session.ask("Phrase: ")).trim() !== PHONE_ACCEPTANCE_PHRASE) throw new Refusal("the typed phrase is not the required one; nothing was written");
  await retypeNonce(session);
  return {
    fileName: PHONE_TIMING_RECORD_FILE,
    text: `${JSON.stringify({
      schema: 1,
      kind: "acceptance",
      nonceVerified: true,
      phrase: PHONE_ACCEPTANCE_PHRASE,
      acceptedAt: new Date(session.now).toISOString(),
      statement: acceptanceStatement(build.tree.t8, build.prefix),
      treeSha256: build.tree.treeSha256,
      pluginMainJsSha256: build.mainSha256,
    }, null, 2)}\n`,
  };
}

async function collectStatement(session, build) {
  session.say(`Signed statement for tree ${build.tree.t8} and plugin build ${build.prefix} (the timing is recorded as unverified).\nnonce: ${session.nonce}\n`);
  await retypeNonce(session);
  return { fileName: PHONE_TIMING_STATEMENT_FILE, text: signedStatementText(build.tree.t8, build.prefix) };
}

const COLLECTORS = Object.freeze({ measured: collectMeasured, acceptance: collectAcceptance, statement: collectStatement });

/** The signature file beside a statement: its mode is the signing tool's umask's, so it is set to 0600 here (a link is refused). */
function secureSignature(path) {
  const stats = lstatOrNull(path);
  if (stats === null) return false;
  if (stats.isSymbolicLink() || !stats.isFile()) throw new CheckerEnvironmentError(`${path} is a symbolic link or not a regular file`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new CheckerEnvironmentError(`${path} is not owned by the current user`);
  chmodSync(path, 0o600);
  return true;
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/* ---------- entry ---------- */

/**
 * Runs the recorder. `context`: `root` (the repository), `out` / `err` (strings), `terminal` (`{ input, output }`, the shape of
 * `process.stdin` and `process.stdout`), and for tests `environment`, `now`, `nonce` and `computeTree`. Returns the exit code.
 */
export async function runRecorder(argv, context) {
  const { root, out, err, terminal } = context;
  const environment = context.environment ?? process.env;
  const kind = argv.length === 1 ? argv[0] : undefined;
  if (kind === undefined || !KINDS.includes(kind)) {
    err(USAGE);
    return 2;
  }
  let reader;
  try {
    requireTerminal(terminal);
    const build = inspectBuild(root, context.computeTree ?? computeTreeHash);
    const fileNames = kind === "statement" ? [PHONE_TIMING_STATEMENT_FILE, `${PHONE_TIMING_STATEMENT_FILE}.sig`] : [PHONE_TIMING_RECORD_FILE];
    const place = planFolder(environment, fileNames);
    const say = (text) => void terminal.output.write(text);
    reader = createLineReader(terminal.input);
    const session = {
      say,
      ask: async (prompt) => {
        say(prompt);
        return reader.next();
      },
      nonce: (context.nonce ?? randomNonce)(),
      now: context.now ?? Date.now(),
    };
    const file = await COLLECTORS[kind](session, build);
    ensureFolder(place);
    const target = join(place.directory, file.fileName);
    const signaturePath = `${target}.sig`;
    const unchanged = kind === "statement" && readOrNull(target) === file.text;
    if (!unchanged) {
      atomicWrite(target, file.text);
      if (kind === "statement") {
        try {
          unlinkSync(signaturePath);
        } catch {
          // no earlier signature to remove
        }
      }
      out(`wrote ${plain(target)} (0600)\n`);
    }
    if (kind === "statement" && !secureSignature(signaturePath)) {
      out(`Sign it with the enrolled key, then run this tool again with "statement":\n  ssh-keygen -Y sign -n ${REVIEW_NAMESPACE} -f <your private key file> ${shellQuote(plain(target))}\n`);
      return 0;
    }
    const verdict = checkPhoneTiming({ root, tree: build.tree, buildFiles: { [PLUGIN_MAIN_JS]: build.mainSha256 }, environment, now: session.now });
    if (verdict.ok) {
      out(`item C: pass (${verdict.form}${verdict.evidence.timingMeasured === true ? ", measured" : ", unverified"})\n`);
      return 0;
    }
    err(`item C: fail\n${verdict.failures.map((item) => `FAIL ${item.code}: ${plain(item.detail)}\n`).join("")}`);
    return 1;
  } catch (error) {
    if (error instanceof Refusal) {
      err(`${plain(error.message)}\n`);
      return 1;
    }
    if (error instanceof InputEnded) {
      err("the terminal input ended before the answers were complete; nothing was written\n");
      return 1;
    }
    err(`recorder error: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  } finally {
    reader?.close();
  }
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === here) {
  process.exitCode = await runRecorder(process.argv.slice(2), {
    root: fileURLToPath(new URL("..", import.meta.url)),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    terminal: { input: process.stdin, output: process.stdout },
  });
}
