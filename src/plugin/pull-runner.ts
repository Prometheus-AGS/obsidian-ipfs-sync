import { ConfigError, type SyncConfig } from "../core/config";
import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import { createKuboClient, type Transport } from "../kubo";
import { EncryptedVaultError, PlaintextV1RefusedError, PullGuardError } from "../sync/pull-errors";
import { assertVaultPullDestination } from "../sync/pull-guard";
import { pullVault, type PullClient, type PullPhase, type PullResult } from "../sync/pull";
import { PLUGIN_DEVICE } from "./publish-runner";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import {
  ENCRYPTED_PULL_NOTICE,
  FIXTURE_ONLY_PULL_NOTICE,
  invalidSettingsPullNotice,
  noTargetNotice,
  PLAINTEXT_DOWNGRADE_NOTICE,
  PLAINTEXT_V1_OFF_NOTICE,
  phaseText,
  pullFailedNotice,
  pullResultNotice,
  STARTING_PULL_TEXT,
  unsafeDestinationNotice,
} from "./pull-notices";
import { resolvePullTarget } from "./pull-target";
import { requestUrlTransport } from "./request-url-transport";
import type { PluginSettings, PullSummary } from "./settings-model";
import type { SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";
import { saveSummary } from "./summary-store";
import { busyNotice, createSyncLock, type SyncLock } from "./sync-lock";

export type PullRefusalReason = "busy" | "fixture-only" | "unsafe-destination" | "invalid-settings" | "no-target" | "encrypted-vault" | "plaintext-v1-off";

/**
 * What a run did, with the text to show. `refused` means nothing was sent to the node or written; `pulled` means
 * every file is current or was replaced; `incomplete` means some file failed (the counts and paths say which);
 * `failed` means the run stopped early with a reason.
 */
export type PullOutcome =
  | { readonly kind: "pulled"; readonly notice: string; readonly result: PullResult }
  | { readonly kind: "incomplete"; readonly notice: string; readonly result: PullResult }
  | { readonly kind: "refused"; readonly reason: PullRefusalReason; readonly notice: string }
  | { readonly kind: "failed"; readonly notice: string };

export interface PullRunOptions {
  /** Called with the text for the in-place notice and the status bar as the pull moves along. */
  readonly onProgress?: (text: string) => void;
}

export interface PullRunnerDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  readonly bus: SyncEventBus;
  /** Shared with the publish runner so the two never run at once. A runner without one has its own. */
  readonly lock?: SyncLock;
  /** Saves the pending content of every open editor to disk. Must reject if it cannot. Defaults to doing nothing. */
  readonly flushEditors?: () => Promise<void>;
  /** Defaults to the `requestUrl` transport: the WebView's `fetch` is CORS-blocked by the node. */
  readonly transport?: Transport;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => PullClient;
  readonly now?: () => Date;
  /** Unique temp file names; defaults to a random UUID. */
  readonly newId?: () => string;
  /**
   * Whether the plaintext (version 1) reader may run. Off unless this says so: nothing in the settings switches it on
   * (encrypted pull replaces the plaintext reader in the next change), and it is refused anyway for a destination
   * that has seen an encrypted vault.
   */
  readonly allowPlaintextV1?: () => boolean;
}

export interface PullRunner {
  run(options?: PullRunOptions): Promise<PullOutcome>;
  /** True while any sync operation (this runner's or the publish runner's) holds the shared lock. */
  readonly isRunning: () => boolean;
}

interface Prepared {
  readonly settings: PluginSettings;
  readonly host: HostBridge;
  readonly config: SyncConfig;
  readonly client: PullClient;
  /** The IPNS name to resolve. */
  readonly name: string;
}

function refused(reason: PullRefusalReason, notice: string): PullOutcome {
  return { kind: "refused", reason, notice };
}

/** Thrown when open editors could not be saved: going on would let a pending edit be overwritten without a copy. */
class EditorFlushError extends Error {
  constructor(cause: unknown) {
    super(`the open editors could not be saved, so nothing was pulled (${cause instanceof Error ? cause.message : "unknown error"})`, { cause });
    this.name = "EditorFlushError";
  }
}

