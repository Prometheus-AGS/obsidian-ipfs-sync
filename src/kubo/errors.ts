import type { EndpointName } from "../core/config";

/** Base class for every failure raised by the shared client. Messages never carry credentials. */
export class KuboError extends Error {
  readonly endpoint: EndpointName;
  readonly url: string;

  constructor(endpoint: EndpointName, url: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.endpoint = endpoint;
    this.url = url;
  }
}

/** The endpoint answered 401 or 403. */
export class KuboAuthError extends KuboError {
  readonly status: number;

  constructor(endpoint: EndpointName, url: string, status: number) {
    super(endpoint, url, `credentials rejected by the ${endpoint} endpoint ${url} (HTTP ${status})`);
    this.status = status;
  }
}

/** The endpoint answered with a non-success status other than 401/403. */
export class KuboHttpError extends KuboError {
  readonly status: number;
  /** The `Message` of the node's own JSON error body, when the body was one. Proxy pages and raw text leave this unset. */
  readonly nodeMessage: string | undefined;

  constructor(endpoint: EndpointName, url: string, status: number, detail: string, nodeMessage?: string) {
    super(endpoint, url, `${endpoint} endpoint ${url} answered HTTP ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.status = status;
    this.nodeMessage = nodeMessage;
  }
}

/** A response (or a listing in it) is larger than the caller allows. The node is untrusted, so the read is abandoned. */
export class KuboResponseTooLargeError extends KuboError {
  constructor(endpoint: EndpointName, url: string, what: string, limit: string) {
    super(endpoint, url, `${what} is larger than the limit of ${limit}; the response was refused`);
  }
}

/** No usable response (DNS, refused connection, TLS, reset, or the browser blocking the request). */
export class KuboNetworkError extends KuboError {
  constructor(endpoint: EndpointName, url: string, cause: unknown, via?: string) {
    const route = via === undefined ? "" : ` (via ${via})`;
    super(endpoint, url, `cannot reach the ${endpoint} endpoint ${url}${route}: ${describeCause(cause)}${corsHint(cause)}`, { cause });
  }
}

/** A browser `fetch` that fails with this message was usually blocked by CORS, not by the network. */
function corsHint(cause: unknown): string {
  return cause instanceof TypeError && cause.message === "Failed to fetch"
    ? " -- the browser blocked the request (CORS); the plugin uses requestUrl to avoid this"
    : "";
}

const MISSING_PATH_MESSAGE = /does not exist|not found|no link named/i;

/**
 * A `files/*` or `ls` call failed because the path does not exist. Only the node's own JSON `Message` on an
 * HTTP 500 counts: a proxy 404, an HTML error page or text in the URL must not read as "absent".
 */
export function isMissingPathError(error: unknown): boolean {
  return error instanceof KuboHttpError && error.status === 500 && error.nodeMessage !== undefined && MISSING_PATH_MESSAGE.test(error.nodeMessage);
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause;
    return inner instanceof Error ? `${cause.message} (${inner.message})` : cause.message;
  }
  return String(cause);
}
