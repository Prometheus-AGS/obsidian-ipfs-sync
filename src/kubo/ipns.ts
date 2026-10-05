import { assertValidKeyName, type ResolvedEndpoint } from "../core/config";
import { KuboAuthError, KuboError, KuboHttpError } from "./errors";
import type { Transport } from "./http";
import { rpcCall } from "./rpc-call";
import { malformed, stringField } from "./rpc-fields";
import type { NodeKey, PublishedName, ResolveOptions } from "./types";

/**
 * Key generation, pinning and name publication. Every argument travels in the
 * query string. The surface deliberately has no `key/rm`, `key/rename`,
 * `key/rotate` or `pin/rm`.
 */

/** How long resolvers may cache a published record (kubo duration syntax). */
export const DEFAULT_IPNS_TTL = "5m";

/** 128 is the bound the local record applies when it reads a CID back; a longer value is refused where it enters. */
const CID_SHAPE = /^[A-Za-z0-9]{10,128}$/;
const CID_ECHO_MAX = 64;

function assertCid(endpoint: ResolvedEndpoint, cid: string): string {
  if (CID_SHAPE.test(cid)) return cid;
  if (cid.length > CID_ECHO_MAX) throw new KuboError(endpoint.name, endpoint.baseUrl, "the value is not a valid CID (it is longer than a CID can be)");
  throw new KuboError(endpoint.name, endpoint.baseUrl, `"${cid.replace(/[^A-Za-z0-9]/g, "?")}" is not a valid CID`);
}

/** `key/gen`: create an ed25519 key. The name must match the project pattern and not be reserved. */
export async function generateKey(endpoint: ResolvedEndpoint, name: string, transport?: Transport): Promise<NodeKey> {
  const keyName = assertValidKeyName(name);
  const body = await rpcCall({ endpoint, command: "key/gen", args: { arg: keyName, type: "ed25519" }, transport }, "ndjson-last");
  return { name: stringField(endpoint, "key/gen", body, "Name"), id: stringField(endpoint, "key/gen", body, "Id") };
}

/** `pin/add`: recursive pin of a CID. */
export async function addPin(endpoint: ResolvedEndpoint, cid: string, transport?: Transport): Promise<void> {
  const args = { arg: assertCid(endpoint, cid), recursive: true, progress: false };
  const body = await rpcCall({ endpoint, command: "pin/add", args, transport }, "ndjson-last");
  if (!Array.isArray(body["Pins"])) throw malformed(endpoint, "pin/add", 'missing "Pins" list');
}

/** `name/publish`: point the key at `/ipfs/<cid>`. The caller has already established that the key is owned. */
export async function publishName(
  endpoint: ResolvedEndpoint,
  key: string,
  cid: string,
  ttl: string = DEFAULT_IPNS_TTL,
  transport?: Transport,
): Promise<PublishedName> {
  const args = { arg: `/ipfs/${assertCid(endpoint, cid)}`, key: assertValidKeyName(key), ttl };
  const body = await rpcCall({ endpoint, command: "name/publish", args, transport }, "ndjson-last");
  return { name: stringField(endpoint, "name/publish", body, "Name"), value: stringField(endpoint, "name/publish", body, "Value") };
}

/**
 * `name/resolve`: the `/ipfs/<cid>` path a key ID or `/ipns/...` name currently points at.
 * Always sends `nocache=true`: kubo caches IPNS lookups for the record TTL (5m), so a cached
 * resolve right after a publish returns the previous root.
 */
export async function resolveName(endpoint: ResolvedEndpoint, name: string, transport?: Transport, options: ResolveOptions = {}): Promise<string> {
  if (name === "") throw new KuboError(endpoint.name, endpoint.baseUrl, "name/resolve needs a key ID");
  const args = { arg: name.startsWith("/") ? name : `/ipns/${name}`, nocache: true, "dht-timeout": options.dhtTimeout };
  const body = await rpcCall({ endpoint, command: "name/resolve", args, transport }, "ndjson-last");
  return stringField(endpoint, "name/resolve", body, "Path");
}

/** `dht-timeout` the publisher's name re-check sends (kubo duration syntax). Design decision 10.3 of mvp-07, `NAME_RESOLVE_TIMEOUT`. */
export const NAME_RESOLVE_DHT_TIMEOUT = "10s";

/**
 * The error texts of `name/resolve`, taken from the maintainer's own kubo node and from nowhere
 * else; no entry is written from memory. Each entry is the node's own JSON `Message` of an HTTP 500 answer.
 *
 * - `notFound`: recorded 2026-10-01T12:25:16Z for a syntactically valid IPNS key id that was never published, request
 *   `POST /api/v0/name/resolve?arg=/ipns/<id>&nocache=true&dht-timeout=10s`, answer HTTP 500
 *   `{"Message":"could not resolve name","Code":0,"Type":"error"}`.
 * - `timeout`: NOT RECORDED. A second request, the project's own key with `nocache=true&dht-timeout=1ms`
 *   (2026-10-01T12:25:32Z), was answered HTTP 200 with the key's current path, because the node serves its own key from
 *   its local record, so no timeout was provoked. The list stays empty until a text is recorded from the node; until then
 *   a lookup that fails for any other reason than the entry above is `failed`, which the publisher treats as a refusal.
 * - Observations of 2026-10-01T12:25Z and 12:49Z on the operator node: `name/resolve` of a never-published name answers
 *   HTTP 500 `{"Message":"could not resolve name","Code":0,"Type":"error"}` identically for `dht-timeout=1ms` (0.41 s),
 *   `1s` (1.22 s) and `10s`. So "not found" and "timed out" are indistinguishable at the RPC level, and `timeout` stays
 *   empty. This is a statement about this node's answers only.
 *
 * Anything that is not in this table is `failed` (fail closed).
 */
export const NAME_RESOLVE_ERROR_TEXTS: { readonly notFound: readonly string[]; readonly timeout: readonly string[] } = {
  notFound: ["could not resolve name"],
  timeout: [],
};

/** How a `name/resolve` that did not return a path is to be read. */
export type NameResolveFailure = { readonly kind: "not-found" } | { readonly kind: "failed"; readonly timedOut: boolean };

/**
 * Classify the error of a `name/resolve` call. Only the node's own JSON `Message` on an HTTP 500 can be `not-found` or
 * a timeout; a proxy page, a different status, a network failure or an unlisted text is `failed`. Credentials errors and
 * errors that are not the client's own (a bug) are rethrown: they are not a statement about name routing.
 */
export function classifyResolveFailure(error: unknown): NameResolveFailure {
  if (error instanceof KuboAuthError || !(error instanceof KuboError)) throw error;
  if (error instanceof KuboHttpError && error.status === 500 && error.nodeMessage !== undefined) {
    if (NAME_RESOLVE_ERROR_TEXTS.notFound.includes(error.nodeMessage)) return { kind: "not-found" };
    if (NAME_RESOLVE_ERROR_TEXTS.timeout.includes(error.nodeMessage)) return { kind: "failed", timedOut: true };
  }
  return { kind: "failed", timedOut: false };
}
