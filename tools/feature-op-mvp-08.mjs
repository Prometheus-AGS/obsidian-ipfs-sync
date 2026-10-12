// Feature operation for mvp-08 (device-local sync history store). Fully automated, no operator. Commands:
//   node tools/feature-op-mvp-08.mjs [options]              the run against the shared node (the gate of task 6.2; the lead runs it after the full suite passes)
//   node tools/feature-op-mvp-08.mjs --dry-run              print the plan and run offline self-checks; sends NO request
//   node tools/feature-op-mvp-08.mjs --local-stub           the same run against a script-hosted stub node (no contact with the shared node)
//   node tools/feature-op-mvp-08.mjs --cleanup <runid>      opt-in: remove /obsidian-vault-sync/mvp08-demo/<runid> (files/stat and files/rm -r, nothing else)
// Exit codes: 0 every check passed, 1 a check failed (or crashed), 2 refused or bad usage.
//
// Shape of the run (task 6.2 of openspec/changes/mvp-08-sync-history-store). The structure is tools/feature-op-mvp-07a.mjs's, and
// the machinery is IMPORTED from tools/feature-op-mvp-07a/*.mjs rather than copied — the same reuse the mvp-07 operator harness
// (tools/feature-op-mvp-07/) already makes of 07a. Only what depends on the demo parent (mvp08-demo), the phase flow and the
// history assertions is declared here:
//   * Every CLI child talks to the loopback forwarding-only proxy of 07a, which forwards only the 07a allowlist of /api/v0
//     commands whose path arguments sit below the per-run demo root (/obsidian-vault-sync/mvp08-demo/<runid>), the owned key
//     `obsidian-vault-sync`, and pin/add or name/publish of CIDs the node reported for the demo root. No key/rm, no pin/rm,
//     no files/mv, no route to /obsidian-vault-staging. The proxy records every request and scans request bodies for recorded
//     plaintext (fixture paths, titles, body words, the passphrase spellings).
//   * Two simulated devices, A and B, each with its own vault directory, config file and per-user state directory
//     (XDG_STATE_HOME: the device store, the sequence floor and — the subject of this change — the history database under
//     <state>/ipfs-sync/history). B starts as an EMPTY directory and pulls. Device A's init generates the passphrase.
//   * Every CLI invocation is its own child process, so the `history` runs of step 3 are fresh processes against the same
//     state directories: the recorder processes (publish, pull) have exited before them — the rows they print can only come
//     from the on-disk database.
//   * Before every child spawn the effective API URL, gateway URL, MFS root and key are computed with the CLI's own config
//     loader, from the exact argv and environment the child will get, and must equal the loopback proxy (or stub), a root
//     inside the demo root and the owned key. The child's environment is the 07a allowlist (PATH, HOME, TMPDIR, LANG, LC_ALL;
//     the IPFS_SYNC_* auth variables on the shared-node path only). The script refuses to run on win32 (the device store
//     ignores XDG_STATE_HOME there).
//   * The generated passphrase lives only in a 0600 file in a per-run 0700 temp directory outside the repository. It is never
//     printed; child output is scanned for it and redacted.
//   * This operation has no hostile-object phase and no --tamper mode: nothing in task 6.2 asks for one. The --local-stub
//     mode exists so the whole flow can be exercised without touching the shared node.
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertEffectiveTarget, makeCliRunner, scrub } from "./feature-op-mvp-07a/children.mjs";
import { ALLOWED_HOSTS, BASE, CLI, CONFIG_FILE, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, KEY, MIN_PUBLISHED_FILES, RUN_ID_PATTERN, Refusal, SIGNAL_EXIT_CODES, SIGNAL_POST_RUN_TIMEOUT_MS } from "./feature-op-mvp-07a/constants.mjs";
import { readPassphraseFile } from "./feature-op-mvp-07a/node-view.mjs";
import {
  PULL_READ_COMMANDS,
  RPC_ALLOWLIST,
  bestEffortPostRun,
  childEnv,
  decideRequest,
  findNeedle,
  firstLine,
  formatPointerLine,
  formatPostRunLine,
  isAllowedUpstream,
  isOutsideRepo,
  isValidRunId,
  isWithin,
  mutationLogProblems,
  newRunId,
  parseInitOutput,
  parsePublishOutput,
  parsePullOutput,
  plaintextNeedles,
  pullTraceProblems,
  realpathLoose,
  resolvePreviousPointer,
  restoreInstruction,
  scrubbedDetail,
  staleBuildRefusal,
  win32Refusal,
  withPassphraseSpellings,
} from "./feature-op-mvp-07a/policy.mjs";
import { createProxy, proxySelfTest } from "./feature-op-mvp-07a/proxy.mjs";
import { check, checks, guarded, note, out, skips } from "./feature-op-mvp-07a/report.mjs";
import { startStub } from "./feature-op-mvp-07a/stub-node.mjs";
import { buildToolbox, checkBuildFresh, distSha256 } from "./feature-op-mvp-07a/toolbox.mjs";
import { acquireLock, assertKeyAdoptable, diffMaps, ensureConfig, exists, generateVault, readOnly, readOwnedKeys, walkFiles } from "./feature-op-mvp-07a/workspace.mjs";

// ======================================================================================================================
// What this operation owns (everything else is imported from the 07a modules)
// ======================================================================================================================

export const DEMO_PARENT = `${BASE}/mvp08-demo`;
/** Device labels of the two simulated devices (IPFS_SYNC_DEVICE). */
export const DEVICE_A = "fop08-a";
export const DEVICE_B = "fop08-b";
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
const DEFAULT_OUT = join(CONFIG_DIR, "feature-op-mvp-08.json");
/** The empty-database line of the history command (cli/history-command.ts HISTORY_EMPTY_LINE); declared here, as the 07a script declares the CLI messages it expects. */
const HISTORY_EMPTY_LINE = "no sync operations recorded on this device";

export const UNVERIFIED = [
  "multi-vault filtering (the store is per-user and `history` has no vault filter; each device in this run records exactly one operation)",
  "very large histories and newest-first ordering over many rows (this run records exactly one row per device)",
  "--limit against a database with more rows than the limit (same reason)",
  "plugin-side store use (the WebView adapter does not exist yet; out of MVP scope)",
];

export function demoRootFor(runId) {
  if (!isValidRunId(runId)) throw new Refusal(`run identifier "${String(runId).slice(0, 40)}" does not match ${RUN_ID_PATTERN}`);
  return `${DEMO_PARENT}/${runId}`;
}

