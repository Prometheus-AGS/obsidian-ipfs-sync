import { ConfigError, type SyncConfig } from "../core/config";
import type { SyncEventBus } from "../core/events";
import type { HostBridge } from "../core/host-bridge";
import { CryptoError, type CanonicalPassphrase, type KdfParams } from "../crypto";
import { createKuboClient, type KuboClient, type Transport } from "../kubo";
import { createRangedBlobSources } from "../sync/blob-source";
import type { EncryptedPullOutcome, PullStop, PullTarget } from "../sync/encrypted-pull";
import { pullEncryptedVault, type PullStageResult } from "../sync/encrypted-pull-stage";
import { PullGuardError, type PullStopReason } from "../sync/pull-errors";
import { assertVaultPullDestination, FIXTURE_ONLY_PULL_NOTICE } from "../sync/pull-guard";
import type { PullFlags } from "../sync/pull-sequence";
import { readFloor } from "../sync/sequence-floor";
import { readRootState } from "../sync/root-state";
import { resolveRootCid } from "../sync/target-resolution";
import type { UnlockedVault } from "../sync/vault-keys";
import { VaultKeysError } from "../sync/vault-keys";
import { createAdapterLockFile, createPluginLockContext } from "./adapter-lock-file";
import { createPluginDeviceStore } from "./device-store-plugin";
import type { PullRecordInput } from "./encryption-settings-model";
import type { LockContext, LockFile } from "../sync/publish-lock";
import { createObsidianHostBridge } from "./obsidian-host-bridge";
import type { VaultAdapter } from "./obsidian-fs";
import { PLUGIN_DEVICE } from "./publish-runner";
import { askUntilAccepted, type AttemptResult, type PassphrasePort, type PassphraseVerdict } from "./pull-keys";
import { escapeForDisplay } from "../sync/path-policy";
import type { PullDialogs } from "./pull-dialogs";
import {
  encryptedPullNotice,
  FORK_CANCELLED_NOTICE,
  invalidSettingsPullNotice,
  LOCKED_PULL_NOTICE,
  noTargetNotice,
  PLAINTEXT_UNSUPPORTED_NOTICE,
  PULL_PASSPHRASE_CANCELLED_NOTICE,
  pullFailedNotice,
  RESTORE_CANCELLED_NOTICE,
  RESTORE_NEEDS_NAME_NOTICE,
  RESTORE_NO_ENTRIES_NOTICE,
  restoreMismatchNotice,
  RESTORE_UNREADABLE_NOTICE,
  STARTING_PULL_TEXT,
  stoppedPullNotice,
  unfinishedCount,
  unsafeDestinationNotice,
  type PullReport,
} from "./pull-notices";
import { createPullProgress, type PullProgress } from "./pull-progress";
import { reportOf, summaryOfReport, warningsOf } from "./pull-report";
import { describeHistory, listHistoryFiles, loadChosenEntry, unlockForRestore, type RestoreReader } from "./pull-restore";
import { sweepTempFiles, type SweepOutcome } from "./pull-sweep";
import { resolvePullTarget } from "./pull-target";
import { pullTransport } from "./request-url-transport";
import type { SessionKeys } from "./session-keys";
import type { PluginSettings } from "./settings-model";
import type { SettingsStore } from "./settings-store";
import { exclusionsWithConfigDir, settingsToConfig } from "./settings-to-config";
import { saveSummary } from "./summary-store";
import { busyNotice, createSyncLock, type SyncLock } from "./sync-lock";

export type PullRefusalReason =
  | "busy"
  | "fixture-only"
  | "unsafe-destination"
  | "invalid-settings"
  | "no-target"
  /** The name serves a root with no key slots (an old plaintext publication): no code path of this version reads one. */
  | "plaintext-unsupported"
  /** The vault is locked and this run could not ask for the passphrase (the catch-up pull). */
  | "locked"
  /** The user closed a dialog: nothing was fetched or written. */
  | "cancelled"
  /** Restore or Resolve fork needs an IPNS name and the pull name is an explicit root. */
  | "needs-name"
  /** Restore stopped before the confirmation: no history, an entry that does not authenticate, or a name that does not match its entry. */
  | "restore-refused";