function outcomeFor(error: unknown): PullOutcome {
  if (error instanceof PullGuardError) {
    return error.reason === "real-vault"
      ? refused("fixture-only", FIXTURE_ONLY_PULL_NOTICE)
      : refused("unsafe-destination", unsafeDestinationNotice(error.message));
  }
  if (error instanceof EncryptedVaultError) return refused("encrypted-vault", ENCRYPTED_PULL_NOTICE);
  if (error instanceof PlaintextV1RefusedError) {
    return error.reason === "downgrade" ? refused("plaintext-v1-off", PLAINTEXT_DOWNGRADE_NOTICE) : refused("plaintext-v1-off", PLAINTEXT_V1_OFF_NOTICE);
  }
  if (error instanceof ConfigError) return refused("invalid-settings", invalidSettingsPullNotice(error.message));
  return { kind: "failed", notice: pullFailedNotice(error) };
}

function summaryOf(result: PullResult, at: Date): PullSummary {
  return {
    at: at.toISOString(),
    rootCid: result.rootCid,
    manifestCid: result.manifestCid,
    fetched: result.fetched,
    unchanged: result.unchanged,
    conflicts: result.conflicted,
    failed: result.failed,
    remoteDeleted: result.remoteDeleted,
  };
}

/**
 * Pulls the vault through the shared engine. Order: destination guard (no request without it), settings to
 * validated config, editor flush, target (the pull name, else the owned publication key: `key/list` only when
 * needed), the engine's pull (name resolve, gateway reads, verified atomic writes, three-way decision, dated
 * conflict copies), notice text, `lastPull`. Read-only against the node. One sync operation at a time (the lock
 * is shared with publish); it is released in `finally`.
 */
export function createPullRunner(deps: PullRunnerDeps): PullRunner {
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

  async function flush(): Promise<void> {
    try {
      await deps.flushEditors?.();
    } catch (error) {
      throw new EditorFlushError(error);
    }
  }

  /** Everything that must hold before the engine runs; nothing here writes, and only the target step can ask the node. */
  async function prepare(): Promise<Prepared | PullOutcome> {
    const settings = deps.store.get();
    const host = buildHost();
    await assertVaultPullDestination(host.fs);
    const config = settingsToConfig(settings, now());
    const client = deps.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport });
    await flush();
    const nodeKeys = settings.pullName === "" ? (await client.keyList()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id })) : [];
    const target = resolvePullTarget({ pullName: settings.pullName, publicationKey: config.publicationKey, ownedKeys: config.ownedKeys }, nodeKeys);
    if (target.kind === "none") return refused("no-target", noTargetNotice(target.message));
    return { settings, host, config, client, name: target.name };
  }

  async function execute(options: PullRunOptions): Promise<PullOutcome> {
    const prepared = await prepare();
    if ("kind" in prepared) return prepared;
    const { settings, host, config, client, name } = prepared;
    options.onProgress?.(STARTING_PULL_TEXT);

    const warnings: string[] = [];
    let fetched = 0;
    let latest: PullPhase | undefined;
    const report = (): void => {
      if (latest !== undefined) options.onProgress?.(phaseText(latest, fetched));
    };
    const stop = deps.bus.on("file.changed", () => {
      fetched += 1;
      report();
    });
    try {
      const result = await pullVault(
        {
          client,
          host,
          bus: deps.bus,
          warn: (message) => void warnings.push(message),
          newId: deps.newId,
          assertDestination: assertVaultPullDestination,
          onPhase: (phase) => {
            latest = phase;
            report();
          },
        },
        {
          mfsRoot: config.mfsRoot,
          keyName: config.publicationKey,
          ownedKeys: config.ownedKeys,
          name,
          selector: { kind: "latest" },
          extraExclusions: settings.userExclusions,
          allowPlaintextV1: deps.allowPlaintextV1?.() === true,
        },
      );
      const problem = await saveSummary(deps.store, (current) => ({ ...current, lastPull: summaryOf(result, now()) }));
      const notice = [pullResultNotice(result, warnings), problem].filter((line) => line !== undefined).join("\n");
      return { kind: result.failed === 0 ? "pulled" : "incomplete", notice, result };
    } finally {
      stop();
    }
  }

  return {
    isRunning: () => lock.holder() !== undefined,
    run: async (options = {}) => {
      const release = lock.tryAcquire("pull");
      if (release === undefined) return refused("busy", busyNotice(lock.holder()));
      try {
        return await execute(options);
      } catch (error) {
        return outcomeFor(error);
      } finally {
        release();
      }
    },
  };
}
