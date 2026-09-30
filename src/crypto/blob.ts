import { aesGcmDecrypt, aesGcmEncrypt, AES_GCM_NONCE_BYTES, AES_GCM_TAG_BYTES } from "./aes-gcm";
import { concatBytes, u64be, utf8, type Bytes } from "./bytes";
import { fromHex, toHex } from "./codec";
import { CryptoError, invalidArgument, malformed } from "./errors";
import { FILE_ID_BYTES, LABEL_BLOB_AAD, VAULT_ID_BYTES, type VaultKeys } from "./key-derivation";
import { parseBlobName } from "./blob-names";
import { randomBytes, randomNonce, secureRandom, type RandomSource } from "./random";

/*
 * Encrypted blob (spec: encrypted-blobs). One vault file is one blob:
 *   header (22 bytes) = "ISBL" (4) | version 0x01 (1) | exponent (1) | fileId (16)
 *   then n segments, each: nonce (12) | ciphertext | tag (16)
 * Every segment except the last holds exactly 2^exponent plaintext bytes; the last holds 1..2^exponent; an
 * empty file is one segment with empty plaintext. Writers use exponent 23 (8 MiB); readers accept 16..24.
 * Segment associated data: "ipfs-sync/blob/v1" | vaultId (16) | header (22) | node name (32 raw HMAC bytes) |
 * index (u64 big-endian) | final flag (1 byte). The associated data is always recomputed from the position of
 * the segment and the expected node name, never read from the blob.
 * Stated length: blob length = 22 + 28n + plaintext length exactly, which exposes each file's exact size.
 */
export const BLOB_MAGIC = "ISBL";
export const BLOB_VERSION = 1;
export const BLOB_HEADER_BYTES = 22;
export const BLOB_SEGMENT_OVERHEAD = AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES;
export const BLOB_MIN_BYTES = BLOB_HEADER_BYTES + BLOB_SEGMENT_OVERHEAD;
export const BLOB_WRITER_EXPONENT = 23;
export const BLOB_READER_MIN_EXPONENT = 16;
export const BLOB_READER_MAX_EXPONENT = 24;

const MAGIC_BYTES = utf8(BLOB_MAGIC);

/** Blob length for a plaintext length: 22 + 28 n + length, with n = max(1, ceil(length / 2^exponent)). */
export function blobLength(plaintextLength: number, exponent: number = BLOB_WRITER_EXPONENT): number {
  return BLOB_HEADER_BYTES + BLOB_SEGMENT_OVERHEAD * segmentCountFor(plaintextLength, exponent) + plaintextLength;
}

export function segmentCountFor(plaintextLength: number, exponent: number): number {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) throw invalidArgument("plaintext length out of range");
  assertExponent(exponent);
  return Math.max(1, Math.ceil(plaintextLength / 2 ** exponent));
}

function assertExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < BLOB_READER_MIN_EXPONENT || exponent > BLOB_READER_MAX_EXPONENT) {
    throw invalidArgument("segment exponent must be 16..24");
  }
}

/** Associated data of one segment. `nameBytes` is the raw 32-byte HMAC value that names the blob. */
export function blobSegmentAad(vaultIdBytes: Bytes, header: Bytes, nameBytes: Bytes, index: number, isFinal: boolean): Bytes {
  if (vaultIdBytes.length !== VAULT_ID_BYTES || header.length !== BLOB_HEADER_BYTES || nameBytes.length !== 32) {
    throw invalidArgument("blob associated data inputs have the wrong length");
  }
  return concatBytes(utf8(LABEL_BLOB_AAD), vaultIdBytes, header, nameBytes, u64be(index), new Uint8Array([isFinal ? 1 : 0]));
}

export function buildBlobHeader(exponent: number, fileId: Bytes): Bytes {
  assertExponent(exponent);
  if (fileId.length !== FILE_ID_BYTES) throw invalidArgument("file identifier must be 16 bytes");
  return concatBytes(MAGIC_BYTES, new Uint8Array([BLOB_VERSION, exponent]), fileId);
}

export interface BlobHeader {
  readonly exponent: number;
  /** 32 lowercase hex characters. */
  readonly fileId: string;
}

