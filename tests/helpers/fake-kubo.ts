import { createHash } from "node:crypto";
import { assertMfsMutationPath } from "../../src/core/config";
import { KuboHttpError, KuboResponseTooLargeError, MFS_LIST_MAX_ENTRIES, type GatewayRange, type GatewayStream, type KuboClient, type MfsEntry, type MfsStat, type NodeKey } from "../../src/kubo";
import type { PublishClient } from "../../src/sync/publish";

/** Thrown after a mutating request completed, to model a process that dies right there. */
export class NodeKilled extends Error {
  constructor(readonly after: number) {
    super(`killed after mutation ${after}`);
    this.name = "NodeKilled";
  }
}

/** One request as the node saw it: the command line and, for a write, the body. */
export interface RecordedRequest {
  readonly line: string;
  readonly body?: Uint8Array;
  /** For a write: the byte offset asked for (absent for a whole-file write) and whether it truncates. */
  readonly offset?: number;
  readonly truncate?: boolean;
}

export interface FakeNode {
  readonly client: PublishClient & Pick<KuboClient, "nameResolve" | "gatewayFetch">;
  /** One line per request, in order: `keyList`, `keyGen <name>`, `write <path>`, `stat <path>`, `ls <path>`, `rm <path>`, `pin <cid>`, `publish <key> <cid> <ttl>`, `GET <cid>`. */
  readonly calls: string[];
  /** Every request with its body, for "nothing readable was sent" checks. */
  readonly requests: RecordedRequest[];
  /** MFS files by absolute path. Directories are implied by these paths plus `dirs`. */
  readonly files: Map<string, Uint8Array>;
  /** Directories that exist without a file below them (a removal leaves the folder behind, as MFS does). */
  readonly dirs: Set<string>;
  readonly keys: NodeKey[];
  readonly published: Map<string, string>;
  failWriteFor: RegExp | undefined;
  /** Pretend the node stores fewer bytes than were sent for paths matching this pattern. */
  shortWriteFor: RegExp | undefined;
  /** Mutating requests completed so far (write, rm, pin, publish, keyGen). */
  mutations: number;
  /** Throw `NodeKilled` right after this many mutating requests have completed. */
  killAfterMutation: number | undefined;
  /** Serve different bytes than stored for `/ipfs/` reads whose CID matches. */
  corruptRead: ((cid: string) => Uint8Array | undefined) | undefined;
  /** Runs right after a write to `path` was applied, before the request returns; it may change the node (a hostile writer). */
  afterWrite: ((path: string) => void) | undefined;
  /** Report a different size for a listing entry or a stat, by the last path segment; the stored bytes are unchanged. */
  sizeLie: ((name: string) => number | undefined) | undefined;
  /** Report another CID for a stat, by the last path segment (a node that answers with a value the manifest cannot carry). */
  cidLie: ((name: string) => string | undefined) | undefined;
  /** CID of a file or directory at an MFS path or `/ipfs/<cid>[/...]` path, or undefined when absent. */
  cidOf(path: string): string | undefined;
  /** The bytes of the object with this CID, if it is a file the node has seen. */
  bytesOf(cid: string): Uint8Array | undefined;
}

type Block =
  | { readonly type: "file"; readonly data: Uint8Array }
  | { readonly type: "directory"; readonly children: readonly { readonly name: string; readonly type: "file" | "directory"; readonly cid: string; readonly size: number }[] };

/** The real client refuses a listing of more than 2,000 entries; the in-process fake does the same. */
function capped<T>(children: readonly T[]): readonly T[] {
  if (children.length > MFS_LIST_MAX_ENTRIES) throw new KuboResponseTooLargeError("rpc", "https://node.test", "the listing", `${MFS_LIST_MAX_ENTRIES} entries`);
  return children;
}

const missing = (): KuboHttpError => new KuboHttpError("rpc", "https://node.test", 500, "file does not exist", "file does not exist");

