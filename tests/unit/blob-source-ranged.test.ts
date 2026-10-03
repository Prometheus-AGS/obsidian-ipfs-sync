import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import { blobNameFor, type Bytes, type VaultKeys } from "../../src/crypto";
import { encryptBlobBytesWith } from "../../src/crypto/blob";
import { createKuboClient, type GatewayRange, type GatewayStream } from "../../src/kubo";
import { BlobFetchError, fetchBlobToTemp, type BlobFetchEntry } from "../../src/sync/blob-fetch";
import { RangedSourceRefusal, createRangedBlobSources, rangedRefusalOf, type GatewayBlobClient, type GatewayBlobLocation } from "../../src/sync/blob-source";
import {
  PLUGIN_MIN_EXPONENT,
  PULL_CONFIRM_ABOVE_DEFAULT,
  RANGE_PROBE_MARGIN_BYTES,
  SEGMENT_MEMORY_BUDGET,
  WHOLE_BODY_LIMIT,
  exceedsPullCeiling,
  pullConcurrency,
  smallestBlob,
  totalBytesToFetch,
} from "../../src/sync/pull-budget";
import { requestUrlTransport } from "../../src/plugin/request-url-transport";
import { createFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { createMemoryHost } from "../helpers/memory-host";
import { requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse } from "../support/obsidian-stub";
import { keysFrom } from "../vectors/blob-helpers";

const MIB = 1024 * 1024;
const ROOT = "bafyroot000000000000";
const WIRE20 = 2 ** 20 + 28;

const sha = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

/** A buffer that differs from segment to segment without costing a callback per byte. */
function filled(length: number): Bytes {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 4093) bytes[index] = (index >> 12) & 255 || 1;
  return bytes;
}

interface Blob {
  readonly path: string;
  readonly name: string;
  readonly keys: VaultKeys;
  readonly plaintext: Bytes;
  readonly bytes: Bytes;
  readonly entry: BlobFetchEntry;
  readonly location: GatewayBlobLocation;
}

async function blobOf(label: string, size: number, exponent = 20): Promise<Blob> {
  const keys = await keysFrom(0x20, 0x50);
  const name = await blobNameFor(keys, label);
  const plaintext = filled(size);
  const { blob, fileId } = await encryptBlobBytesWith(keys, name, plaintext, { exponent });
  const path = `ab/${name}`;
  return {
    path,
    name,
    keys,
    plaintext,
    bytes: blob,
    entry: { fileId, size, sha256: sha(plaintext) },
    location: { cid: ROOT, path, totalLength: blob.length },
  };
}

function serve(gateway: FakeGateway, ...blobs: Blob[]): void {
  for (const blob of blobs) gateway.objects.set(`${ROOT}/${blob.path}`, blob.bytes);
}

const gatewayOf = (honourRange: boolean): FakeGateway => createFakeGateway({ chunkSize: MIB, honourRange });

/** Rewrite what the gateway answers, for the wrong-header cases. */
function altered(client: GatewayBlobClient, change: (stream: GatewayStream, range: GatewayRange | undefined) => GatewayStream): GatewayBlobClient {
  return { gatewayStream: async (cid, path, range) => change(await client.gatewayStream(cid, path, range), range) };
}

async function fetchVia(sources: ReturnType<typeof createRangedBlobSources>, blob: Blob, host = createMemoryHost()): Promise<{ readonly host: ReturnType<typeof createMemoryHost>; readonly result: Awaited<ReturnType<typeof fetchBlobToTemp>> }> {
  const result = await fetchBlobToTemp({ fs: host.fs, newId: () => "one" }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: sources.source(blob.location) });
  return { host, result };
}

async function failureOf(promise: Promise<unknown>): Promise<BlobFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BlobFetchError);
    return error as BlobFetchError;
  }
  throw new Error("expected the fetch to fail");
}

const requestsFor = (gateway: FakeGateway, blob: Blob): string[] => gateway.requests.filter((line) => line.includes(blob.path));
const appended = (host: ReturnType<typeof createMemoryHost>): boolean => host.mutations.some((m) => m.startsWith("append"));