/** Parse and check a 22-byte header: magic, version, exponent range. Raises before any key is derived. */
export function parseBlobHeader(header: Uint8Array): BlobHeader {
  if (header.length !== BLOB_HEADER_BYTES) throw malformed("blob header has the wrong length");
  if (!MAGIC_BYTES.every((byte, index) => header[index] === byte)) throw malformed("not an encrypted blob (bad magic)");
  if (header[4] !== BLOB_VERSION) throw new CryptoError("unsupported-format", "unsupported blob version");
  const exponent = header[5] ?? 0;
  if (exponent < BLOB_READER_MIN_EXPONENT || exponent > BLOB_READER_MAX_EXPONENT) {
    throw new CryptoError("unsupported-format", "unsupported blob segment size");
  }
  return { exponent, fileId: toHex(header.subarray(6, BLOB_HEADER_BYTES)) };
}

/* ---------- writing ---------- */

export interface BlobEncryptionParams {
  readonly keys: VaultKeys;
  /** Canonical 52-character node name of this blob (it is bound into every segment). */
  readonly nodeName: string;
  /** Plaintext length in bytes. */
  readonly size: number;
}

/** Test-only writer options: a smaller segment exponent and injected randomness. Never reachable from the public functions. */
export interface BlobWriteOptions {
  readonly exponent?: number;
  readonly random?: RandomSource;
}

export interface BlobEncryption {
  /** Fresh 16-byte file identifier as hex. */
  readonly fileId: string;
  readonly header: Bytes;
  readonly exponent: number;
  readonly segmentCount: number;
  /** Exact blob length: 22 + 28 n + size. */
  readonly blobLength: number;
  /** Encrypt segment `index`; `plaintext` must have exactly the length that index requires. */
  encryptSegment(index: number, plaintext: Bytes): Promise<Bytes>;
  /**
   * Yield the header, then each encrypted segment in order, reading plaintext ranges through `read(offset, length)`.
   * Only one segment of plaintext and one of ciphertext are live at a time.
   */
  chunks(read: (offset: number, length: number) => Promise<Bytes>): AsyncGenerator<Bytes>;
}

/**
 * Start encrypting one file. A NEW random file identifier is drawn here, before anything else, so every
 * encryption (including a rewrite of unchanged content) has its own file key; each segment then draws a fresh
 * 96-bit nonce. Draw order from `random`: file identifier (16), then one nonce (12) per segment.
 */
export function createBlobEncryption(params: BlobEncryptionParams): Promise<BlobEncryption> {
  return createBlobEncryptionWith({ keys: params.keys, nodeName: params.nodeName, size: params.size }, {});
}

/** @internal test use only: exponent and randomness may be substituted. */
export async function createBlobEncryptionWith(params: BlobEncryptionParams, options: BlobWriteOptions): Promise<BlobEncryption> {
  const exponent = options.exponent ?? BLOB_WRITER_EXPONENT;
  const segmentCount = segmentCountFor(params.size, exponent);
  const random = options.random ?? secureRandom;
  const nameBytes = parseBlobName(params.nodeName);
  const fileIdBytes = randomBytes(random, FILE_ID_BYTES);
  const header = buildBlobHeader(exponent, fileIdBytes);
  const key = await params.keys.fileKey(fileIdBytes);
  const vaultIdBytes = params.keys.vaultIdBytes;
  const segmentSize = 2 ** exponent;
  const plainLengthOf = (index: number): number => (params.size === 0 ? 0 : Math.min(segmentSize, params.size - index * segmentSize));

  const encryptSegment = async (index: number, plaintext: Bytes): Promise<Bytes> => {
    if (!Number.isInteger(index) || index < 0 || index >= segmentCount) throw invalidArgument("segment index out of range");
    if (plaintext.length !== plainLengthOf(index)) throw malformed("segment plaintext has an unexpected length");
    const nonce = randomNonce(random);
    const aad = blobSegmentAad(vaultIdBytes, header, nameBytes, index, index === segmentCount - 1);
    return concatBytes(nonce, await aesGcmEncrypt(key, nonce, plaintext, aad));
  };

  async function* chunks(read: (offset: number, length: number) => Promise<Bytes>): AsyncGenerator<Bytes> {
    yield new Uint8Array(header);
    for (let index = 0; index < segmentCount; index++) {
      const length = plainLengthOf(index);
      const plaintext = await read(index * segmentSize, length);
      if (plaintext.length !== length) throw malformed("the file changed while it was being read");
      yield await encryptSegment(index, plaintext);
    }
  }

  return {
    fileId: toHex(fileIdBytes),
    header,
    exponent,
    segmentCount,
    blobLength: blobLength(params.size, exponent),
    encryptSegment,
    chunks,
  };
}

