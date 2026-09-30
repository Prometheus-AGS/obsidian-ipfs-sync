// Feature operation for mvp-05 (plugin pull with a real conflict, fixture-only). One command:
//   node tools/feature-op-mvp-05.mjs [--trigger=manual] [--verify-only [--tamper-expect]] [options]
// Exit codes: 0 every assertion passed, 1 an assertion failed (or the wait timed out), 2 refused or bad usage.
//
// Builds the plugin, makes two throwaway fixture vaults in the OS temp dir with the built plugin installed, publishes a
// baseline from vault 1 with the CLI, creates vault 2 from it with the CLI pull, then makes a remote edit (republished
// from vault 1) and a conflicting local edit in vault 2 and turns one file of vault 2 into a symbolic link. The
// operator (or, with --verify-only, the CLI `pull`) then pulls into vault 2 and the script checks the vault and the node.
// Node mutations: files/write|rm|mkdir under the per-run demo root, pin/add of our own CIDs, name/publish to the owned key
// (all on the publish side, from vault 1). The pull side is audited to make none.
// The machine-readable result goes to the OS temp dir, never into the repository (the delivery freeze fingerprints the repo).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { DEFAULT_TIMEOUT_MINUTES, POLL_MS, Refusal, waitForEnterOrTimeout, waitForNewRoot, waitUntil } from "./feature-op-mvp-04-trigger.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
const PLUGIN_DIST = join(REPO, "dist", "plugin");
const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");
const BASE = "/obsidian-vault-sync";
const DEMO_PARENT = `${BASE}/mvp05-demo`;
const RUN_ID = randomBytes(4).toString("hex");
const DEMO_ROOT = `${DEMO_PARENT}/${RUN_ID}`;
const LOCK_FILE = join(tmpdir(), "ipfs-sync-feature-op-mvp05.lock");
const KEY = "obsidian-vault-sync";
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_OUT = join(CONFIG_DIR, "feature-op-mvp-05.json");
const CONFLICT_NOTE = "notes/welcome.md";
const REMOTE_ONLY_NOTE = "notes/daily/2026-01-01.md";
const PROBE_NOTE = "notes/symlink-probe.md";
const PROBE_ORIGINAL = "symlink probe: original text\n";
const PROBE_REMOTE = "symlink probe: text published from vault 1\n";
const PLUGIN_PATH = ".obsidian/plugins/ipfs-sync";
const MIN_FIXTURE_FILES = 10;
const VERIFY_ONLY_WAIT_MS = 30000;
const SUMMARY_WAIT_MS = 30000;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;
// The operator's real vault. The only use of this path in this file is the guard below that refuses it.
const FORBIDDEN_VAULT_ROOT = "/Users/gqadonis/obsidian";

