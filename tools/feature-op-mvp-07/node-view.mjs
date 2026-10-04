// The lock and the read-only snapshot of the node, with the 07b demo parent. (07a's workspace.mjs hard-codes its own lock file and demo parent.)
import { unlinkSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import process from "node:process";
import { BASE, DEMO_PARENT, Refusal } from "./constants.mjs";

export { assertKeyAdoptable, diffMaps, ensureConfig, readOnly, readOwnedKeys } from "../feature-op-mvp-07a/workspace.mjs";

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** One run at a time: the owned key and the shared config are single-writer. A stale lock (dead pid) is replaced. */
export async function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      process.once("exit", () => {
        try {
          unlinkSync(lockFile);
        } catch {
          // Already gone.
        }
      });
      return () => rm(lockFile, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number((await readFile(lockFile, "utf8").catch(() => "")).trim());
      if (isAlive(pid)) throw new Refusal(`another run of this operation is in progress (pid ${pid}, lock ${lockFile})`);
      await rm(lockFile, { force: true });
    }
  }
  throw new Refusal(`could not take the lock ${lockFile}`);
}

/** What the harness compares before and after: the base folder, the demo parent and the keys. */
export async function nodeSnapshot(client) {
  const listing = (path) => client.filesLs(path).then((entries) => new Map(entries.map((entry) => [entry.name, entry.cid])), () => new Map());
  return { base: await listing(BASE), demoParent: await listing(DEMO_PARENT), keys: new Map((await client.keyList()).map((key) => [key.name, key.id])) };
}
