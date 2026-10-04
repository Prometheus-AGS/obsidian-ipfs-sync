import { ConfigError, assertMfsMutationPath, validateMfsRoot, type SyncConfig } from "../core/config";
import type { Bytes, HostBridge } from "../core/host-bridge";
import { createKuboClient, DEFAULT_IPNS_TTL, type KuboClient, type Transport } from "../kubo";
import { REAL_KEY_OPERATIONS, type AcceptDeps, type AcceptTarget, type KeyManagementDeps, type KeyOperations } from "../sync/key-management";
import { createMaintenanceNode } from "../sync/maintenance-node";
import { lockHeld } from "../sync/publish-refusals";
import { openPublicationKey, type PublicationKey } from "../sync/publish-key";
import { assertPublishMarker, PULLED_MARKER_VALUE, readMarkerState } from "../sync/publish-guard";
import { createSnapshotVerifier } from "../sync/read-back";
import { chooseIpnsName, resolveRootCid } from "../sync/target-resolution";
import { keySlotsCopyPath } from "../sync/vault-keys";
import { createPluginDeviceStore } from "./device-store-plugin";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import { PLUGIN_DEVICE } from "./publish-runner";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";

/**
 * The ports key management runs over inside the plugin (mvp-07b task 2.2): the node, the vault's host files, the device store and the lock checks,
 * built once per action from the plugin's settings. It is the plugin's counterpart of `openKeyPorts` in the command line tool (`cli/keys-session.ts`),
 * which cannot be imported here (it builds a Node host). Nothing in this file decides anything about a rewrap or an acceptance.
 *
 * Guards in the same order as the command line: the fixture marker first (a key action sends nothing to an unmarked vault), then the settings and the
 * MFS root, then the publication key (looked up, never created). `accept` also runs on a pulled copy, which is where the second device needs it.
 */

/** What the ports need from the plugin. */
export interface KeyPortsContext {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  readonly transport: Transport;
  readonly now: () => Date;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => KuboClient;
  /** The cryptography; production leaves it out. Tests pass fast stand-ins. */
  readonly operations?: KeyOperations;
}

/** The lock the action holds, as the ports see it. */
export interface HeldLock {
  readonly assertHeld: () => void;
  /** Re-reads the lock file's token right before the first change (the 07a standard). */
  readonly verifyHeld: () => Promise<boolean>;
}

export interface KeyPorts {
  readonly deps: KeyManagementDeps;
  readonly acceptDeps: AcceptDeps;
  readonly key: Pick<PublicationKey, "absent">;
  /** Set when the publication key is on the node but not owned by this installation (accept only; a withdrawal then needs the key and says so). */
  readonly keyRefusal: ConfigError | undefined;
  readonly mfsRoot: string;
  readonly keyName: string;
  /** This device's key-slot copy for the MFS root, or `undefined` when it holds none. */
  readonly readCopy: () => Promise<Bytes | undefined>;
  /** The root the publication name serves now, resolved once. */
  readonly resolveAcceptTarget: () => Promise<AcceptTarget>;
}

/** What stands in for a key this installation does not own: no ID, so the name is never read for it and nothing is ever published under it. */
const NO_KEY: PublicationKey = {
  absent: true,
  id: () => "",
  created: () => false,
  ensure: async () => {
    throw new Error("a key this installation does not own is never created");
  },
};

async function openKey(client: KuboClient, config: SyncConfig, lenient: boolean): Promise<{ readonly key: PublicationKey; readonly refusal: ConfigError | undefined }> {
  try {
    return { key: await openPublicationKey(client, config.publicationKey, config.ownedKeys, async () => undefined), refusal: undefined };
  } catch (error) {
    // `accept` on a second device reads two files of a root and needs no key of its own; only a withdrawal needs the name.
    if (lenient && error instanceof ConfigError && error.code === "foreign-key") return { key: NO_KEY, refusal: error };
    throw error;
  }
}

/** A key action sends nothing to a vault without the fixture marker; accept and discard also run on a pulled copy. */
async function assertKeyMarker(host: HostBridge, lenient: boolean): Promise<void> {
  if (lenient && (await readMarkerState(host.fs)) === PULLED_MARKER_VALUE) return;
  await assertPublishMarker(host.fs);
}

export async function openKeyPorts(ctx: KeyPortsContext, held: HeldLock, options: { readonly lenient: boolean }): Promise<KeyPorts> {
  const host = createObsidianHostBridge({
    adapter: ctx.adapter,
    maxReadMb: ctx.store.get().maxReadMb,
    env: { IPFS_SYNC_DEVICE: PLUGIN_DEVICE },
    transport: ctx.transport,
    now: () => ctx.now().getTime(),
  });
  await assertKeyMarker(host, options.lenient);
  const config = settingsToConfig(ctx.store.get(), ctx.now());
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(config.mfsRoot));
  const client = ctx.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport: ctx.transport });
  const { key, refusal } = await openKey(client, config, options.lenient);
  const node = createMaintenanceNode({
    client,
    mfsRoot,
    key: config.publicationKey,
    ttl: DEFAULT_IPNS_TTL,
    keyId: () => key.id(),
    keyCreated: () => key.created(),
    beforeWrite: () => held.assertHeld(),
  });
  const deviceStore = createPluginDeviceStore(ctx.store);
  const beforeFirstWrite = async (): Promise<void> => {
    if (!(await held.verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
  };
  const deps: KeyManagementDeps = {
    node,
    fs: host.fs,
    kv: host.kv,
    deviceStore,
    ops: ctx.operations ?? REAL_KEY_OPERATIONS,
    now: () => ctx.now().toISOString(),
    snapshotVerifier: (keySlots) => createSnapshotVerifier({ client, keySlots, written: new Map() }),
    assertHeld: held.assertHeld,
    beforeFirstWrite,
  };
  const acceptDeps: AcceptDeps = { node, fs: host.fs, kv: host.kv, deviceStore, assertHeld: held.assertHeld, beforeFirstWrite };
  return {
    deps,
    acceptDeps,
    key,
    keyRefusal: refusal,
    mfsRoot,
    keyName: config.publicationKey,
    readCopy: () => readKeySlotsCopy(host, mfsRoot),
    resolveAcceptTarget: async () => {
      const ipnsName = await chooseIpnsName(client, { keyName: config.publicationKey, ownedKeys: config.ownedKeys });
      return { kind: "name", rootCid: await resolveRootCid(client, ipnsName) };
    },
  };
}

/** This device's key-slot copy for `mfsRoot`, or `undefined` when there is none. A read only; no request leaves the device. */
export async function readKeySlotsCopy(host: Pick<HostBridge, "fs">, mfsRoot: string): Promise<Bytes | undefined> {
  const path = await keySlotsCopyPath(mfsRoot);
  return (await host.fs.stat(path))?.kind === "file" ? host.fs.read(path) : undefined;
}
