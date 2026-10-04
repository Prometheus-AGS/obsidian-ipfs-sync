import type { HostFs } from "../core/host-bridge";
import { ConfigError, assertMfsMutationPath, validateMfsRoot, type SyncConfig } from "../core/config";
import type { CostPolicy, KdfParams } from "../crypto";
import { createKuboClient, type Transport } from "../kubo";
import { assertPublishMarker } from "../sync/publish-guard";
import { createRootInspector, type RootInspector } from "../sync/node-reader";
import type { PublishClient } from "../sync/publish";
import { readRootState } from "../sync/root-state";
import { openVault, toUnlockedVault } from "../sync/vault-keys";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import { hasLocalKeySlots, type OpenVault } from "./session-keys";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";

/**
 * The derivation port of the key session (`session-keys.ts`, `OpenVault`): the only place where the plugin runs
 * Argon2id. It repeats the guards the engine applies before it touches a vault, in the same order, so the setup and
 * unlock dialogs cannot reach a node that a publish would not: the fixture marker first, then settings and MFS root,
 * then (for creation only) a read of the root to prove it holds no vault, then `openVault`, which decides when a
 * derivation may run and whether a wrong passphrase fails before any request.
 *
 * Creation is local: it writes the per-root key-slot copy under `.ipfs-sync/`. The key slots reach the node with the
 * next publish (the engine writes them first, `resumed-creation`), which is what the publish that follows a
 * successful setup does at once. The passphrase is never stored here; it lives in the request for one call.
 */

export interface VaultOpenerDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  readonly transport: Transport;
  readonly now: () => Date;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => PublishClient;
  /** Tests create vaults at the floor cost. Production uses the default cost. */
  readonly createParams?: KdfParams;
  /**
   * The cost-confirm policy (task 2.4): lets the unlock dialog's derivation run on a key slot above the default cost after an explicit yes. Only the
   * dialogs reach this port (an unattended run never derives: it reads whether the session is unlocked), so the timer cannot ask. Absent: refused.
   */
  readonly costPolicy?: CostPolicy;
}

/** The vault cannot be created or opened here for a reason the user can act on. The message is fixed text. */
export class VaultSetupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultSetupRefusedError";
  }
}

const ROOT_HAS_VAULT =
  "this MFS root already holds a vault (key slots or a manifest are on the node) that this device has no local key copy for. " +
  "A vault is created only in an empty root: choose another MFS root in the settings. Nothing was written.";

const ROOT_NOT_EMPTY =
  "this MFS root is not empty. A vault is created only in an empty root: choose another MFS root in the settings. Nothing was written.";

/** The same rule as `ipfs-sync init`: a vault is created only in an empty root, so any entry at all is refused. */
async function assertRootIsEmpty(inspector: RootInspector): Promise<void> {
  const { entries } = await inspector.view();
  if (entries.has("keyslots.json") || entries.has("manifest.enc")) throw new VaultSetupRefusedError(ROOT_HAS_VAULT);
  if (entries.size > 0) throw new VaultSetupRefusedError(ROOT_NOT_EMPTY);
}

/**
 * Creation derives a key for seconds and then writes the local key-slot copy. Look at the root again just before that
 * write, as `init` does after its derivation: this narrows the window in which another writer could have put something
 * in the root; it cannot close it, because the write is not conditional. A fresh inspector, because the first view is cached.
 */
function guardCreation(fs: HostFs, client: PublishClient, mfsRoot: string): HostFs {
  return {
    ...fs,
    write: async (path, data) => {
      await assertRootIsEmpty(createRootInspector(client, mfsRoot));
      return fs.write(path, data);
    },
  };
}

export function createVaultOpener(deps: VaultOpenerDeps): OpenVault {
  return async (request) => {
    const host = createObsidianHostBridge({ adapter: deps.adapter, transport: deps.transport, now: () => deps.now().getTime() });
    await assertPublishMarker(host.fs);
    const config = settingsToConfig(deps.store.get(), deps.now());
    const mfsRoot = assertMfsMutationPath(validateMfsRoot(config.mfsRoot));
    const client = deps.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport: deps.transport });
    const inspector = createRootInspector(client, mfsRoot);
    if (request.create !== undefined) await assertRootIsEmpty(inspector);
    const state = await readRootState(host.kv, mfsRoot);
    const opened = await openVault({
      fs: request.create === undefined ? host.fs : guardCreation(host.fs, client, mfsRoot),
      mfsRoot,
      passphrase: request.passphrase,
      create: request.create,
      createParams: deps.createParams,
      costPolicy: deps.costPolicy,
      local: { hasState: state !== undefined, vaultId: state?.vaultId, keyslotsSha256: state?.keyslotsSha256 },
      node: {
        fetchKeySlots: () => inspector.readKeySlots(),
        manifestPresent: async () => (await inspector.view()).entries.has("manifest.enc"),
      },
      onProgress: request.onProgress,
    });
    return toUnlockedVault(opened);
  };
}

/**
 * The session's `vaultExists`: this root has a local key-slot copy. Settings that do not validate address no root, so
 * there is no vault to find; the next publish or setup reports the settings problem itself.
 */
export function createVaultProbe(deps: Pick<VaultOpenerDeps, "store" | "adapter" | "now">): () => Promise<boolean> {
  return async () => {
    let mfsRoot: string;
    try {
      mfsRoot = assertMfsMutationPath(validateMfsRoot(settingsToConfig(deps.store.get(), deps.now()).mfsRoot));
    } catch (error) {
      if (error instanceof ConfigError) return false;
      throw error;
    }
    return hasLocalKeySlots(createObsidianHostBridge({ adapter: deps.adapter }).fs, mfsRoot);
  };
}
