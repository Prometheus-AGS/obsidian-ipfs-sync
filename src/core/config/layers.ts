import { ConfigError } from "./errors";
import type { RawAuthInput, RawConfigLayer, RawEndpointInput } from "./types";

/**
 * Precedence layers: flags > env > config file > defaults.
 * Every function here is pure; the caller supplies env and file text.
 */

export type EnvMap = Readonly<Record<string, string | undefined>>;

// ---------- merging ----------

function last<T>(base: T | undefined, over: T | undefined): T | undefined {
  return over !== undefined ? over : base;
}

function mergeAuth(base: RawAuthInput | undefined, over: RawAuthInput | undefined): RawAuthInput | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  return {
    scheme: last(base.scheme, over.scheme),
    user: last(base.user, over.user),
    password: last(base.password, over.password),
    token: last(base.token, over.token),
    headerName: last(base.headerName, over.headerName),
    headerValue: last(base.headerValue, over.headerValue),
  };
}

function mergeEndpoint(
  base: RawEndpointInput | undefined,
  over: RawEndpointInput | undefined,
): RawEndpointInput | undefined {
  if (base === undefined) return over;
  if (over === undefined) return base;
  // A higher layer that sets a URL without a port must not inherit a lower layer's port.
  const urlOverridden = over.url !== undefined && over.port === undefined;
  return {
    url: last(base.url, over.url),
    port: urlOverridden ? undefined : last(base.port, over.port),
    auth: mergeAuth(base.auth, over.auth),
  };
}

function mergeTwo(base: RawConfigLayer, over: RawConfigLayer): RawConfigLayer {
  return {
    rpc: mergeEndpoint(base.rpc, over.rpc),
    gateway: mergeEndpoint(base.gateway, over.gateway),
    publicationKey: last(base.publicationKey, over.publicationKey),
    mfsRoot: last(base.mfsRoot, over.mfsRoot),
    auth: mergeAuth(base.auth, over.auth),
    ownedKeys: last(base.ownedKeys, over.ownedKeys),
  };
}

/** Merge layers left to right; later layers win, undefined never overrides. */
export function mergeLayers(...layers: readonly RawConfigLayer[]): RawConfigLayer {
  return layers.reduce<RawConfigLayer>(mergeTwo, {});
}

// ---------- environment ----------

function authFromEnv(env: EnvMap, prefix: string): RawAuthInput | undefined {
  const auth: RawAuthInput = {
    scheme: env[`${prefix}_SCHEME`],
    user: env[`${prefix}_USER`],
    password: env[`${prefix}_PASSWORD`],
    token: env[`${prefix}_TOKEN`],
    headerName: env[`${prefix}_HEADER_NAME`],
    headerValue: env[`${prefix}_HEADER_VALUE`],
  };
  return Object.values(auth).every((v) => v === undefined) ? undefined : auth;
}

function endpointFromEnv(env: EnvMap, name: "RPC" | "GATEWAY"): RawEndpointInput | undefined {
  const endpoint: RawEndpointInput = {
    url: env[`IPFS_SYNC_${name}_URL`],
    port: env[`IPFS_SYNC_${name}_PORT`],
    auth: authFromEnv(env, `IPFS_SYNC_${name}_AUTH`),
  };
  return endpoint.url === undefined && endpoint.port === undefined && endpoint.auth === undefined
    ? undefined
    : endpoint;
}

/**
 * Read `IPFS_SYNC_*` variables. Global auth secrets live in `IPFS_SYNC_AUTH_*`
 * (SCHEME, USER, PASSWORD, TOKEN, HEADER_NAME, HEADER_VALUE); an endpoint override
 * uses `IPFS_SYNC_RPC_AUTH_*` or `IPFS_SYNC_GATEWAY_AUTH_*`.
 */
export function envLayer(env: EnvMap): RawConfigLayer {
  return {
    rpc: endpointFromEnv(env, "RPC"),
    gateway: endpointFromEnv(env, "GATEWAY"),
    publicationKey: env["IPFS_SYNC_KEY"],
    mfsRoot: env["IPFS_SYNC_MFS_ROOT"],
    auth: authFromEnv(env, "IPFS_SYNC_AUTH"),
  };
}

// ---------- config file ----------

const SECRET_KEYS: readonly string[] = ["password", "passphrase", "token", "headervalue", "secret", "authorization", "apikey"];
const AUTH_KEYS: readonly string[] = ["scheme", "user", "headerName"];
const ENDPOINT_KEYS: readonly string[] = ["url", "port", "auth"];
const TOP_KEYS: readonly string[] = ["rpc", "gateway", "publicationKey", "mfsRoot", "auth", "ownedKeys"];

type JsonObject = Readonly<Record<string, unknown>>;

function fileError(message: string): ConfigError {
  return new ConfigError("invalid-config-file", `config file: ${message}`);
}

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fileError(`"${path}" must be an object`);
  }
  return value as JsonObject;
}

function checkKeys(obj: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (SECRET_KEYS.includes(key.toLowerCase())) {
      throw new ConfigError(
        "secret-in-config-file",
        `config file: "${path}${key}" is a secret and must not be stored here; use IPFS_SYNC_AUTH_* or a flag`,
      );
    }
    if (!allowed.includes(key)) throw fileError(`unknown key "${path}${key}"`);
  }
}

function optString(obj: JsonObject, key: string, path: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw fileError(`"${path}${key}" must be a string`);
  return value;
}

function parseAuthFile(value: unknown, path: string): RawAuthInput | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value, path);
  checkKeys(obj, AUTH_KEYS, `${path}.`);
  return {
    scheme: optString(obj, "scheme", `${path}.`),
    user: optString(obj, "user", `${path}.`),
    headerName: optString(obj, "headerName", `${path}.`),
  };
}

function parseEndpointFile(value: unknown, path: string): RawEndpointInput | undefined {
  if (value === undefined) return undefined;
  const obj = asObject(value, path);
  checkKeys(obj, ENDPOINT_KEYS, `${path}.`);
  const port = obj["port"];
  if (port !== undefined && typeof port !== "number" && typeof port !== "string") {
    throw fileError(`"${path}.port" must be a number`);
  }
  return {
    url: optString(obj, "url", `${path}.`),
    port,
    auth: parseAuthFile(obj["auth"], `${path}.auth`),
  };
}

function parseOwnedKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && v !== "")) {
    throw fileError(`"ownedKeys" must be an array of key IDs`);
  }
  return value;
}

/** Parse the CLI config file. Unknown keys fail; secret keys are rejected by name. */
export function parseConfigFile(text: string): RawConfigLayer {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw fileError("not valid JSON");
  }
  const obj = asObject(json, "(root)");
  checkKeys(obj, TOP_KEYS, "");
  return {
    rpc: parseEndpointFile(obj["rpc"], "rpc"),
    gateway: parseEndpointFile(obj["gateway"], "gateway"),
    publicationKey: optString(obj, "publicationKey", ""),
    mfsRoot: optString(obj, "mfsRoot", ""),
    auth: parseAuthFile(obj["auth"], "auth"),
    ownedKeys: parseOwnedKeys(obj["ownedKeys"]),
  };
}
