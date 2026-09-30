// Feature operation for mvp-04 (plugin publish through the shared engine, fixture-only). One command:
//   node tools/feature-op-mvp-04.mjs [--trigger=manual|cli] [--verify-only [--tamper-expect]] [options]
// Exit codes: 0 every assertion passed, 1 an assertion failed (or the wait timed out), 2 refused or bad usage.
//
// Builds the plugin, makes throwaway fixture vaults in the OS temp dir, installs the built plugin into them,
// publishes a baseline with the CLI, edits one note, lets the plugin publish (operator step, Obsidian's CLI, or,
// with --verify-only, the CLI standing in for the plugin) and checks the node. Node mutations are limited to
// files/write|rm|mkdir under the demo root, pin/add of our own CIDs, and name/publish to the owned key.
// The CLI config is the stable file shared with the mvp-02/03 feature operations, so the created key stays owned;
// a key that exists on the node but is not recorded there is never adopted silently.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  DEFAULT_OBSIDIAN_BIN,
  DEFAULT_REFUSAL_WAIT_SECONDS,
  DEFAULT_TIMEOUT_MINUTES,
  Refusal,
  createObsidianRoute,
  operatorSteps,
  refusalSteps,
  waitForEnterOrTimeout,
  waitForNewRoot,
  waitUntil,
} from "./feature-op-mvp-04-trigger.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
const PLUGIN_DIST = join(REPO, "dist", "plugin");
const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");
const BASE = "/obsidian-vault-sync";
// One tree per run, so concurrent or repeated runs cannot mix trees; still under the allowed prefix.
const DEMO_PARENT = `${BASE}/mvp04-demo`;
const RUN_ID = randomBytes(4).toString("hex");
const DEMO_ROOT = `${DEMO_PARENT}/${RUN_ID}`;
const LOCK_FILE = join(tmpdir(), "ipfs-sync-feature-op-mvp04.lock");
const KEY = "obsidian-vault-sync";
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const EDITED_NOTE = "notes/welcome.md";
const TAMPERED_NOTE = "notes/daily/2026-01-01.md";
const MIN_FIXTURE_FILES = 10;
const PLUGIN_PATH = ".obsidian/plugins/ipfs-sync";
const VERIFY_ONLY_WAIT_MS = 30000;
const IPNS_WAIT_MS = 60000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;
// The operator's real vault. The only use of this path in this file is the guard below that refuses it.
const FORBIDDEN_VAULT_ROOT = "/Users/gqadonis/obsidian";

const results = [];
const out = (line) => process.stdout.write(`${line}\n`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const exists = (path) => stat(path).then(() => true, () => false);

function check(label, ok, detail = "") {
  results.push({ label, ok });
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  -- ${detail}`}`);
  return ok;
}

const isForbidden = (path) => {
  const target = resolve(path);
  return target === FORBIDDEN_VAULT_ROOT || target.startsWith(`${FORBIDDEN_VAULT_ROOT}${sep}`);
};

function assertSafeDirectory(path) {
  if (isForbidden(path)) throw new Refusal(`refusing to use ${path}: it is inside the operator's real vault`);
  if (!resolve(path).startsWith(tmpdir())) throw new Refusal(`refusing to use ${path}: throwaway vaults live in the OS temp directory`);
}

// ---------- arguments ----------

const USAGE = `usage: node tools/feature-op-mvp-04.mjs [options]
  --trigger=manual|cli       who runs "Publish vault" in the throwaway vault (default manual)
  --verify-only              no Obsidian: the CLI publish stands in for the plugin (publishes twice to the demo root)
  --tamper-expect            with --verify-only: expect the wrong note to change; must exit 1 (proves the assertions bite)
  --owned-key <id>           key ID you confirm is yours, if it exists on the node but is not in ${CONFIG_FILE}
  --timeout-minutes <n>      how long to wait for the publish to reach the node (default ${DEFAULT_TIMEOUT_MINUTES})
  --refusal-wait-seconds <n> how long to wait for the refusal check step (default ${DEFAULT_REFUSAL_WAIT_SECONDS})
  --obsidian-bin <path>      Obsidian app binary for --trigger=cli (default ${DEFAULT_OBSIDIAN_BIN})
exit codes: 0 all assertions passed, 1 an assertion failed or the wait timed out, 2 refused or bad usage`;

