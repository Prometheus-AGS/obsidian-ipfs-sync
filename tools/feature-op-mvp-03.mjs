// Feature operation for mvp-03 (delta pull, conflict policy). One process, one command:
//   node tools/feature-op-mvp-03.mjs [--owned-key <id>]
// Drives the built CLI (dist/cli/ipfs-sync.mjs) against the node in IPFS_SYNC_* env. Node writes happen
// only when it publishes fixture vault A to /obsidian-vault-sync/mvp03-demo (twice); every pull is read-only
// and its request trace is audited. The CLI config is the same stable file mvp-02's feature operation uses
// (outside the repo), so the generated key stays "owned"; an unrecorded existing key is never adopted silently.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");
const DEMO_ROOT = "/obsidian-vault-sync/mvp03-demo";
const KEY = "obsidian-vault-sync";
const BASE = "/obsidian-vault-sync";
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const EDITED_NOTE = "notes/welcome.md";
const MIN_FIXTURE_FILES = 10;
const STATE_DIR = ".ipfs-sync";
const MARKER = ".ipfs-sync-fixture";
const SUMMARY = /^(\d+) fetched, (\d+) unchanged, (\d+) conflicts, (\d+) failed, (\d+) remote-deleted, (\d+) locally modified$/m;

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
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function summaryOf(stdout) {
  const match = SUMMARY.exec(stdout);
  if (match === null) return undefined;
  const [, fetched, unchanged, conflicts, failed, remoteDeleted, locallyModified] = match.map(Number);
  return { line: match[0], fetched, unchanged, conflicts, failed, remoteDeleted, locallyModified };
}

const publishSummary = (stdout) => /^(\d+) written, (\d+) removed$/m.exec(stdout);

/** Every request line printed by --show-request: [method, url]. */
function requestsOf(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("request "))
    .map((line) => line.split(" ").slice(1, 3));
}

function isReadOnlyRequest([method, url]) {
  const path = new URL(url).pathname;
  if (method === "GET") return path.startsWith("/ipfs/");
  return method === "POST" && (path.endsWith("/api/v0/name/resolve") || path.endsWith("/api/v0/key/list"));
}

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
  out(`      node tools/feature-op-mvp-03.mjs --owned-key ${nodeId}`);
  return false;
}

/** Vault-relative path -> sha256 and mtime of every file, without the state folder and the marker. */
async function readTree(dir) {
  const files = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== STATE_DIR) await walk(full);
      } else if (entry.isFile() && entry.name !== MARKER) {
        const [data, info] = [await readFile(full), await stat(full)];
        files.set(relative(dir, full).split("\\").join("/"), { sha256: sha256(data), mtimeMs: info.mtimeMs, text: data });
      }
    }
  }
  await walk(dir);
  return files;
}

const exists = (path) => stat(path).then(() => true, () => false);

async function generateVault(dir) {
  const run = await runProcess(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, dir, "--seed", "20260930"]);
  check("fixture vault A generated", run.code === 0, run.stdout.trim() || run.stderr.trim());
  return run.code === 0;
}

const state = { pullRequests: [] };

async function pull(dir, extra, common) {
  const run = await runCli(["pull", dir, "--mfs-root", DEMO_ROOT, "--show-request", ...common, ...extra]);
  state.pullRequests.push(...requestsOf(run.stdout));
  return { ...run, summary: summaryOf(run.stdout) };
}

async function publishFirst(vaultA, common) {
  out("\n== step 1: publish fixture vault A ==");
  const first = await runCli(["publish", vaultA, "--mfs-root", DEMO_ROOT, ...common]);
  const written = publishSummary(first.stdout);
  const count = Number(written?.[1] ?? 0);
  check("publish #1 exits 0 and writes the fixture files", first.code === 0 && count >= MIN_FIXTURE_FILES && written?.[2] === "0", `${written?.[0] ?? first.stderr.trim()} (${first.ms} ms)`);
  const currentCid = /^snapshot\s+(\S+)/m.exec(first.stdout)?.[1] ?? "";
  out(first.stdout.split("\n").filter((l) => /created key|root CID|snapshot/.test(l)).join("\n"));
  return { count, currentCid, ok: first.code === 0 && currentCid !== "" };
}

