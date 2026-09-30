import { authWarnings } from "./jwt";
import { buildAuth } from "./auth";
import { defaultLayer } from "./defaults";
import { composeEndpointUrl } from "./endpoint";
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

function resolveEndpoint(
  name: EndpointName,
  input: RawEndpointInput | undefined,
  globalAuth: AuthConfig,
): ResolvedEndpoint {
  const auth = input?.auth === undefined ? globalAuth : buildAuth(input.auth, `${name} auth`);
  return { name, baseUrl: composeEndpointUrl(name, input?.url ?? "", input?.port), auth };
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
  const gateway = resolveEndpoint("gateway", layer.gateway, globalAuth);
  return {
    rpc,
    gateway,
    publicationKey,
    mfsRoot,
    ownedKeys: layer.ownedKeys ?? [],
    warnings: collectWarnings(rpc, gateway, now),
  };
}

/**
 * Resolve configuration from layers given lowest to highest precedence
 * (config file, env, flags). Defaults sit underneath all of them.
 */
export function resolveSyncConfig(layers: readonly RawConfigLayer[], now: Date): SyncConfig {
  return buildSyncConfig(mergeLayers(defaultLayer(), ...layers), now);
}
