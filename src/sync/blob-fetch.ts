import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CryptoError, decryptBlob, type VaultKeys } from "../crypto";
import type { HostFs } from "../core/host-bridge";
import type { BlobSource } from "./blob-source";
import { TEMP_DIR, discardTemp } from "./temp-files";

/**
 * Fetch core of the decrypting pull (spec: encrypted-pull, "Fetch and verify every file"). One blob is read from a byte
 * source through the `src/crypto/blob.ts` reader, which authenticates every segment before it yields it, and the
 * plaintext is written to `.ipfs-sync/tmp/<random>.part` while an incremental sha256 runs. The temp path is returned
 * only after the last segment authenticated and the identifier, size and sha256 all equal the manifest entry. The caller
 * moves it onto the destination (after any conflict copy); nothing here touches a destination path.
 *
 * Memory: one segment of ciphertext and one of plaintext at a time, plus the chunk the source delivered last. Whether
 * the source itself buffers a whole body is the source's property (see `blob-source.ts`).
 */

/** `integrity-failed`: the bytes are not what the manifest vouches for (or the fetch broke); `unfetched`: this host could not take them. */
export type BlobFetchOutcome = "integrity-failed" | "unfetched";

export type BlobFetchReason =
  | "fetch-failed"
  | "malformed-blob"
  | "manifest-mismatch"
  | "authentication-failed"
  | "size-mismatch"
  | "hash-mismatch"
  | "could-not-write";

const REASON_TEXT: Readonly<Record<BlobFetchReason, string>> = {
  "fetch-failed": "the blob could not be read from the node",
  "malformed-blob": "the blob is not a well-formed encrypted file",
  "manifest-mismatch": "the blob does not match the manifest entry (file identifier or length)",
  "authentication-failed": "the blob failed authentication",
  "size-mismatch": "the decrypted size differs from the manifest",
  "hash-mismatch": "the decrypted content differs from the manifest hash",
  "could-not-write": "could not write",
};

const OUTCOME_OF: Readonly<Record<BlobFetchReason, BlobFetchOutcome>> = {
  "fetch-failed": "integrity-failed",
  "malformed-blob": "integrity-failed",
  "manifest-mismatch": "integrity-failed",
  "authentication-failed": "integrity-failed",
  "size-mismatch": "integrity-failed",
  "hash-mismatch": "integrity-failed",
  "could-not-write": "unfetched",
};

/**
 * One file could not be fetched and verified. The message is fixed text: it never carries a path, node text, a key or a
 * passphrase. The underlying error is kept as `cause` for the caller's own diagnostics.
 */
export class BlobFetchError extends Error {
  readonly outcome: BlobFetchOutcome;
  readonly reason: BlobFetchReason;

  constructor(reason: BlobFetchReason, cause?: unknown) {
    super(REASON_TEXT[reason], cause === undefined ? undefined : { cause });
    this.name = "BlobFetchError";
    this.reason = reason;
    this.outcome = OUTCOME_OF[reason];
  }
}

/** The part of a manifest entry the check needs: lowercase hex file identifier and sha256, and the plaintext size. */
export interface BlobFetchEntry {
  readonly fileId: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BlobFetchInput {
  readonly keys: VaultKeys;
  /** Canonical 52-character node name of this blob; it is bound into every segment. */
  readonly nodeName: string;
  readonly entry: BlobFetchEntry;
  readonly source: BlobSource;
}

export interface BlobFetchDeps {
  readonly fs: Pick<HostFs, "write" | "append" | "remove">;
  /** Unique part-file names. Defaults to a random UUID. */
  readonly newId?: () => string;
}

export interface StagedBlob {
  /** Vault-relative path of the verified plaintext, under `.ipfs-sync/tmp/`. The caller renames or discards it. */
  readonly temp: string;
  readonly size: number;
  readonly sha256: string;
}

/** Marks an error that came out of the byte source, so it is not mistaken for a verification failure. */
class SourceFailure extends Error {
  constructor(readonly original: unknown) {
    super("byte source failed", { cause: original });
    this.name = "SourceFailure";
  }
}

/** Wrap the source so its errors are tagged, and so the fetch can close it on every path (the reader never does). */
function guardSource(chunks: AsyncIterable<Uint8Array>): { readonly iterable: AsyncIterable<Uint8Array>; close(): Promise<void> } {
  let iterator: AsyncIterator<Uint8Array> | undefined;
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          try {
            iterator ??= chunks[Symbol.asyncIterator]();
            return await iterator.next();
          } catch (error) {
            throw new SourceFailure(error);
          }
        },
      }),
    },
    close: async () => {
      await iterator?.return?.().catch(() => undefined);
    },
  };
}