async function firstPull(vaultA, dirB, count, common) {
  out("\n== step 2: pull into an absent directory B ==");
  const original = await readTree(vaultA);
  const run = await pull(dirB, [], common);
  check("pull #1 exits 0 with N fetched, 0 conflicts, 0 failed", run.code === 0 && run.summary?.fetched === count && run.summary?.conflicts === 0 && run.summary?.failed === 0, `${run.summary?.line ?? run.stderr.trim()} (${run.ms} ms)`);
  const pulled = await readTree(dirB);
  const differing = [...pulled].filter(([path, file]) => original.get(path)?.sha256 !== file.sha256);
  check("every pulled file has the sha256 of A's file", pulled.size === count && differing.length === 0, `${pulled.size} files, ${differing.length} differ`);
  check("the fixture marker exists in B", await exists(join(dirB, MARKER)));
  check("no temp file is left in B", (await readdir(join(dirB, STATE_DIR, "tmp")).catch(() => [])).length === 0);
  return { original, pulled };
}

async function conflictSteps(vaultA, dirB, count, pulled, common) {
  out("\n== step 3: edit the same note differently in A and B, publish A ==");
  const remoteText = `${pulled.get(EDITED_NOTE).text.toString("utf8")}\nremote edit by feature-op ${new Date().toISOString()}\n`;
  const localText = `${pulled.get(EDITED_NOTE).text.toString("utf8")}\nlocal edit by feature-op ${new Date().toISOString()}\n`;
  await writeFile(join(vaultA, ...EDITED_NOTE.split("/")), remoteText);
  await writeFile(join(dirB, ...EDITED_NOTE.split("/")), localText);
  const second = await runCli(["publish", vaultA, "--mfs-root", DEMO_ROOT, ...common]);
  check("publish #2 writes exactly the edited note", second.code === 0 && publishSummary(second.stdout)?.[0] === "1 written, 0 removed", `${publishSummary(second.stdout)?.[0] ?? second.stderr.trim()} (${second.ms} ms)`);

  out("\n== step 4: pull into B (conflict) ==");
  const run = await pull(dirB, [], common);
  const s = run.summary;
  check("pull #2: 1 fetched, N-1 unchanged, 1 conflicts, 0 failed, exit 0", run.code === 0 && s?.fetched === 1 && s?.unchanged === count - 1 && s?.conflicts === 1 && s?.failed === 0, `${s?.line ?? run.stderr.trim()} (${run.ms} ms)`);
  const after = await readTree(dirB);
  const copyPath = EDITED_NOTE.replace(/\.md$/, ` (ipfs conflict ${localDate()}).md`);
  check("the edited note holds the remote text", after.get(EDITED_NOTE)?.text.toString("utf8") === remoteText);
  check(`the conflict copy keeps the extension and holds the local text byte for byte (${copyPath})`, after.get(copyPath)?.text.toString("utf8") === localText && after.get(copyPath)?.sha256 === sha256(localText));
  const moved = [...pulled].filter(([path, file]) => path !== EDITED_NOTE && after.get(path)?.mtimeMs !== file.mtimeMs);
  check("the other files' modification times are unchanged", moved.length === 0, moved.map(([p]) => p).join(", "));
  return { remoteText, copyPath, after };
}

async function repullSteps(dirB, count, copyPath, common) {
  out("\n== step 5: pull again ==");
  const before = await readTree(dirB);
  const run = await pull(dirB, [], common);
  check("pull #3: 0 fetched, no new conflict", run.code === 0 && run.summary?.fetched === 0 && run.summary?.conflicts === 0 && run.summary?.unchanged === count, run.summary?.line ?? run.stderr.trim());
  const after = await readTree(dirB);
  const copies = [...after.keys()].filter((p) => p.includes("(ipfs conflict"));
  check("still exactly one conflict copy", copies.length === 1 && copies[0] === copyPath, copies.join(", "));
  check("no file was rewritten", [...before].every(([p, f]) => after.get(p)?.mtimeMs === f.mtimeMs));
}

