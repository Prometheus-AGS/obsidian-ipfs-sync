// Entry for the WebView size probe: the public surface of src/core and src/kubo only (mvp-04, kubo-client-lite).
import { resolveSyncConfig, envLayer, parseConfigFile, classifyKey, assertFixtureVault } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import { createKuboClient, authHeaders, rpcCall } from "../src/kubo";

Object.assign(globalThis, {
  __ipfsSyncKuboCoreProbe: {
    resolveSyncConfig,
    envLayer,
    parseConfigFile,
    classifyKey,
    assertFixtureVault,
    createSyncEventBus,
    createKuboClient,
    authHeaders,
    rpcCall,
  },
});