/**
 * What a run did, with the text to show. `refused` and `stopped` mean nothing was written to the vault; `completed` means
 * every file is current; `unfinished` means some file is not (the report names them and the next publish keeps them as the
 * node has them); `failed` means the run stopped early with a reason. A `stopped` run with `action` set is followed by a
 * button that starts that action.
 */
export type PullOutcome =
  | { readonly kind: "completed" | "unfinished"; readonly notice: string; readonly report: PullReport }
  | { readonly kind: "stopped"; readonly reason: PullStopReason; readonly notice: string; readonly action: "resolve-fork" | undefined }
  | { readonly kind: "refused"; readonly reason: PullRefusalReason; readonly notice: string }
  | { readonly kind: "failed"; readonly notice: string };

export interface PullRunOptions {
  /** Called with the text for the in-place notice and the status bar as the pull moves along. */
  readonly onProgress?: (text: string) => void;
  /** The catch-up pull: no dialog is ever opened. A locked vault or a first pull refuses instead of asking. */
  readonly unattended?: boolean;
}

/** The node reads a pull makes. The plugin's `createKuboClient` provides them; tests swap in a recording node. */
export type PullRunnerClient = Pick<KuboClient, "keyList" | "nameResolve" | "ipfsLs" | "gatewayFetch" | "gatewayStream">;

export interface PullRunnerDeps {
  readonly store: SettingsStore;
  /** `app.vault.adapter`. */
  readonly adapter: VaultAdapter;
  /** `app.vault.configDir`: added to the exclusions when it is not `.obsidian`. */
  readonly configDir?: string;
  readonly bus: SyncEventBus;
  /** Shared with the publish runner so the two never run at once. A runner without one has its own. */
  readonly lock?: SyncLock;
  /** The cross-process lock file. Defaults to `<vault>/.ipfs-sync/publish.lock` through the vault adapter. */
  readonly lockFile?: LockFile;
  readonly lockContext?: LockContext;
  /** Saves the pending content of every open editor to disk. Must reject if it cannot. Defaults to doing nothing. */
  readonly flushEditors?: () => Promise<void>;
  /** Defaults to the `requestUrl` transport: the WebView's `fetch` is CORS-blocked by the node. */
  readonly transport?: Transport;
  /** Tests swap the node client. */
  readonly createClient?: (config: SyncConfig) => PullRunnerClient;
  readonly now?: () => Date;
  /** Unique temp file names; defaults to a random UUID. */
  readonly newId?: () => string;
  /** The key session: an already unlocked vault saves the passphrase prompt. The pull never unlocks it. */
  readonly session?: Pick<SessionKeys, "provider">;
  /** Where a passphrase comes from when no vault is held. Absent: such a run refuses as locked. */
  readonly passphrase?: PassphrasePort;
  /** The confirmations. Absent: a first pull, a large pull, Restore and Resolve fork cannot be confirmed and do not run. */
  readonly dialogs?: PullDialogs;
  /**
   * The cost-confirm dialog (task 2.4): shows the cost of a key slot above the default and resolves `true` only after an explicit confirm. Handed to the
   * engine on a manual pull, Resolve fork and Restore. A run with `unattended: true` is never handed it, so the catch-up pull cannot ask and keeps
   * refusing such a slot. Absent: a slot above the default cost is refused (`kdf-cost-refused`).
   */
  readonly confirmCost?: (costs: readonly KdfParams[]) => Promise<boolean>;
}

export interface PullRunner {
  /** The plain Pull. It never carries the rollback flag. */
  run(options?: PullRunOptions): Promise<PullOutcome>;
  /** The Restore action: list the history, authenticate the chosen entry, confirm, then pull that older version. The only caller of the rollback flag. */
  restore(options?: Pick<PullRunOptions, "onProgress">): Promise<PullOutcome>;
  /** The Resolve fork action: confirm, then pull with the node's version winning where the two differ. */
  resolveFork(options?: Pick<PullRunOptions, "onProgress">): Promise<PullOutcome>;
  /** Remove stale temporary files of a pull that crashed. Runs only while it holds `publish.lock`; skipped when that is held. */
  sweepTemp(): Promise<SweepOutcome>;
  /** What this device's state file records about pulls, for the settings tab. `undefined` when there is no state. */
  record(): Promise<PullRecordInput | undefined>;
  /** True while any sync operation (this runner's or the publish runner's) holds the shared lock. */
  readonly isRunning: () => boolean;
}

