import type { ResolvedEndpoint } from "../core/config";
import { authHeaders } from "./auth-headers";
import { KuboError, KuboNetworkError } from "./errors";
import { requestEndpoint, type Transport } from "./http";

const CID_SHAPE = /^[A-Za-z0-9]{10,}$/;

/** A byte range of a gateway object: `length` bytes starting at `start`. */
export interface GatewayRange {
  readonly start: number;
  readonly length: number;
}

/**
 * A gateway response read as chunks. `status` is 206 when the gateway honoured the range and 200 when it
 * ignored it and sends the whole object; the caller decides whether it can use a whole body.
 */
export interface GatewayStream {
  readonly status: number;
  /** The `Content-Range` response header, when present. */
  readonly contentRange: string | undefined;
  readonly chunks: AsyncIterable<Uint8Array>;
}

function encodeGatewayPath(endpoint: ResolvedEndpoint, cid: string, path: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new KuboError(endpoint.name, endpoint.baseUrl, `gateway path "${path}" must not contain . or .. segments`);
  }
  return [cid, ...segments.map(encodeURIComponent)].join("/");
}

function gatewayUrl(endpoint: ResolvedEndpoint, cid: string, path: string): string {
  if (!CID_SHAPE.test(cid)) {
    throw new KuboError(endpoint.name, endpoint.baseUrl, `"${cid.replace(/[^A-Za-z0-9]/g, "?").slice(0, 64)}" is not a valid CID`);
  }
  return `${endpoint.baseUrl}/ipfs/${encodeGatewayPath(endpoint, cid, path)}`;
}

/** Fetch `<gateway>/ipfs/<cid>[/<path>]` with the gateway's authentication and return the bytes. */
export async function fetchGatewayBytes(
  endpoint: ResolvedEndpoint,
  cid: string,
  path = "",
  transport?: Transport,
): Promise<Uint8Array> {
  const url = gatewayUrl(endpoint, cid, path);
  const response = await requestEndpoint(endpoint, url, { method: "GET", headers: authHeaders(endpoint.auth) }, transport);
  return new Uint8Array(await response.arrayBuffer());
}

function rangeHeader(endpoint: ResolvedEndpoint, range: GatewayRange): string {
  if (!Number.isSafeInteger(range.start) || range.start < 0 || !Number.isSafeInteger(range.length) || range.length < 1) {
    throw new KuboError(endpoint.name, endpoint.baseUrl, `invalid gateway range start=${range.start} length=${range.length}`);
  }
  return `bytes=${range.start}-${range.start + range.length - 1}`;
}

/** Read a response body chunk by chunk. A failure mid-body surfaces as a network error naming the endpoint. */
async function* readChunks(endpoint: ResolvedEndpoint, body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((cause: unknown) => {
        throw new KuboNetworkError(endpoint.name, endpoint.baseUrl, cause);
      });
      if (done) return;
      yield value;
    }
  } finally {
    // Stop the transfer when the consumer leaves early; a cancel error changes nothing for the caller.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Open `<gateway>/ipfs/<cid>[/<path>]` as a chunk stream, with an HTTP `Range` request when `range` is given.
 * Read-only. Gateway auth is applied like any other gateway read.
 */
export async function openGatewayStream(
  endpoint: ResolvedEndpoint,
  cid: string,
  path = "",
  range?: GatewayRange,
  transport?: Transport,
): Promise<GatewayStream> {
  const url = gatewayUrl(endpoint, cid, path);
  const headers = range === undefined ? authHeaders(endpoint.auth) : { ...authHeaders(endpoint.auth), Range: rangeHeader(endpoint, range) };
  const response = await requestEndpoint(endpoint, url, { method: "GET", headers }, transport);
  return {
    status: response.status,
    contentRange: response.headers.get("content-range") ?? undefined,
    chunks: readChunks(endpoint, response.body),
  };
}
