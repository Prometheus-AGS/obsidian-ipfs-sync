import { assertMfsMutationPath, type ResolvedEndpoint } from "../core/config";
import { fetchGatewayBytes, openGatewayStream } from "./gateway";
import type { Transport } from "./http";
import { addPin, generateKey, publishName, resolveName } from "./ipns";
import { writeMfsFile } from "./mfs-write";
import { listIpfs, listKeys, listMfs, nodeId, nodeVersion, removeMfs, statMfs } from "./node-calls";
import type { KuboClient } from "./types";

export interface KuboClientEndpoints {
  readonly rpc: ResolvedEndpoint;
  readonly gateway: ResolvedEndpoint;
  /**
   * How requests reach the network. Defaults to the platform `fetch` (the CLI). The plugin always passes its own transport
   * (`pluginTransport()`: Node's `http`/`https` on desktop, an adapter over `requestUrl` on mobile), because the WebView's
   * `fetch` is CORS-blocked by the node and follows redirects.
   */
  readonly transport?: Transport;
}

/**
 * Build the shared client. Every RPC goes through `rpcCall` (arguments in the query string, the
 * proxy drops form-encoded ones); `files/write` sends multipart field `data`. Gateway reads are
 * plain GETs with the gateway's own auth.
 */
export function createKuboClient(endpoints: KuboClientEndpoints): KuboClient {
  const { rpc, gateway, transport } = endpoints;

  return {
    id: () => nodeId(rpc, transport),
    version: () => nodeVersion(rpc, transport),
    filesLs: (path) => listMfs(rpc, path, transport),
    filesStat: (path) => statMfs(rpc, path, transport),
    ipfsLs: (path) => listIpfs(rpc, path, transport),
    filesRm: async (path, options = {}) => removeMfs(rpc, assertMfsMutationPath(path), options.recursive ?? false, transport),
    filesWrite: (path, data, options) => writeMfsFile(rpc, path, data, options, transport),
    keyList: () => listKeys(rpc, transport),
    keyGen: (name) => generateKey(rpc, name, transport),
    pinAdd: (cid) => addPin(rpc, cid, transport),
    namePublish: (key, cid, ttl) => publishName(rpc, key, cid, ttl, transport),
    nameResolve: (name, options) => resolveName(rpc, name, transport, options),
    gatewayFetch: (cid, path) => fetchGatewayBytes(gateway, cid, path, transport),
    gatewayStream: (cid, path, range) => openGatewayStream(gateway, cid, path, range, transport),
  };
}
