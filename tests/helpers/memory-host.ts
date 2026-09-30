import type { Bytes, HostBridge, HostFs, HostFsEntry, HostFsLstat, HostFsStat, HostKv } from "../../src/core/host-bridge";
import { HostNotImplementedError } from "../../src/sync/host-errors";

interface StoredFile {
  readonly data: Bytes;
  readonly mtimeMs: number;
}

export interface MemoryHost extends HostBridge {
  /** Test helpers: set a file (bytes or text) with a modification time. */
  put(path: string, content: string | Bytes, mtimeMs?: number): void;
  drop(path: string): void;
  readonly files: ReadonlyMap<string, StoredFile>;
  readonly kvStore: Map<string, Bytes>;
  readonly reads: { count: number; rangeLengths: number[]; wholeReads: string[] };
  clock: number;
  /** Mark a path as a symbolic link (mvp-03): `lstat` reports it, `stat` and `list` do not follow it. */
  link(path: string): void;
  /** Every mutating call in order (`write`, `append`, `rename`, `remove`), for "nothing was touched" assertions. */
  readonly mutations: string[];
  /** Make `append` or `rename` fail for paths matching the pattern. */
  failOn: { append?: RegExp; rename?: RegExp };
}

const encode = (text: string): Bytes => new TextEncoder().encode(text);

/** An in-memory HostBridge for pure-logic tests. Directories are implied by file paths. */
export function createMemoryHost(options: { readonly env?: Record<string, string> } = {}): MemoryHost {
  const files = new Map<string, StoredFile>();
  const links = new Set<string>();
  const mutations: string[] = [];
  const failOn: { append?: RegExp; rename?: RegExp } = {};
  const kvStore = new Map<string, Bytes>();
  const reads = { count: 0, rangeLengths: [] as number[], wholeReads: [] as string[] };
  const host = { clock: 1_700_000_000_000 };

  const directoryNames = (dir: string): Map<string, HostFsEntry> => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const children = new Map<string, HostFsEntry>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      if (head === undefined) continue;
      if (tail.length === 0) children.set(head, { name: head, kind: "file", size: file.data.length, mtimeMs: file.mtimeMs });
      else children.set(head, { name: head, kind: "directory", size: 0, mtimeMs: 0 });
    }
    return children;
  };

  const fs: HostFs = {
    list: async (dir) => [...directoryNames(dir).values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    stat: async (path): Promise<HostFsStat | undefined> => {
      if (path === "") return { kind: "directory", size: 0, mtimeMs: 0 };
      const file = files.get(path);
      if (file !== undefined) return { kind: "file", size: file.data.length, mtimeMs: file.mtimeMs };
      return [...files.keys()].some((key) => key.startsWith(`${path}/`)) ? { kind: "directory", size: 0, mtimeMs: 0 } : undefined;
    },
    read: async (path) => {
      reads.count += 1;
      reads.wholeReads.push(path);
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file ${path}`);
      return file.data;
    },
    readRange: async (path, offset, length) => {
      reads.count += 1;
      reads.rangeLengths.push(length);
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file ${path}`);
      return file.data.slice(offset, offset + length);
    },
    write: async (path, data) => {
      mutations.push(`write ${path}`);
      files.set(path, { data, mtimeMs: host.clock });
    },
    mkdir: async () => undefined,
    remove: async (path) => {
      mutations.push(`remove ${path}`);
      files.delete(path);
    },
    lstat: async (path): Promise<HostFsLstat | undefined> => {
      if (links.has(path)) return { kind: "symlink", size: 0, mtimeMs: 0 };
      return fs.stat(path);
    },
    rename: async (from, to) => {
      mutations.push(`rename ${from} ${to}`);
      if (failOn.rename?.test(to) === true) throw new Error(`injected rename failure for ${to}`);
      const file = files.get(from);
      if (file === undefined) throw new Error(`no such file ${from}`);
      files.delete(from);
      links.delete(to);
      files.set(to, file);
    },
    append: async (path, data) => {
      mutations.push(`append ${path}`);
      if (failOn.append?.test(path) === true) throw new Error(`injected append failure for ${path}`);
      const previous = files.get(path)?.data ?? new Uint8Array(0);
      const merged = new Uint8Array(previous.length + data.length);
      merged.set(previous);
      merged.set(data, previous.length);
      files.set(path, { data: merged, mtimeMs: host.clock });
    },
  };

  const kv: HostKv = {
    get: async (key) => kvStore.get(key),
    set: async (key, value) => {
      kvStore.set(key, value);
    },
    delete: async (key) => {
      kvStore.delete(key);
    },
    list: async (prefix) => [...kvStore.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };

  return {
    fs,
    kv,
    net: { fetch: () => Promise.reject(new HostNotImplementedError("net_fetch")) },
    agent: {
      list: () => Promise.reject(new HostNotImplementedError("agent_list")),
      invoke: () => Promise.reject(new HostNotImplementedError("agent_invoke")),
    },
    timeNow: () => host.clock,
    envRead: (name) => options.env?.[name],
    shellExec: () => Promise.reject(new HostNotImplementedError("shell_exec")),
    put(path, content, mtimeMs = host.clock) {
      files.set(path, { data: typeof content === "string" ? encode(content) : content, mtimeMs });
    },
    drop(path) {
      files.delete(path);
    },
    link(path) {
      links.add(path);
    },
    mutations,
    failOn,
    files,
    kvStore,
    reads,
    get clock() {
      return host.clock;
    },
    set clock(value: number) {
      host.clock = value;
    },
  };
}