function digest(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/** A syntactically valid CIDv1 (base32) over a sha2-256 digest: raw leaves for files (0x55), dag-pb for directories (0x70). */
function cidFrom(digestHex: string, codec: 0x55 | 0x70): string {
  return `b${base32(Buffer.from(`01${codec.toString(16)}1220${digestHex}`, "hex"))}`;
}

/** What a node holds, copyable: a test builds a state once and starts many runs from copies of it. */
export interface NodeSnapshot {
  readonly files: readonly (readonly [string, Uint8Array])[];
  readonly dirs: readonly string[];
  readonly keys: readonly NodeKey[];
  readonly published: readonly (readonly [string, string])[];
}

export function snapshotNode(node: FakeNode): NodeSnapshot {
  return { files: [...node.files].map(([path, data]) => [path, Uint8Array.from(data)] as const), dirs: [...node.dirs], keys: node.keys.map((key) => ({ ...key })), published: [...node.published] };
}

export function restoreNode(snapshot: NodeSnapshot): FakeNode {
  const node = createFakeNode(snapshot.keys);
  for (const [path, data] of snapshot.files) node.files.set(path, Uint8Array.from(data));
  for (const dir of snapshot.dirs) node.dirs.add(dir);
  for (const [key, value] of snapshot.published) node.published.set(key, value);
  return node;
}

export function createFakeNode(initialKeys: readonly NodeKey[] = []): FakeNode {
  const calls: string[] = [];
  const requests: RecordedRequest[] = [];
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const keys = [...initialKeys];
  const published = new Map<string, string>();
  const blocks = new Map<string, Block>();
  const hashes = new WeakMap<Uint8Array, string>();

  const hashOf = (data: Uint8Array): string => {
    let found = hashes.get(data);
    if (found === undefined) {
      found = digest(data);
      hashes.set(data, found);
    }
    return found;
  };

  const isDir = (path: string): boolean => dirs.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)) || [...dirs].some((dir) => dir.startsWith(`${path}/`));

  const childrenOf = (dir: string): string[] => {
    const names = new Set<string>();
    for (const path of [...files.keys(), ...dirs]) {
      if (!path.startsWith(`${dir}/`)) continue;
      names.add(path.slice(dir.length + 1).split("/")[0] as string);
    }
    return [...names].sort();
  };

  /** Merkle node of an MFS path, registering every block below it so `/ipfs/<cid>` reads keep working after later changes. */
  const nodeAt = (path: string): { type: "file" | "directory"; cid: string; size: number } | undefined => {
    const file = files.get(path);
    if (file !== undefined) {
      const cid = cidFrom(hashOf(file), 0x55);
      blocks.set(cid, { type: "file", data: file });
      return { type: "file", cid, size: file.length };
    }
    if (!isDir(path)) return undefined;
    const children = childrenOf(path).map((name) => {
      const child = nodeAt(`${path}/${name}`) as { type: "file" | "directory"; cid: string; size: number };
      return { name, ...child };
    });
    const cid = cidFrom(digest(children.map((child) => `${child.name}:${child.type}:${child.cid}`).join("\n")), 0x70);
    blocks.set(cid, { type: "directory", children });
    return { type: "directory", cid, size: 0 };
  };

  /** Resolve `/ipfs/<cid>/a/b` through the block store. */
  const resolveIpfs = (path: string): { type: "file" | "directory"; cid: string; size: number } | undefined => {
    const [cid, ...rest] = path.slice("/ipfs/".length).split("/").filter((segment) => segment !== "");
    let current = cid === undefined ? undefined : blocks.get(cid);
    let currentCid = cid ?? "";
    let type: "file" | "directory" = current?.type ?? "file";
    let size = current?.type === "file" ? current.data.length : 0;
    for (const name of rest) {
      if (current === undefined || current.type !== "directory") return undefined;
      const child = current.children.find((entry) => entry.name === name);
      if (child === undefined) return undefined;
      currentCid = child.cid;
      current = blocks.get(child.cid);
      type = child.type;
      size = child.size;
    }
    return current === undefined ? undefined : { type, cid: currentCid, size };
  };

  const lookup = (path: string): { type: "file" | "directory"; cid: string; size: number } | undefined =>
    path.startsWith("/ipfs/") ? resolveIpfs(path) : nodeAt(path);

  const cidOf = (path: string): string | undefined => lookup(path)?.cid;

  const node: FakeNode = {
    calls,
    requests,
    files,
    dirs,
    keys,
    published,
    failWriteFor: undefined,
    shortWriteFor: undefined,
    mutations: 0,
    killAfterMutation: undefined,
    corruptRead: undefined,
    afterWrite: undefined,
    sizeLie: undefined,
    cidLie: undefined,
    cidOf,
    bytesOf: (cid) => {
      const block = blocks.get(cid);
      return block?.type === "file" ? block.data : undefined;
    },
    client: undefined as unknown as FakeNode["client"],
  };

  const record = (line: string, body?: Uint8Array, options?: { readonly offset?: number; readonly truncate?: boolean }): void => {
    calls.push(line);
    requests.push(body === undefined ? { line } : { line, body, ...(options?.offset === undefined ? {} : { offset: options.offset }), truncate: options?.truncate ?? true });
  };

  const mutated = (): void => {
    node.mutations += 1;
    if (node.killAfterMutation !== undefined && node.mutations >= node.killAfterMutation) throw new NodeKilled(node.mutations);
  };

  const ensureParents = (path: string): void => {
    const parts = path.split("/").slice(1, -1);
    for (let index = 1; index <= parts.length; index += 1) dirs.add(`/${parts.slice(0, index).join("/")}`);
  };

  const gatewayBytes = (cid: string, path: string): Uint8Array => {
    const found = resolveIpfs(`/ipfs/${cid}${path === "" ? "" : `/${path}`}`);
    const data = found === undefined ? undefined : node.bytesOf(found.cid);
    if (data === undefined) throw new KuboHttpError("gateway", "https://gw.test", 404, "not found");
    return node.corruptRead?.(found?.cid ?? "") ?? data;
  };

  const client: FakeNode["client"] = {
    keyList: async () => {
      record("keyList");
      return keys.map((key) => ({ ...key }));
    },
    keyGen: async (name) => {
      record(`keyGen ${name}`);
      const key = { name, id: `k51${digest(name + String(keys.length)).slice(0, 30)}` };
      keys.push(key);
      mutated();
      return key;
    },
    filesWrite: async (path, data, options) => {
      const target = assertMfsMutationPath(path);
      record(`write ${target}`, data, options);
      if (node.failWriteFor?.test(target) === true) throw new Error(`injected write failure for ${target}`);
      const stored = node.shortWriteFor?.test(target) === true ? data.slice(0, Math.max(0, data.length - 1)) : data;
      const previous = options?.truncate === false ? (files.get(target) ?? new Uint8Array()) : new Uint8Array();
      const merged = new Uint8Array(Math.max(previous.length, (options?.offset ?? 0) + stored.length));
      merged.set(previous);
      merged.set(stored, options?.offset ?? 0);
      files.set(target, merged);
      ensureParents(target);
      node.afterWrite?.(target);
      mutated();
    },
    filesStat: async (path): Promise<MfsStat> => {
      record(`stat ${path}`);
      const found = lookup(path);
      if (found === undefined) throw missing();
      const size = node.sizeLie?.(path.split("/").at(-1) ?? "") ?? found.size;
      return { cid: node.cidLie?.(path.split("/").at(-1) ?? "") ?? found.cid, size, cumulativeSize: size, type: found.type };
    },
    filesLs: async (path): Promise<readonly MfsEntry[]> => {
      record(`ls ${path}`);
      // Like kubo, `files/ls` lists the mutable MFS; an immutable path is what `ls` (ipfsLs) is for.
      if (path.startsWith("/ipfs/")) throw missing();
      const found = lookup(path);
      if (found === undefined) throw missing();
      if (found.type !== "directory") throw new KuboHttpError("rpc", "https://node.test", 500, "not a directory");
      const block = blocks.get(found.cid);
      if (block?.type === "directory") return capped(block.children).map((child) => ({ ...child, size: node.sizeLie?.(child.name) ?? child.size }));
      return [];
    },
    ipfsLs: async (path): Promise<readonly MfsEntry[]> => {
      record(`ipfs-ls ${path}`);
      const found = resolveIpfs(path);
      if (found === undefined) throw new KuboHttpError("rpc", "https://node.test", 500, `no link named "${path.split("/").at(-1) ?? ""}"`, `no link named "${path.split("/").at(-1) ?? ""}"`);
      const block = blocks.get(found.cid);
      if (block?.type === "directory") return capped(block.children).map((child) => ({ ...child, size: node.sizeLie?.(child.name) ?? child.size }));
      return [];
    },
    filesRm: async (path, options) => {
      const target = assertMfsMutationPath(path);
      record(`rm ${target}`);
      if (files.delete(target)) {
        mutated();
        return;
      }
      if (!isDir(target)) throw missing();
      if (options?.recursive !== true) throw new KuboHttpError("rpc", "https://node.test", 500, "cannot remove a directory without recursive");
      for (const file of [...files.keys()]) if (file.startsWith(`${target}/`)) files.delete(file);
      for (const dir of [...dirs]) if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
      mutated();
    },
    pinAdd: async (cid) => {
      record(`pin ${cid}`);
      mutated();
    },
    namePublish: async (key, cid, ttl = "5m") => {
      record(`publish ${key} ${cid} ${ttl}`);
      const found = keys.find((candidate) => candidate.name === key);
      if (found === undefined) throw new Error(`no such key ${key}`);
      published.set(found.id, `/ipfs/${cid}`);
      mutated();
      return { name: found.id, value: `/ipfs/${cid}` };
    },
    nameResolve: async (name) => published.get(name.replace("/ipns/", "")) ?? "",
    gatewayFetch: async (cid, path = "") => {
      record(`GET ${cid}${path === "" ? "" : `/${path}`}`);
      return Uint8Array.from(gatewayBytes(cid, path));
    },
    gatewayStream: async (cid, path = "", range?: GatewayRange): Promise<GatewayStream> => {
      record(`GET ${cid}${path === "" ? "" : `/${path}`}${range === undefined ? "" : ` Range: bytes=${range.start}-${range.start + range.length - 1}`}`);
      const whole = gatewayBytes(cid, path);
      const part = range === undefined ? whole : whole.slice(range.start, range.start + range.length);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        const size = 65_536;
        for (let offset = 0; offset < part.length; offset += size) yield part.slice(offset, offset + size);
      }
      return { status: range === undefined || whole.length === 0 ? 200 : 206, contentRange: undefined, chunks: chunks() };
    },
  };
  return Object.assign(node, { client });
}
