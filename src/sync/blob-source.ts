import { BLOB_HEADER_BYTES, BLOB_SEGMENT_OVERHEAD, parseBlobHeader } from "../crypto";
import type { GatewayStream, KuboClient } from "../kubo";
import { PLUGIN_MIN_EXPONENT, RANGE_PROBE_MARGIN_BYTES, WHOLE_BODY_LIMIT, blobsPerSizeClass } from "./pull-budget";

/**
 * Where the bytes of one encrypted blob come from. The fetch core (`blob-fetch.ts`) reads it from offset 0, once, in
 * order, and never asks for more than `totalLength` bytes.
 *
 * `totalLength` is the blob's exact length as the node reports it (the size of its entry in the tree listing). It is not
 * trusted: the reader needs it only to tell which segment is the last, and the fetch core refuses a blob whose length
 * does not equal `22 + 28 n + the manifest's size` for the segment size in the blob's own header.
 *
 * `chunks` is lazy: nothing is requested before the first read. A source may be backed by a stream (the CLI) or by a
 * body that was already fully buffered (the plugin: `requestUrl` returns whole bodies). This interface makes no claim
 * either way; a caller that needs bounded memory must pick a source that provides it.
 */
export interface BlobSource {
  readonly totalLength: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

/** The node answered a blob request in a way that cannot be a whole blob. The message holds fixed text and a status number only. */
export class BlobSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobSourceError";
  }
}

export type GatewayBlobClient = Pick<KuboClient, "gatewayStream">;

export interface GatewayBlobLocation {
  /** The immutable root named by the authenticated manifest's `rootCID` (never the mutable `current/` tree). */
  readonly cid: string;
  /** Path of the blob below that root, for example `<xx>/<52 character name>`. */
  readonly path: string;
  /** Blob length from the tree listing. */
  readonly totalLength: number;
}

/** Stop reading a response that cannot be used, so its connection is released (an unstarted generator would not cancel). */
async function release(stream: GatewayStream): Promise<void> {
  const iterator = stream.chunks[Symbol.asyncIterator]();
  await iterator.next().catch(() => undefined);
  await iterator.return?.();
}

/**
 * Streaming source over `gatewayStream` with no `Range` header: one request per blob, chunks handed on as they arrive,
 * so the reader holds one segment of ciphertext at a time. Only a plain 200 is accepted; a 206 or anything else was not
 * asked for and is refused. The stream is opened when the first chunk is read.
 */
export function gatewayBlobSource(client: GatewayBlobClient, location: GatewayBlobLocation): BlobSource {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const stream = await client.gatewayStream(location.cid, location.path);
    if (stream.status !== 200) {
      await release(stream);
      throw new BlobSourceError(`the gateway answered a blob request with status ${stream.status}`);
    }
    yield* stream.chunks;
  }
  return { totalLength: location.totalLength, chunks: { [Symbol.asyncIterator]: chunks } };
}

/* ---------- plugin: segment-aligned ranged source ---------- */

/** Why the ranged source declined a file. Every reason makes the file `unfetched` (this host cannot take it); none is a verdict on the bytes. */
export type RangedRefusalReason = "gateway-ignored-range" | "bad-content-range" | "bad-range-length" | "segment-size-too-small";

const REFUSAL_TEXT: Readonly<Record<RangedRefusalReason, string>> = {
  "gateway-ignored-range": "the gateway ignored the Range header; the file is too large to fetch in this host",
  "bad-content-range": "the gateway answered a range request with a Content-Range that is not the one requested",
  "bad-range-length": "the gateway answered a range request with a body of the wrong length",
  "segment-size-too-small": "the segment size is too small for ranged fetch here",
};

/**
 * The ranged source declined to hand out a file. Whatever was received is discarded, not decrypted. The message is fixed
 * text. `fetchBlobToTemp` wraps a source error as `fetch-failed` (integrity-failed) with this error as `cause`; the caller
 * maps it to `unfetched` with `rangedRefusalOf`.
 */
export class RangedSourceRefusal extends BlobSourceError {
  readonly outcome = "unfetched";
  readonly reason: RangedRefusalReason;

  constructor(reason: RangedRefusalReason) {
    super(REFUSAL_TEXT[reason]);
    this.name = "RangedSourceRefusal";
    this.reason = reason;
  }
}

