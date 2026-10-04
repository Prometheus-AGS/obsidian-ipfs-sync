import { ConfigError, type SyncConfig } from "../core/config";
import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import type { CostPolicy } from "../crypto";
import { createKuboClient, type Transport } from "../kubo";
import { ManifestFormatError } from "../sync/encrypted-manifest";
import { createDeviceIdProvider } from "../sync/device-store";
import { assertPublishMarker, FIXTURE_ONLY_NOTICE } from "../sync/publish-guard";
import { publishVault, type PublishClient, type PublishResult } from "../sync/publish";
import { OwnedKeyNotRecordedError } from "../sync/publish-errors";
import { withTokenCheck } from "../sync/lock-token-check";
import { acquirePublishLock, type LockContext, type LockFile, type PublishLock } from "../sync/publish-lock";
import { lockHeld, PublishRefusedError, type MassRemovalCounts } from "../sync/publish-refusals";
import { VaultKeysError } from "../sync/vault-keys";
import { createAdapterLockFile, createPluginLockContext } from "./adapter-lock-file";
import { createPluginDeviceStore } from "./device-store-plugin";
import { requestUrlTransport } from "./request-url-transport";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import {
  failedNotice,
  foreignKeyNotice,
  INCOMPATIBLE_MANIFEST_NOTICE,
  invalidSettingsNotice,
  keyNotRecordedNotice,
  LOCKED_TIMER_NOTICE,
  lockHeldNotice,
  massRemovalDeclinedNotice,
  massRemovalTimerRefusal,
  NOT_SET_UP_TIMER_NOTICE,
  PASSPHRASE_REQUIRED_NOTICE,
  publishedNotice,
  unchangedNotice,
  UNLOCK_CANCELLED_NOTICE,
} from "./publish-notices";
import type { SessionKeys } from "./session-keys";
import type { PublishSummary } from "./settings-model";
import type { SettingsStore } from "./settings-store";
import { exclusionsWithConfigDir, settingsToConfig } from "./settings-to-config";
import { saveSummary } from "./summary-store";
import { busyNotice, createSyncLock, type SyncLock } from "./sync-lock";

/** The label the manifest `device` starts with when the plugin publishes; the installation's device id follows it (`obsidian-<12 hex>`). */
export const PLUGIN_DEVICE = "obsidian";

export type RefusalReason =
  | "busy"
  | "fixture-only"
  | "invalid-settings"
  | "foreign-key"
  | "key-not-recorded"
  /** The session holds no keys and the run could not ask for them (unattended), or the keys were dropped mid-run. */
  | "locked"
  /** No vault exists on this device and the run could not open the setup dialog (unattended). */
  | "not-set-up"
  /** The user closed the unlock or setup dialog. */
  | "cancelled"
  /** The node holds an authentic manifest this build cannot read (written by a newer or incompatible version). */
  | "incompatible-manifest"
  /** The guard stopped a publish that would remove every remaining entry or more than half of them, and it was not confirmed (the timer never asks). */
  | "mass-removal";

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
  /**
   * The auto-publish timer. An unattended run never opens a dialog: it publishes only with a session that is already
   * unlocked, and otherwise refuses (`locked` or `not-set-up`) before sending anything. A manual run asks for the
   * passphrase, and opens the setup dialog when this device has no vault.
   */
  readonly unattended?: boolean;
}

export interface PublishRunnerDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  /** `app.vault.configDir`: added to the exclusions when it is not `.obsidian`. */
  readonly configDir?: string;
  readonly bus: SyncEventBus;
  /**
   * The key session. The engine gets its `provider`, so a run with an unlocked session performs no key derivation. The
   * runner only asks the session to unlock or set up; it never sees a passphrase.
   */
  readonly session: SessionKeys;
  /** Shared with the pull runner so the two never run at once. A runner without one has its own. */
  readonly lock?: SyncLock;
  /** Defaults to the `requestUrl` transport: the WebView's `fetch` is CORS-blocked by the node. */
  readonly transport?: Transport;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => PublishClient;
  readonly now?: () => Date;
  /** The cross-process lock file. Defaults to `<vault>/.ipfs-sync/publish.lock` through the vault adapter. */
  readonly lockFile?: LockFile;
  readonly lockContext?: LockContext;
  /**
   * The engine's `confirmMassRemoval` port for a MANUAL run: it opens the mass-removal dialog and resolves `true` only after the explicit confirm. A run
   * with `unattended: true` never reaches it. Without this port a manual run that the guard stops is refused, as the timer is.
   */
  readonly askMassRemoval?: (counts: MassRemovalCounts) => Promise<boolean>;
  /**
   * The cost-confirm policy (task 2.4, `obsidianCostConfirmation(app).policy`): handed to the engine on a MANUAL run only. A run with `unattended: true`
   * is never handed it, so the timer cannot ask and keeps refusing a key slot above the default cost. The session's unlock (the dialog path) has its own
   * copy in `createVaultOpener`. Absent: such a slot is refused (`kdf-cost-refused`).
   */
  readonly costPolicy?: CostPolicy;
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

