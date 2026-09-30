import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { assertMfsMutationPath } from "../core/config";
import type { Bytes, HostFs } from "../core/host-bridge";
import { BLOB_SEGMENT_OVERHEAD, CryptoError, blobMfsPath, blobNameFor, createBlobEncryption, type VaultKeys } from "../crypto";
import { isMissingPathError, type KuboClient } from "../kubo";
import { writeBytesToMfs } from "./chunked-write";
import { runPool, type PoolFailure } from "./pool";
import { WriteVerificationError } from "./publish-errors";
import { PublishRefusedError, fileChangedWhileReading, fileUnreadable, remoteObjectInvalid } from "./publish-refusals";

/**
 * Sending encrypted files to the node (spec: encrypted-publish, "Verified writes and safe order", "Bounded memory").
 * One file becomes one blob. A blob of one small segment goes out in one request; otherwise its 22-byte header goes
 * first and each segment follows in its own request at the running byte offset, so no buffer larger than one segment
 * (8 MiB) is ever joined and a file is never held whole. The plaintext is hashed as it streams past, so the manifest
 * records what was actually encrypted. Every blob is checked with `files/stat` (size must equal 22 + 28 n + plaintext
 * length) and its CID is recorded for the read-back. Names in errors are the opaque blob names; a host's own message,
 * which can carry a vault path, stays behind as the error's cause.
 *
 * Memory: files up to 1 MiB run with the configured concurrency, larger files two at a time, so the bytes in flight
 * stay near 100 MiB whatever the vault holds. A larger file may hold about four copies of a segment at once (the
 * plaintext, the ciphertext, its nonce-prefixed copy and the multipart body), which is why the bound is on lanes.
 */

export type TransferClient = Pick<KuboClient, "filesWrite" | "filesStat" | "filesRm">;

/** A file of at most this many bytes has a blob of one small segment, which goes out header and segment together; a larger one sends the header alone. */
const JOIN_LIMIT_BYTES = 1024 * 1024;
/** Files above the join limit are uploaded this many at a time. */
const LARGE_FILE_LANES = 2;
const BLOB_CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{10,127})$/;
const REMOVABLE_BLOB = /^current\/([a-z2-7]{2})\/\1[a-z2-7]{50}$/;
const MESSAGE_LIMIT = 160;
// Terminal escapes and line breaks in a node-supplied message are replaced before it is shown.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export interface TransferContext {
  readonly client: TransferClient;
  readonly fs: Pick<HostFs, "readRange">;
  readonly keys: VaultKeys;
  readonly mfsRoot: string;
  readonly concurrency?: number;
  /** Called before each request that changes the node; the publish lock check goes here. */
  readonly beforeWrite: () => void;
}

/** One file to encrypt and send. */
export interface BlobJob {
  /** Vault-relative path; the source of the node name and of the bytes. */
  readonly path: string;
  /** Size from the scan; the read must yield exactly this many bytes. */
  readonly size: number;
}

/** What a manifest entry needs about a written blob. */
export interface WrittenBlob {
  readonly path: string;
  /** 52-character node name. */
  readonly blob: string;
  /** 32 lowercase hex characters, the header's file identifier. */
  readonly fileId: string;
  readonly sha256: string;
  readonly size: number;
  /** CID of the blob on the node, from `files/stat` after the write. */
  readonly cid: string;
}