/** The refusal behind an error thrown by `fetchBlobToTemp` (or the source itself), if it was one. */
export function rangedRefusalOf(error: unknown): RangedSourceRefusal | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current instanceof RangedSourceRefusal) return current;
    current = current.cause;
  }
  return undefined;
}

/** `unprobed`: no header answer seen yet; `honoured`: the probe got a 206 of the right size; `ignored`: some answer showed the gateway ignores Range (sticky for the pull). */
export type RangeState = "unprobed" | "honoured" | "ignored";

export interface RangedBlobSources {
  /**
   * Send the header request of this blob, alone, and learn whether the gateway honours Range. The pull calls it once,
   * with the smallest blob it will fetch, before any other ranged request. The answer is kept for `source` to reuse, so
   * the blob's header is not requested twice. A refusal for this blob is kept too; only a transport failure is thrown.
   */
  probe(location: GatewayBlobLocation): Promise<RangeState>;
  /** The source for one blob. Lazy: nothing is requested before the first read. */
  source(location: GatewayBlobLocation): BlobSource;
  state(): RangeState;
}

type Opening = { readonly kind: "whole"; readonly bytes: Uint8Array } | { readonly kind: "ranged"; readonly header: Uint8Array };

const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/;

/** True when the header is exactly `bytes <start>-<end>/<total>` with the numbers given. */
function contentRangeIs(header: string | undefined, start: number, end: number, total: number): boolean {
  const match = header === undefined ? null : CONTENT_RANGE.exec(header);
  return match !== null && Number(match[1]) === start && Number(match[2]) === end && Number(match[3]) === total;
}

function joined(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Read at most `max` bytes. `exceeded` means the body is longer; the reading stops there and the bytes read are dropped. */
async function readUpTo(chunks: AsyncIterable<Uint8Array>, max: number): Promise<{ readonly bytes: Uint8Array; readonly exceeded: boolean }> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    length += chunk.length;
    if (length > max) return { bytes: new Uint8Array(0), exceeded: true };
    parts.push(chunk);
  }
  return { bytes: joined(parts, length), exceeded: false };
}

function exponentOf(header: Uint8Array): number | undefined {
  try {
    return parseBlobHeader(header).exponent;
  } catch {
    // Not a readable header (bad magic, exponent outside 16..24): the decryptor refuses it from the bytes we hand on.
    return undefined;
  }
}

/**
 * Send the header probe of the smallest blob in every size class, one at a time, smallest first, and stop at the first
 * answer that shows the gateway ignores Range (review finding B2-03: a gateway can honour Range for one size and answer a
 * larger blob with a full body). Returns the number of probes sent. A transport failure is thrown, as with `probe`.
 */
export async function probeSizeClasses(
  sources: { probe(location: GatewayBlobLocation): Promise<unknown>; state(): RangeState },
  blobs: readonly GatewayBlobLocation[],
): Promise<number> {
  let sent = 0;
  for (const blob of blobsPerSizeClass(blobs)) {
    await sources.probe(blob);
    sent += 1;
    if (sources.state() === "ignored") break;
  }
  return sent;
}

/**
 * Plugin source over `gatewayStream` with `Range` requests: the 22-byte header first (`bytes=0-21`), then segment `i` at
 * `22 + i * (2^e + 28)`, the last one short. Memory note: `requestUrl` returns a whole response before the plugin sees it, so
 * nothing here is unbuffered; what the ranges bound is the size of each response, and a response that is refused is discarded,
 * not decrypted.
 *
 * Rules (design decision 14): a header or segment answer must be 206 with `Content-Range` equal to the request and the blob's
 * listed length, else the file is `unfetched`. A 200 to the header request is a whole body, taken only for a blob of at most
 * `WHOLE_BODY_LIMIT`; a 200 for a larger blob, or a 200 to a later segment request, is discarded. Any 200, or a header answer
 * longer than 22 plus `RANGE_PROBE_MARGIN_BYTES`, marks the gateway as ignoring Range, after which a blob above the limit is
 * `unfetched` with no request. An exponent below `PLUGIN_MIN_EXPONENT` is `unfetched` before any segment request; one above 24
 * is handed on as the header it is and fails as an integrity failure in the decryptor with no further request.
 */
