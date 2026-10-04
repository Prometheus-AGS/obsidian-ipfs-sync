import { Platform, requestUrl } from "obsidian";
import type { Transport } from "../kubo";
import { createRangeStreamingTransport, desktopNodeModules } from "./range-streaming-transport";

/**
 * The plugin's transport: Obsidian's `requestUrl` instead of `fetch`. The node answers a request from the
 * WebView origin (`app://obsidian.md`) with 403 and sends no CORS headers on the preflight, so the WebView's
 * own `fetch` is blocked; `requestUrl` goes through the app's network layer and is not subject to CORS.
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
 * The transport of a decrypting pull: ranged gateway reads stream through Node on desktop (a hostile gateway's oversize body
 * is cut off after the probe margin), everything else, and every request on mobile, goes through `requestUrl`.
 */
export function pullTransport(): Transport {
  return createRangeStreamingTransport({ fallback: requestUrlTransport, node: desktopNodeModules(Platform.isDesktopApp) });
}
