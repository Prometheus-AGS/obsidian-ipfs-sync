// Files, vaults, the lock, and the read-only view of the node with the before/after comparison helpers.
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { BASE, CONFIG_FILE, DEMO_PARENT, GENERATOR, KEY, LOCK_FILE, REPO, Refusal, SEED } from "./constants.mjs";
import { childEnv, rootDigest, sha256 } from "./policy.mjs";

// ======================================================================================================================
// Files, vaults, the lock
// ======================================================================================================================

export const exists = (path) => stat(path).then(() => true, () => false);
export const vaultPath = (vault, path) => join(vault, ...path.split("/"));

/** Every file of a vault directory except the `.ipfs-sync` state folder: [{ path, size, sha256, text? }], sorted by path. */
export async function walkFiles(root, dir = "") {
  const found = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (path === ".ipfs-sync") continue;
    if (entry.isDirectory()) found.push(...(await walkFiles(root, path)));
    else {
      const data = await readFile(join(root, path));
      found.push({ path, size: data.length, sha256: sha256(data), text: path.endsWith(".md") ? data.toString("utf8") : undefined });
    }
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Every file below `root`, the `.ipfs-sync` state folder included: a Map of path to sha256. Used to prove a refused command changed nothing. */
export async function treeDigest(root, dir = "") {
  const found = new Map();
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) for (const [name, digest] of await treeDigest(root, path)) found.set(name, digest);
    else found.set(path, sha256(await readFile(join(root, path))));
  }
  return found;
}

export const sameDigest = (a, b) => a.size === b.size && [...a].every(([path, digest]) => b.get(path) === digest);

export async function appendNote(vault, path, text) {
  const target = vaultPath(vault, path);
  const next = `${await readFile(target, "utf8")}${text}`;
  await writeFile(target, next);
  return next;
}

/** The fixture marker word of a vault directory: `fixture` (publish accepts it) or `pulled-fixture` (what pull writes; publish refuses it). */
export async function setMarker(vault, word) {
  await writeFile(join(vault, ".ipfs-sync-fixture"), `${word}\n`);
}

export async function generateVault(dir) {
  const run = await new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, dir, "--seed", String(SEED)], { cwd: REPO, env: childEnv(process.env, {}, { localStub: true }), stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("close", (code) => done({ code, text }));
  });
  return run;
}

/** The local state record of one MFS root (`.ipfs-sync/state.<h>.json`), or undefined when absent or unreadable. */
export async function readLocalState(vault, mfsRoot) {
  try {
    return JSON.parse(await readFile(join(vault, ".ipfs-sync", `state.${rootDigest(mfsRoot)}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

export async function readOwnedKeys(configFile) {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8"));
    return Array.isArray(parsed.ownedKeys) ? parsed.ownedKeys : [];
  } catch {
    return [];
  }
}

export async function ensureConfig(configFile) {
  await mkdir(dirname(configFile), { recursive: true });
  if (!(await exists(configFile))) await writeFile(configFile, `${JSON.stringify({ ownedKeys: [] }, null, 2)}\n`);
}

/** One run at a time: the demo key and the shared config are single-writer. A stale lock (dead pid) is replaced. */
export async function acquireLock() {
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
      if (alive) throw new Refusal(`another run of this feature operation is in progress (pid ${pid}, lock ${LOCK_FILE})`);
      await rm(LOCK_FILE, { force: true });
    }
  }
  throw new Refusal(`could not take the lock ${LOCK_FILE}`);
}

// ======================================================================================================================
// Node reads (read-only view of the shared client) and the before/after comparison
// ======================================================================================================================

/** Only the read calls of the shared client. The script never holds a write method during the run. */
export function readOnly(client) {
  return Object.freeze({ filesLs: client.filesLs, filesStat: client.filesStat, ipfsLs: client.ipfsLs, keyList: client.keyList, nameResolve: client.nameResolve, gatewayFetch: client.gatewayFetch });
}

export async function nodeSnapshot(client) {
  const listing = (path) => client.filesLs(path).then((entries) => new Map(entries.map((entry) => [entry.name, entry.cid])), () => new Map());
  return { base: await listing(BASE), demoParent: await listing(DEMO_PARENT), keys: new Map((await client.keyList()).map((key) => [key.name, key.id])) };
}

export const diffMaps = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)).sort();

export function assertKeyAdoptable(keys, ownedKeys, explicit) {
  const nodeId = keys.get(KEY);
  if (nodeId === undefined || ownedKeys.includes(nodeId) || explicit.includes(nodeId)) return;
  throw new Refusal(`key "${KEY}" already exists on the node (ID ${nodeId}) but is not recorded in ${CONFIG_FILE}. If it is yours, re-run with --owned-key ${nodeId}. It is never adopted silently.`);
}