/** Encrypt a whole in-memory file into one blob (small files). */
export function encryptBlobBytes(keys: VaultKeys, nodeName: string, plaintext: Bytes): Promise<{ readonly blob: Bytes; readonly fileId: string }> {
  return encryptBlobBytesWith(keys, nodeName, plaintext, {});
}

/** @internal test use only. */
export async function encryptBlobBytesWith(
  keys: VaultKeys,
  nodeName: string,
  plaintext: Bytes,
  options: BlobWriteOptions,
): Promise<{ readonly blob: Bytes; readonly fileId: string }> {
  const encryption = await createBlobEncryptionWith({ keys, nodeName, size: plaintext.length }, options);
  const parts: Bytes[] = [];
  for await (const chunk of encryption.chunks(async (offset, length) => plaintext.slice(offset, offset + length))) parts.push(chunk);
  return { blob: concatBytes(...parts), fileId: encryption.fileId };
}

/* ---------- reading ---------- */

export interface BlobDecryptionInput {
  readonly keys: VaultKeys;
  /** Expected canonical node name; decoded to the 32 raw bytes bound into the associated data. */
  readonly nodeName: string;
  /**
   * The blob's total length in bytes (from `files/stat` or the equivalent). It is required because a reader must
   * know which segment is the final one before it decrypts the first.
   */
  readonly totalLength: number;
  readonly source: AsyncIterable<Uint8Array> | Uint8Array;
  /** The header's file identifier must equal it (hex; the manifest entry's `fileId`). Required: it defeats replay of an old genuine blob. */
  readonly expectedFileId: string;
  /** The plaintext size the manifest entry states. Required: `totalLength` must equal `blobLength(expectedSize, exponent)`. */
  readonly expectedSize: number;
}

/** @internal test use only: the manifest binding is optional. */
export interface UncheckedBlobInput extends Omit<BlobDecryptionInput, "expectedFileId" | "expectedSize"> {
  readonly expectedFileId?: string;
  readonly expectedSize?: number;
}

interface Layout {
  readonly segmentCount: number;
  readonly wireSize: number;
  readonly finalWireSize: number;
}

/**
 * Segment layout implied by the total length. Refuses a blob that cannot be a sequence of full segments followed
 * by a final one: a final piece under 28 bytes, or a final piece of exactly 28 bytes after another segment
 * (a zero-length final segment is legal only for an empty file). Other inconsistencies surface as authentication
 * failures because they cannot be told apart from tampering.
 */
function layoutFor(totalLength: number, exponent: number): Layout {
  const wireSize = 2 ** exponent + BLOB_SEGMENT_OVERHEAD;
  const body = totalLength - BLOB_HEADER_BYTES;
  const segmentCount = Math.ceil(body / wireSize);
  const finalWireSize = body - (segmentCount - 1) * wireSize;
  if (finalWireSize < BLOB_SEGMENT_OVERHEAD) throw malformed("blob ends with a piece shorter than 28 bytes");
  if (segmentCount > 1 && finalWireSize === BLOB_SEGMENT_OVERHEAD) throw malformed("blob ends with an empty segment after other segments");
  return { segmentCount, wireSize, finalWireSize };
}

const MAX_EMPTY_CHUNKS = 10_000;

const NO_BYTES: Uint8Array = new Uint8Array(0);

/** @internal exported for its structural test only */
export class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private head = 0;
  private available = 0;
  private delivered = 0;
  private finished = false;
  private emptyRun = 0;

  constructor(
    source: AsyncIterable<Uint8Array> | Uint8Array,
    private readonly total: number,
  ) {
    const iterable: AsyncIterable<Uint8Array> =
      source instanceof Uint8Array
        ? {
            async *[Symbol.asyncIterator]() {
              yield source;
            },
          }
        : source;
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  private async pull(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done === true) {
      this.finished = true;
      return;
    }
    this.delivered += next.value.length;
    if (this.delivered > this.total) throw malformed("blob is longer than its stated length");
    if (next.value.length === 0) {
      // A source that keeps yielding nothing would otherwise stall the reader forever.
      if (++this.emptyRun > MAX_EMPTY_CHUNKS) throw malformed("blob source stalled");
      return;
    }
    this.emptyRun = 0;
    this.chunks.push(next.value);
    this.available += next.value.length;
  }

  async take(length: number): Promise<Bytes> {
    while (this.available < length) {
      await this.pull();
      if (this.finished && this.available < length) throw malformed("blob is shorter than its stated length");
    }
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const head = this.chunks[this.head] as Uint8Array;
      const used = Math.min(head.length, length - offset);
      out.set(head.subarray(0, used), offset);
      offset += used;
      if (used === head.length) {
        // Release the consumed chunk now: the slot must not keep the network buffer alive until compaction.
        this.chunks[this.head++] = NO_BYTES;
      } else this.chunks[this.head] = head.subarray(used);
    }
    this.available -= length;
    // Drop consumed chunks in bulk: an index pointer keeps many tiny chunks linear instead of quadratic.
    if (this.head > 1024 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  /** Number of consumed slots that still hold bytes (must always be 0). */
  retainedConsumed(): number {
    return this.chunks.slice(0, this.head).filter((chunk) => chunk.length > 0).length;
  }

  /** The source must be exhausted: extra bytes beyond the stated length are refused. */
  async expectEnd(): Promise<void> {
    while (!this.finished) await this.pull();
    if (this.available !== 0) throw malformed("blob is longer than its stated length");
  }
}

