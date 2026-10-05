import type { EndpointName } from "../core/config";

/**
 * Control characters (C0, DEL, C1 with the control sequence introducer U+009B) and the bidirectional controls, as inclusive
 * UTF-16 code unit ranges written as numbers so no invisible character sits in the source. They match `escapeForDisplay` in
 * `sync/path-policy.ts`; this layer sits below the sync layer and cannot import it.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c],
  [0x200b, 0x200d], // zero-width space, non-joiner, joiner
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2060], // word joiner
  [0x2066, 0x2069],
  [0xfeff, 0xfeff], // byte order mark / zero-width no-break space
  [0xe0000, 0xe007f], // the tag block: invisible characters that can carry hidden text
];

/** The one range table: `escapeNodeText` and the CLI's terminal output both ask this. */
export const isUnsafeCodePoint = (codePoint: number): boolean => UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

/** `\uXXXX` for a code point of the basic plane, `\u{X}` for one above it. */
function escapeCodePoint(codePoint: number): string {
  return codePoint <= 0xffff ? `\\u${codePoint.toString(16).padStart(4, "0")}` : `\\u{${codePoint.toString(16)}}`;
}

/**
 * Text the node (or a proxy in front of it) supplied, made safe to print: each unsafe character becomes a backslash, `u` and four
 * hex digits. A hostile node answering an error with terminal escape sequences could otherwise overwrite earlier lines or fake a
 * status line. Idempotent: the backslash itself is not escaped.
 */
export function escapeNodeText(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    out += isUnsafeCodePoint(codePoint) ? escapeCodePoint(codePoint) : character;
  }
  return out;
}

/** Base class for every failure raised by the shared client. Messages never carry credentials, and never a raw control character. */
export class KuboError extends Error {
  readonly endpoint: EndpointName;
  readonly url: string;

  constructor(endpoint: EndpointName, url: string, message: string, options?: { readonly cause?: unknown }) {
    super(escapeNodeText(message), options);
    this.name = new.target.name;
    this.endpoint = endpoint;
    this.url = url;
  }
}

/** Added when a gateway without its own credential answers 401 or 403. Fixed text: it names no secret and no node text. */
const GATEWAY_NO_CREDENTIAL_HINT =
  "the node credential is not sent to a gateway on a different address; set a gateway credential in the plugin settings under 'Gateway authentication', or for the CLI with the IPFS_SYNC_GATEWAY_AUTH_* variables";

/** Why an endpoint carried no credential, when that is worth telling the user. `other-origin`: the node credential was not inherited by a gateway on a different address. */
export type CredentialWithheldReason = "other-origin";

/** The endpoint answered 401 or 403. `withheld` is set only when the request carried no credential for a reason the user can fix. */
export class KuboAuthError extends KuboError {
  readonly status: number;

  constructor(endpoint: EndpointName, url: string, status: number, withheld?: CredentialWithheldReason) {
    const hint = endpoint === "gateway" && withheld === "other-origin" ? ` -- ${GATEWAY_NO_CREDENTIAL_HINT}` : "";
    super(endpoint, url, `credentials rejected by the ${endpoint} endpoint ${url} (HTTP ${status})${hint}`);
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
