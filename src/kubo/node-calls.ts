import type { ResolvedEndpoint } from "../core/config";
import { KuboError } from "./errors";
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
    { endpoint, command: "files/ls", args: { arg: path, long: true, stream: true }, transport },
    "ndjson",
  );
  // Older kubo ignores `stream` and answers one object with `Entries`; newer streams one entry per line.
  return lines.flatMap((line) => ("Entries" in line ? objectList(endpoint, "files/ls", line, "Entries") : [line])).map((entry) => lsEntry(endpoint, entry));
}

export async function statMfs(endpoint: ResolvedEndpoint, path: string, transport?: Transport): Promise<MfsStat> {
  const body = await rpcCall({ endpoint, command: "files/stat", args: { arg: path }, transport }, "json");
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