function parseArguments(argv) {
  const opts = { trigger: "manual", verifyOnly: false, tamper: false, ownedKey: undefined, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, refusalSeconds: DEFAULT_REFUSAL_WAIT_SECONDS, bin: DEFAULT_OBSIDIAN_BIN, help: false };
  const number = (name, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Refusal(`${name} needs a positive number, got "${raw}"`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--trigger") opts.trigger = value();
    else if (flag === "--verify-only") opts.verifyOnly = true;
    else if (flag === "--tamper-expect") opts.tamper = true;
    else if (flag === "--owned-key") opts.ownedKey = value();
    else if (flag === "--timeout-minutes") opts.timeoutMinutes = number(flag, value());
    else if (flag === "--refusal-wait-seconds") opts.refusalSeconds = number(flag, value());
    else if (flag === "--obsidian-bin") opts.bin = value();
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Refusal(`unknown option "${argv[i]}"`);
  }
  if (opts.trigger !== "manual" && opts.trigger !== "cli") throw new Refusal(`--trigger must be manual or cli, got "${opts.trigger}"`);
  if (opts.tamper && !opts.verifyOnly) throw new Refusal("--tamper-expect only makes sense with --verify-only");
  if (opts.verifyOnly && opts.trigger === "cli") throw new Refusal("--verify-only and --trigger=cli exclude each other");
  return opts;
}

// ---------- processes and the node ----------

function exec(command, args, timeoutMs, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: REPO, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolveRun({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

const runCli = (args, device = "feature-op-mvp04") => exec(process.execPath, [CLI, ...args], undefined, { IPFS_SYNC_DEVICE: device });
const cliCommon = (explicit) => ["--config", CONFIG_FILE, "--mfs-root", DEMO_ROOT, ...explicit.flatMap((id) => ["--owned-key", id])];
const writtenLine = (stdout) => /^(\d+) written, (\d+) removed$/m.exec(stdout);

async function loadClient(work) {
  const outfile = join(work, "feature-op-client.mjs");
  await build({
    entryPoints: [join(REPO, "tools", "feature-op-client.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "silent",
  });
  const { createFeatureOpClient } = await import(pathToFileURL(outfile).href);
  return createFeatureOpClient(process.env, DEMO_ROOT);
}

async function readOwnedKeys() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return Array.isArray(parsed.ownedKeys) ? parsed.ownedKeys : [];
  } catch {
    return [];
  }
}

async function snapshot(client) {
  const listing = await client.filesLs(BASE);
  const keys = await client.keyList();
  return { entries: new Map(listing.map((e) => [e.name, e.cid])), keys: new Map(keys.map((k) => [k.name, k.id])) };
}

const diffMaps = (before, after) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort();

function assertKeyAdoptable(snap, ownedKeys, explicit) {
  const nodeId = snap.keys.get(KEY);
  if (nodeId === undefined || ownedKeys.includes(nodeId) || explicit.includes(nodeId)) return;
  throw new Refusal(
    `key "${KEY}" already exists on the node (ID ${nodeId}) but is not recorded in ${CONFIG_FILE}. ` +
      `If it is yours, re-run with --owned-key ${nodeId}. It is never adopted silently.`,
  );
}

// ---------- vaults and the plugin install ----------

function authSettings(env) {
  const scheme = env.IPFS_SYNC_AUTH_SCHEME ?? "none";
  if (scheme === "basic") return { scheme, user: env.IPFS_SYNC_AUTH_USER ?? "", password: env.IPFS_SYNC_AUTH_PASSWORD ?? "" };
  if (scheme === "bearer") return { scheme, token: env.IPFS_SYNC_AUTH_TOKEN ?? "" };
  if (scheme === "header") return { scheme, headerName: env.IPFS_SYNC_AUTH_HEADER_NAME ?? "", headerValue: env.IPFS_SYNC_AUTH_HEADER_VALUE ?? "" };
  return { scheme: "none" };
}

/** Plugin settings (version 2) that point the plugin at the same node and the demo root. */
function pluginSettings(endpoints, ownedKeys) {
  return {
    version: 2,
    rpc: { url: endpoints.rpcUrl },
    gateway: { url: endpoints.gatewayUrl },
    publicationKey: KEY,
    mfsRoot: DEMO_ROOT,
    auth: authSettings(process.env),
    userExclusions: [],
    ownedKeys,
    publishIntervalMinutes: 0,
    kv: {},
  };
}

async function installPlugin(vault) {
  assertSafeDirectory(vault);
  const target = join(vault, ...PLUGIN_PATH.split("/"));
  await mkdir(target, { recursive: true });
  await copyFile(join(PLUGIN_DIST, "main.js"), join(target, "main.js"));
  await copyFile(join(PLUGIN_DIST, "manifest.json"), join(target, "manifest.json"));
  await writeFile(join(vault, ".obsidian", "community-plugins.json"), `${JSON.stringify(["ipfs-sync"])}\n`);
}

const writeSettings = (vault, settings) => writeFile(join(vault, ...PLUGIN_PATH.split("/"), "data.json"), `${JSON.stringify(settings, null, 2)}\n`);

async function buildStep() {
  out("\n== step 1: build the plugin and the CLI ==");
  const built = await exec("pnpm", ["build"], 300000);
  check("pnpm build exits 0", built.code === 0, built.code === 0 ? "" : (built.stderr || built.stdout).trim().split("\n").slice(-3).join(" | "));
  const files = await Promise.all(["main.js", "manifest.json"].map((name) => exists(join(PLUGIN_DIST, name))));
  check("dist/plugin/main.js and manifest.json exist", files.every(Boolean));
  const bundle = await readFile(join(PLUGIN_DIST, "main.js"), "utf8").catch(() => "");
  const builtIns = bundle.match(/require\((["'])(?!obsidian\1|electron\1)[^"']*\1\)|["']node:[a-z_/]+["']/g) ?? [];
  check("the plugin bundle requires no Node built-in", bundle !== "" && builtIns.length === 0, builtIns.slice(0, 3).join(", "));
  check("the CLI bundle exists", await exists(CLI));
  return built.code === 0 && files.every(Boolean) && builtIns.length === 0;
}

async function setupVaults(work, endpoints) {
  out("\n== step 2: throwaway vaults with the plugin installed ==");
  const fixture = join(work, "fixture-vault");
  const noMarker = join(work, "no-marker-vault");
  const generated = await exec(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, fixture, "--seed", "20260930"]);
  if (!check("fixture vault generated (marker present)", generated.code === 0 && (await exists(join(fixture, ".ipfs-sync-fixture"))), generated.stdout.trim().split("\n")[0])) return undefined;
  await mkdir(noMarker, { recursive: true });
  await writeFile(join(noMarker, "private.md"), "synthetic stand-in for a real note\n");
  const owned = await readOwnedKeys();
  for (const vault of [fixture, noMarker]) {
    await installPlugin(vault);
    await writeSettings(vault, pluginSettings(endpoints, owned));
  }
  check("plugin installed into both vaults from dist/plugin with settings for the demo root", true, `mfsRoot ${DEMO_ROOT}, key ${KEY}, ${owned.length} owned key(s) seeded`);
  return { fixture, noMarker };
}

async function readManifest(client, rootCid) {
  return JSON.parse(new TextDecoder().decode(await client.gatewayFetch(rootCid, "manifest.json")));
}

const cidOfPath = (value) => value.replace(/^\/ipfs\//, "");

async function baselineStep(client, vaults, explicit, endpoints) {
  out("\n== step 3: baseline publish of the fixture vault with the CLI ==");
  const run = await runCli(["publish", vaults.fixture, ...cliCommon(explicit)]);
  const counts = writtenLine(run.stdout);
  const total = Number(counts?.[1] ?? 0);
  check("baseline publish exits 0 and writes the fixture files", run.code === 0 && total >= MIN_FIXTURE_FILES, `${counts?.[0] ?? run.stderr.trim()}`);
  if (run.code !== 0) return undefined;
  const keyId = (await client.keyList()).find((k) => k.name === KEY)?.id ?? "";
  // The publish may have created the key: seed its ID into the plugin settings (data.json is never published).
  const owned = await readOwnedKeys();
  for (const vault of [vaults.fixture, vaults.noMarker]) await writeSettings(vault, pluginSettings(endpoints, owned));
  const root = cidOfPath(await client.nameResolve(keyId));
  const printed = /^root CID\s+(\S+)/m.exec(run.stdout)?.[1];
  check("the IPNS name resolves to the published baseline root", keyId !== "" && root === printed, root);
  return { keyId, root, manifest: await readManifest(client, root), total };
}

async function editNote(vault) {
  const path = join(vault, ...EDITED_NOTE.split("/"));
  const edited = `${await readFile(path, "utf8")}\nedited by feature-op-mvp-04 at ${new Date().toISOString()}\n`;
  await writeFile(path, edited);
  return sha256(edited);
}

/**
 * Files Obsidian itself writes when it first opens a folder as a vault (app.json, appearance.json, core-plugins.json, ...):
 * a .json file directly under .obsidian/. Never anything under .obsidian/plugins/, never a note or another vault path.
 */
const isObsidianConfig = (path) => /^\.obsidian\/[^/]+\.json$/.test(path);

// ---------- triggers ----------

async function triggerPublish(opts, vaults, ctx) {
  if (opts.verifyOnly) {
    out("\n== step 5: --verify-only: the CLI publish stands in for the plugin's Publish command ==");
    const run = await runCli(["publish", vaults.fixture, ...cliCommon(ctx.explicit)], "obsidian-simulated");
    const counts = writtenLine(run.stdout);
    check("simulated publish exits 0 with exactly 1 written, 0 removed", run.code === 0 && counts?.[0] === "1 written, 0 removed", counts?.[0] ?? run.stderr.trim());
    return run.code === 0;
  }
  if (opts.trigger === "cli") return routeA(opts, vaults);
  out(`\n== step 5: the operator publishes from Obsidian ==\n${operatorSteps({ fixtureVault: vaults.fixture, timeoutMinutes: opts.timeoutMinutes })}`);
  return true;
}

async function routeA(opts, vaults) {
  out("\n== step 5: route A, Obsidian's own CLI (every call carries vault=<throwaway>) ==");
  const route = createObsidianRoute({
    bin: opts.bin,
    vaultName: basename(vaults.fixture),
    vaultPath: vaults.fixture,
    isForbidden,
    exec: (bin, args, timeoutMs) => exec(bin, args, timeoutMs),
    realpath,
  });
  const result = await route.publish();
  for (const entry of result.transcript) out(`      ${entry.step} -> exit ${entry.code} ${entry.stdout || entry.stderr}`.trimEnd());
  check("route A: enable plugin and run ipfs-sync:publish-vault", result.ok);
  return result.ok;
}

/** The root the throwaway vault itself recorded after its last publish (its .ipfs-sync/state.json), or undefined. */
async function vaultRecordedRoot(vault) {
  try {
    const parsed = JSON.parse(await readFile(join(vault, ".ipfs-sync", "state.json"), "utf8"));
    return typeof parsed.rootCid === "string" ? parsed.rootCid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The operator's publish is recognised by the vault's OWN record changing from its baseline value, never by
 * "some IPNS root changed" (another run of this script shares the key). Returns the recorded root or undefined on timeout.
 */
async function observeVaultPublish(opts, vault, baseline) {
  const timeoutMs = opts.verifyOnly ? VERIFY_ONLY_WAIT_MS : opts.timeoutMinutes * 60000;
  return waitForNewRoot({ resolveRoot: async () => (await vaultRecordedRoot(vault)) ?? baseline.root, baseline: baseline.root, timeoutMs, out });
}

// ---------- assertions ----------

function checkChangedPaths(expected, changed, baseline, manifest) {
  check(`${expected} changed and its new sha256 equals the edited content`, changed.includes(expected) && manifest.files[expected]?.sha256 === baseline.editedSha256, `changed: ${changed.join(", ") || "none"}`);
  const others = changed.filter((p) => p !== expected);
  const config = others.filter(isObsidianConfig);
  const unexpected = others.filter((p) => !isObsidianConfig(p));
  out(`      Obsidian-owned config paths observed: ${config.length === 0 ? "none" : config.join(", ")}`);
  check("every other changed or added path is a .json config file directly under .obsidian/ (never .obsidian/plugins/, notes or attachments)", unexpected.length === 0, unexpected.join(", "));
  const removed = Object.keys(baseline.manifest.files).filter((p) => manifest.files[p] === undefined);
  check("no path was removed", removed.length === 0, removed.join(", "));
  const drifted = Object.keys(baseline.manifest.files).filter((p) => p !== EDITED_NOTE && !isObsidianConfig(p) && baseline.manifest.files[p].sha256 !== manifest.files[p]?.sha256);
  check("the baseline notes and attachments other than the edited note are byte-identical", drifted.length === 0, drifted.join(", "));
}

async function verifyPublish(opts, client, vaults, baseline, newRoot, explicit) {
  out("\n== step 6: verify the published result ==");
  if (!check("the vault's own record (.ipfs-sync/state.json) shows a new root after the publish", newRoot !== undefined && newRoot !== baseline.root, newRoot ?? "no new root before the timeout")) return;
  const resolvesTo = await waitUntil(async () => (cidOfPath(await client.nameResolve(baseline.keyId)) === newRoot ? newRoot : undefined), IPNS_WAIT_MS);
  if (!check("the IPNS name (nocache) resolves to that same root", resolvesTo === newRoot, resolvesTo === newRoot ? newRoot : "IPNS resolves elsewhere: another publisher used the key")) return;
  const manifest = await readManifest(client, newRoot);
  const expected = opts.tamper ? TAMPERED_NOTE : EDITED_NOTE;
  if (opts.tamper) out(`      --tamper-expect: deliberately expecting ${TAMPERED_NOTE} to be the changed note`);
  const paths = new Set([...Object.keys(baseline.manifest.files), ...Object.keys(manifest.files)]);
  const changed = [...paths].filter((p) => baseline.manifest.files[p]?.sha256 !== manifest.files[p]?.sha256).sort();
  checkChangedPaths(expected, changed, baseline, manifest);
  const currentCid = (await client.filesStat(`${DEMO_ROOT}/current`)).cid;
  check("manifest.rootCID equals the CID of <root>/current", manifest.rootCID === currentCid, currentCid);
  await verifyState(vaults.fixture, manifest, currentCid);
  const status = await runCli(["status", ...cliCommon(explicit)]);
  out(status.stdout.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
  check("ipfs-sync status runs against the same endpoints and exits 0", status.code === 0, status.code === 0 ? "" : status.stderr.trim());
}

async function verifyState(vault, manifest, currentCid) {
  const state = JSON.parse(await readFile(join(vault, ".ipfs-sync", "state.json"), "utf8"));
  check("the vault's record holds this manifest and manifest.rootCID = CID of <root>/current", state.manifest?.rootCID === manifest.rootCID && manifest.rootCID === currentCid, currentCid);
}

async function refusalCheck(opts, client, vaults, baseline, explicit) {
  out("\n== step 7: refusal check on a vault without the fixture marker ==");
  const dataBefore = sha256(await readFile(join(vaults.noMarker, ...PLUGIN_PATH.split("/"), "data.json")));
  const rootBefore = cidOfPath(await client.nameResolve(baseline.keyId));
  const demoBefore = (await client.filesStat(DEMO_ROOT)).cid;
  if (opts.verifyOnly) {
    const run = await runCli(["publish", vaults.noMarker, "--show-request", ...cliCommon(explicit)]);
    const requests = run.stdout.split("\n").filter((l) => l.startsWith("request "));
    check("the guard refuses the vault: nonzero exit and no request sent", run.code !== 0 && requests.length === 0, run.stderr.trim().split("\n")[0]);
  } else {
    out(refusalSteps({ noMarkerVault: vaults.noMarker, waitSeconds: opts.refusalSeconds }));
    await waitForEnterOrTimeout({ seconds: opts.refusalSeconds, out, stdin: process.stdin });
  }
  check("no new IPNS root", cidOfPath(await client.nameResolve(baseline.keyId)) === rootBefore);
  check("the demo root on the node is unchanged", (await client.filesStat(DEMO_ROOT)).cid === demoBefore);
  const dataAfter = sha256(await readFile(join(vaults.noMarker, ...PLUGIN_PATH.split("/"), "data.json")));
  check("the marker-less vault's data.json is unchanged", dataBefore === dataAfter);
  check("no sync record was written into the marker-less vault", !(await exists(join(vaults.noMarker, ".ipfs-sync", "state.json"))));
}

async function nodeStateCheck(client, before) {
  out("\n== step 8: what changed on the node ==");
  const after = await snapshot(client);
  const entryChanges = diffMaps(before.entries, after.entries);
  const keyChanges = diffMaps(before.keys, after.keys);
  check(`only ${DEMO_PARENT} changed under ${BASE}`, entryChanges.every((name) => name === "mvp04-demo"), `changed: ${entryChanges.join(", ") || "none"}`);
  check(`no key was changed or removed (only ${KEY} may have been added)`, keyChanges.every((name) => name === KEY && !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

/** One run at a time: the demo key and the shared config are single-writer. A stale lock (dead pid) is replaced. */
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(LOCK_FILE, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      process.on("exit", () => {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          // Already gone.
        }
      });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number((await readFile(LOCK_FILE, "utf8").catch(() => "")).trim());
      const alive = Number.isInteger(pid) && pid > 0 && (() => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } })();
      if (alive) throw new Refusal(`another run of this feature operation is in progress (pid ${pid}, lock ${LOCK_FILE}); wait for it to finish`);
      await rm(LOCK_FILE, { force: true });
    }
  }
  throw new Refusal(`could not take the lock ${LOCK_FILE}`);
}

async function run(opts) {
  await acquireLock();
  await mkdir(CONFIG_DIR, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop04-"));
  assertSafeDirectory(work);
  try {
    if (!(await buildStep())) return EXIT_FAILED;
    const { client, rpcUrl, gatewayUrl, auth } = await loadClient(work);
    const endpoints = { rpcUrl, gatewayUrl };
    out(`\nfeature operation mvp-04  rpc ${rpcUrl}  gateway ${gatewayUrl}  auth ${auth}\nconfig ${CONFIG_FILE}\ndemo root ${DEMO_ROOT}\nmode ${opts.verifyOnly ? "verify-only" : `trigger=${opts.trigger}`}${opts.tamper ? " (tampered expectation)" : ""}`);
    const explicit = opts.ownedKey === undefined ? [] : [opts.ownedKey];
    const before = await snapshot(client);
    assertKeyAdoptable(before, await readOwnedKeys(), explicit);
    const vaults = await setupVaults(work, endpoints);
    if (vaults === undefined) return EXIT_FAILED;
    const baseline = await baselineStep(client, vaults, explicit, endpoints);
    if (baseline === undefined) return EXIT_FAILED;
    baseline.editedSha256 = await editNote(vaults.fixture);
    baseline.recorded = await vaultRecordedRoot(vaults.fixture);
    if (baseline.recorded !== baseline.root) throw new Error("the baseline record of the vault does not match the published root");
    const triggered = await triggerPublish(opts, vaults, { explicit });
    const newRoot = triggered ? await observeVaultPublish(opts, vaults.fixture, baseline) : undefined;
    await verifyPublish(opts, client, vaults, baseline, newRoot, explicit);
    if (newRoot !== undefined) await refusalCheck(opts, client, vaults, baseline, explicit);
    await nodeStateCheck(client, before);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  out(`\n${results.length - failed.length}/${results.length} checks passed${failed.length === 0 ? "" : `; failed: ${failed.map((r) => r.label).join(" | ")}`}`);
  if (!opts.verifyOnly) {
    out("\nEvidence to note from the operator steps (the script cannot capture it):");
    out("  - the exact text of the Publish notice (expected: \"published: 1 written, 0 removed\", plus any config files Obsidian wrote)");
    out("  - the settings-tab screenshots, dark theme and light theme");
    out("  - the exact text of the refusal notice in the marker-less vault");
    out("  - which Obsidian version ran, and whether the requestUrl transport reached the node");
  }
  return failed.length === 0 ? EXIT_OK : EXIT_FAILED;
}

async function main() {
  let opts;
  try {
    opts = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return EXIT_REFUSED;
  }
  if (opts.help) {
    out(USAGE);
    return EXIT_OK;
  }
  try {
    return await run(opts);
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`refused: ${error.message}\n`);
      return EXIT_REFUSED;
    }
    process.stderr.write(`feature operation crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILED;
  }
}

process.exitCode = await main();