/** What one run learned that the thrown error does not carry: the counts the mass-removal guard reported (the refusal itself holds text only). */
interface RunFacts {
  counts: MassRemovalCounts | undefined;
}

/** The notice for a publish the mass-removal guard stopped: the timer's words for an unattended run, otherwise the "not confirmed" words. */
function massRemovalOutcome(error: PublishRefusedError, facts: RunFacts, unattended: boolean): PublishOutcome {
  const { counts } = facts;
  if (counts === undefined) return refused("mass-removal", failedNotice(error));
  return refused("mass-removal", unattended ? massRemovalTimerRefusal(counts) : massRemovalDeclinedNotice(counts));
}

/** Map a thrown error to the outcome the user should see. */
function outcomeFor(error: unknown, keyName: string, facts: RunFacts, unattended: boolean): PublishOutcome {
  if (error instanceof PublishRefusedError && error.code === "mass-removal") return massRemovalOutcome(error, facts, unattended);
  if (error instanceof OwnedKeyNotRecordedError) return refused("key-not-recorded", keyNotRecordedNotice(error));
  if (error instanceof ManifestFormatError) return refused("incompatible-manifest", INCOMPATIBLE_MANIFEST_NOTICE);
  if (error instanceof PublishRefusedError && error.code === "passphrase-required") return refused("locked", PASSPHRASE_REQUIRED_NOTICE);
  // Another process holds the lock file: like the in-process lock, the timer skips it silently and a manual run says so.
  if (error instanceof PublishRefusedError && error.code === "lock-held") return refused("busy", lockHeldNotice(error));
  if (error instanceof VaultKeysError && error.code === "locked") return refused("locked", PASSPHRASE_REQUIRED_NOTICE);
  if (error instanceof ConfigError) {
    if (error.code === "foreign-key") return refused("foreign-key", foreignKeyNotice(keyName));
    if (error.code === "fixture-marker-required") return refused("fixture-only", FIXTURE_ONLY_NOTICE);
    return refused("invalid-settings", invalidSettingsNotice(error));
  }
  return { kind: "failed", notice: failedNotice(error) };
}

/** The session held a vault that no longer opens the slots on disk: dropping it and asking again is the way out. */
function isHeldVaultStale(error: unknown): boolean {
  return error instanceof VaultKeysError && error.code === "locked";
}

/** Release the lock file; a failure to remove it is reported to the user, not thrown over a finished publish. */
async function releaseLockFile(lock: PublishLock): Promise<string | undefined> {
  try {
    await lock.release();
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return `(The publish lock file could not be removed: ${reason}. It expires after 15 minutes without a heartbeat.)`;
  }
}

/**
 * Publishes the vault through the shared engine. Order, all before the first request: a busy check on the in-process
 * lock (shared with pull), the fixture marker guard, settings to validated config, the key session (an unattended run
 * refuses when it is not already unlocked; a manual run unlocks, or sets up, through the session's dialogs), then the
 * in-process lock, then the lock file with a read-back of its token. The dialogs run before the in-process lock is taken,
 * so an open dialog never blocks pull, abandon or the timer. The engine gets the session's key provider and the lock
 * file's `assertHeld`, so it repeats the marker guard, checks the publication key and does the delta publish with
 * `ownedKeys` kept in plugin data. Both locks are released in `finally`. When a held vault answers "locked" (its key
 * slots changed on disk), a manual run locks the session and asks once more. The outcome of a run that reached the node
 * is saved as `lastPublish` (counts, root CID and time only).
 */
