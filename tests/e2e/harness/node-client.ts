// The suite's own minimal kubo RPC client (task 2.1): the node probe, the pre-run snapshot, name/resolve, and the
// proxy-confined cleanup (files/stat, files/rm -r). The node address and auth come from the operator's environment
// (IPFS_SYNC_RPC_URL / IPFS_SYNC_GATEWAY_URL and the IPFS_SYNC_*_AUTH_* variables) — nothing is hardcoded
// (no-default-node; design feature operation). src/kubo is NOT imported: the suite's only src/ import is the
// test-only unwrap hook (design decision 4), so the wire conventions are re-declared here from src/kubo/rpc-call.ts
// and node-calls.ts: every argument travels in the query string (the reverse proxy drops form-encoded ones), every
// command is a POST, files/ls answers ndjson, files/rm answers an empty body on success.
import { SuiteRefusal } from "./run-context";

/** Where the node lives for this run: the upstream the proxy forwards to, from the operator's environment. */
export interface NodeTarget {
  readonly rpc: string;
  readonly gateway: string;
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

/**
 * The node address from IPFS_SYNC_RPC_URL / IPFS_SYNC_GATEWAY_URL. Both are required and both must parse:
 * the suite hardcodes no address, and a missing one fails the suite with the variable named (fail, never skip).
 */
export function nodeTargetFromEnv(env: Readonly<Record<string, string | undefined>>): NodeTarget {
  const rpc = env["IPFS_SYNC_RPC_URL"];
  const gateway = env["IPFS_SYNC_GATEWAY_URL"];
  const missing = [
    rpc === undefined || rpc.trim() === "" ? "IPFS_SYNC_RPC_URL" : undefined,
    gateway === undefined || gateway.trim() === "" ? "IPFS_SYNC_GATEWAY_URL" : undefined,
  ].filter((name) => name !== undefined);
  if (missing.length > 0) {
    throw new SuiteRefusal(
      `the suite takes the node address from the operator's environment and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
        "Export both (and the IPFS_SYNC_* auth variables when the endpoint needs them) and re-run; the suite hardcodes no node address.",
    );
  }
  for (const [name, value] of [["IPFS_SYNC_RPC_URL", rpc], ["IPFS_SYNC_GATEWAY_URL", gateway]] as const) {
    try {
      const parsed = new URL(value as string);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
    } catch {
      throw new SuiteRefusal(`${name} is not a valid http(s) URL: "${(value as string).slice(0, 80)}"`);
    }
  }
  return { rpc: trimSlashes(rpc as string), gateway: trimSlashes(gateway as string) };
}

/** An RPC failure: HTTP status and the node's own JSON Message when it sent one. */
export class NodeRequestError extends Error {
  readonly status: number | undefined;
  readonly nodeMessage: string | undefined;
  constructor(command: string, status: number | undefined, nodeMessage: string | undefined, detail: string) {
    super(`${command} failed${status === undefined ? "" : ` (HTTP ${status})`}: ${detail}`);
    this.name = "NodeRequestError";
    this.status = status;
    this.nodeMessage = nodeMessage;
  }
}

export interface NodeVersion {
  readonly version: string;
  readonly commit?: string;
}

export interface NodeKey {
  readonly name: string;
  readonly id: string;
}

export interface MfsEntry {
  readonly name?: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly cid: string;
}

export interface MfsStat {
  readonly cid: string;
  readonly size: number;
  readonly type: "file" | "directory";
}

export interface NodeClient {
  version(): Promise<NodeVersion>;
  keyList(): Promise<NodeKey[]>;
  keyGen(name: string): Promise<NodeKey>;
  filesLs(path: string): Promise<MfsEntry[]>;
  filesStat(path: string): Promise<MfsStat>;
  filesRm(path: string, recursive: boolean): Promise<void>;
  /** The /ipfs/<cid> path the key ID currently points at (nocache, as src/kubo/ipns.ts sends it). */
  nameResolve(keyId: string): Promise<string>;
}

type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * The auth headers of one endpoint, from the same environment variables the CLI reads
 * (src/core/config/layers.ts authFromEnv: IPFS_SYNC_RPC_AUTH_* / IPFS_SYNC_GATEWAY_AUTH_* over IPFS_SYNC_AUTH_*).
 * Re-declared here under the no-src-import rule; an unknown scheme or a missing field refuses instead of
 * silently dropping credentials.
 */
export function authHeadersFromEnv(env: EnvMap, endpoint: "RPC" | "GATEWAY"): Record<string, string> {
  const pick = (suffix: string): string | undefined => env[`IPFS_SYNC_${endpoint}_AUTH_${suffix}`] ?? env[`IPFS_SYNC_AUTH_${suffix}`];
  const scheme = pick("SCHEME")?.trim().toLowerCase();
  if (scheme === undefined || scheme === "" || scheme === "none") return {};
  const need = (field: string): string => {
    const value = pick(field);
    if (value === undefined || value === "") throw new SuiteRefusal(`IPFS_SYNC_${endpoint}_AUTH_${field} (or IPFS_SYNC_AUTH_${field}) is required by the ${scheme} auth scheme`);
    return value;
  };
  switch (scheme) {
    case "basic":
      return { Authorization: `Basic ${Buffer.from(`${need("USER")}:${need("PASSWORD")}`, "utf8").toString("base64")}` };
    case "bearer":
      return { Authorization: `Bearer ${need("TOKEN")}` };
    case "header":
      return { [need("HEADER_NAME")]: need("HEADER_VALUE") };
    default:
      throw new SuiteRefusal(`unknown auth scheme "${scheme}" in IPFS_SYNC_${endpoint}_AUTH_SCHEME / IPFS_SYNC_AUTH_SCHEME (use none, basic, bearer or header)`);
  }
}

/** One command at most this long; a hung node must not hang the probe, a scenario read, or the cleanup. */
const REQUEST_TIMEOUT_MS = 30_000;
/** files/ls and files/stat answers are a handful of entries; 1 MiB is the product's own cap (src/kubo/node-calls.ts). */
const RESPONSE_MAX_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

async function readBounded(response: Response, command: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_MAX_BYTES) throw new NodeRequestError(command, response.status, undefined, `the response is larger than ${RESPONSE_MAX_BYTES} bytes`);
  const text = await response.text();
  if (text.length > RESPONSE_MAX_BYTES) throw new NodeRequestError(command, response.status, undefined, `the response is larger than ${RESPONSE_MAX_BYTES} bytes`);
  return text;
}

async function rpcText(target: NodeTarget, headers: Readonly<Record<string, string>>, command: string, args: Readonly<Record<string, string>>): Promise<{ status: number; text: string }> {
  const url = new URL(`${target.rpc}/api/v0/${command}`);
  for (const [name, value] of Object.entries(args)) url.searchParams.set(name, value);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new NodeRequestError(command, undefined, undefined, error instanceof Error ? error.message : String(error));
  }
  const text = await readBounded(response, command);
  if (!response.ok) {
    let nodeMessage: string | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed) && typeof parsed["Message"] === "string") nodeMessage = parsed["Message"];
    } catch {
      // Not the node's JSON error shape; the raw head of the body is the detail.
    }
    throw new NodeRequestError(command, response.status, nodeMessage, nodeMessage ?? (text.trim().slice(0, 200) || "no body"));
  }
  return { status: response.status, text };
}

function parseObjects(command: string, text: string): JsonObject[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new NodeRequestError(command, 200, undefined, "the body is empty");
  return lines.map((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) return parsed;
    } catch {
      // Reported below.
    }
    throw new NodeRequestError(command, 200, undefined, "the body is not (newline-delimited) JSON objects");
  });
}

const stringField = (command: string, body: JsonObject, field: string): string => {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new NodeRequestError(command, 200, undefined, `the answer has no "${field}" string`);
  return value;
};

const numberField = (body: JsonObject, field: string): number => {
  const value = body[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** A client bound to one target: the upstream for the probe/snapshot, the loopback proxy for the confined cleanup. */
export function createNodeClient(target: NodeTarget, env: EnvMap): NodeClient {
  const headers = authHeadersFromEnv(env, "RPC");
  const json = async (command: string, args: Readonly<Record<string, string>>): Promise<JsonObject> => {
    const objects = parseObjects(command, (await rpcText(target, headers, command, args)).text);
    // ndjson-last: kubo streams progress lines before the answer on some commands; the last object is the answer.
    return objects[objects.length - 1] as JsonObject;
  };
  return {
    version: async () => {
      const body = await json("version", {});
      return { version: stringField("version", body, "Version"), commit: typeof body["Commit"] === "string" ? body["Commit"] : undefined };
    },
    keyList: async () => {
      const body = await json("key/list", {});
      const keys = body["Keys"];
      if (!Array.isArray(keys)) throw new NodeRequestError("key/list", 200, undefined, 'the answer has no "Keys" list');
      return keys.filter(isObject).map((key) => ({ name: stringField("key/list", key, "Name"), id: typeof key["Id"] === "string" ? key["Id"] : "" }));
    },
    keyGen: async (name) => {
      const body = await json("key/gen", { arg: name, type: "ed25519" });
      return { name: stringField("key/gen", body, "Name"), id: stringField("key/gen", body, "Id") };
    },
    filesLs: async (path) => {
      const { text } = await rpcText(target, headers, "files/ls", { arg: path, long: "true", stream: "true" });
      // Older kubo ignores `stream` and answers one object with Entries; newer streams one entry per line.
      const entries = parseObjects("files/ls", text).flatMap((line) => {
        const listed = line["Entries"];
        if (listed === undefined) return [line];
        return Array.isArray(listed) ? listed.filter(isObject) : [];
      });
      return entries.map((entry) => ({
        name: typeof entry["Name"] === "string" ? entry["Name"] : undefined,
        type: entry["Type"] === 1 ? "directory" : "file",
        size: numberField(entry, "Size"),
        cid: stringField("files/ls", entry, "Hash"),
      }));
    },
    filesStat: async (path) => {
      const body = await json("files/stat", { arg: path });
      return { cid: stringField("files/stat", body, "Hash"), size: numberField(body, "Size"), type: body["Type"] === "directory" ? "directory" : "file" };
    },
    filesRm: async (path, recursive) => {
      const { text } = await rpcText(target, headers, "files/rm", { arg: path, recursive: recursive ? "true" : "false" });
      // A non-empty body on a 2xx means the node reported an error in the body (kubo issue 8606).
      if (text.trim() !== "") throw new NodeRequestError("files/rm", 200, undefined, text.trim().slice(0, 200));
    },
    nameResolve: async (keyId) => {
      const body = await json("name/resolve", { arg: keyId.startsWith("/") ? keyId : `/ipns/${keyId}`, nocache: "true" });
      return stringField("name/resolve", body, "Path");
    },
  };
}
