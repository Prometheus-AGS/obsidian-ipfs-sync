import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Bytes, HostFs } from "../core/host-bridge";
import type { GatewayStream, KuboClient } from "../kubo";
import { HASH_CHUNK_BYTES, SINGLE_READ_LIMIT_BYTES } from "./hash";
import type { ManifestFile } from "./manifest";
import { findSymlink } from "./symlink-guard";

/** Vault-relative folder for in-flight downloads: same filesystem as the destination, never synced. */
export const TEMP_DIR = ".ipfs-sync/tmp";

/** Buffered chunks are appended to the temp file once they reach this size. */
const FLUSH_BYTES = 1024 * 1024;

export type FetchClient = Pick<KuboClient, "gatewayStream">;
export type FetchFs = Pick<HostFs, "lstat" | "stat" | "write" | "append" | "rename" | "remove">;

export interface FetchContext {
  readonly client: FetchClient;
  readonly fs: FetchFs;
  /** Unique temp file names (a random UUID in production). */
  readonly newId: () => string;
}

export class VerificationError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`"${path}" failed verification: ${detail}`);
    this.name = "VerificationError";
    this.path = path;
  }
}

export class SymlinkRefusedError extends Error {
  readonly path: string;

  constructor(path: string, link: string) {
    super(`"${path}" not written: "${link}" is a symbolic link`);
    this.name = "SymlinkRefusedError";
    this.path = path;
  }
}

export class GatewayRangeError extends Error {
  constructor(path: string, detail: string) {
    super(`gateway range read of "${path}" failed: ${detail}`);
    this.name = "GatewayRangeError";
  }
}

function concat(parts: readonly Uint8Array[], total: number): Bytes {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/** Stop reading a response we cannot use, so its connection is released (an unstarted generator would not cancel). */
async function abandon(stream: GatewayStream): Promise<void> {
  const iterator = stream.chunks[Symbol.asyncIterator]();
  await iterator.next().catch(() => undefined);
  await iterator.return?.();
}

async function* ranged(client: FetchClient, cid: string, path: string, size: number): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < size; start += HASH_CHUNK_BYTES) {
    const length = Math.min(HASH_CHUNK_BYTES, size - start);
    const stream: GatewayStream = await client.gatewayStream(cid, path, { start, length });
    if (stream.status === 200 && start === 0) {
      // The gateway ignored Range and sends the whole object: read it as one stream (same hash-while-writing loop).
      yield* stream.chunks;
      return;
    }
    const expected = `bytes ${start}-`;
    if (stream.status !== 206 || (stream.contentRange !== undefined && !stream.contentRange.startsWith(expected))) {
      await abandon(stream);
      throw new GatewayRangeError(path, `expected 206 "${expected}…" at offset ${start}, got ${stream.status} ${stream.contentRange ?? "(no Content-Range)"}`);
    }
    yield* stream.chunks;
  }
}

/** The bytes of `/ipfs/<cid>/<path>`: one plain stream up to 32 MB, 8 MB ranged reads above. */
async function* body(client: FetchClient, cid: string, path: string, size: number): AsyncGenerator<Uint8Array> {
  if (size > SINGLE_READ_LIMIT_BYTES) {
    yield* ranged(client, cid, path, size);
    return;
  }
  yield* (await client.gatewayStream(cid, path)).chunks;
}

/** Write chunks to a new temp file while hashing; stops as soon as more bytes than expected arrive. */
async function writeAndHash(
  fs: FetchFs,
  temp: string,
  chunks: AsyncIterable<Uint8Array>,
  path: string,
  expectedSize: number,
): Promise<{ readonly sha256: string; readonly size: number }> {
  await fs.write(temp, new Uint8Array(0));
  const hasher = sha256.create();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > expectedSize) throw new VerificationError(path, `more than the ${expectedSize} bytes the manifest lists`);
    hasher.update(chunk);
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes >= FLUSH_BYTES) {
      await fs.append(temp, concat(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
    }
  }
  if (pendingBytes > 0) await fs.append(temp, concat(pending, pendingBytes));
  return { sha256: bytesToHex(hasher.digest()), size };
}

/** Remove a temp file. A failure here cannot change the outcome of the file, and the next pull sweeps the folder. */
export async function discardTemp(fs: Pick<HostFs, "remove">, temp: string): Promise<void> {
  await fs.remove(temp).catch(() => undefined);
}

/** Delete leftovers of an earlier interrupted pull. */
export async function sweepTemp(fs: Pick<HostFs, "stat" | "list" | "remove">): Promise<number> {
  if ((await fs.stat(TEMP_DIR))?.kind !== "directory") return 0;
  const leftovers = await fs.list(TEMP_DIR);
  for (const entry of leftovers) await fs.remove(`${TEMP_DIR}/${entry.name}`);
  return leftovers.length;
}

/**
 * Download `/ipfs/<cid>/<path>` into a temp file under `.ipfs-sync/tmp/`, hashing as it arrives, and return the
 * temp path only when size and sha256 match the manifest entry. On any mismatch or error the temp file is
 * removed and the destination is untouched. A symlink on the destination path fails the file first.
 */
export async function stageVerified(ctx: FetchContext, cid: string, path: string, entry: ManifestFile): Promise<string> {
  const link = await findSymlink(ctx.fs, path);
  if (link !== undefined) throw new SymlinkRefusedError(path, link);
  const temp = `${TEMP_DIR}/${ctx.newId()}.part`;
  try {
    const written = await writeAndHash(ctx.fs, temp, body(ctx.client, cid, path, entry.size), path, entry.size);
    if (written.size !== entry.size) throw new VerificationError(path, `received ${written.size} bytes, manifest lists ${entry.size}`);
    if (written.sha256 !== entry.sha256) throw new VerificationError(path, "sha256 differs from the manifest");
    return temp;
  } catch (error) {
    await discardTemp(ctx.fs, temp);
    throw error;
  }
}

/**
 * Move a verified temp file onto its destination and return the destination's modification time.
 * The symlink check runs again here, because a download can take long; a link then removes the temp file.
 */
export async function commitStaged(ctx: FetchContext, temp: string, path: string): Promise<number> {
  try {
    const link = await findSymlink(ctx.fs, path);
    if (link !== undefined) throw new SymlinkRefusedError(path, link);
    await ctx.fs.rename(temp, path);
  } catch (error) {
    await discardTemp(ctx.fs, temp);
    throw error;
  }
  return (await ctx.fs.stat(path))?.mtimeMs ?? 0;
}