/**
 * Decrypt a blob as an iterator that yields a segment's plaintext only AFTER that segment has authenticated.
 * The consumer must treat the file as untrusted until the iterator completes with the final segment (write to a
 * temporary file and move it into place only then), and must discard everything if the iterator throws.
 * Structural problems raise `malformed-input` or `unsupported-format` before any key is derived; a failed
 * authentication raises `authentication-failed` after any earlier segments were yielded.
 */
export function decryptBlob(input: BlobDecryptionInput): AsyncGenerator<Bytes> {
  if (typeof input.expectedFileId !== "string" || typeof input.expectedSize !== "number") {
    throw invalidArgument("decryptBlob requires the manifest's expectedFileId and expectedSize");
  }
  return decryptBlobUnchecked(input);
}

/** @internal test use only: decrypt without the manifest binding. */
export async function* decryptBlobUnchecked(input: UncheckedBlobInput): AsyncGenerator<Bytes> {
  const nameBytes = parseBlobName(input.nodeName);
  if (!Number.isSafeInteger(input.totalLength) || input.totalLength < BLOB_MIN_BYTES) {
    throw malformed("blob is shorter than 50 bytes");
  }
  const reader = new ByteReader(input.source, input.totalLength);
  const header = await reader.take(BLOB_HEADER_BYTES);
  const { exponent, fileId } = parseBlobHeader(header);
  if (input.expectedFileId !== undefined && input.expectedFileId !== fileId) {
    throw new CryptoError("vault-mismatch", "blob file identifier does not match the manifest");
  }
  if (input.expectedSize !== undefined && input.totalLength !== blobLength(input.expectedSize, exponent)) {
    throw new CryptoError("vault-mismatch", "blob length does not match the size the manifest states");
  }
  const layout = layoutFor(input.totalLength, exponent);
  const key = await input.keys.fileKey(fromHex(fileId, FILE_ID_BYTES));
  const vaultIdBytes = input.keys.vaultIdBytes;
  for (let index = 0; index < layout.segmentCount; index++) {
    const isFinal = index === layout.segmentCount - 1;
    const segment = await reader.take(isFinal ? layout.finalWireSize : layout.wireSize);
    const aad = blobSegmentAad(vaultIdBytes, header, nameBytes, index, isFinal);
    yield await aesGcmDecrypt(key, segment.subarray(0, AES_GCM_NONCE_BYTES) as Bytes, segment.subarray(AES_GCM_NONCE_BYTES) as Bytes, aad);
  }
  await reader.expectEnd();
}

async function collect(iterator: AsyncGenerator<Bytes>): Promise<Bytes> {
  const parts: Bytes[] = [];
  for await (const part of iterator) parts.push(part);
  return concatBytes(...parts);
}

/** Decrypt a whole in-memory blob against the manifest entry's file identifier and size, or raise. Small files. */
export async function decryptBlobBytes(keys: VaultKeys, nodeName: string, blob: Uint8Array, expectedFileId: string, expectedSize: number): Promise<Bytes> {
  return collect(decryptBlob({ keys, nodeName, totalLength: blob.length, source: blob, expectedFileId, expectedSize }));
}

/** @internal test use only. */
export function decryptBlobBytesUnchecked(keys: VaultKeys, nodeName: string, blob: Uint8Array, expectedFileId?: string): Promise<Bytes> {
  return collect(decryptBlobUnchecked({ keys, nodeName, totalLength: blob.length, source: blob, expectedFileId }));
}
