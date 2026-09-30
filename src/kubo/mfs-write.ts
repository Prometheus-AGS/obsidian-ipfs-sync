import { assertMfsMutationPath, type ResolvedEndpoint } from "../core/config";
import type { Bytes } from "../core/host-bridge";
import type { Transport } from "./http";
import { buildMultipart } from "./multipart";
import { rpcCall } from "./rpc-call";

/**
 * The proxy in front of the node requires the multipart field to be named
 * `data` (the previous library sent `file`). This module is the ONLY place in the
 * project that issues `files/write`.
 */
export const MULTIPART_FIELD = "data";

export type { Bytes };

export interface WriteOptions {
  /** Default true. */
  readonly create?: boolean;
  /** Default true: create missing parent directories. */
  readonly parents?: boolean;
  /** Default true: replace existing content. */
  readonly truncate?: boolean;
  /** Default 1. */
  readonly cidVersion?: 0 | 1;
  /** Byte offset to write at (chunked writes). Omitted for a whole-file write. */
  readonly offset?: number;
}

/** Write bytes to an MFS path under `/obsidian-vault-sync/`. Other paths are refused before any request. */
export async function writeMfsFile(
  endpoint: ResolvedEndpoint,
  path: string,
  data: Bytes,
  options: WriteOptions = {},
  transport?: Transport,
): Promise<void> {
  const target = assertMfsMutationPath(path);
  const args = {
    arg: target,
    create: options.create ?? true,
    parents: options.parents ?? true,
    truncate: options.truncate ?? true,
    "cid-version": options.cidVersion ?? 1,
    offset: options.offset,
  };
  const body = buildMultipart(MULTIPART_FIELD, data);
  await rpcCall({ endpoint, command: "files/write", args, body, transport }, "none");
}
