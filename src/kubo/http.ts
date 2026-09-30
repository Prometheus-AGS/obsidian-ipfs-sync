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

async function readDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const message = (parsed as { Message?: unknown } | null)?.Message;
    if (typeof message === "string") return message.slice(0, DETAIL_LIMIT);
  } catch {
    // Not JSON (for example an HTML error page from the proxy): use the raw text.
  }
  return text.slice(0, DETAIL_LIMIT);
}

/** Map an HTTP status to a typed error, or return nothing for a success. */
export function statusError(endpoint: ResolvedEndpoint, url: string, status: number, detail: string): Error | undefined {
  if (status === 401 || status === 403) return new KuboAuthError(endpoint.name, endpoint.baseUrl, status);
  if (status < 200 || status >= 300) return new KuboHttpError(endpoint.name, url, status, detail);
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
  const failure = statusError(endpoint, url, response.status, response.ok ? "" : await readDetail(response));
  if (failure !== undefined) throw failure;
  return response;
}
