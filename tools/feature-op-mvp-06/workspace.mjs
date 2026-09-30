// Files, vaults, the lock, and the read-only view of the node with the before/after comparison helpers.
import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { BASE, CONFIG_FILE, DEMO_PARENT, GENERATOR, KEY, LOCK_FILE, REPO, Refusal, SEED } from "./constants.mjs";
import { sha256 } from "./policy.mjs";

// ======================================================================================================================
// Files, vaults, the lock
// ======================================================================================================================

export const exists = (path) => stat(path).then(() => true, () => false);
export const vaultPath = (vault, path) => join(vault, ...path.split("/"));

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
  return found;
}

export async function appendNote(vault, path, text) {
  const target = vaultPath(vault, path);
  const next = `${await readFile(target, "utf8")}${text}`;
  await writeFile(target, next);
  return next;
}

/** Append to a note of the main vault and keep the script's record of the local files (size, sha256) current. */
export async function editNote(S, path, text) {
  const next = await appendNote(S.vault, path, text);
  S.files = S.files.map((file) => (file.path === path ? { ...file, size: Buffer.byteLength(next), sha256: sha256(next), text: next } : file));
  return next;
}

export async function generateVault(dir) {
  const run = await new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", GENERATOR, dir, "--seed", String(SEED)], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("close", (code) => done({ code, text }));
  });
  return run;
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