async function failClosedStep(client, work, count, common) {
  out("\n== step 6: fail closed on a manifest with one wrong sha256 ==");
  const rootCid = (await client.filesStat(DEMO_ROOT)).cid;
  const manifest = JSON.parse(new TextDecoder().decode(await client.gatewayFetch(rootCid, "manifest.json")));
  const victim = Object.keys(manifest.files).sort().find((p) => p !== EDITED_NOTE);
  const real = manifest.files[victim].sha256;
  manifest.files[victim].sha256 = `${real[0] === "0" ? "1" : "0"}${real.slice(1)}`;
  const manifestPath = join(work, "edited-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const dirC = join(work, "vault-c");
  const run = await pull(dirC, ["--manifest-file", manifestPath], common);
  check("pull --manifest-file: exit 1 with 1 failed", run.code === 1 && run.summary?.failed === 1 && run.summary?.fetched === count - 1, `${run.summary?.line ?? run.stderr.trim()} (${run.ms} ms)`);
  check(`the file with the wrong sha256 is absent from C (${victim})`, !(await exists(join(dirC, ...victim.split("/")))));
  const present = await readTree(dirC);
  check("the other files are present and correct", present.size === count - 1 && [...present].every(([p, f]) => manifest.files[p]?.sha256 === f.sha256));
  check("no temp file is left in C", (await readdir(join(dirC, STATE_DIR, "tmp")).catch(() => [])).length === 0);
  check("stderr names the failed file", run.stderr.includes(victim));
}

async function restoreStep(work, original, firstCurrentCid, common) {
  out("\n== step 7: restore the first snapshot with --manifest ==");
  const dirD = join(work, "vault-d");
  const run = await pull(dirD, ["--manifest", firstCurrentCid], common);
  check("pull --manifest <first currentCID>: exit 0", run.code === 0 && run.summary?.failed === 0, `${run.summary?.line ?? run.stderr.trim()} (${run.ms} ms)`);
  const restored = await readTree(dirD);
  const original_x = original.get(EDITED_NOTE)?.sha256;
  check("X holds its original text", restored.get(EDITED_NOTE)?.sha256 === original_x);
  check("every restored file equals A's first published content", [...restored].every(([p, f]) => original.get(p)?.sha256 === f.sha256));
  check("restore into a fresh directory writes no sync record", !(await exists(join(dirD, STATE_DIR, "state.json"))));
  check("stderr carries the record-not-advanced notice", run.stderr.includes(`restored from ${firstCurrentCid}; sync record not advanced`));
}

async function restoreKeepsRecord(dirB, firstCurrentCid, common) {
  out("\n== step 7b: a restore into the synced vault B does not advance its record ==");
  const statePath = join(dirB, STATE_DIR, "state.json");
  const before = await readFile(statePath);
  const run = await pull(dirB, ["--manifest", firstCurrentCid], common);
  const after = await readFile(statePath);
  check("pull --manifest into B: exit 0", run.code === 0 && run.summary?.failed === 0, run.summary?.line ?? run.stderr.trim());
  check("state.json is byte-identical before and after the restore", before.equals(after), `${sha256(before).slice(0, 12)} vs ${sha256(after).slice(0, 12)}`);
}

async function refusalSteps(work, common) {
  out("\n== step 8: guard refusals (no request may be sent) ==");
  const real = join(work, "real-vault");
  await mkdir(real);
  await writeFile(join(real, "private.md"), "synthetic stand-in for a real note\n");
  const refused = await pull(real, [], common);
  check("non-empty directory without the marker: exit 2, no request", refused.code === 2 && requestsOf(refused.stdout).length === 0, refused.stderr.trim().split("\n")[0]);
  check("the refused directory is unchanged", (await readdir(real)).join(",") === "private.md");
  const conflicting = await runCli(["pull", join(work, "never"), "--manifest", "bafyx", "--manifest-file", "x.json", "--show-request", ...common]);
  check("--manifest with --manifest-file: exit 2, no request", conflicting.code === 2 && requestsOf(conflicting.stdout).length === 0);
}

function auditRequests() {
  out("\n== step 9: request audit for every pull ==");
  const offenders = state.pullRequests.filter((request) => !isReadOnlyRequest(request));
  const kinds = new Map();
  for (const [method, url] of state.pullRequests) {
    const path = new URL(url).pathname;
    const kind = path.startsWith("/ipfs/") ? "gateway GET" : path.replace(/^.*\/api\/v0\//, "rpc ");
    kinds.set(`${method} ${kind}`, (kinds.get(`${method} ${kind}`) ?? 0) + 1);
  }
  out(`      ${state.pullRequests.length} requests: ${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  check("every pull request was a name resolve, a key list or a gateway GET", state.pullRequests.length > 0 && offenders.length === 0, offenders.map((o) => o.join(" ")).join("; "));
}

async function rangeProbe(client) {
  out("\n== step 10: ranged gateway read through the shared client ==");
  const rootCid = (await client.filesStat(DEMO_ROOT)).cid;
  const entry = (await client.filesLs(`${DEMO_ROOT}/current/attachments`)).find((e) => e.name === "diagram.bin");
  if (entry === undefined) {
    check("range probe file exists", false, "attachments/diagram.bin not found in the demo tree");
    return;
  }
  const stream = await client.gatewayStream(rootCid, "current/attachments/diagram.bin", { start: 100, length: 100 });
  const parts = [];
  for await (const chunk of stream.chunks) parts.push(Buffer.from(chunk));
  const partial = Buffer.concat(parts);
  const whole = Buffer.from(await client.gatewayFetch(rootCid, "current/attachments/diagram.bin"));
  check("gateway honours Range: 206 with Content-Range and the right 100 bytes", stream.status === 206 && (stream.contentRange ?? "").startsWith("bytes 100-199/") && partial.equals(whole.subarray(100, 200)), `${stream.status} ${stream.contentRange ?? "(no Content-Range)"}`);
}

async function sideEffects(client, before) {
  out("\n== step 11: what changed on the node ==");
  const after = await snapshot(client);
  const entryChanges = diffMaps(before.entries, after.entries);
  const keyChanges = diffMaps(before.keys, after.keys);
  check(`only ${BASE}/mvp03-demo changed under ${BASE}`, entryChanges.every((name) => name === "mvp03-demo"), `changed: ${entryChanges.join(", ") || "none"}`);
  check(`no key was changed or removed (only ${KEY} may have been added)`, keyChanges.every((name) => name === KEY && !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

async function main() {
  await mkdir(CONFIG_DIR, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "ipfs-sync-feature-op-03-"));
  try {
    const { client, rpcUrl, gatewayUrl, auth } = await loadClient(work);
    out(`feature operation mvp-03  rpc ${rpcUrl}  gateway ${gatewayUrl}  auth ${auth}\nconfig ${CONFIG_FILE}\ndemo root ${DEMO_ROOT}`);
    const explicit = process.argv.includes("--owned-key") ? [argValue("--owned-key") ?? ""] : [];
    const before = await snapshot(client);
    if (!assertKeyAdoptable(before, await readOwnedKeys(), explicit)) return 1;
    out(`before: ${before.entries.size} entries under ${BASE}, ${before.keys.size} keys, key ${KEY} ${before.keys.has(KEY) ? "present" : "absent (publish will create it)"}`);
    const common = ["--config", CONFIG_FILE, ...explicit.flatMap((id) => ["--owned-key", id])];
    const vaultA = join(work, "vault-a");
    const dirB = join(work, "vault-b");
    if (!(await generateVault(vaultA))) return 1;
    const published = await publishFirst(vaultA, common);
    if (!published.ok) return 1;
    const { original, pulled } = await firstPull(vaultA, dirB, published.count, common);
    const { copyPath } = await conflictSteps(vaultA, dirB, published.count, pulled, common);
    await repullSteps(dirB, published.count, copyPath, common);
    await failClosedStep(client, work, published.count, common);
    await restoreStep(work, original, published.currentCid, common);
    await restoreKeepsRecord(dirB, published.currentCid, common);
    await refusalSteps(work, common);
    auditRequests();
    await rangeProbe(client);
    await sideEffects(client, before);
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