type Where = { readonly kind: "name"; readonly name: string } | { readonly kind: "root"; readonly cid: string };

interface Prepared {
  readonly settings: PluginSettings;
  readonly host: HostBridge;
  readonly config: SyncConfig;
  readonly client: PullRunnerClient;
  readonly where: Where;
}

/** The three ways the engine is called. Only `restore` passes the rollback flag, and only `fork` passes the fork flag. */
type Mode = { readonly kind: "pull" } | { readonly kind: "fork" } | { readonly kind: "restore"; readonly historyCid: string };

const MIB = 1024 * 1024;

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
  if (error instanceof ConfigError) return refused("invalid-settings", invalidSettingsPullNotice(error.message));
  return { kind: "failed", notice: pullFailedNotice(error) };
}

/** Whether the pull stopped at a check for this reason. A plain test: another reason is a stop too. */
const isStop = (outcome: EncryptedPullOutcome<PullStageResult>, reason: PullStopReason): boolean => outcome.kind === "stopped" && outcome.stop.reason === reason;

/**
 * How the unlock dialog is answered when the pull ends while it is still open: a finished pull is a success; every other end is a
 * refusal that says why. The notice is already escaped fixed text.
 */
function verdictFor(outcome: PullOutcome): PassphraseVerdict {
  if (outcome.kind === "completed" || outcome.kind === "unfinished") return { ok: true };
  return { ok: false, reason: outcome.notice };
}

const isWrongPassphraseError = (error: unknown): boolean => error instanceof CryptoError && error.code === "wrong-passphrase-or-damaged-slot";

/**
 * Pulls the vault through the shared engines. Order: destination guard (no request without it), settings to validated
 * config, editor flush, target (the pull name, else the owned publication key: `key/list` only when needed), then the
 * decrypting pull (`pullEncryptedVault`: both locks, unlock, authentication, verdict, confirmations, verified writes,
 * state), notice text, `lastPull`. A root that lists a `manifest.json` and holds no key slots is refused as a plaintext publication
 * (`plaintext-unsupported`); nothing reads one. A root with neither is the ordinary `no-key-slots` stop. Read-only against the node. One sync operation at a time (the lock is shared with
 * publish); it is released in `finally`, and so is the file lock, by the engine.
 *
 * Keys: an unlocked session vault is used as it is; otherwise the engine is asked first without a passphrase, and only a
 * root that turns out to hold key slots causes the prompt (an unattended run refuses instead). A wrong passphrase is the
 * engine's own single outcome, raised before anything is written, and asks again.
 */