/** The one folder `--cleanup` may remove: strictly below the demo parent, from a valid run identifier only. */
export function cleanupTarget(runId) {
  const target = demoRootFor(runId);
  if (!isWithin(target, DEMO_PARENT)) throw new Refusal(`${target} is not below ${DEMO_PARENT}`);
  return target;
}

/**
 * The history database directory of one simulated device. The same rule as `deviceStoreDirectory` (cli/device-store-node.ts)
 * composed with `historyStoreDirectory` (cli/store/location.ts): XDG_STATE_HOME is always set to an absolute path for the
 * children of this run (and win32 is refused), so the rule reduces to the join below. The run never trusts the derivation
 * silently: the directory must exist and hold files before the restart step is believed.
 */
export function historyDirOf(stateHome) {
  return join(stateHome, "ipfs-sync", "history");
}

/** Every file below `dir`, relative to it, sorted; an absent directory is an empty list. */
async function listFilesRecursive(dir, prefix = "") {
  let entries;
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFilesRecursive(dir, rel)));
    else found.push(rel);
  }
  return found.sort();
}

// ======================================================================================================================
// The history output parser (the line format of cli/history-command.ts lineOf: ISO, kind padded to 8, root CID, then the counts)
// ======================================================================================================================

const PUBLISH_DETAILS = /^written (\d+), removed (\d+), (\d+) ms$/;
const PULL_DETAILS = /^fetched (\d+), unchanged (\d+), conflicted (\d+), failed (\d+), removed remotely (\d+), kept locally (\d+), (\d+) ms$/;

/**
 * The rows of one `history` run. The empty-database line parses to an empty list; everything else must be a record line
 * (`ok: false` marks a line that is neither). Timestamps and the two kinds' counts are parsed, not compared as text.
 */
export function parseHistoryLines(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 1 && lines[0] === HISTORY_EMPTY_LINE) return [];
  return lines.map((line) => {
    const parts = line.split(/\s{2,}/);
    if (parts.length < 4) return { line, ok: false };
    const [iso, kind, rootCid, ...rest] = parts;
    const details = rest.join("  ");
    const occurredAtMs = Date.parse(iso);
    const row = { line, ok: !Number.isNaN(occurredAtMs), iso, occurredAtMs, kind, rootCid, details };
    const publish = kind === "publish" ? PUBLISH_DETAILS.exec(details) : null;
    const pull = kind === "pull" ? PULL_DETAILS.exec(details) : null;
    if (publish !== null) row.counts = { written: Number(publish[1]), removed: Number(publish[2]), durationMs: Number(publish[3]) };
    if (pull !== null) {
      row.counts = { fetched: Number(pull[1]), unchanged: Number(pull[2]), conflicted: Number(pull[3]), failed: Number(pull[4]), remoteDeleted: Number(pull[5]), locallyModified: Number(pull[6]), durationMs: Number(pull[7]) };
    }
    if ((kind === "publish" || kind === "pull") && row.counts === undefined) row.ok = false;
    return row;
  });
}

const isWordByte = (byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 95;

/**
 * The needle search for the database bytes. Unlike the proxy's wire scan (a substring there is always a leak), a database
 * directory legitimately holds fixed initdb catalog text: observed 2026-10-06 against a virgin PGlite 0.5.8 database, a
 * bare-word needle fires there with no user data present at all ("ember" inside "December"; "reference" standing alone in
 * SQL-feature prose and in catalog identifiers such as reference_type; "signal" in pg_signal_backend). Bare words and bare
 * path segments therefore can never prove a leak here, and the database needle set (databaseNeedles) holds only
 * high-specificity values: vault paths, full vault-relative paths, file names with their extension, whole body lines, note
 * titles and the passphrase. A needle flagged `bounded` (the titles) must not be flanked by ASCII letters, digits or an
 * underscore, so a title matching inside a longer catalog identifier does not fire; the fixture's titles stand alone in a
 * leaked text, so a real leak still matches. All other needles are plain substrings.
 */
export function findNeedleBounded(haystack, needles) {
  for (const needle of needles) {
    if (needle.bytes.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle.bytes, from);
      if (at === -1) break;
      const before = at === 0 ? 0 : haystack[at - 1];
      const after = at + needle.bytes.length >= haystack.length ? 0 : haystack[at + needle.bytes.length];
      if (needle.bounded !== true || (!isWordByte(before) && !isWordByte(after))) return needle.label;
      from = at + 1;
    }
  }
  return undefined;
}

/**
 * The needles for the raw database scan (see findNeedleBounded for why bare words and bare path segments are absent):
 * both vault paths, every fixture file's vault-relative path and its extension-carrying file name, every note title
 * (bounded), every body line of at least 20 characters, and both passphrase spellings. Built from the generated vault
 * after step 1 (S.filesA) and the passphrase file (S.secrets).
 */
export function databaseNeedles(files, vaultA, vaultB, secrets) {
  const needles = [];
  const seen = new Set();
  const add = (label, value, bounded = false) => {
    if (value === "" || seen.has(value)) return;
    seen.add(value);
    needles.push({ label, bytes: Buffer.from(value, "utf8"), bounded });
  };
  add(`vault path "${vaultA}"`, vaultA);
  add(`vault path "${vaultB}"`, vaultB);
  for (const file of files) {
    add(`path "${file.path}"`, file.path);
    const base = file.path.split("/").at(-1) ?? "";
    if (base.includes(".")) add(`file name "${base}"`, base);
    const title = /^# (.+)$/m.exec(file.text ?? "")?.[1];
    if (title !== undefined) add(`title "${title}"`, title, true);
    for (const line of (file.text ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length >= 20 && !trimmed.startsWith("# ")) add(`body line "${trimmed.slice(0, 36)}..."`, trimmed);
    }
  }
  for (const secret of secrets) if (secret !== "") add("passphrase", secret);
  return needles;
}

/**
 * Byte-level needle scan of every file under `dir` (a PGlite data directory is binary; the buffers are searched, not
 * decoded — the grep -a equivalent). Returns { hit, file, fileCount, scannedBytes }.
 */
async function scanTreeForNeedles(dir, needles) {
  const files = await listFilesRecursive(dir);
  let scannedBytes = 0;
  for (const rel of files) {
    const data = await readFile(join(dir, ...rel.split("/")));
    scannedBytes += data.length;
    const hit = findNeedleBounded(data, needles);
    if (hit !== undefined) return { hit, file: rel, fileCount: files.length, scannedBytes };
  }
  return { hit: undefined, file: undefined, fileCount: files.length, scannedBytes };
}

