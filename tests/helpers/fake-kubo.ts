import { createHash } from "node:crypto";
import { assertMfsMutationPath } from "../../src/core/config";
import { KuboHttpError, type KuboClient, type NodeKey } from "../../src/kubo";
import type { PublishClient } from "../../src/sync/publish";

export interface FakeNode {
  readonly client: PublishClient & Pick<KuboClient, "nameResolve">;
  /** One line per request, in order: `keyList`, `keyGen <name>`, `write <path>`, `stat <path>`, `rm <path>`, `pin <cid>`, `publish <key> <cid> <ttl>`. */
  readonly calls: string[];
  readonly files: Map<string, Uint8Array>;
  readonly keys: NodeKey[];
  readonly published: Map<string, string>;
  failWriteFor: RegExp | undefined;
  /** Pretend the node stores fewer bytes than were sent for paths matching this pattern. */
  shortWriteFor: RegExp | undefined;
  /** CID of a file or directory at `path`, or undefined when absent. */
  cidOf(path: string): string | undefined;
}

const missing = (): KuboHttpError => new KuboHttpError("rpc", "https://node.test", 500, "file does not exist");

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

export function createFakeNode(initialKeys: readonly NodeKey[] = []): FakeNode {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>();
  const keys = [...initialKeys];
  const published = new Map<string, string>();

  const childrenOf = (dir: string): [string, Uint8Array][] => [...files].filter(([path]) => path.startsWith(`${dir}/`));

  const cidOf = (path: string): string | undefined => {
    const file = files.get(path);
    if (file !== undefined) return cidFrom(digest(file), 0x55);
    const children = childrenOf(path);
    if (children.length === 0) return undefined;
    const listing = children.map(([child, data]) => `${child.slice(path.length)}:${digest(data)}`).sort().join("\n");
    return cidFrom(digest(listing), 0x70);
  };

  const node: FakeNode = {
    calls,
    files,
    keys,
    published,
    failWriteFor: undefined,
    shortWriteFor: undefined,
    cidOf,
    client: {
      keyList: async () => {
        calls.push("keyList");
        return keys.map((key) => ({ ...key }));
      },
      keyGen: async (name) => {
        calls.push(`keyGen ${name}`);
        const key = { name, id: `k51${digest(name + String(keys.length)).slice(0, 30)}` };
        keys.push(key);
        return key;
      },
      filesWrite: async (path, data, options) => {
        const target = assertMfsMutationPath(path);
        calls.push(`write ${target}`);
        if (node.failWriteFor?.test(target) === true) throw new Error(`injected write failure for ${target}`);
        const stored = node.shortWriteFor?.test(target) === true ? data.slice(0, Math.max(0, data.length - 1)) : data;
        const previous = options?.truncate === false ? (files.get(target) ?? new Uint8Array()) : new Uint8Array();
        const merged = new Uint8Array(Math.max(previous.length, (options?.offset ?? 0) + stored.length));
        merged.set(previous);
        merged.set(stored, options?.offset ?? 0);
        files.set(target, merged);
      },
      filesStat: async (path) => {
        calls.push(`stat ${path}`);
        const cid = cidOf(path);
        if (cid === undefined) throw missing();
        const file = files.get(path);
        return { cid, size: file?.length ?? 0, cumulativeSize: file?.length ?? 0, type: file === undefined ? "directory" : "file" };
      },
      filesRm: async (path) => {
        const target = assertMfsMutationPath(path);
        calls.push(`rm ${target}`);
        if (!files.delete(target)) throw missing();
      },
      pinAdd: async (cid) => {
        calls.push(`pin ${cid}`);
      },
      namePublish: async (key, cid, ttl = "5m") => {
        calls.push(`publish ${key} ${cid} ${ttl}`);
        const found = keys.find((candidate) => candidate.name === key);
        if (found === undefined) throw new Error(`no such key ${key}`);
        published.set(found.id, `/ipfs/${cid}`);
        return { name: found.id, value: `/ipfs/${cid}` };
      },
      nameResolve: async (name) => published.get(name.replace("/ipns/", "")) ?? "",
    },
  };
  return node;
}