/** Fixed-text errors of this module are shown as they are; anything else by class and a cut, control-free message (node text is not trusted). */
function describe(error: unknown): string {
  if (error instanceof PublishRefusedError) return error.message;
  if (!(error instanceof Error)) return "an unexpected failure";
  const text = error.message.replace(CONTROL_CHARACTERS, "?");
  return `${error.name}: ${text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}...` : text}`;
}

/** One or more blob transfers failed; the IPNS record was not touched. Names are opaque blob names. */
export class BlobTransferError extends Error {
  readonly failures: readonly { readonly blob: string; readonly error: unknown }[];

  constructor(failures: readonly { readonly blob: string; readonly error: unknown }[]) {
    const first = failures[0];
    const detail = first === undefined ? "" : `: blob ${first.blob}: ${describe(first.error)}`;
    super(`${failures.length} blob transfer(s) failed${detail}`);
    this.name = "BlobTransferError";
    this.failures = failures;
  }
}

/**
 * Raise what a pool run found. A refusal with its own code (the publish lock was lost, a file changed while it was read)
 * is rethrown as it is, the lock first, so a caller keeps the code; anything else is gathered into one transfer error.
 */
async function raise<T>(failures: readonly PoolFailure<T>[], nameOf: (item: T) => Promise<string> | string): Promise<never> {
  const refusals = failures.flatMap((failure) => (failure.error instanceof PublishRefusedError ? [failure.error] : []));
  const first = refusals.find((refusal) => refusal.code === "lock-lost") ?? refusals[0];
  if (first !== undefined) throw first;
  const named = await Promise.all(failures.map(async (failure) => ({ blob: await nameOf(failure.item), error: failure.error })));
  throw new BlobTransferError(named);
}

/** `<mfsRoot>/current/<xx>/<blob name>`, confined to the project's MFS area. */
export function blobPath(mfsRoot: string, blobName: string): string {
  return assertMfsMutationPath(`${mfsRoot}/${blobMfsPath(blobName)}`);
}

/** Read the plaintext one segment at a time, feeding the running hash. A zero-length range is answered without asking the host. */
function hashingReader(fs: Pick<HostFs, "readRange">, path: string, blob: string, hasher: ReturnType<typeof sha256.create>) {
  return async (offset: number, length: number): Promise<Bytes> => {
    if (length === 0) return new Uint8Array(0);
    let chunk: Bytes;
    try {
      chunk = await fs.readRange(path, offset, length);
    } catch (error) {
      throw fileUnreadable(blob, error);
    }
    hasher.update(chunk);
    return chunk;
  };
}

function joinBytes(first: Bytes, second: Bytes): Bytes {
  const whole = new Uint8Array(first.length + second.length);
  whole.set(first, 0);
  whole.set(second, first.length);
  return whole;
}

/**
 * A blob of one small segment goes out in ONE request, header and segment together. Otherwise the 22-byte header goes
 * first (which truncates any older content) and each segment follows at the running offset.
 */
async function sendChunks(ctx: TransferContext, mfsPath: string, chunks: AsyncGenerator<Bytes>, segmentCount: number): Promise<void> {
  let header: Bytes | undefined;
  let offset = 0;
  const send = async (body: Bytes): Promise<void> => {
    ctx.beforeWrite();
    await (offset === 0 ? ctx.client.filesWrite(mfsPath, body) : ctx.client.filesWrite(mfsPath, body, { offset, truncate: false }));
    offset += body.length;
  };
  for await (const part of chunks) {
    if (header === undefined) {
      header = part;
    } else if (offset === 0 && segmentCount === 1 && part.length <= JOIN_LIMIT_BYTES + BLOB_SEGMENT_OVERHEAD) {
      await send(joinBytes(header, part));
    } else {
      if (offset === 0) await send(header);
      await send(part);
    }
  }
}

/** Encrypt one file into its blob and write it, verifying the remote size and the CID the node reports. */
export async function writeEncryptedBlob(ctx: TransferContext, job: BlobJob): Promise<WrittenBlob> {
  const blob = await blobNameFor(ctx.keys, job.path);
  const mfsPath = blobPath(ctx.mfsRoot, blob);
  const encryption = await createBlobEncryption({ keys: ctx.keys, nodeName: blob, size: job.size });
  const hasher = sha256.create();
  try {
    await sendChunks(ctx, mfsPath, encryption.chunks(hashingReader(ctx.fs, job.path, blob, hasher)), encryption.segmentCount);
  } catch (error) {
    // The only malformed-input the encryptor raises here is a read that returned fewer bytes than the scan saw.
    if (error instanceof CryptoError && error.code === "malformed-input") throw fileChangedWhileReading();
    throw error;
  }
  const stat = await ctx.client.filesStat(mfsPath);
  if (stat.size !== encryption.blobLength) throw new WriteVerificationError(mfsPath, encryption.blobLength, stat.size);
  // The node chose this CID and it goes into the manifest: refuse a shape the manifest cannot carry now, not after the upload.
  if (!BLOB_CID.test(stat.cid)) throw remoteObjectInvalid(`the CID of blob ${blob}`);
  return { path: job.path, blob, fileId: encryption.fileId, sha256: bytesToHex(hasher.digest()), size: job.size, cid: stat.cid };
}

/** Write every job: small files with the configured concurrency, then large ones two at a time. After the first failure nothing new starts. */
export async function writeEncryptedBlobs(ctx: TransferContext, jobs: readonly BlobJob[]): Promise<readonly WrittenBlob[]> {
  const groups = [
    { jobs: jobs.filter((job) => job.size <= JOIN_LIMIT_BYTES), lanes: ctx.concurrency },
    { jobs: jobs.filter((job) => job.size > JOIN_LIMIT_BYTES), lanes: LARGE_FILE_LANES },
  ];
  const written: WrittenBlob[] = [];
  for (const group of groups) {
    const outcome = await runPool(group.jobs, (job) => writeEncryptedBlob(ctx, job), group.lanes);
    if (outcome.failures.length > 0) return raise(outcome.failures, (job) => blobNameFor(ctx.keys, job.path));
    written.push(...outcome.completed.map(({ value }) => value));
  }
  return written;
}

/**
 * Remove blobs by node path. Only `current/<xx>/<name>` with a 52-character base32 name that starts with its folder
 * is accepted, whatever the caller says: this is the one destructive call, and it never touches `manifests/`,
 * `keyslots.json` or `manifest.enc`. A blob that is already gone counts as removed, so a rerun after a partial run converges.
 */
export async function removeBlobPaths(ctx: Pick<TransferContext, "client" | "beforeWrite" | "concurrency" | "mfsRoot">, blobPaths: readonly string[]): Promise<void> {
  for (const path of blobPaths) if (!REMOVABLE_BLOB.test(path)) throw remoteObjectInvalid("a removal target");
  const targets = blobPaths.map((path) => assertMfsMutationPath(`${ctx.mfsRoot}/${path}`));
  const outcome = await runPool(
    targets,
    async (target) => {
      ctx.beforeWrite();
      try {
        await ctx.client.filesRm(target);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    },
    ctx.concurrency,
  );
  if (outcome.failures.length > 0) await raise(outcome.failures, (target) => target.split("/").at(-1) ?? "");
}

/** Write `keyslots.json` to the root (first publish of a vault, or a rerun after the slots never reached the node). */
export async function writeKeySlotsFile(
  ctx: Pick<TransferContext, "client" | "beforeWrite" | "mfsRoot">,
  bytes: Bytes,
): Promise<void> {
  ctx.beforeWrite();
  await writeBytesToMfs(ctx.client, assertMfsMutationPath(`${ctx.mfsRoot}/keyslots.json`), bytes, "keyslots.json");
}
