// Feature operation for mvp-02 (delta publish). One process, one command:
//   node tools/feature-op-mvp-02.mjs [--owned-key <id>]
// Drives the built CLI (dist/cli/ipfs-sync.mjs) against the node in IPFS_SYNC_* env, publishing a
// synthetic fixture vault to /obsidian-vault-sync/mvp02-demo. The CLI config lives at a stable path
// outside the repo so the generated key stays "owned" on re-runs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");
const DEMO_ROOT = "/obsidian-vault-sync/mvp02-demo";
const KEY = "obsidian-vault-sync";
const FOREIGN_KEY = "obsidian-vault";
const STAGING_ROOT = "/obsidian-vault-staging";
const BASE = "/obsidian-vault-sync";
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const EDITED_NOTE = "notes/welcome.md";
const MIN_FIXTURE_FILES = 10;

const results = [];
const out = (line) => process.stdout.write(`${line}\n`);

function check(label, ok, detail = "") {
  results.push({ label, ok });
  out(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  -- ${detail}`}`);
  return ok;
}

function runProcess(command, args) {
  const started = Date.now();
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: REPO, env: { ...process.env, IPFS_SYNC_DEVICE: "feature-op" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolveRun({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

const runCli = (args) => runProcess(process.execPath, [CLI, ...args]);
const requestsOf = (stdout) => stdout.split("\n").filter((line) => line.startsWith("request ")).map((line) => line.split(" ")[2] ?? "");
const summaryOf = (stdout) => /^(\d+) written, (\d+) removed$/m.exec(stdout);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

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
    // CommonJS dependencies of the shared client call require(); same shim as the CLI bundle.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
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

function diffMaps(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

/** Stop before any mutation if the key exists on the node but this machine does not own it. */
function assertKeyAdoptable(snap, ownedKeys, explicit) {
  const nodeId = snap.keys.get(KEY);
  if (nodeId === undefined || ownedKeys.includes(nodeId) || explicit.includes(nodeId)) return true;
  out(`FAIL  key "${KEY}" already exists on the node (ID ${nodeId}) but is not recorded in ${CONFIG_FILE}.`);
  out(`      The feature operation does not adopt it silently. If it is yours, re-run:`);
  out(`      node tools/feature-op-mvp-02.mjs --owned-key ${nodeId}`);
  return false;
}

async function generateVault(dir) {
  const run = await runProcess(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, dir, "--seed", "20260930"]);
  check("fixture vault generated", run.code === 0, run.stdout.trim() || run.stderr.trim());
  return run.code === 0;
}

async function publishSteps(vault, common, client) {
  out("\n== step 1: first publish of a fresh fixture vault ==");
  const first = await runCli(["publish", vault, "--mfs-root", DEMO_ROOT, ...common]);
  const firstSummary = summaryOf(first.stdout);
  check("publish #1 exits 0", first.code === 0, first.code === 0 ? `${first.ms} ms` : first.stderr.trim());
  check("publish #1 writes the fixture files", Number(firstSummary?.[1] ?? 0) >= MIN_FIXTURE_FILES && firstSummary?.[2] === "0", firstSummary?.[0] ?? "no summary line");
  out(first.stdout.split("\n").filter((l) => /created key|root CID|snapshot/.test(l)).join("\n"));

  out("\n== step 2: edit one note and publish again ==");
  const notePath = join(vault, ...EDITED_NOTE.split("/"));
  const edited = `${await readFile(notePath, "utf8")}\nedited by feature-op at ${new Date().toISOString()}\n`;
  await writeFile(notePath, edited);
  const second = await runCli(["publish", vault, "--mfs-root", DEMO_ROOT, ...common]);
  check("publish #2 writes exactly the edited note", second.code === 0 && summaryOf(second.stdout)?.[0] === "1 written, 0 removed", `${summaryOf(second.stdout)?.[0] ?? second.stderr.trim()} (${second.ms} ms)`);

  const third = await runCli(["publish", vault, "--mfs-root", DEMO_ROOT, ...common]);
  check("publish #3 with no change sends nothing", third.code === 0 && summaryOf(third.stdout)?.[0] === "0 written, 0 removed", `${third.ms} ms`);
  const publishedRoot = /^root CID\s+(\S+)/m.exec(second.stdout)?.[1] ?? "";
  return { edited, publishedRoot, timings: [first.ms, second.ms, third.ms] };
}

async function verifyRemote(client, edited, publishedRoot) {
  out("\n== step 3: resolve the key and read the manifest through the gateway ==");
  const keyId = (await client.keyList()).find((k) => k.name === KEY)?.id ?? "";
  const resolved = await client.nameResolve(keyId);
  const rootCid = (await client.filesStat(DEMO_ROOT)).cid;
  const currentCid = (await client.filesStat(`${DEMO_ROOT}/current`)).cid;
  check("name/resolve returns the root CID printed by publish #2", publishedRoot !== "" && resolved === `/ipfs/${publishedRoot}` && publishedRoot === rootCid, `${resolved}`);
  const manifest = JSON.parse(new TextDecoder().decode(await client.gatewayFetch(rootCid, "manifest.json")));
  check("manifest.json is reachable at <root>/manifest.json through the gateway", manifest.version === 1);
  check("manifest lists the edited note with its new sha256", manifest.files?.[EDITED_NOTE]?.sha256 === sha256(edited), manifest.files?.[EDITED_NOTE]?.sha256 ?? "missing");
  check("manifest rootCID equals the CID of <root>/current", manifest.rootCID === currentCid, currentCid);
  const excluded = Object.keys(manifest.files ?? {}).filter((p) => /^\.trash\/|workspace\.json$|^\.ipfs-sync/.test(p));
  check("manifest lists no excluded path", excluded.length === 0, excluded.join(", "));
  const file = await client.gatewayFetch(rootCid, `current/${EDITED_NOTE}`);
  check("<root>/current/<path> holds the edited note", sha256(new TextDecoder().decode(file)) === sha256(edited));
}

async function refusalSteps(common, snap, work) {
  out("\n== step 4: refusal cases ==");
  const unmarked = await mkdtemp(join(work, "unmarked-"));
  await writeFile(join(unmarked, "note.md"), "synthetic unmarked directory for the refusal test\n");
  const noMarker = await runCli(["publish", unmarked, "--mfs-root", DEMO_ROOT, "--show-request", ...common]);
  check("no marker: exit 2, no request sent", noMarker.code === 2 && requestsOf(noMarker.stdout).length === 0, noMarker.stderr.trim().split("\n")[0]);

  const vault = await mkdtemp(join(work, "refusal-vault-"));
  await writeFile(join(vault, ".ipfs-sync-fixture"), "marker\n");
  await writeFile(join(vault, "a.md"), "a\n");
  const staging = await runCli(["publish", vault, "--mfs-root", STAGING_ROOT, "--show-request", ...common]);
  check("--mfs-root /obsidian-vault-staging: exit 2, no request sent", staging.code === 2 && requestsOf(staging.stdout).length === 0, staging.stderr.trim().split("\n")[0]);

  if (!snap.keys.has(FOREIGN_KEY)) {
    out(`SKIP  --key ${FOREIGN_KEY}: no such key on this node, running it would create one`);
    return;
  }
  const foreign = await runCli(["publish", vault, "--mfs-root", DEMO_ROOT, "--key", FOREIGN_KEY, "--show-request", "--config", CONFIG_FILE]);
  const requests = requestsOf(foreign.stdout);
  const readOnly = requests.length === 1 && requests[0].endsWith("/api/v0/key/list");
  check("--key obsidian-vault without --owned-key: exit 2, only the read-only key/list was sent", foreign.code === 2 && readOnly, `${requests.join(" ")} | ${foreign.stderr.trim().split("\n")[0]}`);
}

async function sideEffects(client, before) {
  out("\n== step 5: what changed on the node ==");
  const after = await snapshot(client);
  const entryChanges = diffMaps(before.entries, after.entries);
  const keyChanges = diffMaps(before.keys, after.keys);
  check(`only ${BASE}/mvp02-demo changed under ${BASE}`, entryChanges.every((name) => name === "mvp02-demo"), `changed: ${entryChanges.join(", ") || "none"}`);
  check(`only the key ${KEY} was added to key/list`, keyChanges.every((name) => name === KEY) && keyChanges.every((name) => !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

async function main() {
  await mkdir(CONFIG_DIR, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-feature-op-"));
  try {
    const { client, rpcUrl, gatewayUrl, auth } = await loadClient(work);
    out(`feature operation mvp-02  rpc ${rpcUrl}  gateway ${gatewayUrl}  auth ${auth}\nconfig ${CONFIG_FILE}\ndemo root ${DEMO_ROOT}`);
    const explicit = process.argv.includes("--owned-key") ? [argValue("--owned-key") ?? ""] : [];
    const before = await snapshot(client);
    if (!assertKeyAdoptable(before, await readOwnedKeys(), explicit)) return 1;
    out(`before: ${before.entries.size} entries under ${BASE}, ${before.keys.size} keys, key ${KEY} ${before.keys.has(KEY) ? "present" : "absent (publish will create it)"}`);
    const common = ["--config", CONFIG_FILE, ...explicit.flatMap((id) => ["--owned-key", id])];
    const vault = join(work, "vault");
    if (!(await generateVault(vault))) return 1;
    const { edited, publishedRoot, timings } = await publishSteps(vault, common, client);
    await verifyRemote(client, edited, publishedRoot);
    await refusalSteps(common, before, work);
    await sideEffects(client, before);
    out(`\nCLI wall time per publish (includes name/publish through the proxy): ${timings.join(" ms, ")} ms`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  out(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`feature operation crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
