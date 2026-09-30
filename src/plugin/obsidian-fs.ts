import type { Bytes, HostFs, HostFsEntry, HostFsLstat, HostFsStat } from "../core/host-bridge";
import { HostPathError, HostReadCapError } from "../sync/host-errors";
import { DEFAULT_MAX_READ_MB, readCapBytes } from "./read-cap";

/**
 * The part of Obsidian's `DataAdapter` the host file system needs. The real adapter satisfies it
 * structurally; tests pass an in-memory one. It reaches hidden folders such as `.obsidian/` and `.ipfs-sync/`.
 */
export interface VaultAdapter {
  stat(path: string): Promise<{ readonly type: "file" | "folder"; readonly mtime: number; readonly size: number } | null>;
  list(path: string): Promise<{ readonly files: string[]; readonly folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
}

export interface ObsidianFsOptions {
  /** Largest file a read may load, in megabytes. Defaults to 64. */
  readonly maxReadMb?: number;
}

/** Obsidian's spelling of the vault root (what `normalizePath("")` returns). */
const ROOT = "/";

/** Vault-relative, `/`-separated, no `..`, no absolute path, no backslash or NUL. The empty string is the root. */
export function assertVaultPath(path: string): string {
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new HostPathError(path, "absolute paths, backslashes and NUL are not allowed");
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new HostPathError(path, "`.` and `..` segments are not allowed");
  }
  return segments.join("/");
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function adapterPath(path: string): string {
  return path === "" ? ROOT : path;
}

/** An `ArrayBuffer` holding exactly these bytes, copying only when the view is a window onto a larger buffer. */
function toArrayBuffer(data: Bytes): ArrayBuffer {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data.buffer
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

/**
 * Host file system over the Obsidian vault adapter. Limits, all from the adapter's API:
 * - `readRange` has no platform primitive: it reads the whole file and returns a copy of the slice, so
 *   one very large file can still exhaust mobile memory. Only one file is read per call, and a file above
 *   the read cap is refused with a `HostReadCapError` before it is loaded.
 * - `lstat` cannot see symbolic links (the adapter has no lstat); it reports what `stat` reports.
 * - `rename` onto an existing file removes the target first, so it is not atomic; a missing source is
 *   refused before the target is touched.
 */
export function createObsidianFs(adapter: VaultAdapter, options: ObsidianFsOptions = {}): HostFs {
  const capBytes = readCapBytes(options.maxReadMb ?? DEFAULT_MAX_READ_MB);
  const statAt = async (path: string): Promise<HostFsStat | undefined> => {
    const clean = assertVaultPath(path);
    if (clean === "") return { kind: "directory", size: 0, mtimeMs: 0 };
    const info = await adapter.stat(clean);
    if (info === null) return undefined;
    return info.type === "file" ? { kind: "file", size: info.size, mtimeMs: info.mtime } : { kind: "directory", size: 0, mtimeMs: info.mtime };
  };

  /** Create the directory and each missing ancestor, one level at a time. */
  const ensureDirectory = async (path: string): Promise<void> => {
    if (path === "" || (await adapter.stat(path)) !== null) return;
    await ensureDirectory(parentOf(path));
    await adapter.mkdir(path);
  };

  const readAll = async (path: string): Promise<Uint8Array<ArrayBuffer>> => {
    const clean = assertVaultPath(path);
    const info = await adapter.stat(clean);
    if (info?.type === "file" && info.size > capBytes) throw new HostReadCapError(clean, info.size, capBytes);
    return new Uint8Array(await adapter.readBinary(clean));
  };

  const entryFor = async (fullPath: string): Promise<HostFsEntry | undefined> => {
    const info = await statAt(fullPath);
    return info === undefined ? undefined : { name: baseName(fullPath), ...info };
  };

  return {
    list: async (dir) => {
      const clean = assertVaultPath(dir);
      const listed = await adapter.list(adapterPath(clean));
      const entries = await Promise.all([...listed.files, ...listed.folders].map(entryFor));
      return entries.filter((entry): entry is HostFsEntry => entry !== undefined).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    stat: statAt,
    read: readAll,
    readRange: async (path, offset, length) => (await readAll(path)).slice(offset, offset + length),
    write: async (path, data) => {
      const clean = assertVaultPath(path);
      await ensureDirectory(parentOf(clean));
      await adapter.writeBinary(clean, toArrayBuffer(data));
    },
    mkdir: async (path) => ensureDirectory(assertVaultPath(path)),
    remove: async (path) => {
      const clean = assertVaultPath(path);
      const info = await adapter.stat(clean);
      if (info === null) return;
      if (info.type === "folder") throw new HostPathError(path, "it is a directory; remove deletes one file");
      await adapter.remove(clean);
    },
    lstat: async (path): Promise<HostFsLstat | undefined> => statAt(path),
    rename: async (from, to) => {
      const source = assertVaultPath(from);
      const target = assertVaultPath(to);
      if ((await adapter.stat(source)) === null) throw new HostPathError(from, "the source does not exist; the target was left as it was");
      await ensureDirectory(parentOf(target));
      if ((await adapter.stat(target))?.type === "file") await adapter.remove(target);
      await adapter.rename(source, target);
    },
    append: async (path, data) => {
      const clean = assertVaultPath(path);
      await ensureDirectory(parentOf(clean));
      if ((await adapter.stat(clean)) === null) await adapter.writeBinary(clean, toArrayBuffer(data));
      else await adapter.appendBinary(clean, toArrayBuffer(data));
    },
  };
}
