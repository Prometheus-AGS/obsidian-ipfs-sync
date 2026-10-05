// Bundled on the fly by tools/feature-op-mvp-02.mjs so the feature operation reads the node through
// the same shared client and the same IPFS_SYNC_* environment rules as the CLI.
import { describeAuth, envLayer, resolveSyncConfig, type EnvMap } from "../src/core/config";
import { createKuboClient } from "../src/kubo";

/**
 * The product has no default node. These operator feature operations talk to the maintainer's shared node and name it here,
 * explicitly; `IPFS_SYNC_RPC_URL` and `IPFS_SYNC_GATEWAY_URL` still override it, as they did before.
 */
const SHARED_NODE = { rpc: { url: "https://ipfs.prometheusags.ai" }, gateway: { url: "https://ipfs.prometheusags.ai" } };

export function createFeatureOpClient(env: EnvMap, mfsRoot: string) {
  const config = resolveSyncConfig([SHARED_NODE, envLayer(env), { mfsRoot }], new Date());
  return {
    client: createKuboClient({ rpc: config.rpc, gateway: config.gateway }),
    rpcUrl: config.rpc.baseUrl,
    gatewayUrl: config.gateway.baseUrl,
    auth: describeAuth(config.rpc.auth),
  };
}
