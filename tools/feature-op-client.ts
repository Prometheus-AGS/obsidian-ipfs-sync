// Bundled on the fly by tools/feature-op-mvp-02.mjs so the feature operation reads the node through
// the same shared client and the same IPFS_SYNC_* environment rules as the CLI.
import { describeAuth, envLayer, resolveSyncConfig, type EnvMap } from "../src/core/config";
import { createKuboClient } from "../src/kubo";

export function createFeatureOpClient(env: EnvMap, mfsRoot: string) {
  const config = resolveSyncConfig([envLayer(env), { mfsRoot }], new Date());
  return {
    client: createKuboClient({ rpc: config.rpc, gateway: config.gateway }),
    rpcUrl: config.rpc.baseUrl,
    gatewayUrl: config.gateway.baseUrl,
    auth: describeAuth(config.rpc.auth),
  };
}
