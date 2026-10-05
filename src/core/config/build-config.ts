import { authWarnings } from "./jwt";
import { buildAuth } from "./auth";
import { defaultLayer } from "./defaults";
import { composeEndpointUrl } from "./endpoint";
import { ConfigError } from "./errors";
import { assertValidKeyName, validateMfsRoot } from "./node-safety";
import { mergeLayers } from "./layers";
import type {
  AuthConfig,
  EndpointName,
  RawConfigLayer,
  RawEndpointInput,
  ResolvedEndpoint,
  SyncConfig,
} from "./types";

/**
 * No node is a default. A missing URL fails here, before any client exists, and the message names the real
 * ways to set it (flag, environment variable, config file key). The plugin re-words it for its settings tab.
 * The gateway is a separate endpoint (different port, often a different host) and is never derived from the RPC URL.
 */
const MISSING_URL: Readonly<Record<EndpointName, { readonly code: "no-rpc-url" | "no-gateway-url"; readonly message: string }>> = {
  rpc: {
    code: "no-rpc-url",
    message:
      "no IPFS node is configured: there is no RPC URL and no default node. Set one with --rpc-url <url>, " +
      "the IPFS_SYNC_RPC_URL environment variable, or \"rpc\": { \"url\": \"<url>\" } in the config file (--config <path>).",
  },
  gateway: {
    code: "no-gateway-url",
    message:
      "no gateway is configured: there is no gateway URL and none is derived from the RPC URL. Set one with --gateway-url <url>, " +
      "the IPFS_SYNC_GATEWAY_URL environment variable, or \"gateway\": { \"url\": \"<url>\" } in the config file (--config <path>).",
  },
};

const NO_AUTH: AuthConfig = { kind: "none" };

/**
 * The global auth is the RPC credential. An endpoint without auth of its own inherits it only when it is the RPC endpoint or
 * shares the RPC endpoint's origin (scheme, host and port, as in one reverse proxy serving both); otherwise it gets none, so the
 * credential is never sent to a host the operator did not give it to. An explicit per-endpoint auth always wins.
 */
function inheritedAuth(globalAuth: AuthConfig, baseUrl: string, rpcBaseUrl: string | undefined): AuthConfig {
  if (rpcBaseUrl === undefined) return globalAuth;
  return new URL(baseUrl).origin === new URL(rpcBaseUrl).origin ? globalAuth : NO_AUTH;
}

function resolveEndpoint(
  name: EndpointName,
  input: RawEndpointInput | undefined,
  globalAuth: AuthConfig,
  rpcBaseUrl?: string,
): ResolvedEndpoint {
  if ((input?.url ?? "").trim() === "") {
    const missing = MISSING_URL[name];
    throw new ConfigError(missing.code, missing.message);
  }
  const baseUrl = composeEndpointUrl(name, input?.url ?? "", input?.port);
  const auth = input?.auth === undefined ? inheritedAuth(globalAuth, baseUrl, rpcBaseUrl) : buildAuth(input.auth, `${name} auth`);
  return { name, baseUrl, auth };
}

function collectWarnings(rpc: ResolvedEndpoint, gateway: ResolvedEndpoint, now: Date): readonly string[] {
  if (rpc.auth === gateway.auth) return authWarnings("auth", rpc.auth, now);
  return [...authWarnings("rpc", rpc.auth, now), ...authWarnings("gateway", gateway.auth, now)];
}

/** Validate a merged layer into a SyncConfig. Throws ConfigError before any request is possible. */
export function buildSyncConfig(layer: RawConfigLayer, now: Date): SyncConfig {
  const mfsRoot = validateMfsRoot(layer.mfsRoot ?? "");
  const publicationKey = assertValidKeyName(layer.publicationKey ?? "");
  const globalAuth = buildAuth(layer.auth, "auth");
  const rpc = resolveEndpoint("rpc", layer.rpc, globalAuth);
  const gateway = resolveEndpoint("gateway", layer.gateway, globalAuth, rpc.baseUrl);
  return {
    rpc,
    gateway,
    publicationKey,
    mfsRoot,
    ownedKeys: layer.ownedKeys ?? [],
    warnings: collectWarnings(rpc, gateway, now),
  };
}

/** What a command that never contacts the node needs: the validated local fields, no endpoints. */
export type LocalSyncConfig = Pick<SyncConfig, "publicationKey" | "mfsRoot" | "ownedKeys">;

/**
 * Like `resolveSyncConfig`, minus the endpoints: every other check still runs (MFS root, key name, auth), and no URL is
 * required or invented. For commands that send no request, such as `abandon`.
 */
export function resolveLocalConfig(layers: readonly RawConfigLayer[]): LocalSyncConfig {
  const layer = mergeLayers(defaultLayer(), ...layers);
  buildAuth(layer.auth, "auth");
  return {
    publicationKey: assertValidKeyName(layer.publicationKey ?? ""),
    mfsRoot: validateMfsRoot(layer.mfsRoot ?? ""),
    ownedKeys: layer.ownedKeys ?? [],
  };
}

/**
 * Resolve configuration from layers given lowest to highest precedence
 * (config file, env, flags). Defaults sit underneath all of them.
 */
export function resolveSyncConfig(layers: readonly RawConfigLayer[], now: Date): SyncConfig {
  return buildSyncConfig(mergeLayers(defaultLayer(), ...layers), now);
}
