import type { ResolvedEndpoint } from "../core/config";
import { KuboAuthError, KuboHttpError, KuboNetworkError } from "./errors";

const DETAIL_LIMIT = 200;

/**
 * How a request reaches the network. The CLI uses the platform `fetch`. The Obsidian plugin uses an adapter over
 * Obsidian's `requestUrl` (src/plugin/request-url-transport.ts), because the WebView's `fetch` is CORS-blocked by the node.
 * `transportName` appears in network error messages.
 */
export interface Transport {
  (url: string, init: RequestInit): Promise<Response>;
  readonly transportName?: string;
}

/** Resolves the global `fetch` at call time, so tests may stub it. */
export const fetchTransport: Transport = Object.assign((url: string, init: RequestInit) => fetch(url, init), { transportName: "fetch" });

export type QueryArgs = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;

function encodePair(key: string, value: string | number | boolean): string {
  return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

/**
 * Build `<base>/api/v0/<command>?...`. Every kubo argument travels in the
 * query string: the proxy drops form-encoded arguments.
 */
export function buildRpcUrl(baseUrl: string, command: string, args: QueryArgs = {}): string {
  const pairs = Object.entries(args).flatMap(([key, value]) => {
    if (value === undefined) return [];
    return typeof value === "object" ? value.map((v) => encodePair(key, v)) : [encodePair(key, value)];
  });
  const query = pairs.length === 0 ? "" : `?${pairs.join("&")}`;
  return `${baseUrl}/api/v0/${command}${query}`;
}

/** An error body is read for at most this many bytes; the node is untrusted and the detail is cut to 200 characters anyway. */
export const ERROR_BODY_MAX_BYTES = 16 * 1024;

/** Up to `limit` bytes of the body as text; the rest is never pulled and the stream is cancelled. */
async function readBoundedPrefix(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value.subarray(0, limit - total));
      total += parts.at(-1)?.length ?? 0;
    }
  } catch {
    // A broken body still yields whatever arrived before the break.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(whole);
}

interface ErrorDetail {
  readonly detail: string;
  /** Set only when the body was the node's JSON error object. */
  readonly nodeMessage: string | undefined;
}

async function readDetail(response: Response): Promise<ErrorDetail> {
  const text = (await readBoundedPrefix(response, ERROR_BODY_MAX_BYTES)).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { Message?: unknown } | null)?.Message;
    if (typeof message === "string") return { detail: message.slice(0, DETAIL_LIMIT), nodeMessage: message.slice(0, DETAIL_LIMIT) };
  } catch {
    // Not JSON (for example an HTML error page from the proxy): use the raw text.
  }
  return { detail: text.slice(0, DETAIL_LIMIT), nodeMessage: undefined };
}

/** Map an HTTP status to a typed error, or return nothing for a success. */
export function statusError(endpoint: ResolvedEndpoint, url: string, status: number, detail: string, nodeMessage?: string): Error | undefined {
  if (status === 401 || status === 403) return new KuboAuthError(endpoint.name, endpoint.baseUrl, status);
  if (status < 200 || status >= 300) return new KuboHttpError(endpoint.name, url, status, detail, nodeMessage);
  return undefined;
}

/**
 * Issue one request against an endpoint through `transport` (default: the platform `fetch`, which
 * the WebView and Node 24 both provide). Failures become typed errors.
 */
export async function requestEndpoint(
  endpoint: ResolvedEndpoint,
  url: string,
  init: RequestInit,
  transport: Transport = fetchTransport,
): Promise<Response> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch (cause) {
    throw new KuboNetworkError(endpoint.name, endpoint.baseUrl, cause, transport.transportName);
  }
  const read: ErrorDetail = response.ok ? { detail: "", nodeMessage: undefined } : await readDetail(response);
  const failure = statusError(endpoint, url, response.status, read.detail, read.nodeMessage);
  if (failure !== undefined) throw failure;
  return response;
}