const INTEGRITY_CODES: ReadonlySet<string> = new Set(["authentication-failed", "malformed-input", "unsupported-format", "vault-mismatch", "oversize-input"]);

function classify(error: unknown): unknown {
  if (error instanceof BlobFetchError) return error;
  if (error instanceof SourceFailure) return new BlobFetchError("fetch-failed", error.original);
  if (error instanceof CryptoError && INTEGRITY_CODES.has(error.code)) {
    if (error.code === "authentication-failed") return new BlobFetchError("authentication-failed", error);
    if (error.code === "vault-mismatch") return new BlobFetchError("manifest-mismatch", error);
    return new BlobFetchError("malformed-blob", error);
  }
  // An environment or programming failure (no WebCrypto, a bad argument): not a property of this file, so it is not relabelled.
  return error;
}

async function writing(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw new BlobFetchError("could-not-write", error);
  }
}

/**
 * Decrypt one blob into a new part file and verify it against its manifest entry. On any failure the part file is
 * removed, the source is closed, and a `BlobFetchError` (or, for an environment failure, the original error) is thrown.
 */
export async function fetchBlobToTemp(deps: BlobFetchDeps, input: BlobFetchInput): Promise<StagedBlob> {
  const { fs } = deps;
  const { entry } = input;
  const temp = `${TEMP_DIR}/${(deps.newId ?? (() => crypto.randomUUID()))()}.part`;
  const source = guardSource(input.source.chunks);
  let plaintext: AsyncGenerator<Uint8Array> | undefined;
  let verified = false;
  try {
    await writing(() => fs.write(temp, new Uint8Array(0)));
    plaintext = decryptBlob({
      keys: input.keys,
      nodeName: input.nodeName,
      totalLength: input.source.totalLength,
      source: source.iterable,
      expectedFileId: entry.fileId,
      expectedSize: entry.size,
    });
    const hasher = sha256.create();
    let size = 0;
    for await (const segment of plaintext) {
      size += segment.length;
      hasher.update(segment);
      await writing(() => fs.append(temp, segment as Uint8Array<ArrayBuffer>));
    }
    if (size !== entry.size) throw new BlobFetchError("size-mismatch");
    const digest = bytesToHex(hasher.digest());
    if (digest !== entry.sha256) throw new BlobFetchError("hash-mismatch");
    verified = true;
    return { temp, size, sha256: digest };
  } catch (error) {
    throw classify(error);
  } finally {
    await plaintext?.return(undefined).catch(() => undefined);
    await source.close();
    if (!verified) await discardTemp(fs, temp);
  }
}

/** `<id>.part` as this module writes it, or `<id>.copy` as pull-conflict writes it (a UUID in production). Anything else in the folder is left alone. */
const PART_FILE = /^[0-9A-Za-z-]+\.(?:part|copy)$/;

export interface SweepResult {
  readonly removed: number;
  /** Part files that could not be removed; the next sweep retries them. */
  readonly failed: number;
}

/**
 * Delete stale `.part` files in `.ipfs-sync/tmp/`. The caller holds the publish lock, so no live pull owns one.
 * A removal failure is counted and does not stop the sweep.
 */
export async function sweepStaleParts(fs: Pick<HostFs, "stat" | "list" | "remove">): Promise<SweepResult> {
  if ((await fs.stat(TEMP_DIR))?.kind !== "directory") return { removed: 0, failed: 0 };
  let removed = 0;
  let failed = 0;
  for (const entry of await fs.list(TEMP_DIR)) {
    if (entry.kind !== "file" || !PART_FILE.test(entry.name)) continue;
    try {
      await fs.remove(`${TEMP_DIR}/${entry.name}`);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