/** The read-only snapshot of the node, with this operation's demo parent (07a's own snapshot reads mvp07a-demo). */
async function nodeSnapshot(client) {
  const listing = (path) => client.filesLs(path).then((entries) => new Map(entries.map((entry) => [entry.name, entry.cid])), () => new Map());
  return { base: await listing(BASE), demoParent: await listing(DEMO_PARENT), keys: new Map((await client.keyList()).map((key) => [key.name, key.id])) };
}

// ======================================================================================================================
// Arguments
// ======================================================================================================================

export const USAGE = `usage: node tools/feature-op-mvp-08.mjs [options]
  (no option)             run against the shared node under ${DEMO_PARENT}/<runid> (needs a fresh \`pnpm build\`)
  --dry-run               print the plan, the RPC allowlist and run offline self-checks; sends no request, opens no socket
  --local-stub            use a script-hosted stub node as the target instead of the shared node (no contact with the shared node)
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
  const opts = { dryRun: false, localStub: false, cleanup: undefined, ownedKey: undefined, out: DEFAULT_OUT, keepWork: false, allowStaleBuild: false, cli: undefined, acceptUnresolvedPointer: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => {
      const given = inline ?? argv[++i];
      if (given === undefined) throw new Refusal(`${flag} needs a value`);
      return given;
    };
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--local-stub") opts.localStub = true;
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
  if (opts.cleanup !== undefined && opts.localStub) throw new Refusal("--cleanup removes a shared-node demo folder; it cannot be combined with --local-stub");
  if (opts.cleanup !== undefined && !isValidRunId(opts.cleanup)) throw new Refusal(`--cleanup needs a run identifier matching ${RUN_ID_PATTERN}`);
  if (opts.cli !== undefined && !opts.localStub) throw new Refusal("--cli drives a build outside dist, which is allowed only against a script-hosted stub: it needs --local-stub (the shared-node path always drives dist/cli/ipfs-sync.mjs)");
  if (opts.acceptUnresolvedPointer && (opts.localStub || opts.dryRun || opts.cleanup !== undefined)) throw new Refusal("--accept-unresolved-pointer applies only to the shared-node run (the stub path never refuses on an unresolved pointer)");
  const stale = staleBuildRefusal(opts);
  if (stale !== undefined) throw new Refusal(stale);
  opts.out = realpathLoose(opts.out);
  if (!isOutsideRepo(opts.out)) throw new Refusal(`refusing to write the result into the repository (${opts.out}); the delivery freeze fingerprints the repo`);
  return opts;
}

// ======================================================================================================================
// Dry run: the plan and offline self-checks, no request
// ======================================================================================================================

const PLAN = [
  "1. build guard: dist/cli/ipfs-sync.mjs must exist and be newer than cli/ and src/ (this script never builds); its sha256 is printed and recorded",
  "2. read-only snapshot of the node: files/ls of /obsidian-vault-sync and /obsidian-vault-sync/mvp08-demo, key/list, name/resolve of the owned key; the pointer line is printed before the first mutation (shared-node path: only the node's never-published answer is accepted as unresolved; anything else is retried, then refused unless --accept-unresolved-pointer)",
  "3. start the loopback forwarding proxy; self-test, against a second proxy whose upstream is the dead address 127.0.0.1:9, that out-of-policy requests are refused and not forwarded",
  "4. device A: fixture vault; `init --passphrase-file <per-run path>`; `publish` (sequence 1) to the demo root under the owned key; after the publish child exits, A's history database must already exist on disk under <state>/ipfs-sync/history (the recorder is dead, the rows are on disk)",
  "5. device B: an EMPTY directory pulls with --accept-first-pull --expect-vault-id --expect-min-sequence 1; the pull's slice of the proxy log holds reads only; B's history database exists on disk after the pull child exits",
  "6. restart: fresh CLI child processes against the same state directories run `ipfs-sync history` for each device; the proxy log must not grow during the history runs; A's row is the publish (kind, the publish's root CID, the publish's counts), B's row is the pull (kind, the pulled root CID, the pull's counts); `history --limit 1` prints exactly one row",
  "7. no plaintext: the history output holds no vault path, fixture path segment, file stem, title, body word or passphrase spelling; a byte-level scan of every file under each device's history database directory holds no vault path, fixture path, file name, note title, body line or passphrase (bare-word needles are unusable against a database: the initdb catalog legitimately contains words like \"reference\" — observed against a virgin PGlite database, see findNeedleBounded)",
  "8. node-state comparison: only this run's folder under /obsidian-vault-sync/mvp08-demo and at most the key obsidian-vault-sync changed; proxy audit; dist sha256 recomputed (a check); the owned key's pointer is printed before and after, with the restore command",
];

export async function dryRun(opts) {
  out("feature operation mvp-08: DRY RUN (no request is sent, no socket is opened)\n");
  out(PLAN.join("\n"));
  out(`\ndemo root pattern      ${DEMO_PARENT}/<runid>   (runid ${RUN_ID_PATTERN}, e.g. ${newRunId()})`);
  out(`owned key              ${KEY} (the only key ever named; key/gen only for it)`);
  out(`proxy allowlist        ${RPC_ALLOWLIST.join(", ")}`);
  out("proxy also forwards   GET|HEAD /ipfs/<cid>[/path]");
  out(`pull read set          ${PULL_READ_COMMANDS.join(", ")} (a pull's slice of the proxy log must hold nothing else)`);
  out("never sent            key/rm, key/rename, key/import, key/export, pin/rm, files/mv, files/cp, any path outside the demo root, anything naming /obsidian-vault-staging");
  out("direct reads          files/ls, files/stat, key/list, name/resolve (read-only view of the shared client)");
  out(`history database       <XDG_STATE_HOME>/ipfs-sync/history per device (${historyDirOf("<state-a>")} for A)`);
  out(`cleanup (opt-in)       files/stat + files/rm -r on ${DEMO_PARENT}/<runid> only`);
  const cli = opts.cli ?? CLI;
  const fresh = checkBuildFresh(cli);
  note(fresh.ok ? `${opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli} is newer than its sources` : `build guard would refuse a real run: ${fresh.message}`);
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop08-dry-"));
  try {
    const tb = await buildToolbox(work);
    check("dry run: the toolbox bundle (the CLI's own config loader, the kubo client factory) builds and loads", typeof tb.effectiveConfig === "function" && typeof tb.makeClient === "function");
    const config = join(work, "config.json");
    await writeFile(config, `${JSON.stringify({ ownedKeys: [] })}\n`);
    const demoRoot = demoRootFor(newRunId());
    const base = ["--config", config, "--rpc-url", "http://127.0.0.1:9", "--gateway-url", "http://127.0.0.1:9", "--mfs-root", demoRoot, "--key", KEY];
    for (const argv of [
      ["publish", join(work, "vault"), ...base],
      ["pull", join(work, "vault"), ...base],
      ["history", ...base],
      ["history", ...base, "--limit", "1"],
    ]) {
      await assertEffectiveTarget(tb, argv, childEnv({ IPFS_SYNC_RPC_URL: "https://elsewhere.example", IPFS_SYNC_MFS_ROOT: "/elsewhere", IPFS_SYNC_PASSPHRASE: "x", PATH: process.env.PATH }, {}), { url: "http://127.0.0.1:9", demoRoot });
    }
    check("dry run: for publish, pull and history (with and without --limit), with hostile IPFS_SYNC_* variables in the environment, the effective API URL, gateway, MFS root and key are still the intended loopback target (variables stripped, flags win)", true);
    const rejected = await assertEffectiveTarget(tb, ["history", ...base], {}, { url: "http://127.0.0.1:10", demoRoot }).then(() => false, (error) => error instanceof Refusal);
    check("dry run: a history child whose effective API URL is not the intended loopback target is refused before spawn", rejected);
    policySelfCheck(demoRoot);
    historyParserSelfCheck();
    const title = [{ label: 'title "ember"', bytes: Buffer.from("ember"), bounded: true }];
    check(
      "dry run: the database needle scan ignores a bounded needle inside catalog text (December, reference_type) and catches it standing alone or at a buffer edge",
      findNeedleBounded(Buffer.from("see December and November"), title) === undefined
        && findNeedleBounded(Buffer.from("is_derived_ember_attribute"), title) === undefined
        && findNeedleBounded(Buffer.from("harbor lantern ember."), title) === 'title "ember"'
        && findNeedleBounded(Buffer.from("ember"), title) === 'title "ember"'
        && findNeedleBounded(Buffer.from("x notes/welcome.md y"), [{ label: "path", bytes: Buffer.from("notes/welcome.md") }]) === "path",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks.every((entry) => entry.passed) ? EXIT_OK : EXIT_FAILED;
}

/** Offline: the proxy policy decides without a socket. */
function policySelfCheck(demoRoot) {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const decide = (command, init) => decideRequest({ method: "POST", pathname: `/api/v0/${command}`, params: new URLSearchParams(init) }, { demoRoot, knownCids: new Set() });
  const refused = [
    decide("key/rm", { arg: KEY }),
    decide("pin/rm", { arg: cid }),
    decide("files/mv", { arg: `${demoRoot}/a` }),
    decide("key/gen", { arg: "obsidian-vault" }),
    decide("files/write", { arg: "/obsidian-vault-staging/x" }),
    decide("files/write", { arg: `${BASE}/mvp07a-demo/x` }),
    decide("files/write", { arg: `${BASE}/mvp08-demo/other-run/x` }),
  ];
  check("dry run: the policy refuses key/rm, pin/rm, files/mv, a foreign key, the staging root, the 07a demo folder and another mvp08 run's folder", refused.every((verdict) => !verdict.allowed));
  const reads = [
    decide("key/list", {}),
    decide("name/resolve", { arg: `/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8`, nocache: "true" }),
    decide("ls", { arg: `/ipfs/${cid}/manifests` }),
    decide("files/stat", { arg: demoRoot }),
    decideRequest({ method: "GET", pathname: `/ipfs/${cid}/manifest.enc`, params: new URLSearchParams() }, { demoRoot, knownCids: new Set() }),
  ];
  check("dry run: the policy allows exactly the reads a pull sends (key/list, name/resolve, ls of /ipfs/<cid>, files/stat, gateway GET) and none of them is mutating", reads.every((verdict) => verdict.allowed && !verdict.mutating));
  check("dry run: the pull trace audit accepts reads and reports a mutating request", pullTraceProblems([{ command: "gateway", mutating: false, allowed: true }]).length === 0 && pullTraceProblems([{ command: "files/write", mutating: true, allowed: true }]).length === 1);
  check("dry run: the cleanup target is strictly below the demo parent and built from a valid run identifier only", cleanupTarget("abcd1234") === `${DEMO_PARENT}/abcd1234` && (() => { try { cleanupTarget("../x"); return false; } catch { return true; } })());
}

/** Offline: the history parser against the line format of cli/history-command.ts, plus the database-directory derivation. */
function historyParserSelfCheck() {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const iso = "2026-10-06T12:34:56.789Z";
  const publishLine = `${iso}  ${"publish".padEnd("conflict".length)}  ${cid}  written 15, removed 0, 42 ms`;
  const pullLine = `${iso}  ${"pull".padEnd("conflict".length)}  ${cid}  fetched 15, unchanged 0, conflicted 0, failed 0, removed remotely 0, kept locally 0, 43 ms`;
  const [publishRow] = parseHistoryLines(`${publishLine}\n`);
  const [pullRow] = parseHistoryLines(`${pullLine}\n`);
  check(
    "dry run: the history parser reads the publish and pull line formats (ISO, kind, root CID, counts)",
    publishRow?.ok === true && publishRow.kind === "publish" && publishRow.rootCid === cid && publishRow.counts?.written === 15 && publishRow.counts?.removed === 0
      && pullRow?.ok === true && pullRow.kind === "pull" && pullRow.counts?.fetched === 15 && pullRow.counts?.kept === undefined && pullRow.counts?.locallyModified === 0,
  );
  check("dry run: the empty-database line parses to no rows, and a malformed line is marked not ok", parseHistoryLines(`${HISTORY_EMPTY_LINE}\n`).length === 0 && parseHistoryLines("not a row\n")[0]?.ok === false);
  check("dry run: the per-device history database directory derives from the env the children get (XDG_STATE_HOME, the deviceStoreDirectory rule)", historyDirOf("/tmp/state-a") === join("/tmp/state-a", "ipfs-sync", "history") && historyDirOf("/tmp/state-a") !== historyDirOf("/tmp/state-b"));
}

// ======================================================================================================================
// The run
// ======================================================================================================================

function sharedTarget(tb, opts) {
  const target = tb.targetFromEnv(process.env);
  for (const url of [target.rpc, target.gateway]) if (!isAllowedUpstream(url, opts.localStub)) throw new Refusal(`upstream ${url} is not ${ALLOWED_HOSTS.join(" or ")}; this script only talks to the shared node's host (unset IPFS_SYNC_RPC_URL and IPFS_SYNC_GATEWAY_URL)`);
  return target;
}

/** Facts printed to stdout as they are learned and stored in the result document (stdout is what survives a crash). */
async function recordPreRun(client, before, facts, opts) {
  const keyId = before.keys.get(KEY);
  let pointerUnknown = false;
  const previousPointer = keyId === undefined ? null : await resolvePreviousPointer(() => client.nameResolve(keyId), { strict: !opts.localStub, acceptUnresolved: opts.acceptUnresolvedPointer, onPointerUnknown: () => { pointerUnknown = true; } });
  facts.preRun = { keyId: keyId ?? null, previousPointer, ...(pointerUnknown ? { pointerUnknown } : {}) };
  facts.baseChildrenBefore = [...before.base.keys()].sort();
  out(formatPointerLine(keyId, previousPointer));
}

/** After the run, in a finally: where the owned key points now, next to the pre-run line, and the exact restore text. The restore is the operator's step. */
async function recordPostRun(client, facts, live) {
  live.postRunStarted = true;
  try {
    const keyId = (await client.keyList()).find((key) => key.name === KEY)?.id;
    const pointer = keyId === undefined ? null : await client.nameResolve(keyId).catch((error) => `unresolved (${firstLine(error instanceof Error ? error.message : String(error))})`);
    facts.postRun = { keyId: keyId ?? null, pointer };
  } catch (error) {
    facts.postRun = { keyId: null, pointer: `unreadable (${firstLine(error instanceof Error ? error.message : String(error))})` };
  }
  facts.restore = restoreInstruction(facts.preRun);
  out("\n-- IPNS pointer of the owned key, before and after --");
  out(formatPointerLine(facts.preRun.keyId ?? undefined, facts.preRun.previousPointer));
  out(formatPostRunLine(facts.postRun.keyId ?? undefined, facts.postRun.pointer));
  out(facts.restore);
}

/** Signal exit: print where the owned key points and the restore text if the pre-run pointer is known, bounded by SIGNAL_POST_RUN_TIMEOUT_MS. */
async function signalPostRun(live, facts) {
  if (live.postRunStarted === true) return;
  if (live.client === undefined || facts.preRun === undefined) {
    out("\nrun ended by a signal before the pre-run pointer was recorded; no request that changes the node had been sent, so there is nothing to restore.");
    return;
  }
  out("\nrun ended by a signal; recording the post-run pointer (best effort)...");
  const result = await bestEffortPostRun(() => recordPostRun(live.client, facts, live), { timeoutMs: SIGNAL_POST_RUN_TIMEOUT_MS });
  if (!result.ok) out(`post-run pointer NOT recorded (${result.reason}). The pre-run line printed earlier is the saved record: ${restoreInstruction(facts.preRun)}`);
}

// ---- step 1: vault A, init and the publish ---------------------------------------------------------------------------

async function stepPublishA(S) {
  out("\n== step 1: device A: fixture vault, init, publish (encrypted) ==");
  const generated = await generateVault(S.A.vault);
  if (!check("step 1: vault A is a generated fixture vault (marker `fixture`)", generated.code === 0 && (await exists(join(S.A.vault, ".ipfs-sync-fixture"))), firstLine(generated.text))) throw new Error("no fixture vault, nothing further can run");
  S.filesA = await walkFiles(S.A.vault);
  S.plainNeedles = plaintextNeedles(S.filesA);
  S.proxy.setNeedles(S.plainNeedles);
  check(`step 1: ${S.filesA.length} generated files; vault B is an empty directory`, S.filesA.length >= MIN_PUBLISHED_FILES && (await exists(S.B.vault)) && (await walkFiles(S.B.vault)).length === 0);

  const init = await S.A.cli("init", [S.A.vault], { extra: ["--passphrase-file", S.passFile] });
  if (!check("step 1: `init --passphrase-file <per-run path>` exits 0 and creates the vault", init.code === 0, init.code === 0 ? "" : scrubbedDetail(init, S.secrets))) throw new Error("init failed, nothing further can run");
  const loaded = await readPassphraseFile(S.tb, S.passFile);
  check("step 1: the passphrase file is 0600, has the generated 5x5 shape and is outside the repository", loaded.shapeOk && loaded.modeOk && loaded.outsideRepo);
  S.passphrase = loaded.passphrase;
  S.secrets.push(...loaded.secrets);
  S.proxy.setNeedles([...S.plainNeedles, ...loaded.secrets.map((text, index) => ({ label: index === 0 ? "passphrase (grouped)" : "passphrase (canonical)", bytes: Buffer.from(text) }))]);
  S.vaultId = parseInitOutput(init.stdout).vaultId;
  check("step 1: init printed the vault id (32 hex characters, kept for --expect-vault-id) and no passphrase", S.vaultId !== undefined && !scrub(init, S.secrets).leaked, S.vaultId === undefined ? scrubbedDetail({ stdout: init.stdout }, S.secrets) : "");
  const writes = S.proxy.log.filter((entry) => entry.mutating && entry.command === "files/write");
  check("step 1: init wrote only keyslots.json to the node", writes.length > 0 && writes.every((entry) => entry.arg === `${S.demoRoot}/keyslots.json`), writes.map((entry) => entry.arg).join(", "));

  S.publishWindow = { start: Date.now() };
  const publish = await S.A.cli("publish", [S.A.vault], { passphraseFile: S.passFile });
  S.publishWindow.end = Date.now();
  S.publishSummary = parsePublishOutput(publish.stdout);
  check("publish (device A): exits 0 and prints no passphrase", publish.code === 0 && !publish.leaked, firstLine(publish.stderr) || `${publish.ms} ms`);
  if (!check(`publish: sequence 1, nothing removed, every published file written, root CID printed`, S.publishSummary.sequence === 1 && S.publishSummary.removed === 0 && (S.publishSummary.written ?? 0) >= MIN_PUBLISHED_FILES && S.publishSummary.rootCid !== undefined, `${S.publishSummary.written} written, ${S.publishSummary.removed} removed, sequence ${S.publishSummary.sequence}, root ${S.publishSummary.rootCid}`)) throw new Error("publish failed, nothing further can run");
  S.rootCid = S.publishSummary.rootCid;
  const keyId = (await S.client.keyList()).find((key) => key.name === KEY)?.id;
  check(`publish: the owned key ${KEY} exists on the node after the publish`, typeof keyId === "string" && keyId !== "");
  S.keyId = keyId;
  await assertDatabaseOnDisk(S, S.A, "A", "the publish child has exited; its row is on disk");
}

/** The recorder runs inside the publish/pull child; the child has exited (its close was awaited), so files under the database directory prove the row survived the process. */
async function assertDatabaseOnDisk(S, device, label, why) {
  const dir = historyDirOf(device.stateHome);
  const files = await listFilesRecursive(dir);
  check(`step: device ${label}'s history database exists on disk at ${dir} (${why})`, files.length > 0, `${files.length} files`);
  return files;
}

// ---- step 2: B's first pull ------------------------------------------------------------------------------------------

async function stepPullB(S) {
  out("\n== step 2: device B: an empty directory pulls A's publish ==");
  S.B.cli = makeCliRunner({ tb: S.tb, cwd: S.cwd, apiUrl: S.apiUrl, configFile: S.B.configFile, demoRoot: S.demoRoot, ownedFlags: ["--owned-key", S.keyId], secrets: () => S.secrets, cli: S.cliPath, device: DEVICE_B, stateHome: S.B.stateHome, localStub: S.opts.localStub });
  const mark = S.proxy.mark();
  S.pullWindow = { start: Date.now() };
  const pull = await S.B.cli("pull", [S.B.vault], { passphraseFile: S.passFile, extra: ["--accept-first-pull", "--expect-vault-id", S.vaultId, "--expect-min-sequence", "1"] });
  S.pullWindow.end = Date.now();
  S.pullSummary = parsePullOutput(pull.stdout);
  check("first pull (device B): exits 0 and prints no passphrase", pull.code === 0 && !pull.leaked, firstLine(pull.stderr) || `${pull.ms} ms`);
  if (!check("first pull: sequence 1, every published file fetched, none unchanged, no conflict, no failure, and the pulled root is A's published root", S.pullSummary.sequence === 1 && (S.pullSummary.fetched ?? 0) >= MIN_PUBLISHED_FILES && S.pullSummary.unchanged === 0 && S.pullSummary.conflicts === 0 && S.pullSummary.integrityFailed === 0 && S.pullSummary.unfetched === 0 && S.pullSummary.rootCid === S.rootCid, `${S.pullSummary.fetched} fetched, ${S.pullSummary.unchanged} unchanged, ${S.pullSummary.conflicts} conflicts, root ${S.pullSummary.rootCid}`)) throw new Error("pull failed, nothing further can run");
  const trace = S.proxy.since(mark);
  for (const entry of trace) S.pullReads.set(entry.command, (S.pullReads.get(entry.command) ?? 0) + 1);
  const problems = pullTraceProblems(trace);
  check(`first pull: the proxy log shows ${trace.length} request(s), none mutating and none outside the pull read set`, problems.length === 0, problems.slice(0, 3).join("; "));
  const present = (await walkFiles(S.B.vault)).map((file) => file.path);
  check(`first pull: B holds ${present.length} files (the fixture marker is not one of them)`, present.length >= MIN_PUBLISHED_FILES && !present.includes(".ipfs-sync-fixture"), present.slice(0, 3).join(", "));
  await assertDatabaseOnDisk(S, S.B, "B", "the pull child has exited; its row is on disk");
}

// ---- step 3: the restart — fresh CLI processes read the on-disk history ----------------------------------------------

function rowInWindow(row, window) {
  return row.occurredAtMs >= window.start - 1000 && row.occurredAtMs <= window.end + 1000;
}

function assertSingleRow(S, label, run, expected) {
  const rows = parseHistoryLines(run.stdout);
  if (!check(`${label}: exits 0, prints no passphrase, and lists exactly one row`, run.code === 0 && !run.leaked && rows.length === 1 && rows[0].ok !== false, `exit ${run.code}: ${firstLine(run.stderr)}; ${rows.length} row(s)`)) return undefined;
  const row = rows[0];
  const countsOk = expected.kind === "publish"
    ? row.counts?.written === expected.summary.written && row.counts?.removed === expected.summary.removed
    : row.counts?.fetched === expected.summary.fetched && row.counts?.unchanged === expected.summary.unchanged && row.counts?.conflicted === (expected.summary.conflicts ?? 0) && row.counts?.failed === 0 && row.counts?.remoteDeleted === (expected.summary.remoteDeleted ?? 0) && row.counts?.locallyModified === (expected.summary.locallyModified ?? 0);
  check(
    `${label}: the row is the ${expected.kind} — kind, the operation's root CID, its counts, and a timestamp inside the operation's window`,
    row.kind === expected.kind && row.rootCid === expected.rootCid && countsOk && rowInWindow(row, expected.window),
    `kind ${row.kind}, root ${row.rootCid}, counts ${JSON.stringify(row.counts)}, at ${row.iso}`,
  );
  return row;
}

async function stepHistory(S) {
  out("\n== step 3: CLI restart — fresh child processes against the same state directories run `ipfs-sync history` (the publish and pull processes are dead) ==");
  const mark = S.proxy.mark();
  const historyA = await S.A.cli("history", []);
  const historyB = await S.B.cli("history", []);
  const limitA = await S.A.cli("history", [], { extra: ["--limit", "1"] });
  const limitB = await S.B.cli("history", [], { extra: ["--limit", "1"] });
  const duringHistory = S.proxy.since(mark);
  check("history: the four history runs sent no request (the proxy log did not grow; the command is fully local)", duringHistory.length === 0, `${duringHistory.length} request(s)`);

  const rowA = assertSingleRow(S, "device A: history", historyA, { kind: "publish", rootCid: S.rootCid, summary: S.publishSummary, window: S.publishWindow });
  const rowB = assertSingleRow(S, "device B: history", historyB, { kind: "pull", rootCid: S.rootCid, summary: S.pullSummary, window: S.pullWindow });

  const limitRowsA = parseHistoryLines(limitA.stdout);
  check("device A: `history --limit 1` exits 0 and prints exactly one row, the same publish row", limitA.code === 0 && !limitA.leaked && limitRowsA.length === 1 && rowA !== undefined && limitRowsA[0].line === rowA.line, `${limitRowsA.length} row(s)`);
  const limitRowsB = parseHistoryLines(limitB.stdout);
  check("device B: `history --limit 1` exits 0 and prints exactly one row, the same pull row", limitB.code === 0 && !limitB.leaked && limitRowsB.length === 1 && rowB !== undefined && limitRowsB[0].line === rowB.line, `${limitRowsB.length} row(s)`);

  S.historyOutputs = [historyA, historyB, limitA, limitB].map((run) => `${run.stdout}\n${run.stderr}`);
}

// ---- step 4: no plaintext in the history output or the raw database bytes ---------------------------------------------

async function stepNoPlaintext(S) {
  out("\n== step 4: no vault path and no fixture note name in the history output or the raw database bytes ==");
  const outNeedles = [
    ...S.plainNeedles,
    { label: `vault path "${S.A.vault}"`, bytes: Buffer.from(S.A.vault) },
    { label: `vault path "${S.B.vault}"`, bytes: Buffer.from(S.B.vault) },
    ...S.secrets.filter((secret) => secret !== "").map((secret) => ({ label: "passphrase", bytes: Buffer.from(secret) })),
  ];
  const outHit = findNeedle(Buffer.from(S.historyOutputs.join("\n")), outNeedles);
  check("step 4: the history output of both devices (plain and --limit 1) holds no vault path, no fixture path segment, file stem, title or body word, and no passphrase spelling", outHit === undefined, outHit ?? "");
  const dbNeedles = databaseNeedles(S.filesA, S.A.vault, S.B.vault, S.secrets);
  for (const [label, device] of [["A", S.A], ["B", S.B]]) {
    const dir = historyDirOf(device.stateHome);
    const scanned = await scanTreeForNeedles(dir, dbNeedles);
    check(`step 4: the raw bytes of device ${label}'s history database (${scanned.fileCount} files, ${scanned.scannedBytes} bytes under ${dir}) hold no vault path, fixture path, file name, note title, body line or passphrase (${dbNeedles.length} needles)`, scanned.hit === undefined, scanned.hit === undefined ? "" : `${scanned.hit} in ${scanned.file}`);
  }
}

// ---- the end-of-run audits --------------------------------------------------------------------------------------------

async function nodeComparison(S, before) {
  out("\n-- what the run changed on the node --");
  const after = await nodeSnapshot(S.client);
  const baseChanges = diffMaps(before.base, after.base);
  const parentChanges = diffMaps(before.demoParent, after.demoParent);
  const keyChanges = diffMaps(before.keys, after.keys);
  const demoName = DEMO_PARENT.slice(BASE.length + 1);
  check(`only ${DEMO_PARENT} changed under ${BASE}`, baseChanges.every((name) => name === demoName), `changed: ${baseChanges.join(", ") || "none"}`);
  check(`only this run's folder ${S.runId} was added under ${DEMO_PARENT}`, parentChanges.every((name) => name === S.runId && !before.demoParent.has(name)), `changed: ${parentChanges.join(", ") || "none"}`);
  check(`no key was changed or removed; at most ${KEY} was added`, keyChanges.every((name) => name === KEY && !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

function proxyAudit(S) {
  out("\n-- proxy audit: every request the CLI sent, from the proxy's own log --");
  const log = S.proxy.log;
  const counts = new Map();
  for (const entry of log) counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
  out(`      requests by RPC path: ${[...counts].map(([command, count]) => `${command} x${count}`).join(", ")}`);
  out(`      reads sent by the pull command: ${[...S.pullReads].map(([command, count]) => `${command} x${count}`).join(", ") || "none"}`);
  check("proxy: no request left the allowlist (no key/rm, no pin/rm, no files/mv, no foreign key, nothing outside the demo root, no staging root)", S.proxy.violations.length === 0, S.proxy.violations.slice(0, 3).map((entry) => `${entry.command}: ${entry.reason}`).join("; "));
  const mutationProblems = mutationLogProblems(log, S.demoRoot);
  check(`proxy: the requests that change the node are only files/write|rm below ${S.demoRoot}, files/mkdir at or below it, key/gen or name/publish of ${KEY}, or pin/add of a CID, and no request names the staging root`, mutationProblems.length === 0, mutationProblems.slice(0, 3).join("; "));
  check(`proxy: every name/publish used the key ${KEY}`, log.filter((entry) => entry.command === "name/publish").every((entry) => entry.key === KEY));
  const leaks = log.filter((entry) => entry.needle !== undefined);
  check("proxy: no request path, query or body carried a recorded plaintext title, path, folder name or body word or the passphrase", leaks.length === 0, leaks.slice(0, 2).map((entry) => `${entry.command} ${entry.needle}`).join("; "));
}

async function runFeature(opts, work, tb, facts, live) {
  const runId = newRunId();
  const demoRoot = demoRootFor(runId);
  const cliPath = opts.cli ?? CLI;
  const stub = opts.localStub ? await startStub(tb) : undefined;
  const upstream = stub === undefined ? sharedTarget(tb, opts) : { rpc: stub.url, gateway: stub.url };
  const configFile = opts.localStub ? join(work, "stub-shared-config.json") : CONFIG_FILE;
  await ensureConfig(configFile);
  const client = readOnly(tb.makeClient(process.env, upstream.rpc, upstream.gateway, demoRoot));
  live.client = client;
  const before = await nodeSnapshot(client);
  await recordPreRun(client, before, facts, opts);
  const explicit = opts.ownedKey === undefined ? [] : [opts.ownedKey];
  assertKeyAdoptable(before.keys, await readOwnedKeys(configFile), explicit);
  const absent = await client.filesStat(demoRoot).then(() => false, () => true);
  if (!absent) throw new Refusal(`${demoRoot} already exists on the node`);
  const cwd = join(work, "cwd");
  const secretsDir = join(work, "secrets");
  await mkdir(cwd, { recursive: true });
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const proxy = createProxy({ upstream, demoRoot });
  const apiUrl = await proxy.start();
  out(`feature operation mvp-08  ${opts.localStub ? "LOCAL STUB" : "shared node"}  upstream ${upstream.rpc}\ndemo root ${demoRoot}\nproxy ${apiUrl}  key ${KEY}  config ${configFile}\ndevices ${DEVICE_A} and ${DEVICE_B}, each with its own vault directory, config and per-user state directory (the history database lives under <state>/ipfs-sync/history)`);
  const S = {
    opts,
    tb,
    work,
    cwd,
    runId,
    demoRoot,
    client,
    proxy,
    stub,
    apiUrl,
    cliPath,
    secrets: [],
    pullReads: new Map(),
    ownedFlags: explicit.flatMap((id) => ["--owned-key", id]),
    passFile: join(secretsDir, "passphrase.txt"),
    A: { vault: join(work, "vault-a"), stateHome: join(work, "state-a") },
    B: { vault: join(work, "vault-b"), stateHome: join(work, "state-b"), configFile: join(work, "config-b.json") },
  };
  await ensureConfig(S.B.configFile);
  await mkdir(S.B.vault, { recursive: true });
  await mkdir(S.A.stateHome, { recursive: true });
  await mkdir(S.B.stateHome, { recursive: true });
  S.A.cli = makeCliRunner({ tb, cwd, apiUrl, configFile, demoRoot, ownedFlags: S.ownedFlags, secrets: () => S.secrets, cli: cliPath, device: DEVICE_A, stateHome: S.A.stateHome, localStub: opts.localStub });
  try {
    await proxySelfTest(demoRoot);
    await guarded("step 1 (device A: init and publish)", () => stepPublishA(S));
    if (S.rootCid !== undefined) await guarded("step 2 (device B: first pull)", () => stepPullB(S));
    if (S.pullSummary?.rootCid !== undefined) {
      await guarded("step 3 (history after the restart)", () => stepHistory(S));
      await guarded("step 4 (no plaintext in the history or the database)", () => stepNoPlaintext(S));
    }
    await guarded("node comparison", () => nodeComparison(S, before));
    proxyAudit(S);
  } finally {
    await recordPostRun(client, facts, live);
    await proxy.stop();
    if (S.passphrase !== undefined) tb.wipe(S.passphrase);
    await stub?.stop();
  }
  return runId;
}

async function cleanupRun(opts) {
  const target = cleanupTarget(opts.cleanup);
  if (opts.dryRun) {
    out(`dry run: would files/stat and then files/rm -r ${target}; nothing else, no key and no pin is touched`);
    return EXIT_OK;
  }
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop08-clean-"));
  try {
    const tb = await buildToolbox(work);
    const upstream = sharedTarget(tb, opts);
    const client = tb.makeClient(process.env, upstream.rpc, upstream.gateway, target);
    const found = await client.filesStat(target).catch(() => undefined);
    if (found === undefined) throw new Refusal(`${target} does not exist on the node; nothing to remove`);
    out(`removing ${target} (root CID ${found.cid}) with files/rm -r; keys, pins and the IPNS record are not touched (this project never unpins)`);
    await client.filesRm(target, { recursive: true });
    check(`${target} is gone from MFS`, await client.filesStat(target).then(() => false, () => true));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks.every((entry) => entry.passed) ? EXIT_OK : EXIT_FAILED;
}

async function writeResult(opts, runId, code, facts) {
  const failed = checks.filter((entry) => !entry.passed);
  const document = { passed: failed.length === 0 && checks.length > 0 && !opts.localStub, status: failed.length === 0 ? "pass" : "fail", mode: opts.localStub ? "local-stub" : "shared-node", runId, demoRoot: runId === undefined ? null : `${DEMO_PARENT}/${runId}`, finishedAt: new Date().toISOString(), exitCode: code, ...facts, checks, skipped: skips, unverified: UNVERIFIED };
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, `${JSON.stringify(document, null, 2)}\n`);
  out(`result written to ${opts.out}`);
}

export async function run(opts) {
  const stale = staleBuildRefusal(opts);
  if (stale !== undefined) throw new Refusal(stale);
  const cli = opts.cli ?? CLI;
  const fresh = checkBuildFresh(cli);
  if (!fresh.ok && !opts.allowStaleBuild) throw new Refusal(fresh.message);
  const facts = { distSha256: distSha256(cli), ...(opts.cli === undefined ? {} : { cli }) };
  out(`${opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli} sha256 ${facts.distSha256}`);
  await acquireLock();
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop08-"));
  // SIGINT, SIGTERM and SIGHUP all remove the work directory (it holds the 0600 passphrase file) before exiting, after a bounded
  // best-effort print of the post-run pointer and the restore text.
  const live = {};
  const onSignal = Object.entries(SIGNAL_EXIT_CODES).map(([signal, code]) => {
    const handler = () => {
      const finish = () => {
        rmSync(work, { recursive: true, force: true });
        process.exit(code);
      };
      signalPostRun(live, facts).then(finish, finish);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  const shown = opts.cli === undefined ? "dist/cli/ipfs-sync.mjs" : cli;
  let runId;
  try {
    const tb = await buildToolbox(work);
    runId = await runFeature(opts, work, tb, facts, live);
  } finally {
    if (opts.keepWork) note(`work directory kept at ${work}; it holds the throwaway vault's passphrase file`);
    else await rm(work, { recursive: true, force: true });
    const sha = distSha256(cli);
    facts.distUnchangedDuringRun = sha === facts.distSha256;
    check(`${shown} was unchanged during the run (sha256 recomputed after it)`, facts.distUnchangedDuringRun, `sha256 ${sha}`);
    for (const [signal, handler] of onSignal) process.off(signal, handler);
  }
  const failed = checks.filter((entry) => !entry.passed);
  out(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length === 0 ? "" : `; failed: ${failed.map((entry) => entry.label).join(" | ")}`}${skips.length === 0 ? "" : `; ${skips.length} skipped`}`);
  out(`\nUnverified even after a pass: ${UNVERIFIED.join("; ")}.`);
  if (!opts.localStub) out(`\nThe demo folder ${DEMO_PARENT}/${runId} stays on the node. To remove it (opt-in): node tools/feature-op-mvp-08.mjs --cleanup ${runId}`);
  const code = failed.length === 0 ? EXIT_OK : EXIT_FAILED;
  await writeResult(opts, runId, code, facts);
  return code;
}

export async function main(argv) {
  let opts;
  try {
    opts = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return EXIT_REFUSED;
  }
  if (opts.help) {
    out(USAGE);
    return EXIT_OK;
  }
  try {
    const unsupported = win32Refusal(process.platform);
    if (unsupported !== undefined) throw new Refusal(unsupported);
    if (opts.cleanup !== undefined) return await cleanupRun(opts);
    return opts.dryRun ? await dryRun(opts) : await run(opts);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`refused: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    process.stderr.write(`feature operation crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return EXIT_FAILED;
  }
}

const isMain = import.meta.main ?? (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