export function createPublishRunner(deps: PublishRunnerDeps): PublishRunner {
  const now = deps.now ?? ((): Date => new Date());
  const transport = deps.transport ?? requestUrlTransport;
  const lock = deps.lock ?? createSyncLock();
  const lockFile = deps.lockFile ?? createAdapterLockFile(deps.adapter);
  const lockContext = deps.lockContext ?? createPluginLockContext(() => now().getTime());
  // The device id and the sequence floor live in the plugin data, through the settings store (its only writer).
  const deviceStore = createPluginDeviceStore(deps.store);
  const deviceId = createDeviceIdProvider(deviceStore);

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

  /** Undefined when the session is unlocked and the run may go on; otherwise the refusal. */
  async function requireUnlockedSession(unattended: boolean): Promise<PublishOutcome | undefined> {
    if (unattended) {
      // `refresh` reads a local file only: no request, no dialog.
      const state = await deps.session.refresh();
      if (state === "unlocked") return undefined;
      return state === "locked" ? refused("locked", LOCKED_TIMER_NOTICE) : refused("not-set-up", NOT_SET_UP_TIMER_NOTICE);
    }
    let outcome = await deps.session.unlock();
    // Publish with no vault opens the setup dialog; a vault is created only by that dialog's Create action.
    if (outcome.kind === "not-set-up") outcome = await deps.session.setup();
    return outcome.kind === "unlocked" ? undefined : refused("cancelled", UNLOCK_CANCELLED_NOTICE);
  }

  async function publishUnderLock(
    options: RunOptions,
    host: HostBridge,
    config: SyncConfig,
    client: PublishClient,
    fileLock: PublishLock,
    verifyHeld: () => Promise<boolean>,
    confirmMassRemoval: (counts: MassRemovalCounts) => Promise<boolean>,
  ): Promise<PublishResult> {
    let changed = 0;
    const stop = deps.bus.on("file.changed", () => {
      changed += 1;
      options.onProgress?.({ changed, done: false });
    });
    try {
      const result = await publishVault(
        {
          client,
          host,
          bus: deps.bus,
          deviceId,
          deviceStore,
          // Awaited by the engine right before its first request that can change the node (resume, key creation or first blob, junk removal).
          beforeFirstWrite: async () => {
            if (!(await verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
          },
        },
        {
          mfsRoot: config.mfsRoot,
          keyName: config.publicationKey,
          ownedKeys: config.ownedKeys,
          recordOwnedKey,
          extraExclusions: exclusionsWithConfigDir(deps.store.get().userExclusions, deps.configDir),
          unlocked: deps.session.provider,
          assertHeld: () => fileLock.assertHeld(),
          confirmMassRemoval,
          ...(options.unattended === true || deps.costPolicy === undefined ? {} : { costPolicy: deps.costPolicy }),
        },
      );
      options.onProgress?.({ changed, done: true });
      return result;
    } finally {
      stop();
    }
  }

  /** What must hold before the sync lock is taken: the marker guard, valid settings and an unlocked session (this may open a dialog). */
  async function prepare(options: RunOptions): Promise<{ readonly host: HostBridge; readonly config: SyncConfig } | PublishOutcome> {
    const host = buildHost();
    await assertPublishMarker(host.fs);
    const config = settingsToConfig(deps.store.get(), now());
    const gate = await requireUnlockedSession(options.unattended === true);
    return gate ?? { host, config };
  }

  /**
   * The engine's `confirmMassRemoval` port. It records the counts for the notice (the engine's refusal carries text only). A manual run asks the dialog;
   * an unattended run has nobody to ask and answers no, so a timer publish can never confirm a mass removal.
   */
  function massRemovalPort(options: RunOptions, facts: RunFacts): (counts: MassRemovalCounts) => Promise<boolean> {
    return async (counts) => {
      facts.counts = counts;
      if (options.unattended === true || deps.askMassRemoval === undefined) return false;
      return deps.askMassRemoval(counts);
    };
  }

  async function execute(options: RunOptions, host: HostBridge, config: SyncConfig, facts: RunFacts): Promise<PublishOutcome> {
    const client = deps.createClient?.(config) ?? createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport });

    const checked = withTokenCheck(lockFile);
    const fileLock = await acquirePublishLock(checked.file, lockContext);
    let result: PublishResult;
    try {
      // The adapter may not refuse a rename onto an existing lock file: look at the file itself before the first request
      // that can write to the node. (`assertHeld` is synchronous and only knows the last heartbeat.)
      if (!(await checked.verifyHeld())) throw lockHeld("the lock file changed hands right after it was taken");
      result = await publishUnderLock(options, host, config, client, fileLock, checked.verifyHeld, massRemovalPort(options, facts));
    } catch (error) {
      await releaseLockFile(fileLock);
      throw error;
    }
    const lockProblem = await releaseLockFile(fileLock);
    const outcome: PublishOutcome = result.published
      ? { kind: "published", notice: publishedNotice(result), result }
      : { kind: "unchanged", notice: unchangedNotice(result), result };
    const summaryProblem = await saveSummary(deps.store, (current) => ({ ...current, lastPublish: publishSummary(result, now()) }));
    const problems = [summaryProblem, lockProblem].filter((problem): problem is string => problem !== undefined);
    return problems.length === 0 ? outcome : { ...outcome, notice: `${outcome.notice} ${problems.join(" ")}` };
  }

  /**
   * One attempt. The session is unlocked before the sync lock is taken, so a passphrase dialog left open (a
   * backgrounded phone) never holds the lock that pull, abandon and the timer wait on. The timer path never opens a
   * dialog and is unchanged. A busy lock is answered before a dialog can open.
   */
  async function attempt(options: RunOptions, facts: RunFacts): Promise<PublishOutcome> {
    if (lock.holder() !== undefined) return refused("busy", busyNotice(lock.holder()));
    const prepared = await prepare(options);
    if ("kind" in prepared) return prepared;
    const release = lock.tryAcquire("publish");
    if (release === undefined) return refused("busy", busyNotice(lock.holder()));
    try {
      return await execute(options, prepared.host, prepared.config, facts);
    } finally {
      release();
    }
  }

  return {
    isRunning: () => lock.holder() !== undefined,
    run: async (options = {}) => {
      const facts: RunFacts = { counts: undefined };
      const unattended = options.unattended === true;
      try {
        return await attempt(options, facts);
      } catch (error) {
        // A held vault whose key slots changed on disk answers "locked" on every run; drop it and ask once more.
        if (isHeldVaultStale(error) && !unattended) {
          deps.session.lock();
          try {
            return await attempt(options, facts);
          } catch (again) {
            return outcomeFor(again, deps.store.get().publicationKey, facts, unattended);
          }
        }
        return outcomeFor(error, deps.store.get().publicationKey, facts, unattended);
      }
    },
  };
}
