import type { HostFs } from "../core/host-bridge";
import type { KuboClient } from "../kubo";
import { HASH_CHUNK_BYTES, SINGLE_READ_LIMIT_BYTES } from "./hash";
import { WriteVerificationError } from "./publish-errors";

/** Files up to this size go out in one request; larger files are written in chunks. */
export const SINGLE_WRITE_LIMIT_BYTES = SINGLE_READ_LIMIT_BYTES;
export const WRITE_CHUNK_BYTES = HASH_CHUNK_BYTES;

export type WriteClient = Pick<KuboClient, "filesWrite" | "filesStat">;

export interface WrittenFile {
  /** CID of the file on the node, from `files/stat` after the write. */
  readonly cid: string;
  readonly size: number;
}

async function sendChunks(
  client: WriteClient,
  fs: Pick<HostFs, "readRange">,
  localPath: string,
  mfsPath: string,
  size: number,
): Promise<void> {
  for (let offset = 0; offset < size; offset += WRITE_CHUNK_BYTES) {
    const chunk = await fs.readRange(localPath, offset, Math.min(WRITE_CHUNK_BYTES, size - offset));
    await client.filesWrite(mfsPath, chunk, { offset, truncate: offset === 0 });
  }
}

/**
 * Write one local file to MFS and confirm the remote size with `files/stat`.
 * Up to 32 MB is one request; above that, 8 MB chunks at increasing offsets
 * (first chunk truncates, later ones do not), so the file is never fully in memory.
 */
export async function writeFileToMfs(
  client: WriteClient,
  fs: Pick<HostFs, "read" | "readRange">,
  localPath: string,
  mfsPath: string,
  size: number,
): Promise<WrittenFile> {
  if (size <= SINGLE_WRITE_LIMIT_BYTES) {
    await client.filesWrite(mfsPath, await fs.read(localPath));
  } else {
    await sendChunks(client, fs, localPath, mfsPath, size);
  }
  const stat = await client.filesStat(mfsPath);
  if (stat.size !== size) throw new WriteVerificationError(localPath, size, stat.size);
  return { cid: stat.cid, size: stat.size };
}
