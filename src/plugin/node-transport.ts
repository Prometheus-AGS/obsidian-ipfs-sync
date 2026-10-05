import type { Transport } from "../kubo";

/**
 * The desktop transport: every request goes through Node's `http` and `https`, never through Obsidian's `requestUrl`.
 *
 * Why: `requestUrl` follows redirects itself (method kept, body replayed on 307 and 308) and gives the plugin no way to see or
 * refuse a 3xx, so a node, or a proxy in front of it, could make the desktop send POSTs to any URL it names, including a local
 * kubo RPC. Node's modules never follow a redirect: the 3xx comes back as the answer and `requestEndpoint` refuses it with its
 * fixed message. `requestUrl` also hands the plugin a response only after the whole body has arrived; here the body streams, so
 * the bounded readers (64 KiB for RPC answers, the probe margin for ranged reads) cut a hostile body off before it is buffered
 * and cancelling destroys the socket.
 *
 * Differences from Chromium's network stack, stated and not worked around: Node trusts its bundled CA list unless
 * `NODE_EXTRA_CA_CERTS` is set, and it ignores the system proxy. A TLS verification failure is reported with fixed text
 * (`TLS_FAILURE_MESSAGE`), never with the text Node supplied.
 *
 * Where no Node modules are handed in (`node` undefined) `createNodeTransport` returns the fallback (`requestUrl`), which cannot
 * refuse a redirect. That is right on mobile only; `pluginTransport` never passes the fallback on desktop, where missing Node
 * modules yield `nodeUnavailableTransport` (every request refused). A response the `Response` constructor cannot represent
 * (status outside 200-599, headers `Headers` refuses) is destroyed and rejected with a fixed message. A body type this transport cannot send is rejected with a typed error; it never falls back silently. No
 * timeout is added; an abort signal on the request destroys the socket. Request headers (credentials) go to the request's own
 * URL only, since no redirect is followed. This module imports no Node module: the modules are handed in
 * (`desktopNodeModules`), so the WebView bundle stays free of Node built-ins.
 */

/* Structural slices of the Node types this file uses (src is compiled without @types/node). */
interface NodeIncoming {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(error?: Error): unknown;
}

interface NodeOutgoing {
  on(event: "response", listener: (response: NodeIncoming) => void): unknown;
  on(event: "error", listener: (error: Error & { readonly code?: string }) => void): unknown;
  end(data?: Uint8Array): unknown;
  destroy(error?: Error): unknown;
}

interface NodeRequestOptions {
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface NodeHttpModule {
  request(url: string, options: NodeRequestOptions): NodeOutgoing;
}

export interface NodeModules {
  readonly http: NodeHttpModule;
  readonly https: NodeHttpModule;
}

export interface NodeTransportOptions {
  readonly fallback: Transport;
  /** Absent on a host without Node. */
  readonly node: NodeModules | undefined;
}

/** Fixed text for a certificate failure. It names the cause class and the remedy; it carries nothing Node or the peer supplied. */
export const TLS_FAILURE_MESSAGE =
  "the connection failed TLS verification; on desktop the plugin uses Node's certificate list; set NODE_EXTRA_CA_CERTS for a private CA";

/**
 * Fixed text for a response the `Response` constructor cannot represent: a status outside 200-599 (Node's parser accepts any
 * three digits, and every 1xx throws in `new Response`) or headers `Headers` refuses. Nothing the node sent is echoed.
 */
export const NODE_RESPONSE_UNREADABLE_MESSAGE = "the node answered with a response this plugin cannot read";

/** Fixed text for a desktop app whose Node modules cannot be loaded: the redirect-following fallback is not an option there. */
export const NODE_UNAVAILABLE_MESSAGE =
  "the desktop network layer is unavailable, so the plugin will not send requests through the redirect-following fallback; reload the plugin or report this";

const BODY_TYPE_MESSAGE = "the node transport sends text or bytes only";

const MIN_RESPONSE_STATUS = 200;
const MAX_RESPONSE_STATUS = 599;
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "HOSTNAME_MISMATCH",
]);

