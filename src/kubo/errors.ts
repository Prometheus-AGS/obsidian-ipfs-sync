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

  constructor(endpoint: EndpointName, url: string, status: number, detail: string) {
    super(endpoint, url, `${endpoint} endpoint ${url} answered HTTP ${status}${detail === "" ? "" : `: ${detail}`}`);
    this.status = status;
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

/** A `files/*` call failed because the MFS path does not exist. */
export function isMissingPathError(error: unknown): boolean {
  return error instanceof KuboHttpError && /does not exist|not found/i.test(error.message);
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause;
    return inner instanceof Error ? `${cause.message} (${inner.message})` : cause.message;
  }
  return String(cause);
}
