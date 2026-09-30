import type { ResolvedEndpoint } from "../core/config";
import { KuboError, KuboResponseTooLargeError } from "./errors";
import type { Transport } from "./http";
import { rpcCall } from "./rpc-call";
import { numberField, objectList, optionalString, stringField, type JsonObject } from "./rpc-fields";
import type { MfsEntry, MfsEntryType, MfsStat, NodeIdentity, NodeKey, NodeVersion } from "./types";

/**
 * The read calls and `files/rm` (formerly served by the third-party RPC library). Response field names are kubo's:
 * `id` -> ID, AgentVersion; `version` -> Version, Commit; `files/ls` -> Entries[Name, Type, Size, Hash]
 * (Type 0 file, 1 directory); `files/stat` -> Hash, Size, CumulativeSize, Type ("file"|"directory");
 * `key/list` -> Keys[Name, Id].
 */

const DETAIL_LIMIT = 200;
const LS_TYPE_DIRECTORY = 1;

/**
 * The node is untrusted: a `files/ls` or `files/stat` answer is refused above 1 MiB, and a listing above 2,000
 * entries. A folder that legitimately holds more (for example `manifests/` after 2,000 publishes) is refused
 * too, with a typed error, not truncated.
 */
export const MFS_RESPONSE_MAX_BYTES = 1024 * 1024;
export const MFS_LIST_MAX_ENTRIES = 2000;

export async function nodeId(endpoint: ResolvedEndpoint, transport?: Transport): Promise<NodeIdentity> {
  const body = await rpcCall({ endpoint, command: "id", transport }, "json");
  return { peerId: stringField(endpoint, "id", body, "ID"), agentVersion: optionalString(body, "AgentVersion") };
}

export async function nodeVersion(endpoint: ResolvedEndpoint, transport?: Transport): Promise<NodeVersion> {
  const body = await rpcCall({ endpoint, command: "version", transport }, "json");
  return { version: stringField(endpoint, "version", body, "Version"), commit: optionalString(body, "Commit") };
}

function lsEntry(endpoint: ResolvedEndpoint, entry: JsonObject): MfsEntry {
  const type: MfsEntryType = entry["Type"] === LS_TYPE_DIRECTORY ? "directory" : "file";
  const size = typeof entry["Size"] === "number" ? entry["Size"] : 0;
  return { name: optionalString(entry, "Name"), type, size, cid: stringField(endpoint, "files/ls", entry, "Hash") };
}

/** `files/ls` with `long` (so entries carry CIDs) and `stream`, as the previous library sent it. */
export async function listMfs(endpoint: ResolvedEndpoint, path: string, transport?: Transport): Promise<readonly MfsEntry[]> {
  const lines = await rpcCall(
    { endpoint, command: "files/ls", args: { arg: path, long: true, stream: true }, transport, maxResponseBytes: MFS_RESPONSE_MAX_BYTES },
    "ndjson",
  );
  // Older kubo ignores `stream` and answers one object with `Entries`; newer streams one entry per line.
  const entries = lines.flatMap((line) => ("Entries" in line ? objectList(endpoint, "files/ls", line, "Entries") : [line]));
  if (entries.length > MFS_LIST_MAX_ENTRIES) {
    throw new KuboResponseTooLargeError(endpoint.name, endpoint.baseUrl, `the files/ls listing (${entries.length} entries)`, `${MFS_LIST_MAX_ENTRIES} entries`);
  }
  return entries.map((entry) => lsEntry(endpoint, entry));
}

/** UnixFS types `ls` reports for a directory: 1 (directory) and 5 (a sharded directory). Everything else is a file. */
const IPFS_LS_DIRECTORY_TYPES: readonly number[] = [1, 5];

/**
 * `ls` on an immutable path: the children of a directory, each with the CID of the link. Used to read a published
 * snapshot back by its root CID, where the mutable MFS listing (`files/ls`) would not be evidence.
 */
export async function listIpfs(endpoint: ResolvedEndpoint, path: string, transport?: Transport): Promise<readonly MfsEntry[]> {
  const body = await rpcCall(
    { endpoint, command: "ls", args: { arg: path, "resolve-type": true, size: true, stream: false }, transport, maxResponseBytes: MFS_RESPONSE_MAX_BYTES },
    "json",
  );
  const links = objectList(endpoint, "ls", body, "Objects").flatMap((object) => objectList(endpoint, "ls", object, "Links"));
  if (links.length > MFS_LIST_MAX_ENTRIES) {
    throw new KuboResponseTooLargeError(endpoint.name, endpoint.baseUrl, `the ls listing (${links.length} entries)`, `${MFS_LIST_MAX_ENTRIES} entries`);
  }
  return links.map((link) => ({
    name: optionalString(link, "Name"),
    type: IPFS_LS_DIRECTORY_TYPES.includes(typeof link["Type"] === "number" ? link["Type"] : -1) ? "directory" : "file",
    size: typeof link["Size"] === "number" ? link["Size"] : 0,
    cid: stringField(endpoint, "ls", link, "Hash"),
  }));
}

export async function statMfs(endpoint: ResolvedEndpoint, path: string, transport?: Transport): Promise<MfsStat> {
  const body = await rpcCall({ endpoint, command: "files/stat", args: { arg: path }, transport, maxResponseBytes: MFS_RESPONSE_MAX_BYTES }, "json");
  return {
    cid: stringField(endpoint, "files/stat", body, "Hash"),
    size: numberField(endpoint, "files/stat", body, "Size"),
    cumulativeSize: numberField(endpoint, "files/stat", body, "CumulativeSize"),
    type: body["Type"] === "directory" ? "directory" : "file",
  };
}

/** `files/rm`. The caller has already confined the path to `/obsidian-vault-sync/`. Kubo answers an empty body on success. */
export async function removeMfs(
  endpoint: ResolvedEndpoint,
  path: string,
  recursive: boolean,
  transport?: Transport,
): Promise<void> {
  const text = await rpcCall({ endpoint, command: "files/rm", args: { arg: path, recursive }, transport }, "text");
  // A non-empty body on a 2xx means the node reported an error in the body (kubo issue 8606).
  if (text.trim() !== "") throw new KuboError(endpoint.name, endpoint.baseUrl, text.trim().slice(0, DETAIL_LIMIT));
}

/** `key/list`. The ID is empty when the proxy strips key IDs. */
export async function listKeys(endpoint: ResolvedEndpoint, transport?: Transport): Promise<readonly NodeKey[]> {
  const body = await rpcCall({ endpoint, command: "key/list", transport }, "json");
  return objectList(endpoint, "key/list", body, "Keys").map((key) => ({
    name: stringField(endpoint, "key/list", key, "Name"),
    id: optionalString(key, "Id"),
  }));
}
