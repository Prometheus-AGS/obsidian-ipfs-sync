import { chmod, lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { EnvMap } from "../src/core/config";
import type { Bytes } from "../src/core/host-bridge";
import { DeviceStoreError, type DeviceStore } from "../src/sync/device-store";

/**
 * The Node 24 side of the device-local store: a per-user directory outside every vault. It is created 0700 and its files
 * are 0600; the directory and each file must belong to the current user, and a symbolic link in either place is refused.
 * Writes go to a temporary file in the same directory and are renamed over the target. A read-merge-write section that
 * other processes may run at the same moment (the sequence floor) runs inside `exclusive`, which holds a lock file in the
 * same directory.
 */

const DIRECTORY_NAME = "ipfs-sync";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const OTHERS_MASK = 0o077;
/** The names this store accepts: lower-case letters, digits, dots and hyphens; no separators, so a name stays inside the directory. */
const STORE_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
/** The lock file of `exclusive`. Its leading dot keeps it outside the names `get` and `set` accept. */
const LOCK_NAME = ".store.lock";
/** The removal guard sits next to the lock file (`takeGuard`). */
const GUARD_SUFFIX = ".removing";
const LOCK_TOKEN_BYTES = 16;
/** A release that finds the guard busy polls this long, then leaves the lock to go stale (it is never removed unguarded). */
const RELEASE_GUARD_WAIT_MS = 2_000;
/** A lock older than this was left by a process that died inside its section (a section takes milliseconds). */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;
const LOCK_WAIT_MS = 10_000;

/**
 * The per-user state directory. `$XDG_STATE_HOME/ipfs-sync` when that variable is set (any platform but Windows),
 * else macOS `~/Library/Application Support/ipfs-sync`, Windows `%LOCALAPPDATA%\ipfs-sync`, other systems
 * `~/.local/state/ipfs-sync`. The home directory is read from `HOME` in the given environment only, so a test that
 * passes an environment never reaches the real one. A relative or missing base is refused.
 */
export function deviceStoreDirectory(env: EnvMap, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  const base = (variable: string, ...rest: string[]): string => {
    const value = env[variable];
    if (value === undefined || value === "" || !path.isAbsolute(value)) {
      throw new DeviceStoreError(`cannot locate the per-user state directory: ${variable} is not set to an absolute path`);
    }
    return path.join(value, ...rest, DIRECTORY_NAME);
  };
  if (platform === "win32") return base("LOCALAPPDATA");
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") return base("XDG_STATE_HOME");
  return platform === "darwin" ? base("HOME", "Library", "Application Support") : base("HOME", ".local", "state");
}

export interface NodeDeviceStoreOptions {
  readonly directory: string;
  /** The owner every entry must have. Defaults to `process.getuid()`; undefined (Windows) turns the owner and mode checks off. */
  readonly uid?: number | undefined;
  /** How long `exclusive` waits for a lock that another process holds before it stops. Defaults to ten seconds. */
  readonly lockWaitMs?: number;
}

/** The node store always has the cross-process section. */
export type NodeDeviceStore = DeviceStore & Required<Pick<DeviceStore, "exclusive">>;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function assertName(name: string): void {
  if (!STORE_NAME.test(name)) throw new DeviceStoreError(`"${name}" is not a valid device store name`);
}

/** Directory checks after creation: a real directory, owned by the current user, closed to everyone else. */
async function checkDirectory(directory: string, uid: number | undefined): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new DeviceStoreError(`the per-user state directory ${directory} is a symbolic link; refusing to use it`);
  if (!info.isDirectory()) throw new DeviceStoreError(`${directory} is not a directory`);
  if (uid === undefined) return;
  if (info.uid !== uid) throw new DeviceStoreError(`the per-user state directory ${directory} belongs to another user; refusing to use it`);
  if ((info.mode & OTHERS_MASK) !== 0) {
    throw new DeviceStoreError(`the per-user state directory ${directory} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 700 on it`);
  }
}

