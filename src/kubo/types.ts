import type { GatewayRange, GatewayStream } from "./gateway";
import type { Bytes, WriteOptions } from "./mfs-write";

export interface NodeIdentity {
  readonly peerId: string;
  readonly agentVersion: string;
}

export interface NodeVersion {
  readonly version: string;
  readonly commit: string;
}

export type MfsEntryType = "file" | "directory";

export interface MfsEntry {
  readonly name: string;
  readonly type: MfsEntryType;
  readonly size: number;
  readonly cid: string;
}

export interface MfsStat {
  readonly cid: string;
  readonly size: number;
  readonly cumulativeSize: number;
  readonly type: MfsEntryType;
}

export interface NodeKey {
  readonly name: string;
  /** Empty when the proxy strips key IDs from `key/list`. */
  readonly id: string;
}

export interface PublishedName {
  /** IPNS name (the key ID) that was published. */
  readonly name: string;
  /** The value it now points at, `/ipfs/<cid>`. */
  readonly value: string;
}

export interface RemoveOptions {
  readonly recursive?: boolean;
}

/** The one client both the plugin and the CLI use to reach a kubo node and its gateway. */
export interface KuboClient {
  id(): Promise<NodeIdentity>;
  version(): Promise<NodeVersion>;
  filesLs(path: string): Promise<readonly MfsEntry[]>;
  filesStat(path: string): Promise<MfsStat>;
  /**
   * Lists the children of an IPFS directory path (`/ipfs/<cid>/...`) with the `ls` command: name, kind, size and CID of each.
   * Read-only and immutable, unlike `filesLs`, which lists the mutable MFS. The response is capped like `filesLs`.
   */
  ipfsLs(path: string): Promise<readonly MfsEntry[]>;
  /** Refuses paths outside `/obsidian-vault-sync/` before any request. */
  filesRm(path: string, options?: RemoveOptions): Promise<void>;
  /** Sends multipart field `data`. Refuses paths outside `/obsidian-vault-sync/`. */
  filesWrite(path: string, data: Bytes, options?: WriteOptions): Promise<void>;
  keyList(): Promise<readonly NodeKey[]>;
  /** Creates one ed25519 key. Refuses names outside the project pattern before any request. There is no key removal, rename or rotation. */
  keyGen(name: string): Promise<NodeKey>;
  /** Recursive pin. There is no unpin operation. */
  pinAdd(cid: string): Promise<void>;
  /** Publishes `/ipfs/<cid>` under `key` (name validated; ownership is the caller's check). `ttl` defaults to 5m. */
  namePublish(key: string, cid: string, ttl?: string): Promise<PublishedName>;
  /** Resolves a key ID or `/ipns/...` name to `/ipfs/<cid>`. */
  nameResolve(name: string): Promise<string>;
  gatewayFetch(cid: string, path?: string): Promise<Uint8Array>;
  /** Read-only. Opens `/ipfs/<cid>[/<path>]` as chunks, with an HTTP `Range` request when `range` is given (added in mvp-03). */
  gatewayStream(cid: string, path?: string, range?: GatewayRange): Promise<GatewayStream>;
}