describe("ranged plugin source", () => {
  it("honoured ranges: a 40 MiB blob is fetched one segment-aligned response at a time", async () => {
    const blob = await blobOf("big.bin", 40 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const sources = createRangedBlobSources(gateway.client);
    const { host, result } = await fetchVia(sources, blob);
    expect(result.sha256).toBe(blob.entry.sha256);
    expect(host.files.get(result.temp)?.data.length).toBe(40 * MIB);
    const expected: (readonly [number, number])[] = [[0, 22]];
    for (let index = 0; index < 40; index++) expected.push([22 + index * WIRE20, WIRE20]);
    expect(gateway.ranges).toEqual(expected);
    expect(gateway.stats.maxInFlight).toBe(1);
    expect(sources.state()).toBe("unprobed");
  });

  it("a short last segment is requested with its own length", async () => {
    const blob = await blobOf("odd.bin", 2 * MIB + 5);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    await fetchVia(createRangedBlobSources(gateway.client), blob);
    expect(gateway.ranges).toEqual([[0, 22], [22, WIRE20], [22 + WIRE20, WIRE20], [22 + 2 * WIRE20, 5 + 28]]);
  });

  it("a probe on an honoured gateway marks it honoured and the header is not requested twice", async () => {
    const blob = await blobOf("probe.bin", 3 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const sources = createRangedBlobSources(gateway.client);
    expect(await sources.probe(blob.location)).toBe("honoured");
    expect(gateway.ranges).toEqual([[0, 22]]);
    await fetchVia(sources, blob);
    expect(gateway.ranges.filter(([start]) => start === 0)).toHaveLength(1);
    expect(gateway.ranges).toHaveLength(1 + 3);
  });

  it("a gateway that ignores Range: the smallest header goes first and alone, the large file is unfetched with no request, the small one is fetched whole", async () => {
    const small = await blobOf("small.md", 2 * MIB);
    const large: Blob = { ...(await blobOf("large.bin", 1 * MIB)), location: { cid: ROOT, path: "ab/large", totalLength: 100 * MIB } };
    const gateway = gatewayOf(false);
    serve(gateway, small);
    gateway.objects.set(`${ROOT}/ab/large`, new Uint8Array(0));
    const sources = createRangedBlobSources(gateway.client);

    const first = smallestBlob([large.location, small.location]);
    expect(first).toBe(small.location);
    expect(await sources.probe(first ?? small.location)).toBe("ignored");
    expect(gateway.requests).toEqual([`GET ${ROOT}/${small.path} Range: bytes=0-21`]);

    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: large.keys, nodeName: large.name, entry: large.entry, source: sources.source(large.location) }));
    expect(error.outcome).toBe("integrity-failed");
    const refusal = rangedRefusalOf(error);
    expect(refusal?.outcome).toBe("unfetched");
    expect(refusal?.reason).toBe("gateway-ignored-range");
    expect(requestsFor(gateway, { ...large, path: "ab/large" })).toEqual([]);

    const { result } = await fetchVia(sources, small);
    expect(result.sha256).toBe(small.entry.sha256);
    expect(gateway.requests).toEqual([`GET ${ROOT}/${small.path} Range: bytes=0-21`]);
  });

  it("a 200 answer to a header request for a 100 MiB blob is discarded, not decrypted", async () => {
    const real = await blobOf("large.bin", 1 * MIB);
    const gateway = gatewayOf(false);
    gateway.objects.set(`${ROOT}/ab/large`, real.bytes);
    const location: GatewayBlobLocation = { cid: ROOT, path: "ab/large", totalLength: 100 * MIB };
    const host = createMemoryHost();
    const sources = createRangedBlobSources(gateway.client);
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: real.keys, nodeName: real.name, entry: real.entry, source: sources.source(location) }));
    expect(rangedRefusalOf(error)?.reason).toBe("gateway-ignored-range");
    expect(gateway.requests).toEqual([`GET ${ROOT}/ab/large Range: bytes=0-21`]);
    expect(sources.state()).toBe("ignored");
    expect(appended(host)).toBe(false);
    expect([...host.files.keys()]).toEqual([]);
  });

  it("a 200 answer for a 20 MiB blob is accepted as a whole body", async () => {
    const blob = await blobOf("mid.bin", 20 * MIB);
    expect(blob.bytes.length).toBeLessThanOrEqual(WHOLE_BODY_LIMIT);
    const gateway = gatewayOf(false);
    serve(gateway, blob);
    const sources = createRangedBlobSources(gateway.client);
    const { result } = await fetchVia(sources, blob);
    expect(result.sha256).toBe(blob.entry.sha256);
    expect(gateway.requests).toHaveLength(1);
    expect(sources.state()).toBe("ignored");
  });

  it("a 200 body of the wrong length for a small blob is refused", async () => {
    const blob = await blobOf("short.bin", 2 * MIB);
    const gateway = gatewayOf(false);
    gateway.objects.set(`${ROOT}/${blob.path}`, blob.bytes.slice(0, blob.bytes.length - 1));
    const host = createMemoryHost();
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(gateway.client).source(blob.location) }));
    expect(rangedRefusalOf(error)?.reason).toBe("bad-range-length");
    expect(appended(host)).toBe(false);
  });

  it("a header answer far above 22 bytes marks the gateway as ignoring Range even under status 206", async () => {
    const blob = await blobOf("liar.bin", 2 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const client = altered(gateway.client, (stream) => ({ ...stream, chunks: (async function* () { yield new Uint8Array(22 + RANGE_PROBE_MARGIN_BYTES + 1); })() }));
    const sources = createRangedBlobSources(client);
    expect(await sources.probe(blob.location)).toBe("ignored");
  });

  it("a 206 with a wrong Content-Range is unfetched and decrypts nothing (header, start, end and total)", async () => {
    const blob = await blobOf("range.bin", 2 * MIB);
    const total = blob.bytes.length;
    for (const value of ["bytes 0-21/999", `bytes 1-22/${total}`, `bytes 0-20/${total}`, `bytes 0-21/${total + 1}`, "items 0-21/" + total, undefined]) {
      const gateway = gatewayOf(true);
      serve(gateway, blob);
      const client = altered(gateway.client, (stream) => ({ ...stream, contentRange: value }));
      const host = createMemoryHost();
      const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(client).source(blob.location) }));
      expect(rangedRefusalOf(error)?.reason).toBe("bad-content-range");
      expect(appended(host)).toBe(false);
      expect(gateway.requests).toHaveLength(1);
    }
  });

  it("a wrong Content-Range on a later segment is unfetched and leaves no part file", async () => {
    const blob = await blobOf("later.bin", 3 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const client = altered(gateway.client, (stream, range) => (range?.start === 22 + WIRE20 ? { ...stream, contentRange: `bytes ${range.start}-${range.start + range.length - 1}/${blob.bytes.length + 1}` } : stream));
    const host = createMemoryHost();
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(client).source(blob.location) }));
    expect(rangedRefusalOf(error)?.reason).toBe("bad-content-range");
    expect([...host.files.keys()]).toEqual([]);
    expect(gateway.ranges).toHaveLength(3);
  });

  it("a 206 body longer or shorter than the range is refused", async () => {
    const blob = await blobOf("len.bin", 2 * MIB);
    for (const delta of [1, -1]) {
      const gateway = gatewayOf(true);
      serve(gateway, blob);
      const client = altered(gateway.client, (stream, range) => {
        if (range?.start !== 22) return stream;
        return { ...stream, chunks: (async function* () { yield new Uint8Array(range.length + delta); })() };
      });
      const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(client).source(blob.location) }));
      expect(rangedRefusalOf(error)?.reason).toBe("bad-range-length");
    }
  });

  it("a segment request answered 200 is refused and marks the gateway", async () => {
    const blob = await blobOf("flip.bin", 3 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const client = altered(gateway.client, (stream, range) => (range?.start === 22 ? { ...stream, status: 200 } : stream));
    const sources = createRangedBlobSources(client);
    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: sources.source(blob.location) }));
    expect(rangedRefusalOf(error)?.reason).toBe("gateway-ignored-range");
    expect(sources.state()).toBe("ignored");
  });

  it("an exponent below the plugin floor is unfetched with no segment request", async () => {
    for (const exponent of [16, PLUGIN_MIN_EXPONENT - 1]) {
      const blob = await blobOf("small-seg.bin", 5 * 2 ** exponent, exponent);
      const gateway = gatewayOf(true);
      serve(gateway, blob);
      const host = createMemoryHost();
      const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(gateway.client).source(blob.location) }));
      const refusal = rangedRefusalOf(error);
      expect(refusal).toBeInstanceOf(RangedSourceRefusal);
      expect(refusal?.reason).toBe("segment-size-too-small");
      expect(gateway.requests).toEqual([`GET ${ROOT}/${blob.path} Range: bytes=0-21`]);
      expect(appended(host)).toBe(false);
    }
  });

  it("exponent 20 is the floor and is fetched", async () => {
    const blob = await blobOf("floor.bin", 2 * MIB, PLUGIN_MIN_EXPONENT);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const { result } = await fetchVia(createRangedBlobSources(gateway.client), blob);
    expect(result.sha256).toBe(blob.entry.sha256);
  });

  it("an exponent above 24 is an integrity failure with no segment request", async () => {
    const blob = await blobOf("tall.bin", 2 * MIB);
    const bad = blob.bytes.slice();
    bad[5] = 25;
    const gateway = gatewayOf(true);
    gateway.objects.set(`${ROOT}/${blob.path}`, bad);
    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(gateway.client).source(blob.location) }));
    expect(error.outcome).toBe("integrity-failed");
    expect(error.reason).toBe("malformed-blob");
    expect(rangedRefusalOf(error)).toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
  });

  it("a listing length that does not fit the manifest size fails as integrity before any segment request", async () => {
    const blob = await blobOf("lie.bin", 2 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const location = { ...blob.location, totalLength: blob.bytes.length + 28 };
    // The header answer carries the listed total, so the gateway is made to agree with the lying listing.
    const client = altered(gateway.client, (stream) => (stream.contentRange === undefined ? stream : { ...stream, contentRange: `bytes 0-21/${location.totalLength}` }));
    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(client).source(location) }));
    expect(error.reason).toBe("manifest-mismatch");
    expect(gateway.ranges).toEqual([[0, 22]]);
  });

  it("a probe keeps its refusal for the blob and sends no second request; a transport failure is thrown", async () => {
    const blob = await blobOf("kept.bin", 2 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const client = altered(gateway.client, (stream) => ({ ...stream, contentRange: "bytes 0-21/1" }));
    const sources = createRangedBlobSources(client);
    expect(await sources.probe(blob.location)).toBe("unprobed");
    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: sources.source(blob.location) }));
    expect(rangedRefusalOf(error)?.reason).toBe("bad-content-range");
    expect(gateway.requests).toHaveLength(1);

    const broken = createRangedBlobSources({ gatewayStream: async () => { throw new Error("socket hang up"); } });
    await expect(broken.probe(blob.location)).rejects.toThrow("socket hang up");
  });

  it("any other status is a source failure, not a refusal", async () => {
    const blob = await blobOf("odd-status.bin", 2 * MIB);
    const gateway = gatewayOf(true);
    serve(gateway, blob);
    const client = altered(gateway.client, (stream) => ({ ...stream, status: 416 }));
    const error = await failureOf(fetchBlobToTemp({ fs: createMemoryHost().fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(client).source(blob.location) }));
    expect(error.reason).toBe("fetch-failed");
    expect(rangedRefusalOf(error)).toBeUndefined();
  });

  it("one flipped bit in a ranged segment still fails authentication", async () => {
    const blob = await blobOf("flip-bit.bin", 3 * MIB);
    const bad = blob.bytes.slice();
    bad[22 + WIRE20 + 100] = (bad[22 + WIRE20 + 100] ?? 0) ^ 1;
    const gateway = gatewayOf(true);
    gateway.objects.set(`${ROOT}/${blob.path}`, bad);
    const host = createMemoryHost();
    const error = await failureOf(fetchBlobToTemp({ fs: host.fs }, { keys: blob.keys, nodeName: blob.name, entry: blob.entry, source: createRangedBlobSources(gateway.client).source(blob.location) }));
    expect(error.outcome).toBe("integrity-failed");
    expect(error.reason).toBe("authentication-failed");
    expect([...host.files.keys()]).toEqual([]);
  });
});

