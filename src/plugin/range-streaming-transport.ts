import type { Transport } from "../kubo";

/**
 * Desktop streaming for ranged gateway reads (review finding B2-03). Obsidian's `requestUrl` hands the plugin a response only
 * after the whole body has arrived, so a hostile gateway that answers a 22-byte `Range` request with a multi-GB full body
 * costs the plugin that much memory before any size check runs. On desktop Obsidian runs with Node, whose `http` and `https`
 * modules deliver the body as a stream: the ranged source reads at most 22 + 64 bytes of a header answer, then cancels, and
 * cancelling destroys the socket.
 *
 * Only a GET that carries a `Range` header is streamed (those are the requests whose answer may be unbounded: header and
 * segment reads of encrypted blobs). Every other request, and every request on a host without Node (mobile), goes to the
 * fallback transport (`requestUrl`) unchanged. This module imports no Node module; the modules are handed in
 * (`desktopNodeModules`), so the WebView bundle stays free of Node built-ins.
 *
 * Not done here: redirects are not followed (a redirect status is returned as the answer), the system proxy is not consulted,
 * and no timeout is added; an abort signal on the request destroys the socket.
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
  on(event: "error", listener: (error: Error) => void): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

interface NodeRequestOptions {
  readonly method: "GET";
  readonly headers: Record<string, string>;
}

export interface NodeHttpModule {
  request(url: string, options: NodeRequestOptions): NodeOutgoing;
}

export interface NodeModules {
  readonly http: NodeHttpModule;
  readonly https: NodeHttpModule;
}

export interface RangeStreamingOptions {
  readonly fallback: Transport;
  /** Absent on a host without Node. */
  readonly node: NodeModules | undefined;
}

const NO_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

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

function rangeRequest(node: NodeModules, url: string, init: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const module = url.startsWith("https:") ? node.https : node.http;
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted === true) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const request = module.request(url, { method: "GET", headers });
    const onAbort = (): void => {
      request.destroy(new DOMException("aborted", "AbortError"));
    };
    init.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      init.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.on("response", (incoming) => {
      const status = incoming.statusCode ?? 0;
      const noBody = NO_BODY_STATUSES.has(status);
      if (noBody) incoming.destroy();
      resolve(new Response(noBody ? null : bodyOf(incoming, request), { status, headers: responseHeaders(incoming.headers) }));
    });
    request.end();
  });
}

/** True for a GET (or no method) that carries a `Range` header and an http(s) URL. */
function isRangeRead(url: string, init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return method === "GET" && /^https?:/i.test(url) && new Headers(init.headers).has("range");
}

export function createRangeStreamingTransport(options: RangeStreamingOptions): Transport {
  const { fallback, node } = options;
  if (node === undefined) return fallback;
  const send = (url: string, init: RequestInit): Promise<Response> => (isRangeRead(url, init) ? rangeRequest(node, url, init) : fallback(url, init));
  return Object.assign(send, { transportName: "node-stream" });
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
