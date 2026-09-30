import { appendFile, chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Bytes, HostBridge, HostFs, HostFsEntry, HostFsLstat, HostFsStat, HostKv } from "../src/core/host-bridge";
import { HostNotImplementedError, HostPathError } from "../src/sync/host-errors";

export { HostPathError };

export interface NodeHostOptions {
  /** Directory every fs path is resolved against (the vault, or a config directory). */
  readonly root: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

const KV_DIRECTORY = ".ipfs-sync";
const KV_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function resolveInside(root: string, path: string): string {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new HostPathError(path, "absolute paths, backslashes and NUL are not allowed");
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new HostPathError(path, "`.` and `..` segments are not allowed");
  }
  return join(root, ...segments);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function statOrUndefined(absolute: string): Promise<HostFsStat | undefined> {
  try {
    const info = await stat(absolute);
    if (info.isFile()) return { kind: "file", size: info.size, mtimeMs: info.mtimeMs };
    if (info.isDirectory()) return { kind: "directory", size: 0, mtimeMs: info.mtimeMs };
    return undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function lstatOrUndefined(absolute: string): Promise<HostFsLstat | undefined> {
  try {
    const info = await lstat(absolute);
    const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    return { kind, size: info.isFile() ? info.size : 0, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function listDirectory(absolute: string): Promise<readonly HostFsEntry[]> {
  const dirents = await readdir(absolute, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.isFile() || dirent.isDirectory())
      .map(async (dirent): Promise<HostFsEntry | undefined> => {
        const info = await statOrUndefined(join(absolute, dirent.name));
        return info === undefined ? undefined : { name: dirent.name, ...info };
      }),
  );
  return entries.filter((entry): entry is HostFsEntry => entry !== undefined).sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function readSlice(absolute: string, offset: number, length: number): Promise<Bytes> {
  const handle = await open(absolute, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function createFs(root: string): HostFs {
  const at = (path: string): string => resolveInside(root, path);
  return {
    list: async (dir) => listDirectory(at(dir)),
    stat: async (path) => statOrUndefined(at(path)),
    read: async (path) => readFile(at(path)),
    readRange: async (path, offset, length) => readSlice(at(path), offset, length),
    write: async (path, data) => {
      const target = at(path);
      await mkdir(dirname(target), { recursive: true, mode: KV_DIRECTORY_MODE });
      await replaceAtomically(target, data);
    },
    mkdir: async (path) => {
      await mkdir(at(path), { recursive: true });
    },
    remove: async (path) => rm(at(path), { force: true }),
    lstat: async (path) => lstatOrUndefined(at(path)),
    rename: async (from, to) => {
      const target = at(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(at(from), target);
    },
    append: async (path, data) => {
      const target = at(path);
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, data);
    },
  };
}

function kvPath(root: string, key: string): string {
  if (!KV_KEY.test(key)) throw new HostPathError(key, "kv keys are 1-128 characters of [A-Za-z0-9._-], starting with a letter or digit");
  return join(root, KV_DIRECTORY, key);
}

/** State, journal and key slots hold every vault path: owner-only. */
const KV_FILE_MODE = 0o600;
const KV_DIRECTORY_MODE = 0o700;

/** Create the file 0600 (replacing a stale temp of another mode), write, flush to disk, close. */
async function writeDurably(path: string, value: Bytes): Promise<void> {
  await rm(path, { force: true });
  const handle = await open(path, "wx", KV_FILE_MODE);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write `value` to a same-directory temp file (0600, fsynced), then rename it over `target`. A crash or a failed
 * write leaves the previous content of `target` intact; the temp file is removed on every path.
 */
async function replaceAtomically(target: string, value: Bytes): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeDurably(temp, value);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Key-value storage as files under `<root>/.ipfs-sync/`. Writes go to a temp file and are renamed into place. */
function createKv(root: string): HostKv {
  return {
    get: async (key) => {
      try {
        return await readFile(kvPath(root, key));
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    set: async (key, value) => {
      const target = kvPath(root, key);
      const temp = join(dirname(target), `.${key}.${process.pid}.tmp`);
      await mkdir(dirname(target), { recursive: true, mode: KV_DIRECTORY_MODE });
      await chmod(dirname(target), KV_DIRECTORY_MODE);
      await writeDurably(temp, value);
      await rename(temp, target);
    },
    delete: async (key) => rm(kvPath(root, key), { force: true }),
    list: async (prefix) => {
      try {
        const names = await readdir(join(root, KV_DIRECTORY));
        return names.filter((name) => KV_KEY.test(name) && name.startsWith(prefix)).sort();
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

/**
 * The Node 24 host: `fs_*`, `kv_*`, `time_now` and `env_read` are real; `net_*`,
 * `agent_*` and `shell_exec` raise HostNotImplementedError.
 */
export function createNodeHostBridge(options: NodeHostOptions): HostBridge {
  const { root, env = {}, now = Date.now } = options;
  return {
    fs: createFs(root),
    kv: createKv(root),
    net: {
      fetch: () => Promise.reject(new HostNotImplementedError("net_fetch")),
    },
    agent: {
      list: () => Promise.reject(new HostNotImplementedError("agent_list")),
      invoke: () => Promise.reject(new HostNotImplementedError("agent_invoke")),
    },
    timeNow: () => now(),
    envRead: (name) => env[name],
    shellExec: () => Promise.reject(new HostNotImplementedError("shell_exec")),
  };
}