export function createPullRunner(deps: PullRunnerDeps): PullRunner {
  const now = deps.now ?? ((): Date => new Date());
  const transport = deps.transport ?? pullTransport();
  const lock = deps.lock ?? createSyncLock();
  const lockFile = deps.lockFile ?? createAdapterLockFile(deps.adapter);
  const lockContext = deps.lockContext ?? createPluginLockContext(() => now().getTime());
  const deviceStore = createPluginDeviceStore(deps.store);

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
    const where: Where = target.source === "explicit-root" ? { kind: "root", cid: target.rootCid } : { kind: "name", name: target.name };
    return { settings, host, config, client, where };
  }

  // ---- the decrypting pull ----------------------------------------------------------------------------------------

  function engineTarget(prepared: Prepared, mode: Mode): { readonly target: PullTarget; readonly flags: PullFlags } {
    const { where } = prepared;
    if (mode.kind === "restore") return { target: { kind: "manifest", cid: mode.historyCid, ...(where.kind === "name" ? { name: where.name } : {}) }, flags: { allowRollback: true } };
    const target: PullTarget = where.kind === "root" ? { kind: "root-cid", cid: where.cid } : { kind: "name", name: where.name };
    return { target, flags: mode.kind === "fork" ? { resolveFork: true } : {} };
  }

  interface Keys {
    readonly unlocked?: UnlockedVault;
    readonly passphrase?: CanonicalPassphrase;
  }

  function runEngine(prepared: Prepared, mode: Mode, keys: Keys, progress: PullProgress, unattended: boolean, onPrompt: () => void): Promise<EncryptedPullOutcome<PullStageResult>> {
    const { settings, host, config } = prepared;
    const client = progress.observe(prepared.client);
    const { dialogs } = deps;
    const { target, flags } = engineTarget(prepared, mode);
    const interactive = !unattended && dialogs !== undefined;
    const extraExclusions = exclusionsWithConfigDir(settings.userExclusions, deps.configDir);
    return pullEncryptedVault(
      {
        client,
        host,
        deviceStore,
        lockFile,
        lockContext,
        now: () => now().getTime(),
        assertDestination: assertVaultPullDestination,
        confirmFirstPull: interactive
          ? (details) => {
              onPrompt();
              return dialogs.confirmFirstPull(details);
            }
          : undefined,
        // Never on an unattended run: the catch-up pull has nobody to ask.
        confirmCost: unattended ? undefined : deps.confirmCost,
        onProgress: progress.onKdf,
        sources: createRangedBlobSources(client),
        confirmLargePull: interactive
          ? (details) => {
              onPrompt();
              return dialogs.confirmLargePull({ totalBytes: details.totalBytes, fileCount: details.fileCount, ceilingMb: settings.pullConfirmAboveMb });
            }
          : undefined,
        newId: deps.newId,
        bus: deps.bus,
      },
      {
        mfsRoot: config.mfsRoot,
        keyName: config.publicationKey,
        ownedKeys: config.ownedKeys,
        target,
        flags,
        ...keys,
        configDir: deps.configDir,
        extraExclusions,
        confirmAboveBytes: settings.pullConfirmAboveMb * MIB,
      },
    );
  }

  async function completedOutcome(outcome: Extract<EncryptedPullOutcome<PullStageResult>, { kind: "completed" }>): Promise<PullOutcome> {
    const report = reportOf(outcome.result);
    const roots = { rootCid: outcome.verified.target.rootCid, manifestCid: outcome.verified.manifest.rootCID };
    const problem = await saveSummary(deps.store, (current) => ({ ...current, lastPull: summaryOfReport(report, roots, now()) }));
    const notice = [encryptedPullNotice(report, warningsOf(outcome.result)), problem].filter((line) => line !== undefined).join("\n");
    return { kind: unfinishedCount(report) > 0 ? "unfinished" : "completed", notice, report };
  }

  function stoppedOutcome(stop: PullStop): PullOutcome {
    const { text, action } = stoppedPullNotice(stop);
    // Another process holds publish.lock: the same answer as a busy in-process lock, so a quiet run stays silent about it.
    if (stop.reason === "lock-held" || stop.reason === "lock-unreadable" || stop.reason === "busy") return refused("busy", text);
    // The name or root could not be turned into a root: a failure of the request, worded as one.
    if (stop.reason === "target-unresolved") return { kind: "failed", notice: pullFailedNotice(new Error(stop.message)) };
    return { kind: "stopped", reason: stop.reason, notice: text, action };
  }

  function outcomeOf(outcome: EncryptedPullOutcome<PullStageResult>): Promise<PullOutcome> | PullOutcome {
    return outcome.kind === "completed" ? completedOutcome(outcome) : stoppedOutcome(outcome.stop);
  }

  /**
   * One decrypting pull. `held` replaces the session's vault when the caller already unlocked one (Restore). A plain pull of a
   * root that lists a `manifest.json` and holds no key slots is refused as a plaintext publication, which no code path of this version reads.
   */
  async function decrypting(prepared: Prepared, mode: Mode, options: PullRunOptions, held?: UnlockedVault): Promise<PullOutcome> {
    const unattended = options.unattended === true;
    const port = deps.passphrase;
    let prompting = false;
    // The dialog is answered once. The pull going on to a confirmation or to fetching means the passphrase was accepted (ok); a
    // stop or a failure before that answers it as refused, with the reason, so the dialog does not close as if the unlock had worked.
    let verdict: PassphraseVerdict = { ok: true };
    const settle = (): void => {
      if (!prompting) return;
      prompting = false;
      port?.settle?.(verdict);
    };
    const progress = createPullProgress({ bus: deps.bus, show: (text) => options.onProgress?.(text), kdfFraction: port?.progress, onFetchStart: () => settle() });
    try {
      const outcome = await decryptingOutcome(prepared, mode, unattended, held, progress, {
        settle,
        prompt: () => {
          prompting = true;
        },
        cancelled: () => {
          prompting = false; // the user closed the dialog: nothing is left to settle
        },
      });
      verdict = verdictFor(outcome);
      return outcome;
    } catch (error) {
      verdict = { ok: false, reason: escapeForDisplay(error instanceof Error ? error.message : "unknown error") };
      throw error;
    } finally {
      progress.stop();
      settle();
    }
  }

  async function decryptingOutcome(
    prepared: Prepared,
    mode: Mode,
    unattended: boolean,
    held: UnlockedVault | undefined,
    progress: PullProgress,
    dialog: { readonly settle: () => void; readonly prompt: () => void; readonly cancelled: () => void },
  ): Promise<PullOutcome> {
    const port = deps.passphrase;
    const unlocked = held ?? deps.session?.provider();
    const first = await runEngine(prepared, mode, { unlocked }, progress, unattended, dialog.settle);
    if (isStop(first, "plaintext-root") && mode.kind === "pull") return refused("plaintext-unsupported", PLAINTEXT_UNSUPPORTED_NOTICE);
    if (!isStop(first, "locked")) return outcomeOf(first);
    if (unattended || port === undefined) return refused("locked", LOCKED_PULL_NOTICE);
    dialog.prompt();
    const prompted = await askUntilAccepted(port, async (passphrase): Promise<AttemptResult<EncryptedPullOutcome<PullStageResult>>> => {
      const next = await runEngine(prepared, mode, { unlocked, passphrase }, progress, unattended, dialog.settle);
      if (isStop(next, "wrong-passphrase")) return { kind: "wrong" };
      if (isStop(next, "passphrase-format")) return { kind: "wrong", failure: "format" };
      return { kind: "done", value: next };
    });
    if (prompted.kind === "cancelled") {
      dialog.cancelled();
      return refused("cancelled", PULL_PASSPHRASE_CANCELLED_NOTICE);
    }
    return outcomeOf(prompted.value);
  }

  async function pullFlow(options: PullRunOptions): Promise<PullOutcome> {
    const prepared = await prepare();
    if ("kind" in prepared) return prepared;
    options.onProgress?.(STARTING_PULL_TEXT);
    return decrypting(prepared, { kind: "pull" }, options);
  }

  // ---- Resolve fork -----------------------------------------------------------------------------------------------

  async function forkFlow(options: Pick<PullRunOptions, "onProgress">): Promise<PullOutcome> {
    const prepared = await prepare();
    if ("kind" in prepared) return prepared;
    if (prepared.where.kind !== "name") return refused("needs-name", RESTORE_NEEDS_NAME_NOTICE);
    options.onProgress?.(STARTING_PULL_TEXT);
    return decrypting(prepared, { kind: "fork" }, options);
  }

  // ---- Restore ----------------------------------------------------------------------------------------------------

  /** The vault for the listing: the session's, or one unlocked with a prompted passphrase (the engine re-uses it, so one derivation). */
  async function vaultForRestore(prepared: Prepared, rootCid: string): Promise<UnlockedVault | PullOutcome> {
    const { host, config, client } = prepared;
    const port = deps.passphrase;
    // Restore is a manual action only, so the confirmation is always offered.
    const base = { client, fs: host.fs, kv: host.kv, deviceStore, mfsRoot: config.mfsRoot, rootCid, unlocked: deps.session?.provider(), confirmCost: deps.confirmCost };
    try {
      return await unlockForRestore(base);
    } catch (error) {
      if (!(error instanceof VaultKeysError && error.code === "locked")) throw error;
    }
    if (port === undefined) return refused("locked", LOCKED_PULL_NOTICE);
    let verdict: PassphraseVerdict = { ok: true };
    try {
      const prompted = await askUntilAccepted(port, async (passphrase): Promise<AttemptResult<UnlockedVault>> => {
        try {
          return { kind: "done", value: await unlockForRestore({ ...base, passphrase, onProgress: (fraction) => void port.progress?.(fraction) }) };
        } catch (error) {
          if (isWrongPassphraseError(error)) return { kind: "wrong" };
          throw error;
        }
      });
      return prompted.kind === "cancelled" ? refused("cancelled", PULL_PASSPHRASE_CANCELLED_NOTICE) : prompted.value;
    } catch (error) {
      // A refused key-derivation cost, damaged key slots or a mismatching vault: the dialog says so instead of closing as unlocked.
      verdict = { ok: false, reason: escapeForDisplay(error instanceof Error ? error.message : "unknown error") };
      throw error;
    } finally {
      port.settle?.(verdict);
    }
  }

  async function recordedHighest(prepared: Prepared, vaultId: string): Promise<number | undefined> {
    const state = await readRootState(prepared.host.kv, prepared.config.mfsRoot);
    const floor = await readFloor(deviceStore, vaultId);
    const highest = Math.max(state?.vaultId === vaultId ? state.highestSequence : 0, floor?.sequence ?? 0);
    return highest === 0 ? undefined : highest;
  }

  async function restoreFlow(options: Pick<PullRunOptions, "onProgress">): Promise<PullOutcome> {
    const { dialogs } = deps;
    if (dialogs === undefined) return refused("cancelled", RESTORE_CANCELLED_NOTICE);
    const prepared = await prepare();
    if ("kind" in prepared) return prepared;
    if (prepared.where.kind !== "name") return refused("needs-name", RESTORE_NEEDS_NAME_NOTICE);
    const rootCid = await resolveRootCid(prepared.client, prepared.where.name);
    const vault = await vaultForRestore(prepared, rootCid);
    if ("kind" in vault) return vault;

    const files = await listHistoryFiles(prepared.client, rootCid);
    if (files.length === 0) return refused("restore-refused", RESTORE_NO_ENTRIES_NOTICE);
    const reader: RestoreReader = { client: prepared.client, keys: vault.keys, vaultId: vault.vaultId };
    const index = await dialogs.chooseRestoreEntry(await describeHistory(reader, files));
    const file = index === undefined ? undefined : files[index];
    if (file === undefined) return refused("cancelled", RESTORE_CANCELLED_NOTICE);

    // The name is a claim. The confirmation shows what the entry's own manifest says, and a disagreement ends here.
    const chosen = await loadChosenEntry(reader, file);
    if (chosen.kind === "mismatch") return refused("restore-refused", restoreMismatchNotice(chosen.listed, chosen.found));
    if (chosen.kind === "unreadable") return refused("restore-refused", RESTORE_UNREADABLE_NOTICE);
    const { manifest } = chosen;
    const confirmed = await dialogs.confirmRestore({
      authenticated: { sequence: manifest.sequence, publishedAt: manifest.publishedAt, device: manifest.device },
      highestSequence: await recordedHighest(prepared, vault.vaultId),
      labelMismatch: undefined,
    });
    if (!confirmed) return refused("cancelled", RESTORE_CANCELLED_NOTICE);

    options.onProgress?.(STARTING_PULL_TEXT);
    return decrypting(prepared, { kind: "restore", historyCid: file.parsed.cid }, options, vault);
  }

  // ---- the runner ---------------------------------------------------------------------------------------------------

  /** One sync operation at a time; the lock is held for the whole run and released in `finally`. */
  async function exclusive(task: () => Promise<PullOutcome>): Promise<PullOutcome> {
    const release = lock.tryAcquire("pull");
    if (release === undefined) return refused("busy", busyNotice(lock.holder()));
    try {
      return await task();
    } catch (error) {
      return outcomeFor(error);
    } finally {
      release();
    }
  }

  return {
    isRunning: () => lock.holder() !== undefined,
    run: (options = {}) => exclusive(() => pullFlow(options)),
    restore: (options = {}) => exclusive(() => restoreFlow(options)),
    resolveFork: async (options = {}) => {
      const { dialogs } = deps;
      if (dialogs === undefined) return refused("cancelled", FORK_CANCELLED_NOTICE);
      if (lock.holder() !== undefined) return refused("busy", busyNotice(lock.holder()));
      // The confirmation comes first, before the lock: a dialog left open must not hold the lock that publish and the timer wait on.
      if (!(await dialogs.confirmResolveFork({ sequence: undefined }))) return refused("cancelled", FORK_CANCELLED_NOTICE);
      return exclusive(() => forkFlow(options));
    },
    sweepTemp: async () => {
      const release = lock.tryAcquire("pull");
      if (release === undefined) return { ran: false, removed: 0 };
      try {
        return await sweepTempFiles({ fs: buildHost().fs, lockFile, lockContext });
      } finally {
        release();
      }
    },
    record: async () => {
      const state = await readRootState(buildHost().kv, settingsToConfig(deps.store.get(), now()).mfsRoot);
      return state === undefined ? undefined : { highestSequence: state.highestSequence, complete: state.complete, unfinished: state.unmaterialized.length, restoredFrom: state.restoredFrom };
    },
  };
}
