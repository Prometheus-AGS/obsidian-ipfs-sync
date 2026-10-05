import { Platform, requestUrl } from "obsidian";
import type { Transport } from "../kubo";
import { createNodeTransport, desktopNodeModules } from "./node-transport";

/**
 * The mobile transport: Obsidian's `requestUrl` instead of `fetch`. The node answers a request from the
 * WebView origin (`app://obsidian.md`) with 403 and sends no CORS headers on the preflight, so the WebView's
 * own `fetch` is blocked; `requestUrl` goes through the app's network layer and is not subject to CORS.
 *
 * Desktop does not use it (see `pluginTransport`): `requestUrl` follows redirects itself and exposes no 3xx, so the
 * plugin cannot refuse one. A real desktop probe (Obsidian 1.8.4) saw a 307 to a local address followed with the POST
 * replayed. Mobile has no Node, so this is the transport there and it cannot refuse a redirect: iOS was probed and
 * follows cross-origin, strips Authorization, and forwards a custom header. This is a stated limit, not a guard.
 *
 * `throw: false` makes a 4xx or 5xx answer an ordinary response, so `requestEndpoint` maps 401/403 and the
 * other statuses to the same typed errors as with `fetch`. The body arrives whole (no streaming), which is
 * why the sync engine keeps its transfers bounded (chunks of 8 MB).
 */

/** Statuses the `Response` constructor only accepts without a body. */
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** Bodies this transport can send: text or bytes. Multipart uploads arrive as one prebuilt byte buffer. */
function toRequestBody(body: BodyInit | null | undefined): ArrayBuffer | string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
    return whole ? (body.buffer as ArrayBuffer) : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  }
  throw new TypeError("the requestUrl transport sends text or bytes only");
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const contentType = headers.get("content-type") ?? undefined;
  headers.delete("content-type");
  const result = await requestUrl({
    url,
    method: init.method ?? "GET",
    headers: Object.fromEntries(headers.entries()),
    contentType,
    body: toRequestBody(init.body),
    throw: false,
  });
  return new Response(NO_BODY_STATUSES.has(result.status) ? null : result.arrayBuffer, { status: result.status, headers: result.headers });
}

export const requestUrlTransport: Transport = Object.assign(send, { transportName: "requestUrl" });

/**
 * The one transport choice for every plugin call site. On desktop (Node's `require` exists) every request goes through Node's
 * `http`/`https` (src/plugin/node-transport.ts): a redirect is returned, not followed, and refused by `requestEndpoint`, and
 * response bodies stream. Only where `require` is unavailable (mobile) does this return `requestUrl`.
 */
export function pluginTransport(host: unknown = globalThis): Transport {
  return createNodeTransport({ fallback: requestUrlTransport, node: desktopNodeModules(Platform.isDesktopApp, host) });
}
