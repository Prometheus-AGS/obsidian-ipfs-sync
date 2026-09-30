import type { ResolvedEndpoint } from "../core/config";
import { authHeaders } from "./auth-headers";
import { KuboResponseTooLargeError } from "./errors";
import { buildRpcUrl, requestEndpoint, type QueryArgs, type Transport } from "./http";
import type { MultipartBody } from "./multipart";
import { isJsonObject, malformed, type JsonObject } from "./rpc-fields";

/**
 * The one caller for kubo's HTTP RPC (replaces the third-party RPC library; decision log 2026-09-30).
 *
 * Proxy quirk: every argument travels in the query string; the reverse proxy drops form-encoded
 * arguments. `body` is only for `files/write`, whose multipart field must be named `data`
 * (see mfs-write.ts, the only caller that sends a body).
 */
export interface RpcCallInput {
  readonly endpoint: ResolvedEndpoint;
  /** Kubo command such as `key/list` (no leading slash). */
  readonly command: string;
  readonly args?: QueryArgs;
  readonly body?: MultipartBody;
  /** Defaults to the platform `fetch`. */
  readonly transport?: Transport;
  /**
   * Refuse a response body larger than this many bytes, checked against `Content-Length` first and again while the
   * body streams, so a node that understates its length is still cut off. Unset means `RPC_RESPONSE_MAX_BYTES`.
   */
  readonly maxResponseBytes?: number;
}

/** Default cap for every RPC answer except the discarded `files/write` reply: they are all a few hundred bytes. */
export const RPC_RESPONSE_MAX_BYTES = 64 * 1024;

function tooLarge(input: RpcCallInput, limit: number): KuboResponseTooLargeError {
  return new KuboResponseTooLargeError(input.endpoint.name, input.endpoint.baseUrl, `the ${input.command} response`, `${limit} bytes`);
}

/** The body as text, abandoning the read as soon as it passes `limit` bytes. */
async function readBoundedText(input: RpcCallInput, response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(input, limit);
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw tooLarge(input, limit);
      parts.push(value);
    }
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

/**
 * How the response body is read:
 * - `json`: the whole body is one JSON object
 * - `ndjson`: one JSON object per line, all returned
 * - `ndjson-last`: one JSON object per line, the last one returned (tolerates progress lines)
 * - `text`: the body as text
 * - `none`: the body is discarded
 */
export type RpcMode = "json" | "ndjson" | "ndjson-last" | "text" | "none";

function parseObject(input: RpcCallInput, text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // Reported below with the command name, never as a raw parse failure.
  }
  throw malformed(input.endpoint, input.command, "body is not a JSON object");
}

function nonBlankLines(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

/**
 * POST one kubo command. Non-2xx answers become typed errors (401/403 as the authentication error naming
 * the endpoint, others as an HTTP error carrying the node's `Message`); transport failures become network errors.
 */
export function rpcCall(input: RpcCallInput, mode: "json" | "ndjson-last"): Promise<JsonObject>;
export function rpcCall(input: RpcCallInput, mode: "ndjson"): Promise<readonly JsonObject[]>;
export function rpcCall(input: RpcCallInput, mode: "text"): Promise<string>;
export function rpcCall(input: RpcCallInput, mode: "none"): Promise<undefined>;
export async function rpcCall(
  input: RpcCallInput,
  mode: RpcMode,
): Promise<JsonObject | readonly JsonObject[] | string | undefined> {
  const url = buildRpcUrl(input.endpoint.baseUrl, input.command, input.args);
  const headers = input.body === undefined ? authHeaders(input.endpoint.auth) : { ...authHeaders(input.endpoint.auth), "Content-Type": input.body.contentType };
  const init: RequestInit = { method: "POST", headers, body: input.body?.bytes };
  const response = await requestEndpoint(input.endpoint, url, init, input.transport);
  if (mode === "none") {
    await response.arrayBuffer();
    return undefined;
  }
  const text = await readBoundedText(input, response, input.maxResponseBytes ?? RPC_RESPONSE_MAX_BYTES);
  switch (mode) {
    case "text":
      return text;
    case "json":
      return parseObject(input, text);
    case "ndjson":
      return nonBlankLines(text).map((line) => parseObject(input, line));
    case "ndjson-last":
      return parseObject(input, nonBlankLines(text).at(-1) ?? "");
  }
}
