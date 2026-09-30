import { assertFixtureVault, ConfigError, FIXTURE_MARKER, type SyncConfig } from "../core/config";
import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import { createKuboClient, type Transport } from "../kubo";
import { publishVault, type PublishClient, type PublishResult } from "../sync/publish";
import { OwnedKeyNotRecordedError } from "../sync/publish-errors";
import { requestUrlTransport } from "./request-url-transport";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import {
  failedNotice,
  FIXTURE_ONLY_NOTICE,
  foreignKeyNotice,
  invalidSettingsNotice,
  keyNotRecordedNotice,
  publishedNotice,
  unchangedNotice,
} from "./publish-notices";
import type { PublishSummary } from "./settings-model";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";
import { saveSummary } from "./summary-store";
import { busyNotice, createSyncLock, type SyncLock } from "./sync-lock";

/** The name the manifest carries as `device` when the plugin publishes. */
export const PLUGIN_DEVICE = "obsidian";

export type RefusalReason = "busy" | "fixture-only" | "invalid-settings" | "foreign-key" | "key-not-recorded";

/** What a run did, with the text to show. `refused` means no `name/publish` was sent and nothing changed on the node's pointer. */
export type PublishOutcome =
  | { readonly kind: "published"; readonly notice: string; readonly result: PublishResult }
  | { readonly kind: "unchanged"; readonly notice: string; readonly result: PublishResult }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly notice: string }
  | { readonly kind: "failed"; readonly notice: string };

export interface PublishProgress {
  /** Files reported changed so far in this run. */
  readonly changed: number;
  readonly done: boolean;
}

export interface RunOptions {
  /** Called with the running count as the engine reports changes on the event bus. */
  readonly onProgress?: (progress: PublishProgress) => void;
}

export interface PublishRunnerDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  readonly bus: SyncEventBus;
  /** Shared with the pull runner so the two never run at once. A runner without one has its own. */
  readonly lock?: SyncLock;
  /** Defaults to the `requestUrl` transport: the WebView's `fetch` is CORS-blocked by the node. */
  readonly transport?: Transport;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => PublishClient;
  readonly now?: () => Date;
}

export interface PublishRunner {
  run(options?: RunOptions): Promise<PublishOutcome>;
  /** True while any sync operation (this runner's or the pull runner's) holds the shared lock. */
  readonly isRunning: () => boolean;
}

function refused(reason: RefusalReason, notice: string): PublishOutcome {
  return { kind: "refused", reason, notice };
}

function publishSummary(result: PublishResult, at: Date): PublishSummary {
  const base = { at: at.toISOString(), written: result.written, removed: result.removed, skipped: result.skipped.length };
  return result.rootCid === undefined ? base : { ...base, rootCid: result.rootCid };
}

/** Map a thrown error to the outcome the user should see. */
function outcomeFor(error: unknown, keyName: string): PublishOutcome {
  if (error instanceof OwnedKeyNotRecordedError) return refused("key-not-recorded", keyNotRecordedNotice(error));
  if (error instanceof ConfigError) {
    if (error.code === "foreign-key") return refused("foreign-key", foreignKeyNotice(keyName));
    if (error.code === "plaintext-publish-refused") return refused("fixture-only", FIXTURE_ONLY_NOTICE);
    return refused("invalid-settings", invalidSettingsNotice(error));
  }
  return { kind: "failed", notice: failedNotice(error) };
}

/**
 * Publishes the vault through the shared engine. Order: marker guard (no request without it), settings to
 * validated config, key rules and the engine's delta publish with `ownedKeys` kept in plugin data, notice text.
 * One sync operation at a time (the lock is shared with pull); it is released in `finally`. The outcome of a
 * run that reached the node is saved as `lastPublish` (counts, root CID and time only).
 */
export function createPublishRunner(deps: PublishRunnerDeps): PublishRunner {
  const now = deps.now ?? ((): Date => new Date());
  const transport = deps.transport ?? requestUrlTransport;
  const lock = deps.lock ?? createSyncLock();

  const buildHost = (): HostBridge =>
    createObsidianHostBridge({
      adapter: deps.adapter,
      maxReadMb: deps.store.get().maxReadMb,
      env: { IPFS_SYNC_DEVICE: PLUGIN_DEVICE },
      transport,
      now: () => now().getTime(),
    });

  const recordOwnedKey = async (keyId: string): Promise<void> => {
    await deps.store.update((settings) =>
      settings.ownedKeys.includes(keyId) ? settings : { ...settings, ownedKeys: [...settings.ownedKeys, keyId] },
    );
  };

  async function execute(options: RunOptions): Promise<PublishOutcome> {
    const settings = deps.store.get();
    const host = buildHost();
    assertFixtureVault((await host.fs.stat(FIXTURE_MARKER))?.kind === "file");
    const config = settingsToConfig(settings, now());
    const client = deps.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport });

    let changed = 0;
    const stop = deps.bus.on("file.changed", () => {
      changed += 1;
      options.onProgress?.({ changed, done: false });
    });
    try {
      const result = await publishVault(
        { client, host, bus: deps.bus },
        {
          mfsRoot: config.mfsRoot,
          keyName: config.publicationKey,
          ownedKeys: config.ownedKeys,
          recordOwnedKey,
          extraExclusions: settings.userExclusions,
        },
      );
      options.onProgress?.({ changed, done: true });
      const outcome: PublishOutcome = result.published
        ? { kind: "published", notice: publishedNotice(result), result }
        : { kind: "unchanged", notice: unchangedNotice(result), result };
      const problem = await saveSummary(deps.store, (current) => ({ ...current, lastPublish: publishSummary(result, now()) }));
      return problem === undefined ? outcome : { ...outcome, notice: `${outcome.notice} ${problem}` };
    } finally {
      stop();
    }
  }

  return {
    isRunning: () => lock.holder() !== undefined,
    run: async (options = {}) => {
      const release = lock.tryAcquire("publish");
      if (release === undefined) return refused("busy", busyNotice(lock.holder()));
      try {
        return await execute(options);
      } catch (error) {
        return outcomeFor(error, deps.store.get().publicationKey);
      } finally {
        release();
      }
    },
  };
}