export function createRangedBlobSources(client: GatewayBlobClient): RangedBlobSources {
  let state: RangeState = "unprobed";
  const probed = new Map<string, Opening | RangedSourceRefusal>();

  const keyOf = (location: GatewayBlobLocation): string => `${location.cid}/${location.path}`;
  const ignored = (): void => {
    state = "ignored";
  };

  async function segment(location: GatewayBlobLocation, start: number, length: number): Promise<Uint8Array> {
    const stream = await client.gatewayStream(location.cid, location.path, { start, length });
    if (stream.status === 200) {
      ignored();
      await release(stream);
      throw new RangedSourceRefusal("gateway-ignored-range");
    }
    if (stream.status !== 206) {
      await release(stream);
      throw new BlobSourceError(`the gateway answered a blob request with status ${stream.status}`);
    }
    if (!contentRangeIs(stream.contentRange, start, start + length - 1, location.totalLength)) {
      await release(stream);
      throw new RangedSourceRefusal("bad-content-range");
    }
    const { bytes, exceeded } = await readUpTo(stream.chunks, length);
    if (exceeded || bytes.length !== length) throw new RangedSourceRefusal("bad-range-length");
    return bytes;
  }

  async function openHeader(location: GatewayBlobLocation): Promise<Opening> {
    if (state === "ignored" && location.totalLength > WHOLE_BODY_LIMIT) throw new RangedSourceRefusal("gateway-ignored-range");
    const stream = await client.gatewayStream(location.cid, location.path, { start: 0, length: BLOB_HEADER_BYTES });
    if (stream.status === 200) {
      ignored();
      if (location.totalLength > WHOLE_BODY_LIMIT) {
        await release(stream);
        throw new RangedSourceRefusal("gateway-ignored-range");
      }
      const { bytes, exceeded } = await readUpTo(stream.chunks, location.totalLength);
      if (exceeded || bytes.length !== location.totalLength) throw new RangedSourceRefusal("bad-range-length");
      return { kind: "whole", bytes };
    }
    if (stream.status !== 206) {
      await release(stream);
      throw new BlobSourceError(`the gateway answered a blob request with status ${stream.status}`);
    }
    if (!contentRangeIs(stream.contentRange, 0, BLOB_HEADER_BYTES - 1, location.totalLength)) {
      await release(stream);
      throw new RangedSourceRefusal("bad-content-range");
    }
    const { bytes, exceeded } = await readUpTo(stream.chunks, BLOB_HEADER_BYTES + RANGE_PROBE_MARGIN_BYTES);
    if (exceeded) ignored();
    if (exceeded || bytes.length !== BLOB_HEADER_BYTES) throw new RangedSourceRefusal("bad-range-length");
    return { kind: "ranged", header: bytes };
  }

  async function headerOf(location: GatewayBlobLocation): Promise<Opening> {
    const key = keyOf(location);
    const kept = probed.get(key);
    probed.delete(key);
    if (kept instanceof RangedSourceRefusal) throw kept;
    return kept ?? openHeader(location);
  }

  async function* chunks(location: GatewayBlobLocation): AsyncGenerator<Uint8Array> {
    const opening = await headerOf(location);
    const header = opening.kind === "whole" ? opening.bytes.subarray(0, BLOB_HEADER_BYTES) : opening.header;
    const exponent = exponentOf(header);
    if (exponent !== undefined && exponent < PLUGIN_MIN_EXPONENT) throw new RangedSourceRefusal("segment-size-too-small");
    if (opening.kind === "whole") {
      yield opening.bytes;
      return;
    }
    yield header;
    if (exponent === undefined) return;
    const wire = 2 ** exponent + BLOB_SEGMENT_OVERHEAD;
    for (let start = BLOB_HEADER_BYTES; start < location.totalLength; start += wire) {
      yield await segment(location, start, Math.min(wire, location.totalLength - start));
    }
  }

  return {
    state: () => state,
    source: (location) => ({ totalLength: location.totalLength, chunks: { [Symbol.asyncIterator]: () => chunks(location) } }),
    async probe(location) {
      try {
        const opening = await openHeader(location);
        probed.set(keyOf(location), opening);
        if (opening.kind === "ranged" && state === "unprobed") state = "honoured";
      } catch (error) {
        if (!(error instanceof RangedSourceRefusal)) throw error;
        probed.set(keyOf(location), error);
      }
      return state;
    },
  };
}