const assertions = [];
const skipped = [];
const out = (line) => process.stdout.write(`${line}\n`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const exists = (path) => stat(path).then(() => true, () => false);
const cidOfPath = (value) => value.replace(/^\/ipfs\//, "");

function check(label, ok, detail = "") {
  assertions.push({ label, passed: ok, detail });
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  -- ${detail}`}`);
  return ok;
}

function skip(label, reason) {
  skipped.push({ label, reason });
  out(`SKIP  ${label}  -- ${reason}`);
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

const USAGE = `usage: node tools/feature-op-mvp-05.mjs [options]
  --trigger=manual           who runs "Pull vault" in vault 2 (default and only supported value; see below)
  --verify-only              no Obsidian: the CLI \`pull\` stands in for the plugin (symlink rule differs; see the output)
  --tamper-expect            with --verify-only: expect the wrong note to conflict; must exit 1 (proves the assertions bite)
  --with-refusal             also check that Pull in a vault with a non-fixture note is refused (operator step, manual only)
  --evidence <path>          a screenshot or note the operator saved; repeatable; recorded and checked to exist
  --out <file>               where to write the result (default ${DEFAULT_OUT}); never inside the repository
  --owned-key <id>           key ID you confirm is yours, if it exists on the node but is not in ${CONFIG_FILE}
  --timeout-minutes <n>      how long to wait for the pull to show in vault 2 (default ${DEFAULT_TIMEOUT_MINUTES})
  --refusal-wait-seconds <n> how long to wait for the refusal step (default 120)
  --no-build                 use the existing dist/ instead of running pnpm build
--trigger=cli (Obsidian's own CLI) is not enabled for pull: route A is unproven, so it is refused with exit 2.
A --verify-only run writes ${DEFAULT_OUT.replace(/\.json$/, "-verify-only.json")}, never the file a release reads.
exit codes: 0 all assertions passed, 1 an assertion failed or the wait timed out, 2 refused or bad usage`;

function parseArguments(argv) {
  const opts = { trigger: "manual", verifyOnly: false, tamper: false, withRefusal: false, evidence: [], out: undefined, ownedKey: undefined, timeoutMinutes: DEFAULT_TIMEOUT_MINUTES, refusalSeconds: 120, noBuild: false, help: false };
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
    else if (flag === "--with-refusal") opts.withRefusal = true;
    else if (flag === "--evidence") opts.evidence.push(resolve(value()));
    else if (flag === "--out") opts.out = resolve(value());
    else if (flag === "--owned-key") opts.ownedKey = value();
    else if (flag === "--timeout-minutes") opts.timeoutMinutes = number(flag, value());
    else if (flag === "--refusal-wait-seconds") opts.refusalSeconds = number(flag, value());
    else if (flag === "--no-build") opts.noBuild = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Refusal(`unknown option "${argv[i]}"`);
  }
  if (opts.trigger === "cli") throw new Refusal("--trigger=cli is not enabled for pull: Obsidian's CLI route is unproven. Use --trigger=manual.");
  if (opts.trigger !== "manual") throw new Refusal(`--trigger must be manual, got "${opts.trigger}"`);
  if (opts.tamper && !opts.verifyOnly) throw new Refusal("--tamper-expect only makes sense with --verify-only");
  if (opts.withRefusal && opts.verifyOnly) throw new Refusal("--with-refusal is an operator step; it cannot be combined with --verify-only");
  const target = opts.out ?? (opts.verifyOnly ? DEFAULT_OUT.replace(/\.json$/, "-verify-only.json") : DEFAULT_OUT);
  if (target === REPO || target.startsWith(`${REPO}${sep}`)) throw new Refusal(`refusing to write the result into the repository (${target}); the delivery freeze fingerprints the repo`);
  opts.out = target;
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

const runCli = (args, device) => exec(process.execPath, [CLI, ...args], undefined, { IPFS_SYNC_DEVICE: device });
const cliCommon = (explicit) => ["--config", CONFIG_FILE, "--mfs-root", DEMO_ROOT, ...explicit.flatMap((id) => ["--owned-key", id])];
const writtenLine = (stdout) => /^(\d+) written, (\d+) removed$/m.exec(stdout);
const pullSummary = (stdout) => {
  const m = /(\d+) fetched, (\d+) unchanged, (\d+) conflicts, (\d+) failed/.exec(stdout);
  return m === null ? undefined : { fetched: Number(m[1]), unchanged: Number(m[2]), conflicts: Number(m[3]), failed: Number(m[4]) };
};

async function loadClient(work) {
  const outfile = join(work, "feature-op-client.mjs");
  await build({ entryPoints: [join(REPO, "tools", "feature-op-client.ts")], bundle: true, platform: "node", format: "esm", target: "node24", outfile, logLevel: "silent" });
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

/** Everything a pull must leave alone: the demo root, the name, every key, and the folder listing under the base. */
async function nodeSnapshot(client, keyId) {
  const listing = await client.filesLs(BASE);
  const keys = await client.keyList();
  const demo = await client.filesStat(DEMO_ROOT).then((s) => s.cid, () => "absent");
  const resolved = keyId === "" ? "no key" : await client.nameResolve(keyId).catch(() => "unresolved");
  return { entries: new Map(listing.map((e) => [e.name, e.cid])), keys: new Map(keys.map((k) => [k.name, k.id])), demo, resolved };
}

const diffMaps = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort();

function assertKeyAdoptable(snap, ownedKeys, explicit) {
  const nodeId = snap.keys.get(KEY);
  if (nodeId === undefined || ownedKeys.includes(nodeId) || explicit.includes(nodeId)) return;
  throw new Refusal(`key "${KEY}" already exists on the node (ID ${nodeId}) but is not recorded in ${CONFIG_FILE}. If it is yours, re-run with --owned-key ${nodeId}. It is never adopted silently.`);
}

// ---------- vaults and the plugin install ----------

function authSettings(env) {
  const scheme = env.IPFS_SYNC_AUTH_SCHEME ?? "none";
  if (scheme === "basic") return { scheme, user: env.IPFS_SYNC_AUTH_USER ?? "", password: env.IPFS_SYNC_AUTH_PASSWORD ?? "" };
  if (scheme === "bearer") return { scheme, token: env.IPFS_SYNC_AUTH_TOKEN ?? "" };
  if (scheme === "header") return { scheme, headerName: env.IPFS_SYNC_AUTH_HEADER_NAME ?? "", headerValue: env.IPFS_SYNC_AUTH_HEADER_VALUE ?? "" };
  return { scheme: "none" };
}

/** Plugin settings (version 3): the demo root, the owned keys, an empty pull name (the owned key's ID), catch-up off. */
function pluginSettings(endpoints, ownedKeys) {
  return {
    version: 3,
    rpc: { url: endpoints.rpcUrl },
    gateway: { url: endpoints.gatewayUrl },
    publicationKey: KEY,
    mfsRoot: DEMO_ROOT,
    auth: authSettings(process.env),
    userExclusions: [],
    ownedKeys,
    publishIntervalMinutes: 0,
    pullName: "",
    catchUpOnLoad: false,
    maxReadMb: 64,
    kv: {},
  };
}

async function installPlugin(vault, settings) {
  assertSafeDirectory(vault);
  const target = join(vault, ...PLUGIN_PATH.split("/"));
  await mkdir(target, { recursive: true });
  await copyFile(join(PLUGIN_DIST, "main.js"), join(target, "main.js"));
  await copyFile(join(PLUGIN_DIST, "manifest.json"), join(target, "manifest.json"));
  await writeFile(join(vault, ".obsidian", "community-plugins.json"), `${JSON.stringify(["ipfs-sync"])}\n`);
  await writeFile(join(target, "data.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

async function buildStep(opts) {
  out("\n== step 1: build the plugin and the CLI ==");
  if (!opts.noBuild) {
    const built = await exec("pnpm", ["build"], 300000);
    if (!check("pnpm build exits 0", built.code === 0, built.code === 0 ? "" : (built.stderr || built.stdout).trim().split("\n").slice(-3).join(" | "))) return false;
  } else {
    skip("pnpm build", "--no-build: using the existing dist/");
  }
  const files = await Promise.all(["main.js", "manifest.json"].map((name) => exists(join(PLUGIN_DIST, name))));
  check("dist/plugin/main.js and manifest.json exist", files.every(Boolean));
  const bundle = await readFile(join(PLUGIN_DIST, "main.js"), "utf8").catch(() => "");
  const builtIns = bundle.match(/require\((["'])(?!obsidian\1|electron\1)[^"']*\1\)|["']node:[a-z_/]+["']/g) ?? [];
  check("the plugin bundle requires no Node built-in", bundle !== "" && builtIns.length === 0, builtIns.slice(0, 3).join(", "));
  check("the CLI bundle exists", await exists(CLI));
  return files.every(Boolean) && builtIns.length === 0 && (await exists(CLI));
}

async function readManifest(client, rootCid) {
  return JSON.parse(new TextDecoder().decode(await client.gatewayFetch(rootCid, "manifest.json")));
}

async function appendTo(vault, path, text) {
  const full = join(vault, ...path.split("/"));
  const next = `${await readFile(full, "utf8")}${text}`;
  await writeFile(full, next);
  return next;
}

/** Every entry below `root` with lstat data (links are not followed); the hash is of regular files only. */
async function walk(root, dir = "") {
  const found = new Map();
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    const info = await lstat(join(root, path));
    if (entry.isDirectory()) {
      for (const [p, v] of await walk(root, path)) found.set(p, v);
    } else if (info.isSymbolicLink()) {
      found.set(path, { kind: "symlink", size: info.size, mtimeMs: info.mtimeMs });
    } else {
      found.set(path, { kind: "file", size: info.size, mtimeMs: info.mtimeMs, sha256: sha256(await readFile(join(root, path))) });
    }
  }
  return found;
}

/** Files Obsidian itself writes when it first opens a folder as a vault: a .json file directly under .obsidian/. */
const isObsidianConfig = (path) => /^\.obsidian\/[^/]+\.json$/.test(path);
const inPlugins = (path) => path === ".obsidian/plugins" || path.startsWith(".obsidian/plugins/");
const inState = (path) => path === ".ipfs-sync" || path.startsWith(".ipfs-sync/");
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function conflictPattern(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  return new RegExp(`^${escapeRegex(directory)}${escapeRegex(stem)} \\(ipfs conflict (\\d{4}-\\d{2}-\\d{2})(?: \\d+)?\\)${escapeRegex(extension)}$`);
}

const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

async function vaultRecordedRoot(vault) {
  try {
    const parsed = JSON.parse(await readFile(join(vault, ".ipfs-sync", "state.json"), "utf8"));
    return typeof parsed.rootCid === "string" ? parsed.rootCid : undefined;
  } catch {
    return undefined;
  }
}

// ---------- the scenario ----------

async function setupScenario(work, endpoints, explicit) {
  out("\n== step 2: vault 1 (fixture), baseline publish, vault 2 from a CLI pull, plugin in both ==");
  const v1 = join(work, "vault-1");
  const v2 = join(work, "vault-2");
  assertSafeDirectory(v1);
  assertSafeDirectory(v2);
  const generated = await exec(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, v1, "--seed", "20260930"]);
  if (!check("vault 1 generated (marker present)", generated.code === 0 && (await exists(join(v1, ".ipfs-sync-fixture"))), generated.stdout.trim().split("\n")[0])) return undefined;
  await writeFile(join(v1, ...PROBE_NOTE.split("/")), PROBE_ORIGINAL);
  // Installed before the baseline: .obsidian/community-plugins.json is publishable, so it belongs in the baseline and not in the edit.
  await mkdir(join(v1, ".obsidian"), { recursive: true });
  await installPlugin(v1, pluginSettings(endpoints, await readOwnedKeys()));
  const baseline = await runCli(["publish", v1, ...cliCommon(explicit)], "feature-op-mvp05-v1");
  const total = Number(writtenLine(baseline.stdout)?.[1] ?? 0);
  if (!check("baseline publish from vault 1 exits 0 and writes the fixture files", baseline.code === 0 && total >= MIN_FIXTURE_FILES, writtenLine(baseline.stdout)?.[0] ?? baseline.stderr.trim())) return undefined;
  const pulled = await runCli(["pull", v2, ...cliCommon(explicit)], "feature-op-mvp05-v2");
  const base = pullSummary(pulled.stdout);
  if (!check("vault 2 is created by a CLI pull (fresh directory gets the marker and a sync record)", pulled.code === 0 && base?.failed === 0 && (await exists(join(v2, ".ipfs-sync-fixture"))) && (await exists(join(v2, ".ipfs-sync", "state.json"))), pulled.stdout.split("\n").find((l) => l.includes("fetched")) ?? pulled.stderr.trim())) return undefined;
  const owned = await readOwnedKeys();
  for (const vault of [v1, v2]) {
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await installPlugin(vault, pluginSettings(endpoints, owned));
  }
  // The first publish may have created the key: both data.json files now carry its ID (data.json is never published).
  check("plugin installed into both vaults from dist/plugin with settings for the demo root", true, `mfsRoot ${DEMO_ROOT}, key ${KEY}, ${owned.length} owned key(s) seeded, pull name empty, catch-up off`);
  return { v1, v2, baselineRoot: await vaultRecordedRoot(v2) };
}

async function editStep(client, s, explicit, work) {
  out("\n== step 3: remote edit republished from vault 1, conflicting local edit in vault 2, symlink probe ==");
  const remoteX = await appendTo(s.v1, CONFLICT_NOTE, "\nremote text from vault 1\n");
  await appendTo(s.v1, REMOTE_ONLY_NOTE, "\nremote-only text\n");
  await writeFile(join(s.v1, ...PROBE_NOTE.split("/")), PROBE_REMOTE);
  const republish = await runCli(["publish", s.v1, ...cliCommon(explicit)], "feature-op-mvp05-v1");
  const counts = writtenLine(republish.stdout);
  if (!check("republish from vault 1 writes exactly the 3 edited files", republish.code === 0 && counts?.[0] === "3 written, 0 removed", counts?.[0] ?? republish.stderr.trim())) return undefined;
  const newRoot = cidOfPath(await client.nameResolve((await client.keyList()).find((k) => k.name === KEY)?.id ?? ""));
  const manifest = await readManifest(client, newRoot);
  const localX = await appendTo(s.v2, CONFLICT_NOTE, "\nlocal text from vault 2\n");
  const outside = join(work, "outside");
  await mkdir(outside, { recursive: true });
  const target = join(outside, "probe-target.md");
  await writeFile(target, PROBE_ORIGINAL);
  await rm(join(s.v2, ...PROBE_NOTE.split("/")));
  await symlink(target, join(s.v2, ...PROBE_NOTE.split("/")));
  const linked = (await lstat(join(s.v2, ...PROBE_NOTE.split("/")))).isSymbolicLink();
  check("vault 2: the probe note is now a symbolic link to a byte-identical file outside the vault; the conflict note holds a local edit", linked && localX !== remoteX);
  return { newRoot, manifest, remoteX, localX, target, outsideSha: sha256(await readFile(target)), keyId: (await client.keyList()).find((k) => k.name === KEY)?.id ?? "" };
}

function operatorSteps(s, timeoutMinutes) {
  return [
    "== operator steps (trigger=manual) ==",
    `Vault 1 (the remote side, already published): ${s.v1}`,
    `Vault 2 (pull into this one):                 ${s.v2}`,
    "Use only these throwaway vaults. Do not open your real vault for this checkpoint.",
    "1. In Obsidian choose \"Open folder as vault\" and open vault 2. (Vault 1 needs no action; open it too if you want to compare.)",
    "2. When Obsidian asks, allow community plugins. In Settings > Community plugins enable \"IPFS Sync\" (already installed).",
    "3. Open the settings tab \"IPFS Sync\": take a screenshot in the dark theme and one in the light theme.",
    "4. Open the note notes/welcome.md so it is on screen; that is the note with the conflicting local edit.",
    "5. Run the command \"IPFS Sync: Pull vault\" from the command palette (or click the download ribbon icon).",
    "6. Read the notice. Expected: \"Pull complete: 3 fetched, ... 1 conflicts, 0 failed\" and the name of the conflict copy.",
    "   Save the exact text and a screenshot. One notice is expected, updated in place.",
    "7. Reopen the settings tab and screenshot the \"Last activity\" pull line (light and dark if you can).",
    `This script polls vault 2's own sync record (.ipfs-sync/state.json) every ${POLL_MS / 1000} s and continues when it shows a new root.`,
    `It gives up after ${timeoutMinutes} minutes (--timeout-minutes) and then exits 1.`,
  ].join("\n");
}

async function triggerPull(opts, s, scenario, explicit) {
  const baseline = s.baselineRoot;
  if (opts.verifyOnly) {
    out("\n== step 4: --verify-only: the CLI `pull` stands in for the plugin's Pull command ==");
    out("      note: the CLI refuses a symbolic link (mvp-03 rule); the plugin cannot see links and replaces it. Expectations differ for the probe.");
    const run = await runCli(["pull", s.v2, ...cliCommon(explicit)], "obsidian-simulated");
    scenario.cliSummary = pullSummary(run.stdout);
    scenario.cliExit = run.code;
    out(run.stdout.trimEnd().split("\n").map((l) => `      ${l}`).join("\n"));
    return waitForNewRoot({ resolveRoot: async () => (await vaultRecordedRoot(s.v2)) ?? baseline, baseline, timeoutMs: VERIFY_ONLY_WAIT_MS, out });
  }
  out(`\n== step 4: the operator pulls in Obsidian ==\n${operatorSteps(s, opts.timeoutMinutes)}`);
  return waitForNewRoot({ resolveRoot: async () => (await vaultRecordedRoot(s.v2)) ?? baseline, baseline, timeoutMs: opts.timeoutMinutes * 60000, out });
}

// ---------- assertions ----------

async function verifyVault(opts, s, scenario, before, recorded) {
  out("\n== step 5: verify vault 2 ==");
  const after = await walk(s.v2);
  const read = (path) => (after.get(path)?.kind === "file" ? readFile(join(s.v2, path), "utf8") : Promise.resolve(undefined));
  const conflictNote = opts.tamper ? REMOTE_ONLY_NOTE : CONFLICT_NOTE;
  if (opts.tamper) out(`      --tamper-expect: deliberately expecting ${REMOTE_ONLY_NOTE} to be the conflicted note`);
  check("remote text applied: the conflict note now equals what vault 1 published", (await read(CONFLICT_NOTE)) === scenario.remoteX);
  const pattern = conflictPattern(conflictNote);
  const copies = [...after.keys()].filter((p) => pattern.test(p));
  const today = localDate(new Date());
  const dated = copies.length === 1 && [today, scenario.startDate].includes(pattern.exec(copies[0])?.[1] ?? "");
  check(`exactly one dated conflict copy "<stem> (ipfs conflict YYYY-MM-DD).<ext>" exists for ${conflictNote}`, dated, copies.join(", ") || "none");
  const copy = copies[0] === undefined ? undefined : await read(copies[0]);
  check("the conflict copy holds the local text byte for byte", copies.length === 1 && copy === scenario.localX);
  const remoteOnly = after.get(REMOTE_ONLY_NOTE);
  check("the remote-only note was replaced with the published text and got no conflict copy", remoteOnly?.sha256 === scenario.manifest.files[REMOTE_ONLY_NOTE]?.sha256 && !(await hasCopy(after, REMOTE_ONLY_NOTE)));
  probeChecks(opts, s, scenario, after);
  untouchedChecks(before, after, [CONFLICT_NOTE, REMOTE_ONLY_NOTE, PROBE_NOTE], copies);
  pluginFolderChecks(before, after);
  check("the vault's own record shows the new root and manifest.rootCID = CID of <root>/current", recorded === scenario.newRoot && scenario.manifest.rootCID === scenario.currentCid, recorded ?? "no record");
  check("the fixture marker is still present", after.get(".ipfs-sync-fixture")?.kind === "file");
  await summaryChecks(opts, s, scenario);
}

const hasCopy = async (after, path) => [...after.keys()].some((p) => conflictPattern(path).test(p));

function probeChecks(opts, s, scenario, after) {
  const probe = after.get(PROBE_NOTE);
  const outcome = probe === undefined ? "missing" : probe.kind === "symlink" ? "link retained (not written through)" : "link replaced by a regular file";
  out(`      symlink probe outcome: ${outcome}`);
  scenario.probeOutcome = outcome;
  const outsideNow = sha256(scenario.targetBytes());
  check("the file outside the vault that the probe link pointed at is unchanged", outsideNow === scenario.outsideSha, outcome);
  if (opts.verifyOnly) {
    check("verify-only: the CLI refused the linked probe note (link retained, counted failed)", probe?.kind === "symlink" && scenario.cliSummary?.failed === 1 && scenario.cliExit === 1, `exit ${scenario.cliExit}`);
    check("verify-only: CLI counts are 2 fetched, 1 conflicts, 1 failed", scenario.cliSummary?.fetched === 2 && scenario.cliSummary?.conflicts === 1 && scenario.cliSummary?.failed === 1, JSON.stringify(scenario.cliSummary));
  } else {
    check("the probe note ends as a regular file with the published text (the plugin cannot see links)", probe?.kind === "file" && probe.sha256 === scenario.manifest.files[PROBE_NOTE]?.sha256, outcome);
  }
}

function untouchedChecks(before, after, changing, copies) {
  const rewritten = [];
  for (const [path, was] of before) {
    if (changing.includes(path) || inState(path) || isObsidianConfig(path) || inPlugins(path)) continue;
    const now = after.get(path);
    if (now === undefined || now.size !== was.size || now.mtimeMs !== was.mtimeMs || now.sha256 !== was.sha256) rewritten.push(path);
  }
  check("files the pull had no reason to touch were not rewritten (size, mtime and content equal; .obsidian config and .ipfs-sync excluded)", rewritten.length === 0, rewritten.join(", "));
  const added = [...after.keys()].filter((p) => !before.has(p) && !copies.includes(p) && !inState(p) && !isObsidianConfig(p) && !inPlugins(p));
  check("the only new paths are the conflict copy, .ipfs-sync/ state and Obsidian's own .obsidian/*.json files", added.length === 0, added.join(", "));
}

function pluginFolderChecks(before, after) {
  const code = ["main.js", "manifest.json"].map((n) => `${PLUGIN_PATH}/${n}`);
  const same = code.every((p) => before.get(p)?.sha256 !== undefined && before.get(p)?.sha256 === after.get(p)?.sha256);
  const plugins = [...after.keys()].filter(inPlugins);
  const unexpected = plugins.filter((p) => !p.startsWith(`${PLUGIN_PATH}/`) || ![...code, `${PLUGIN_PATH}/data.json`].includes(p));
  check("nothing under .obsidian/plugins/ was written by the pull: plugin code identical, no other file there (data.json holds only the summary)", same && unexpected.length === 0, unexpected.join(", "));
}

async function summaryChecks(opts, s, scenario) {
  if (opts.verifyOnly) {
    skip("plugin lastPull in data.json (fetched 3, conflicts 1, failed 0, counts/CIDs/time only)", "--verify-only: the plugin did not run");
    return;
  }
  const dataPath = join(s.v2, ...PLUGIN_PATH.split("/"), "data.json");
  const summary = await waitUntil(async () => JSON.parse(await readFile(dataPath, "utf8")).lastPull, SUMMARY_WAIT_MS);
  scenario.lastPull = summary;
  const keys = Object.keys(summary ?? {}).sort().join(",");
  check("plugin lastPull reports fetched 3, conflicts 1, failed 0", summary?.fetched === 3 && summary?.conflicts === 1 && summary?.failed === 0, JSON.stringify(summary));
  check("lastPull holds only counts, CIDs and a time (no path text)", keys === "at,conflicts,failed,fetched,manifestCid,remoteDeleted,rootCid,unchanged" && !/\.md/.test(JSON.stringify(summary)), keys);
}

async function nodeAudit(client, keyId, beforePull, startSnap) {
  out("\n== step 6: what the pull and the whole run did to the node ==");
  const afterPull = await nodeSnapshot(client, keyId);
  check("the pull made no node mutation: demo root CID, name resolution, key list and the listing under the base are identical before and after", afterPull.demo === beforePull.demo && afterPull.resolved === beforePull.resolved && diffMaps(afterPull.keys, beforePull.keys).length === 0 && diffMaps(afterPull.entries, beforePull.entries).length === 0);
  const entryChanges = diffMaps(startSnap.entries, afterPull.entries);
  const keyChanges = diffMaps(startSnap.keys, afterPull.keys);
  check(`only ${DEMO_PARENT} changed under ${BASE}`, entryChanges.every((name) => name === "mvp05-demo"), `changed: ${entryChanges.join(", ") || "none"}`);
  check(`no key was changed or removed (only ${KEY} may have been added)`, keyChanges.every((name) => name === KEY && !startSnap.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

async function refusalStep(opts, work, endpoints, client, keyId) {
  out("\n== optional step: Pull in a vault with a non-fixture note must be refused ==");
  const vault = join(work, "no-marker-vault");
  assertSafeDirectory(vault);
  await mkdir(vault, { recursive: true });
  await writeFile(join(vault, "private.md"), "synthetic stand-in for a real note\n");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await installPlugin(vault, pluginSettings(endpoints, await readOwnedKeys()));
  const before = await nodeSnapshot(client, keyId);
  const dataBefore = sha256(await readFile(join(vault, ...PLUGIN_PATH.split("/"), "data.json")));
  out(["Open this folder as a vault in Obsidian, enable \"IPFS Sync\", and run \"IPFS Sync: Pull vault\".", `Vault: ${vault}`,
    "Expected: a notice that only fixture vaults can be synced in this release, and no file changes.",
    `Press Enter here when done, or wait ${opts.refusalSeconds} s.`].join("\n"));
  await waitForEnterOrTimeout({ seconds: opts.refusalSeconds, out, stdin: process.stdin });
  const after = await nodeSnapshot(client, keyId);
  check("refusal vault: the node is unchanged", after.demo === before.demo && after.resolved === before.resolved);
  check("refusal vault: no marker, no sync record, note and data.json untouched", !(await exists(join(vault, ".ipfs-sync-fixture"))) && !(await exists(join(vault, ".ipfs-sync", "state.json"))) && (await readFile(join(vault, "private.md"), "utf8")) === "synthetic stand-in for a real note\n" && sha256(await readFile(join(vault, ...PLUGIN_PATH.split("/"), "data.json"))) === dataBefore);
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

const EVIDENCE_PROMPTS = [
  "the exact text of the Pull notice (expected: Pull complete: 3 fetched, ... 1 conflicts, 0 failed, plus the conflict copy name; one notice, updated in place)",
  "settings-tab screenshots, dark theme and light theme, including the Pull name line, catch-up, read cap and the Last activity pull line",
  "which Obsidian version and platform ran",
  "whether the requestUrl transport reached the node (the pull completing is the evidence)",
  "the symlink probe outcome printed above (link replaced or retained), for the release notes",
  "if --with-refusal ran: the exact text of the refusal notice",
];

async function writeResult(opts, scenario) {
  const failed = assertions.filter((a) => !a.passed);
  const simulated = opts.verifyOnly;
  const doc = {
    // A simulated run can never read as a release pass: `passed` is true only for a real (operator) run with no failed assertion.
    passed: !simulated && failed.length === 0 && assertions.length > 0,
    status: simulated ? "simulated" : failed.length === 0 ? "pass" : "fail",
    simulatedPass: simulated && failed.length === 0,
    mode: simulated ? (opts.tamper ? "verify-only+tamper-expect" : "verify-only") : "manual",
    runId: RUN_ID,
    demoRoot: DEMO_ROOT,
    finishedAt: new Date().toISOString(),
    probeOutcome: scenario.probeOutcome ?? null,
    lastPull: scenario.lastPull ?? null,
    assertions,
    skipped,
    evidencePrompts: simulated ? [] : EVIDENCE_PROMPTS,
    evidenceFiles: await Promise.all(opts.evidence.map(async (path) => ({ path, exists: await exists(path) }))),
  };
  await mkdir(dirname(opts.out), { recursive: true });
  await writeFile(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
  out(`result written to ${opts.out}`);
}

async function run(opts) {
  await acquireLock();
  await mkdir(CONFIG_DIR, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-fop05-"));
  assertSafeDirectory(work);
  const scenario = {};
  try {
    if (!(await buildStep(opts))) return await finish(opts, scenario, EXIT_FAILED);
    const { client, rpcUrl, gatewayUrl, auth } = await loadClient(work);
    const endpoints = { rpcUrl, gatewayUrl };
    out(`\nfeature operation mvp-05  rpc ${rpcUrl}  gateway ${gatewayUrl}  auth ${auth}\nconfig ${CONFIG_FILE}\ndemo root ${DEMO_ROOT}\nmode ${opts.verifyOnly ? "verify-only" : "trigger=manual"}${opts.tamper ? " (tampered expectation)" : ""}`);
    const explicit = opts.ownedKey === undefined ? [] : [opts.ownedKey];
    const startSnap = await nodeSnapshot(client, "");
    assertKeyAdoptable(startSnap, await readOwnedKeys(), explicit);
    const s = await setupScenario(work, endpoints, explicit);
    if (s === undefined) return await finish(opts, scenario, EXIT_FAILED);
    const edits = await editStep(client, s, explicit, work);
    if (edits === undefined) return await finish(opts, scenario, EXIT_FAILED);
    Object.assign(scenario, edits, { startDate: localDate(new Date()), currentCid: (await client.filesStat(`${DEMO_ROOT}/current`)).cid, targetBytes: () => readFileSync(edits.target) });
    const before = await walk(s.v2);
    const beforePull = await nodeSnapshot(client, edits.keyId);
    const recorded = await triggerPull(opts, s, scenario, explicit);
    if (!check("vault 2's own record (.ipfs-sync/state.json) shows a new root after the pull", recorded !== undefined && recorded !== s.baselineRoot, recorded ?? "no new root before the timeout")) return await finish(opts, scenario, EXIT_FAILED);
    await verifyVault(opts, s, scenario, before, recorded);
    await nodeAudit(client, edits.keyId, beforePull, startSnap);
    if (opts.withRefusal) await refusalStep(opts, work, endpoints, client, edits.keyId);
    return await finish(opts, scenario, assertions.some((a) => !a.passed) ? EXIT_FAILED : EXIT_OK);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function finish(opts, scenario, code) {
  const failed = assertions.filter((a) => !a.passed);
  out(`\n${assertions.length - failed.length}/${assertions.length} checks passed${failed.length === 0 ? "" : `; failed: ${failed.map((r) => r.label).join(" | ")}`}${skipped.length === 0 ? "" : `; ${skipped.length} skipped`}`);
  if (!opts.verifyOnly) {
    out("\nEvidence to note from the operator steps (the script cannot capture it):");
    for (const prompt of EVIDENCE_PROMPTS) out(`  - ${prompt}`);
  }
  await writeResult(opts, scenario);
  return code;
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
