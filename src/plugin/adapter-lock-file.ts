import { decodeLock, type LockContext, type LockFile } from "../sync/publish-lock";
import { PUBLISH_LOCK_KEY } from "../sync/root-files";
import type { VaultAdapter } from "./obsidian-fs";

/**
 * The plugin side of the cross-process publish lock: the same file (`<vault>/.ipfs-sync/publish.lock`) the command
 * line tool uses, reached through Obsidian's vault adapter. The adapter has no hard links, so exclusive creation is
 * a check followed by a rename of a fully written temporary file: the lock never appears half written, but the
 * check and the rename are two steps. Within one Obsidian instance the in-process sync lock closes that gap; against
 * a command-line publish the window is a few milliseconds and the lock stays what the engine says it is, a
 * best-effort guard.
 *
 * `adapter.rename` is not known to refuse an existing target on every platform (unverified in Obsidian). So the file
 * never trusts the rename: after it succeeds, the lock file is read back and compared with the bytes written. A caller
 * whose file was replaced in the gap gets `false` (the other holder's file is left alone) and the engine refuses as
 * `lock-held`. The heartbeat and `write` replace the file by a temporary file and a rename, never by truncating it in
 * place, so a concurrent reader never sees a partial lock. Temporary files (`.publish.lock.*.tmp`) left by a
 * crash are swept when the lock is next taken or released, once they are older than a minute. A moved-aside lock
 * (`.taken`) is never swept: it keeps its old heartbeat age, and only the clearer that moved it discards it.
 */

const STATE_DIRECTORY = ".ipfs-sync";
const TOKEN_CHARS = 12;
/** A scratch file this old is a leftover: a live starter holds its temporary file for milliseconds. */
const SCRATCH_MAX_AGE_MS = 60_000;