async function ensureDirectory(directory: string, uid: number | undefined): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  // `mode` is cut by the umask and applies only to directories this call created; make sure that the leaf is 0700.
  if (created !== undefined && uid !== undefined) await chmod(directory, DIRECTORY_MODE);
  await checkDirectory(directory, uid);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The lock file as it is now: its text (which holds the holder's random token) and its age. `undefined` when there is none. */
interface LockSighting {
  readonly text: string;
  readonly mtimeMs: number;
}

/**
 * Read the lock file. A symbolic link (not followed: O_NOFOLLOW), another kind of object or another user's file is refused; the lock
 * is never followed or replaced.
 */
async function sightLock(path: string, uid: number | undefined): Promise<LockSighting | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    if (isCode(error, "ELOOP")) throw new DeviceStoreError(`the device store lock ${path} is a symbolic link; refusing to use it`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DeviceStoreError(`the device store lock ${path} is not a regular file`);
    if (uid !== undefined && info.uid !== uid) throw new DeviceStoreError(`the device store lock ${path} belongs to another user; refusing to use it`);
    return { text: await handle.readFile("utf8"), mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * Take the removal guard: a second lock file, created exclusively, that every removal of the lock file runs under (a stale takeover and
 * a release). Removals of the lock are therefore one at a time, and the lock can only be created again after a removal, so "the lock
 * still says what I saw, then remove it" cannot delete a lock that a faster waiter created in between. The guard is held for
 * milliseconds; one older than `LOCK_STALE_MS` was left by a process that died inside that section and is removed. Returns the
 * release, or `undefined` when another process holds the guard (the caller polls again).
 */
async function takeGuard(path: string): Promise<(() => Promise<void>) | undefined> {
  const guard = `${path}${GUARD_SUFFIX}`;
  try {
    await (await open(guard, "wx", FILE_MODE)).close();
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    const held = await lstat(guard).catch(() => undefined);
    if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) await rm(guard, { force: true });
    return undefined;
  }
  return () => rm(guard, { force: true });
}

/** Remove the lock file only if it still says `expected`, under the guard. Returns false when the guard was busy (try again). */
async function removeLockIfStill(path: string, uid: number | undefined, expected: string): Promise<boolean> {
  const release = await takeGuard(path);
  if (release === undefined) return false;
  try {
    const now = await sightLock(path, uid);
    if (now?.text === expected) await rm(path, { force: true });
    return true;
  } finally {
    await release();
  }
}

/**
 * Look at a lock file that already exists. A symbolic link, another kind of object or another user's file is refused. A lock older
 * than `LOCK_STALE_MS` was left by a process that died inside its section and is taken over: it is removed only if the lock file
 * still carries the token that was seen, so a lock a faster waiter has just taken (a new token) is never removed.
 */
async function settleExistingLock(path: string, uid: number | undefined): Promise<void> {
  const seen = await sightLock(path, uid);
  if (seen === undefined || Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return;
  await removeLockIfStill(path, uid, seen.text);
}

/** Take the lock file (created exclusively, mode 0600) or wait for it; returns the release. */
async function acquireLock(path: string, uid: number | undefined, waitMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let handle: FileHandle | undefined;
    try {
      // O_CREAT | O_EXCL: fails on an existing entry, a symbolic link included, and never creates through one.
      handle = await open(path, "wx", FILE_MODE);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    if (handle !== undefined) {
      const text = `pid ${process.pid}\ntoken ${randomHex(LOCK_TOKEN_BYTES)}\n`;
      await handle.writeFile(text);
      await handle.close();
      // A holder that was suspended past the stale age may find its lock taken over: it removes the lock only while the file still carries its own token.
      return async () => {
        const until = Date.now() + RELEASE_GUARD_WAIT_MS;
        while (!(await removeLockIfStill(path, uid, text)) && Date.now() < until) await pause(LOCK_POLL_MS);
      };
    }
    await settleExistingLock(path, uid);
    if (Date.now() >= deadline) {
      throw new DeviceStoreError(
        `the device store is locked by another ipfs-sync process (${path}) that did not finish in ${Math.round(waitMs / 1000)} s. If no ipfs-sync process is running, remove that lock file and run again`,
      );
    }
    await pause(LOCK_POLL_MS);
  }
}

function temporaryName(name: string): string {
  return `.${name}.${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}.tmp`;
}

export function createNodeDeviceStore(options: NodeDeviceStoreOptions): NodeDeviceStore {
  const uid = "uid" in options ? options.uid : currentUid();
  const directory = options.directory;
  const fileOf = (name: string): string => join(directory, name);

  return {
    get: async (name) => {
      assertName(name);
      await ensureDirectory(directory, uid);
      const path = fileOf(name);
      let handle;
      try {
        // O_NOFOLLOW refuses a symbolic link at the final component on systems that have it; the owner is read from the opened file.
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        if (isCode(error, "ELOOP")) throw new DeviceStoreError(`device store entry ${name} is a symbolic link; refusing to read it`);
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new DeviceStoreError(`device store entry ${name} is not a regular file`);
        if (uid !== undefined && info.uid !== uid) throw new DeviceStoreError(`device store entry ${name} belongs to another user; refusing to read it`);
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    set: async (name, bytes: Bytes) => {
      assertName(name);
      await ensureDirectory(directory, uid);
      const path = fileOf(name);
      const existing = await lstat(path).catch((error: unknown) => (isCode(error, "ENOENT") ? undefined : Promise.reject(error)));
      if (existing?.isSymbolicLink() === true) throw new DeviceStoreError(`device store entry ${name} is a symbolic link; refusing to replace it`);
      const temp = fileOf(temporaryName(name));
      const handle = await open(temp, "wx", FILE_MODE);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(temp, { force: true });
        throw error;
      }
      await handle.close();
      try {
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    exclusive: async (run) => {
      await ensureDirectory(directory, uid);
      const release = await acquireLock(fileOf(LOCK_NAME), uid, options.lockWaitMs ?? LOCK_WAIT_MS);
      try {
        return await run();
      } finally {
        await release();
      }
    },
  };
}

/**
 * The device store of one run. The per-user directory is located and created only when the store is first used, so a run that
 * is refused before it needs the floor (a bad flag, a held lock) neither creates the directory nor fails to find a home.
 */
export function createLazyDeviceStore(env: EnvMap): DeviceStore {
  let store: NodeDeviceStore | undefined;
  const open = (): NodeDeviceStore => (store ??= createNodeDeviceStore({ directory: deviceStoreDirectory(env) }));
  return { get: async (name) => open().get(name), set: async (name, bytes) => open().set(name, bytes), exclusive: (run) => open().exclusive(run) };
}