describe("requestUrl transport and Range", () => {
  afterEach(() => {
    resetRequestUrl();
  });

  it("forwards the Range header and exposes Content-Range to the ranged source", async () => {
    const blob = await blobOf("transport.bin", 2 * MIB);
    resetRequestUrl();
    setRequestUrlHandler((params) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(params.headers?.Range ?? params.headers?.range ?? "");
      if (range === null) return stubResponse(200, blob.bytes);
      const start = Number(range[1]);
      const end = Number(range[2]);
      return stubResponse(206, blob.bytes.slice(start, end + 1), { "content-range": `bytes ${start}-${end}/${blob.bytes.length}` });
    });
    const client = createKuboClient({
      rpc: { name: "rpc", baseUrl: "https://rpc.example.org:5001", auth: { kind: "none" } },
      gateway: { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "none" } },
      transport: requestUrlTransport,
    });
    const { result } = await fetchVia(createRangedBlobSources(client), { ...blob, location: { ...blob.location, cid: "bafkreiaaaaaaaaaaaaaaaaaa" } });
    expect(result.sha256).toBe(blob.entry.sha256);
    const ranges = requestUrlCalls.map((call) => call.headers?.Range ?? call.headers?.range);
    expect(ranges[0]).toBe("bytes=0-21");
    expect(ranges).toHaveLength(1 + 2);
  });
});

