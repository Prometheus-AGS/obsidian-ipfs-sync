// Throwaway entry for the WebView import probe (mvp-01 task 3.4, extended in mvp-02).
// It references the public surface of src/core, src/kubo and src/sync so nothing is tree-shaken away.
import { resolveSyncConfig, envLayer, parseConfigFile, classifyKey } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import { createKuboClient, authHeaders } from "../src/kubo";
import { assertFixtureVault } from "../src/sync/publish-guard";
import { createExclusionMatcher, excludesHash } from "../src/sync/exclusions";
import { hashFile, sha256Hex } from "../src/sync/hash";
import { decodeManifestFile, encodeManifestFile } from "../src/sync/encrypted-manifest";
import { publishVault } from "../src/sync/publish";
import { chooseConflictName } from "../src/sync/conflict-name";

Object.assign(globalThis, {
  __ipfsSyncProbe: {
    resolveSyncConfig,
    envLayer,
    parseConfigFile,
    classifyKey,
    assertFixtureVault,
    createKuboClient,
    authHeaders,
    createSyncEventBus,
    createExclusionMatcher,
    excludesHash,
    hashFile,
    sha256Hex,
    publishVault,
    encodeManifestFile,
    decodeManifestFile,
    chooseConflictName,
  },
});