function isTlsFailure(error: Error & { readonly code?: string }): boolean {
  const code = error.code;
  return code !== undefined && (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_"));
}

function responseHeaders(raw: NodeIncoming["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of typeof value === "string" ? [value] : value) headers.append(name, item);
  }
  return headers;
}

/** One chunk of look-ahead: the socket is paused whenever the consumer is not reading, so the stream holds a chunk or two, never the body. */
function bodyOf(incoming: NodeIncoming, request: NodeOutgoing): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        incoming.on("data", (chunk) => {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
        });
        incoming.on("end", () => controller.close());
        incoming.on("error", (error) => controller.error(error));
      },
      pull() {
        incoming.resume();
      },
      cancel() {
        incoming.destroy();
        request.destroy();
      },
    },
    { highWaterMark: 1 },
  );
}

/** The bytes of a request body: text or bytes only (multipart bodies arrive as one prebuilt buffer). */
function toBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError(BODY_TYPE_MESSAGE);
}

function nodeRequest(node: NodeModules, url: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const bytes = toBytes(init.body);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (bytes !== undefined) headers["content-length"] = String(bytes.length);
  else if (!BODYLESS_METHODS.has(method)) headers["content-length"] = "0";
  const module = url.startsWith("https:") ? node.https : node.http;
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const request = module.request(url, { method, headers });
    const onAbort = (): void => {
      request.destroy(new DOMException("aborted", "AbortError"));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      init.signal?.removeEventListener("abort", onAbort);
      reject(isTlsFailure(error) ? new Error(TLS_FAILURE_MESSAGE) : error);
    });
    request.on("response", (incoming) => {
      // This runs in an EventEmitter callback, not in the executor: a throw here would leave the promise pending, the socket open
      // and the caller (and its lock) waiting forever.
      try {
        const status = incoming.statusCode ?? 0;
        if (status < MIN_RESPONSE_STATUS || status > MAX_RESPONSE_STATUS) throw new RangeError("unsupported status");
        const noBody = NO_BODY_STATUSES.has(status);
        const headers = responseHeaders(incoming.headers);
        if (noBody) incoming.destroy();
        resolve(new Response(noBody ? null : bodyOf(incoming, request), { status, headers }));
      } catch {
        init.signal?.removeEventListener("abort", onAbort);
        incoming.destroy();
        request.destroy();
        reject(new Error(NODE_RESPONSE_UNREADABLE_MESSAGE));
      }
    });
    request.end(bytes);
  });
}

/** The transport for a desktop app whose Node modules are missing: it refuses every request with a fixed message and sends nothing. */
export const nodeUnavailableTransport: Transport = Object.assign(
  async (): Promise<Response> => {
    throw new Error(NODE_UNAVAILABLE_MESSAGE);
  },
  { transportName: "node-unavailable" },
);

export function createNodeTransport(options: NodeTransportOptions): Transport {
  const { fallback, node } = options;
  if (node === undefined) return fallback;
  const send = async (url: string, init: RequestInit): Promise<Response> => nodeRequest(node, url, init);
  return Object.assign(send, { transportName: "node" });
}

/**
 * Node's `http` and `https`, when this is a desktop app that exposes `require`; otherwise undefined. A runtime lookup, not an
 * import: the bundler sees no Node built-in, and mobile never reaches `require`.
 */
export function desktopNodeModules(isDesktopApp: boolean, host: unknown = globalThis): NodeModules | undefined {
  if (!isDesktopApp) return undefined;
  const load = (host as { require?: (id: string) => unknown }).require;
  if (typeof load !== "function") return undefined;
  try {
    const http = load("http") as NodeHttpModule | undefined;
    const https = load("https") as NodeHttpModule | undefined;
    return http !== undefined && https !== undefined ? { http, https } : undefined;
  } catch {
    return undefined;
  }
}