describe("pull budget", () => {
  it("states the proposed constants", () => {
    expect(SEGMENT_MEMORY_BUDGET).toBe(128 * MIB);
    expect(WHOLE_BODY_LIMIT).toBe(32 * MIB);
    expect(PULL_CONFIRM_ABOVE_DEFAULT).toBe(512 * MIB);
    expect(PLUGIN_MIN_EXPONENT).toBe(20);
    expect(RANGE_PROBE_MARGIN_BYTES).toBe(64);
  });

  it("concurrency is 6 at exponent 23 and 4 at exponent 24, and never above 6", () => {
    expect(pullConcurrency(23)).toBe(6);
    expect(pullConcurrency(24)).toBe(4);
    expect(pullConcurrency(20)).toBe(6);
    expect(pullConcurrency(16)).toBe(6);
    for (const exponent of [20, 21, 22, 23, 24]) {
      expect(pullConcurrency(exponent) * 2 * 2 ** exponent).toBeLessThanOrEqual(SEGMENT_MEMORY_BUDGET);
    }
    expect(() => pullConcurrency(-1)).toThrow(RangeError);
  });

  it("totals the sizes exactly and refuses a bad size", () => {
    expect(totalBytesToFetch([])).toBe(0);
    expect(totalBytesToFetch([{ size: 0 }, { size: 1 }, { size: 2 ** 40 }, { size: 7 }])).toBe(2 ** 40 + 8);
    expect(() => totalBytesToFetch([{ size: -1 }])).toThrow(RangeError);
    expect(() => totalBytesToFetch([{ size: 1.5 }])).toThrow(RangeError);
    expect(() => totalBytesToFetch([{ size: Number.MAX_SAFE_INTEGER }, { size: 1 }])).toThrow(RangeError);
  });

  it("the confirmation ceiling is strict and the smallest blob is the first of equals", () => {
    expect(exceedsPullCeiling(512 * MIB)).toBe(false);
    expect(exceedsPullCeiling(512 * MIB + 1)).toBe(true);
    expect(exceedsPullCeiling(65 * MIB, 64 * MIB)).toBe(true);
    const a = { totalLength: 5, id: "a" };
    const b = { totalLength: 3, id: "b" };
    const c = { totalLength: 3, id: "c" };
    expect(smallestBlob([a, b, c])?.id).toBe("b");
    expect(smallestBlob([])).toBeUndefined();
  });
});
