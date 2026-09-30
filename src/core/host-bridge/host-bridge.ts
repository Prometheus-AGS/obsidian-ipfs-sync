/**
 * Host capability contract (types only). Shared code reaches files, network,
 * key-value storage, agents, time, environment and processes only through this
 * interface; each host (Node CLI, Obsidian plugin, WASM guest) supplies its own
 * implementation. Nothing here imports Node, Obsidian or any runtime module.
 *
 * Member names map to the guest ABI names of specs 003/005/008:
 *   fs.list=fs_list, fs.stat=fs_stat, fs.read=fs_read, fs.readRange=fs_read_range,
 *   fs.write=fs_write, fs.mkdir=fs_mkdir, fs.remove=fs_remove, net.fetch=net_fetch,
 *   (mvp-03 additions with no guest ABI name yet: fs.lstat, fs.rename, fs.append),
 *   kv.get/set/delete/list=kv_get/kv_set/kv_delete/kv_list, agent.list=agent_list,
 *   agent.invoke=agent_invoke, timeNow=time_now, envRead=env_read, shellExec=shell_exec.
 */

/** Byte buffers are ArrayBuffer-backed so they are valid `BufferSource`/`BlobPart` values everywhere. */
export type Bytes = Uint8Array<ArrayBuffer>;

// ---------- fs_* ----------

export type HostFsKind = "file" | "directory";

export interface HostFsEntry {
  /** Base name, no separators. */
  readonly name: string;
  readonly kind: HostFsKind;
  /** Bytes for a file, 0 for a directory. */
  readonly size: number;
  readonly mtimeMs: number;
}

export interface HostFsStat {
  readonly kind: HostFsKind;
  readonly size: number;
  readonly mtimeMs: number;
}

/** What `lstat` reports: like `HostFsStat`, but a symbolic link is reported as itself and never followed. */
export interface HostFsLstat {
  readonly kind: HostFsKind | "symlink" | "other";
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Paths are relative to the host's root (the vault), use `/` separators and never contain
 * `..`; the empty string names the root. A host refuses anything that would leave its root.
 */
export interface HostFs {
  /** Direct children of a directory. Symbolic links and special files are not reported. */
  list(dir: string): Promise<readonly HostFsEntry[]>;
  /** `undefined` when nothing exists at the path. */
  stat(path: string): Promise<HostFsStat | undefined>;
  read(path: string): Promise<Bytes>;
  /** Up to `length` bytes starting at `offset`; shorter at the end of the file. */
  readRange(path: string, offset: number, length: number): Promise<Bytes>;
  /** Replaces the file, creating missing parent directories. */
  write(path: string, data: Bytes): Promise<void>;
  /** Creates the directory and its parents; succeeds when it already exists. */
  mkdir(path: string): Promise<void>;
  /** Removes one file. Removing a missing file succeeds. */
  remove(path: string): Promise<void>;
  /** Added in mvp-03. Like `stat` but never follows a symbolic link. `undefined` when nothing exists at the path. */
  lstat(path: string): Promise<HostFsLstat | undefined>;
  /**
   * Added in mvp-03. Moves `from` onto `to`, creating missing parent directories of `to` and replacing a file
   * already there. Atomic where the platform offers it. Never follows a symbolic link at `to`: it replaces the link.
   */
  rename(from: string, to: string): Promise<void>;
  /** Added in mvp-03. Appends to the file, creating it (and missing parent directories) when absent. */
  append(path: string, data: Bytes): Promise<void>;
}

// ---------- net_* ----------

export interface HostNetRequest {
  readonly url: string;
  /** Default `GET`. */
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Bytes;
  readonly timeoutMs?: number;
}

export interface HostNetResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Bytes;
}

export interface HostNet {
  fetch(request: HostNetRequest): Promise<HostNetResponse>;
}

// ---------- kv_* ----------

/**
 * Small keyed storage for local state. Keys are 1-128 characters from `[A-Za-z0-9._-]`
 * and start with a letter or digit. Values are opaque bytes.
 */
export interface HostKv {
  get(key: string): Promise<Bytes | undefined>;
  set(key: string, value: Bytes): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys that start with `prefix`, sorted. */
  list(prefix: string): Promise<readonly string[]>;
}

// ---------- agent_* ----------

export interface HostAgentDescriptor {
  readonly id: string;
  readonly name: string;
  /** `true` for an agent that runs inside this host, `false` for a remote AG-UI or A2A endpoint. */
  readonly local: boolean;
}

export interface HostAgentRequest {
  readonly agentId: string;
  readonly input: string;
  /** Extra string context for the run (for example the current note path). */
  readonly context?: Readonly<Record<string, string>>;
}

export interface HostAgentResult {
  readonly output: string;
}

export interface HostAgent {
  list(): Promise<readonly HostAgentDescriptor[]>;
  invoke(request: HostAgentRequest): Promise<HostAgentResult>;
}

// ---------- shell_exec ----------

export interface HostShellRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface HostShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// ---------- the bridge ----------

export interface HostBridge {
  readonly fs: HostFs;
  readonly net: HostNet;
  readonly kv: HostKv;
  readonly agent: HostAgent;
  /** Milliseconds since the Unix epoch. */
  timeNow(): number;
  /** `undefined` when the variable or setting is not defined. */
  envRead(name: string): string | undefined;
  /** Denied on mobile hosts; an allowlist on desktop hosts. */
  shellExec(request: HostShellRequest): Promise<HostShellResult>;
}
