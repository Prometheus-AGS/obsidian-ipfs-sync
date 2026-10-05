import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { PUBLISH_LOCK_KEY } from "../src/sync/root-files";
import { decodeLock, type LockContext, type LockFile } from "../src/sync/publish-lock";
import { lockUnsupported } from "../src/sync/publish-refusals";
import { assertStateFolderUnlinked } from "./state-folder-link";

/** The Node 24 side of the publish lock: files under `<vault>/.ipfs-sync/`, process facts from the operating system. */

const STATE_DIRECTORY = ".ipfs-sync";
/** The state folder is owner-only: it holds the record of every vault path and the key-slot copy. */
const STATE_DIRECTORY_MODE = 0o700;

/** A random hexadecimal token (122 random bits). Lock tokens and temporary names are not key material. */
function randomToken(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** `link()` failures that mean "this file system has no hard links" (FAT, some network mounts, some containers). */
const NO_HARD_LINKS = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"];

/**
 * The lock file of one vault. Exclusive creation writes a private temporary file and hard-links it to the lock
 * name: the link fails if the lock exists, and the lock never appears with partial content.
 */
export function createNodeLockFile(vaultRoot: string): LockFile {
  const directory = join(vaultRoot, STATE_DIRECTORY);
  const lockPath = join(directory, PUBLISH_LOCK_KEY);
  const tempPath = (): string => join(directory, `.${PUBLISH_LOCK_KEY}.${randomToken().slice(0, 12)}.tmp`);

  /** Called first by every operation: the lock lives under the state folder, which must not be a link (review round 3, C-M3). */
  const guard = (): Promise<void> => assertStateFolderUnlinked(vaultRoot);

  return {
    createExclusive: async (bytes) => {
      await guard();
      await mkdir(directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
      const temp = tempPath();
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      try {
        await link(temp, lockPath);
        return true;
      } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && NO_HARD_LINKS.includes(code)) throw lockUnsupported(code);
        throw error;
      } finally {
        await rm(temp, { force: true });
      }
    },
    read: async () => {
      await guard();
      try {
        return new Uint8Array(await readFile(lockPath));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    write: async (bytes) => {
      await guard();
      const temp = tempPath();
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, lockPath);
    },
    // POSIX has no compare-and-rename. The temporary file is written first, then the token is re-read and the rename
    // follows at once: the window is one read and one rename, not a whole heartbeat. It is narrowed, not closed; the
    // re-read after the write in the heartbeat still detects a lost race.
    writeIfToken: async (expectedToken, bytes, isStopped) => {
      await guard();
      const temp = tempPath();
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      try {
        let current: Uint8Array | undefined;
        try {
          current = new Uint8Array(await readFile(lockPath));
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
        }
        // The holder released while this beat was in flight: renaming now would put a lock back that nobody owns.
        if (isStopped?.() === true || current === undefined || decodeLock(current)?.token !== expectedToken) {
          await rm(temp, { force: true });
          return false;
        }
        await rename(temp, lockPath);
        return true;
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    remove: async () => {
      await guard();
      await rm(lockPath, { force: true });
    },
    moveAside: async () => {
      await guard();
      const aside = join(directory, `.${PUBLISH_LOCK_KEY}.${randomToken().slice(0, 12)}.taken`);
      try {
        await rename(lockPath, aside);
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
      return { bytes: new Uint8Array(await readFile(aside)), discard: async () => rm(aside, { force: true }) };
    },
  };
}

/** Is `pid` a live process here? A process we may not signal (EPERM) exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

export function createNodeLockContext(now: () => number): LockContext {
  return {
    now,
    pid: process.pid,
    host: hostname(),
    newToken: randomToken,
    isProcessAlive,
    every: (ms, task) => {
      const timer = setInterval(task, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