function randomToken(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function toArrayBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function createAdapterLockFile(adapter: VaultAdapter, now: () => number = Date.now): LockFile {
  const lockPath = `${STATE_DIRECTORY}/${PUBLISH_LOCK_KEY}`;
  const scratchPrefix = `.${PUBLISH_LOCK_KEY}.`;
  const scratchPath = (kind: "tmp" | "taken"): string => `${STATE_DIRECTORY}/${scratchPrefix}${randomToken().slice(0, TOKEN_CHARS)}.${kind}`;
  const exists = async (path: string): Promise<boolean> => (await adapter.stat(path)) !== null;

  const ensureDirectory = async (): Promise<void> => {
    if (!(await exists(STATE_DIRECTORY))) await adapter.mkdir(STATE_DIRECTORY);
  };

  const readLock = async (): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    if (!(await exists(lockPath))) return undefined;
    try {
      return new Uint8Array(await adapter.readBinary(lockPath));
    } catch (error) {
      if (!(await exists(lockPath))) return undefined;
      throw error;
    }
  };

  /** Remove scratch files of a crashed run. Best effort: a sweep never decides whether the lock is taken or released. */
  const sweepScratch = async (): Promise<void> => {
    try {
      const { files } = await adapter.list(STATE_DIRECTORY);
      for (const path of files) {
        const name = path.slice(path.lastIndexOf("/") + 1);
        // Never `.taken`: a moved-aside lock keeps the age of its last heartbeat, so it always looks old, and it belongs to a
        // clearer (possibly another instance, or one from before a reload) that still has to put it back or discard it.
        if (!name.startsWith(scratchPrefix) || !name.endsWith(".tmp")) continue;
        const info = await adapter.stat(path);
        if (info !== null && now() - info.mtime > SCRATCH_MAX_AGE_MS) await adapter.remove(path).catch(() => undefined);
      }
    } catch {
      // The folder may not exist yet or may not be listable; leftovers are harmless and swept next time.
    }
  };

  /** Best effort: remove the lock file when it holds exactly `bytes`; a file that is another holder's, or cannot be read, stays. */
  const removeIfOurs = async (bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    try {
      const current = await readLock();
      if (current !== undefined && sameBytes(current, bytes)) await adapter.remove(lockPath);
    } catch {
      // The failure that matters is the read-back error the caller rethrows.
    }
  };

  /** Replace the lock file with `bytes` through a temporary file and a rename; falls back to remove-then-rename where rename refuses an existing target. */
  const replaceLock = async (bytes: Uint8Array<ArrayBuffer>, stillOurs: () => Promise<boolean>): Promise<boolean> => {
    const temp = scratchPath("tmp");
    await adapter.writeBinary(temp, toArrayBuffer(bytes));
    try {
      if (!(await stillOurs())) return false;
      try {
        await adapter.rename(temp, lockPath);
      } catch (error) {
        // This adapter refuses an existing target. Check the token once more, then clear the way and rename at once.
        if (!(await exists(lockPath))) throw error;
        if (!(await stillOurs())) return false;
        await adapter.remove(lockPath);
        await adapter.rename(temp, lockPath);
      }
      return true;
    } finally {
      await adapter.remove(temp).catch(() => undefined);
    }
  };

  return {
    createExclusive: async (bytes) => {
      await ensureDirectory();
      await sweepScratch();
      if (await exists(lockPath)) return false;
      const temp = scratchPath("tmp");
      await adapter.writeBinary(temp, toArrayBuffer(bytes));
      try {
        await adapter.rename(temp, lockPath);
      } catch (error) {
        // Best-effort removal of our own scratch file; the failure that matters is the one rethrown below.
        await adapter.remove(temp).catch(() => undefined);
        if (await exists(lockPath)) return false;
        throw error;
      }
      // A rename that overwrites would let two starters both see "created". Trust only what is on disk: the file must
      // still hold our bytes. If it does not, it is another holder's file, which stays where it is.
      let onDisk: Uint8Array<ArrayBuffer> | undefined;
      try {
        onDisk = await readLock();
      } catch (error) {
        // Our rename succeeded but the file cannot be read back: leave no lock behind that nothing heartbeats or releases.
        await removeIfOurs(bytes);
        throw error;
      }
      return onDisk !== undefined && sameBytes(onDisk, bytes);
    },
    read: readLock,
    write: async (bytes) => {
      await replaceLock(bytes, async () => true);
    },
    writeIfToken: async (expectedToken, bytes) => {
      const holdsToken = async (): Promise<boolean> => {
        const current = await readLock();
        return current !== undefined && decodeLock(current)?.token === expectedToken;
      };
      // Look first (a lock that is already gone or taken needs no scratch file), and again right before the rename.
      return (await holdsToken()) && (await replaceLock(bytes, holdsToken));
    },
    remove: async () => {
      if (await exists(lockPath)) await adapter.remove(lockPath);
      await sweepScratch();
    },
    moveAside: async () => {
      if (!(await exists(lockPath))) return undefined;
      const aside = scratchPath("taken");
      try {
        await adapter.rename(lockPath, aside);
      } catch (error) {
        if (!(await exists(lockPath))) return undefined;
        throw error;
      }
      const asideBytes = new Uint8Array(await adapter.readBinary(aside));
      return {
        bytes: asideBytes,
        discard: async () => {
          if (await exists(aside)) await adapter.remove(aside);
        },
      };
    },
  };
}

/**
 * Process facts for the lock record. Obsidian has no process id or host name in the WebView, so the record carries a
 * host name that is unique to this session: another instance or the command-line tool never treats it as a dead
 * process on its own host, and a lock left behind by a crash of this plugin expires by its heartbeat (15 minutes)
 * or is removed with `ipfs-sync publish --break-lock`. Create one context per plugin session.
 */
export function createPluginLockContext(now: () => number): LockContext {
  return {
    now,
    pid: 0,
    host: `obsidian-${randomToken().slice(0, 8)}`,
    newToken: randomToken,
    // Only asked about locks recorded on this host name, which is unique to this session: never a live answer to give.
    isProcessAlive: () => true,
    every: (ms, task) => {
      const timer = setInterval(task, ms);
      return () => clearInterval(timer);
    },
  };
}
