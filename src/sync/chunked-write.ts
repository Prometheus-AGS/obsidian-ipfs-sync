import type { Bytes } from "../core/host-bridge";
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

/**
 * Write bytes that are already in memory (key slots, `manifest.enc`, a history file) and confirm the remote size.
 * Up to 32 MB is one request; above that, 8 MB pieces at increasing offsets. `label` names the object in an error
 * message and is never a vault path.
 */
export async function writeBytesToMfs(client: WriteClient, mfsPath: string, bytes: Bytes, label: string): Promise<WrittenFile> {
  if (bytes.length <= SINGLE_WRITE_LIMIT_BYTES) {
    await client.filesWrite(mfsPath, bytes);
  } else {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
      await client.filesWrite(mfsPath, bytes.subarray(offset, offset + WRITE_CHUNK_BYTES), { offset, truncate: offset === 0 });
    }
  }
  const stat = await client.filesStat(mfsPath);
  if (stat.size !== bytes.length) throw new WriteVerificationError(label, bytes.length, stat.size);
  return { cid: stat.cid, size: stat.size };
}
