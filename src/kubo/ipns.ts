import { assertValidKeyName, type ResolvedEndpoint } from "../core/config";
import { KuboError } from "./errors";
import type { Transport } from "./http";
import { rpcCall } from "./rpc-call";
import { malformed, stringField } from "./rpc-fields";
import type { NodeKey, PublishedName } from "./types";

/**
 * Key generation, pinning and name publication. Every argument travels in the
 * query string. The surface deliberately has no `key/rm`, `key/rename`,
 * `key/rotate` or `pin/rm`.
 */

/** How long resolvers may cache a published record (kubo duration syntax). */
export const DEFAULT_IPNS_TTL = "5m";

const CID_SHAPE = /^[A-Za-z0-9]{10,}$/;

function assertCid(endpoint: ResolvedEndpoint, cid: string): string {
  if (CID_SHAPE.test(cid)) return cid;
  throw new KuboError(endpoint.name, endpoint.baseUrl, `"${cid}" is not a valid CID`);
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
export async function resolveName(endpoint: ResolvedEndpoint, name: string, transport?: Transport): Promise<string> {
  if (name === "") throw new KuboError(endpoint.name, endpoint.baseUrl, "name/resolve needs a key ID");
  const args = { arg: name.startsWith("/") ? name : `/ipns/${name}`, nocache: true };
  const body = await rpcCall({ endpoint, command: "name/resolve", args, transport }, "ndjson-last");
  return stringField(endpoint, "name/resolve", body, "Path");
}
