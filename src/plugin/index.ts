import { Notice, Platform, Plugin } from "obsidian";
import { createSyncEventBus, type SyncEventBus } from "../core/events";
import { createKuboClient } from "../kubo";
import { createAdapterLockFile } from "./adapter-lock-file";
import { createAbandonFlow, type AbandonFlow } from "./abandon-flow";
import { AbandonVaultDialog, type AbandonOutcome } from "./abandon-vault-dialog";
import { ClearStaleLockDialog } from "./clear-stale-lock-dialog";
import { ABANDON_COPY } from "./encryption-copy";
import { scheduleCatchUp } from "./catch-up";
import { flushOpenEditors } from "./editor-flush";
import { obsidianCostConfirmation } from "./cost-confirm-dialog";
import { createKeyActions, type KeyActions, type KeyActionStart } from "./key-actions";
import { obsidianKeyDialogs } from "./key-dialogs";
import { askMassRemoval } from "./mass-removal-dialog";
import { measureDerivation } from "./measure-derivation";
import { MEASURE_START_NOTICE, measurementNoticeText, type MeasurementRecord } from "./measure-notice";
import { readPluginSeams } from "./plugin-seams";
import { createPublishRunner, type PublishOutcome, type PublishProgress, type PublishRunner } from "./publish-runner";
import { obsidianPullDialogs } from "./pull-dialogs";
import { createPullPresenter, type PullPresenter } from "./pull-presenter";
import { createPullRunner, type PullOutcome, type PullRunner } from "./pull-runner";
import { createSessionDialogs, describeDialogError, obsidianDialogFactories, type SessionDialogs } from "./session-dialogs";
import { createSessionKeys, type SessionKeys } from "./session-keys";
import { observed } from "./session-status";
import { IpfsSyncSettingTab } from "./settings-tab";
import { requestUrlTransport } from "./request-url-transport";
import { createStaleLockControl } from "./stale-lock";
import { createStaleLockFlow, type StaleLockFlow } from "./stale-lock-flow";
import { MAX_PUBLISH_INTERVAL_MINUTES } from "./settings-model";
import { createUnreadableBackup, type UnreadableBackup } from "./unreadable-backup";
import { openSettingsStore, type SettingsStore } from "./settings-store";
import { retiredDefaultNotice } from "./node-status";
import { settingsToConfig } from "./settings-to-config";
import { createSettingsViewModel as buildSettingsViewModel, type SettingsViewModel } from "./settings-view-model";
import { collectStatus, formatStatus } from "./sync-status";
import { busyNotice, createSyncLock, type SyncLock } from "./sync-lock";
import { createVaultOpener, createVaultProbe } from "./vault-opener";

const NOTICE_MS = 10_000;
const STATUS_NOTICE_MS = 20_000;
const MS_PER_MINUTE = 60_000;
const PUBLISHING = "IPFS Sync: publishing...";
const ALREADY_MEASURING_NOTICE = "IPFS Sync: a key derivation measurement is already running. Keep the app open until it finishes.";
const NO_VAULT_NOTICE = "IPFS Sync: this device holds no key-slot copy for the configured MFS root, so there is nothing to change here.";

/** The device platform for the measurement record. */
function platformLabel(): string {
  if (Platform.isIosApp) return "ios";
  if (Platform.isAndroidApp) return "android";
  return Platform.isMobile ? "mobile" : "desktop";
}

/**
 * The Obsidian plugin: settings, commands, ribbons, status bar, the auto-publish timer and the on-load catch-up
 * around the shared publish and pull engines. It holds no sync logic of its own. Publish and pull share one
 * lock, so only one runs at a time.
 */
export default class IpfsSyncPlugin extends Plugin {
  private declare store: SettingsStore;
  private declare runner: PublishRunner;
  private declare pullRunner: PullRunner;
  private declare presenter: PullPresenter;
  private declare session: SessionKeys;
  private declare dialogs: SessionDialogs;
  private declare abandonFlow: AbandonFlow;
  private declare staleLockFlow: StaleLockFlow;
  private declare keyActions: KeyActions;
  private declare syncLock: SyncLock;
  private declare statusEl: HTMLElement;
  private measuring = false;
  private readonly bus: SyncEventBus = createSyncEventBus();
  private timer: number | undefined;
  /** The MFS root the session's keys belong to; a settings change to another root drops them. */
  private sessionRoot = "";
  /** Reasons already explained by an unattended (auto-publish) run, so it never repeats itself. */
  private readonly explained = new Set<string>();
  async onload(): Promise<void> {
    const { store, load } = await openSettingsStore(this, this.unreadableBackup());
    this.store = store;
    for (const message of load.notices) new Notice(message, NOTICE_MS);
    await this.warnAboutRetiredDefault();
    const adapter = this.app.vault.adapter;
    const lock = createSyncLock();
    this.syncLock = lock;
    const now = (): Date => new Date();
    // One cost-confirm dialog for every manual path: unlock, publish, pull, Restore, and the key actions. The timer and the catch-up pull are handed
    // none of it (publish-runner and pull-runner drop it on an unattended run), so a slot above the default cost keeps refusing there.
    const costConfirmation = obsidianCostConfirmation(this.app);
    this.dialogs = createSessionDialogs(obsidianDialogFactories(this.app));
    const observer = observed(
      this.dialogs.settling(
        createSessionKeys({
          dialogs: this.dialogs.callbacks,
          open: createVaultOpener({ store, adapter, transport: requestUrlTransport, now, costPolicy: costConfirmation.policy }),
          vaultExists: createVaultProbe({ store, adapter, now }),
        }),
      ),
    );
    this.session = observer.session;
    this.sessionRoot = store.get().mfsRoot;
    await this.refreshSession();
    this.abandonFlow = createAbandonFlow({
      store,
      adapter,
      lock,
      session: this.session,
      now,
      openDialog: (request, onFinish) => {
        const dialog = new AbandonVaultDialog(this.app, request, onFinish);
        dialog.open();
        return dialog;
      },
    });
    this.staleLockFlow = createStaleLockFlow({
      control: createStaleLockControl({ lockFile: createAdapterLockFile(adapter), now: () => now().getTime(), syncLock: lock }),
      openDialog: (request, onFinish) => {
        const dialog = new ClearStaleLockDialog(this.app, request, onFinish);
        dialog.open();
        return dialog;
      },
    });
    this.keyActions = createKeyActions({
      store,
      adapter,
      lock,
      transport: requestUrlTransport,
      now,
      dialogs: obsidianKeyDialogs(this.app),
      // A slot above the default cost is unlocked or accepted only after an explicit yes in the cost-confirm dialog.
      costConfirmation,
      // The held keys were opened from the old key-slot file: drop them and look again, as a changed MFS root does.
      afterChange: () => {
        this.session.lock();
        void this.refreshSession();
      },
    });
    this.runner = createPublishRunner({
      store,
      adapter,
      configDir: this.app.vault.configDir,
      bus: this.bus,
      lock,
      session: this.session,
      // A manual publish that the guard stops opens the mass-removal dialog; the timer never reaches this port.
      askMassRemoval: (counts) => askMassRemoval(this.app, counts),
      costPolicy: costConfirmation.policy,
    });
    this.pullRunner = createPullRunner({
      store,
      adapter,
      configDir: this.app.vault.configDir,
      vaultName: this.app.vault.getName(),
      bus: this.bus,
      lock,
      flushEditors: () => flushOpenEditors(this.app.workspace, adapter),
      session: this.session,
      // The pull asks for its passphrase through the same unlock dialog as publish, and ends the sequence with the final verdict.
      passphrase: {
        ask: (request) => this.dialogs.callbacks.unlock(request),
        progress: (fraction) => this.dialogs.callbacks.unlocking?.({ kind: "progress", fraction }),
        settle: (verdict) => this.dialogs.settleUnlock(verdict),
      },
      dialogs: obsidianPullDialogs(this.app),
      confirmCost: costConfirmation.confirm,
    });
    this.statusEl = this.addStatusBarItem();
    this.presenter = createPullPresenter({
      createNotice: (text, durationMs) => new Notice(text, durationMs),
      setStatus: (text) => this.statusEl.setText(text),
      schedule: (callback, delayMs) => void setTimeout(callback, delayMs),
      now: () => new Date(),
      offerAction: (text, label, run) => this.offerAction(text, label, run),
    });

    this.addCommand({ id: "publish-vault", name: "Publish vault", callback: () => void this.publishVault() });
    this.addCommand({ id: "pull-vault", name: "Pull vault", callback: () => void this.pullVault() });
    this.addCommand({ id: "restore-version", name: "Restore an older version", callback: () => void this.restoreVersion() });
    this.addCommand({ id: "resolve-fork", name: "Resolve fork", callback: () => void this.resolveFork() });
    this.addCommand({ id: "show-status", name: "Show status", callback: () => void this.showStatus() });
    this.addCommand({ id: "abandon-vault", name: "Abandon this vault", callback: () => void this.abandonVault() });
    this.addCommand({ id: "clear-stale-lock", name: "Clear stale publish lock", callback: () => void this.clearStaleLock() });
    this.addCommand({ id: "measure-key-derivation", name: "Measure key derivation time", callback: () => void this.measureKeyDerivation() });
    this.addRibbonIcon("network", "IPFS Sync: publish vault", () => void this.publishVault());
    this.addRibbonIcon("download", "IPFS Sync: pull vault", () => void this.pullVault());
    const encryption = {
      ...observer.status({
        openSetup: () => void this.showDialogOutcome(() => this.session.setup()),
        openUnlock: () => void this.showDialogOutcome(() => this.session.unlock()),
        openAbandon: () => void this.abandonVault(),
      }),
      pullRecord: () => this.pullRunner.record(),
      slotCost: () => this.keyActions.slotCost(),
      openChangePassphrase: () => void this.showKeyAction(() => this.keyActions.changePassphrase()),
      openIncreaseCost: () => void this.showKeyAction(() => this.keyActions.increaseCost()),
      openAcceptSlots: () => void this.showKeyAction(() => this.keyActions.acceptSlots()),
      // Prune history is started by a person from this row only: the timer and the catch-up pull never reach it.
      openPruneHistory: () => void this.showKeyAction(() => this.keyActions.pruneHistory()),
    };
    const staleLock = { inspect: () => this.staleLockFlow.inspect(), open: async () => void (await this.clearStaleLock()) };
    this.addSettingTab(new IpfsSyncSettingTab(this.app, this, this.createSettingsViewModel(), encryption, staleLock));
    this.rearmAutoPublish();
    scheduleCatchUp({
      enabled: store.get().catchUpOnLoad,
      onLayoutReady: (callback) => this.app.workspace.onLayoutReady(callback),
      pull: () => this.pullVault({ quiet: true }),
      onError: (error) => new Notice(`IPFS Sync: catch-up failed: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS),
    });
    // Temp files of a pull that crashed. After the layout is ready, never inside onload: plugin loading does no storage work.
    this.app.workspace.onLayoutReady(() => {
      this.pullRunner.sweepTemp().catch((error: unknown) => {
        new Notice(`IPFS Sync: could not clean up temporary files: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS);
      });
    });
  }

  /**
   * A saved 0.2.0 setting equal to the retired default host is an explicit value and stays. Once, tell the operator that node is the
   * maintainer's own and open to anyone. If recording "shown" fails the notice simply comes back at the next load.
   */
  private async warnAboutRetiredDefault(): Promise<void> {
    const text = retiredDefaultNotice(this.store.get());
    if (text === undefined) return;
    new Notice(text, NOTICE_MS);
    await this.store.update((settings) => ({ ...settings, retiredDefaultNoticeShown: true })).catch(() => undefined);
  }

  /** Lock the session and close its dialogs when the plugin unloads: no key outlives the plugin. */
  onunload(): void {
    this.abandonFlow.dispose();
    this.staleLockFlow.dispose();
    this.keyActions.dispose();
    this.session.dispose();
    this.dialogs.dispose();
  }

  /**
   * The copy made before the first save replaces an unreadable `data.json` with defaults. It says, once, where the copy is and that it is
   * plain text with the same secrets as the original.
   */
  private unreadableBackup(): UnreadableBackup {
    const folder = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const copy = createUnreadableBackup({ adapter: this.app.vault.adapter, dataPath: `${folder}/data.json`, now: () => new Date() });
    return {
      save: async (fallbackText) => {
        const path = await copy.save(fallbackText);
        new Notice(
          `IPFS Sync: your unreadable settings file was copied to ${path} before it was replaced with defaults. The copy is plain text and holds the same secrets as the original; delete it when you no longer need it.`,
          NOTICE_MS,
        );
        return path;
      },
    };
  }

  /** (Re)start the auto-publish timer from the stored interval; 0 turns it off. Call after the interval changes. */
  rearmAutoPublish(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    const stored = this.store.get().publishIntervalMinutes;
    // Zero, a negative or a value that is not a number turns the timer off (NaN would fire in a tight loop).
    if (!Number.isFinite(stored) || stored <= 0) return;
    // Whole minutes, at least one (a fraction would otherwise be a near-zero delay), and held at the cap: a longer delay overflows the timer.
    const minutes = Math.min(Math.max(1, Math.floor(stored)), MAX_PUBLISH_INTERVAL_MINUTES);
    this.timer = window.setInterval(() => void this.publishVault({ quiet: true }), minutes * MS_PER_MINUTE);
    this.registerInterval(this.timer);
  }

  /** What the settings tab renders and drives. A saved change re-arms the auto-publish timer. */
  createSettingsViewModel(): SettingsViewModel {
    return buildSettingsViewModel({
      store: this.store,
      configDir: this.app.vault.configDir,
      listNodeKeys: () => {
        const config = settingsToConfig(this.store.get(), new Date());
        return createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport: requestUrlTransport }).keyList();
      },
      onSaved: () => {
        this.rearmAutoPublish();
        void this.followMfsRoot();
      },
    });
  }

  /** Publish through the shared engine. A quiet run (the timer) shows a given problem at most once per session. */
  async publishVault(options: { readonly quiet?: boolean } = {}): Promise<PublishOutcome> {
    const quiet = options.quiet === true;
    const alreadyRunning = this.runner.isRunning();
    const progress = quiet || alreadyRunning ? undefined : new Notice(PUBLISHING, 0);
    if (!alreadyRunning) this.statusEl.setText(PUBLISHING);
    try {
      const outcome = await this.runner.run({ unattended: quiet, onProgress: (update) => this.showProgress(progress, update) });
      this.report(outcome, quiet);
      return outcome;
    } finally {
      progress?.hide();
      if (!alreadyRunning) this.statusEl.setText("");
    }
  }

  /**
   * Pull through the shared engine. A normal run shows one notice, updated in place, and a status-bar summary.
   * A quiet run (catch-up on load) shows a notice only when it changed files, made a conflict copy, was refused
   * or failed. A request made while another operation runs shows a notice and starts nothing.
   */
  async pullVault(options: { readonly quiet?: boolean } = {}): Promise<PullOutcome> {
    const quiet = options.quiet === true;
    return this.showPullAction((onProgress) => this.pullRunner.run({ onProgress, unattended: quiet }), quiet);
  }

  /** Restore: choose an older version, see what it holds as its own manifest says, confirm, then pull it. Never runs unattended. */
  async restoreVersion(): Promise<PullOutcome> {
    return this.showPullAction((onProgress) => this.pullRunner.restore({ onProgress }), false);
  }

  /** Resolve fork: after a confirmation, the node's version wins where the two differ and this device's text is kept as conflict copies. */
  async resolveFork(): Promise<PullOutcome> {
    return this.showPullAction((onProgress) => this.pullRunner.resolveFork({ onProgress }), false);
  }

  /**
   * One pull action with its notice and status. A request made while another operation runs shows a notice and starts nothing
   * (the runner answers busy before it opens a dialog).
   */
  private async showPullAction(start: (onProgress: (text: string) => void) => Promise<PullOutcome>, quiet: boolean): Promise<PullOutcome> {
    if (this.pullRunner.isRunning()) {
      const busy = await start(() => undefined);
      if (!quiet) this.presenter.notify(busy.notice);
      return busy;
    }
    const reporter = this.presenter.begin({ quiet, resolveFork: () => void this.resolveFork() });
    const outcome = await start(reporter.onProgress);
    reporter.finish(outcome);
    return outcome;
  }

  /** A notice with one button, kept for the status-notice time. */
  private offerAction(text: string, label: string, run: () => void): void {
    const notice = new Notice(
      createFragment((fragment) => {
        fragment.createEl("span", { text: `${text} ` });
        const button = fragment.createEl("button", { text: label });
        button.addEventListener("click", () => {
          notice.hide();
          run();
        });
      }),
      STATUS_NOTICE_MS,
    );
  }

  /**
   * Open the abandon-vault confirmation. The word is typed in the dialog; on success the local key-slot copy, state and
   * journal for the configured MFS root are moved into a backup folder and the node is not contacted. A request made
   * while publish or pull runs shows a notice and opens nothing.
   */
  async abandonVault(): Promise<AbandonOutcome | "busy"> {
    const outcome = await this.abandonFlow.open();
    if (outcome === "busy") new Notice(busyNotice(undefined), NOTICE_MS);
    else if (outcome.abandoned) new Notice(`IPFS Sync: vault abandoned. ${outcome.backupNote ?? ""}`.trim(), NOTICE_MS);
    // The dialog was closed while the action ran and the action failed: the device may be in a partial state, so say so.
    else if (outcome.failure !== undefined) new Notice(`IPFS Sync: ${ABANDON_COPY.failed}: ${outcome.failure}. Check the settings before trying again.`, NOTICE_MS);
    return outcome;
  }

  /**
   * Open the confirmation for clearing a stale publish lock. Offered only when the lock's last heartbeat is older than
   * 15 minutes; otherwise a notice says why nothing happened. Resolves with the notice text shown, if any.
   */
  async clearStaleLock(): Promise<string> {
    try {
      const { notice } = await this.staleLockFlow.open();
      if (notice !== "") new Notice(notice, NOTICE_MS);
      return notice;
    } catch (error) {
      const notice = `IPFS Sync: cannot check the publish lock: ${error instanceof Error ? error.message : "unknown error"}`;
      new Notice(notice, NOTICE_MS);
      return notice;
    }
  }

  /**
   * "Measure key derivation time": one Argon2id derivation at the default cost on random input, in the foreground. It reads no vault file, asks for no
   * passphrase and sends nothing; the only file it reads is the installed `main.js`, for the build hash. The result stays on screen until dismissed.
   */
  async measureKeyDerivation(): Promise<MeasurementRecord | undefined> {
    if (this.measuring) {
      new Notice(ALREADY_MEASURING_NOTICE, NOTICE_MS);
      return undefined;
    }
    this.measuring = true;
    new Notice(MEASURE_START_NOTICE, NOTICE_MS);
    try {
      const derive = readPluginSeams(this).measureDerive;
      const record = await measureDerivation({
        readBuild: () => this.app.vault.adapter.readBinary(this.installedBuildPath()),
        platform: platformLabel(),
        ...(derive === undefined ? {} : { derive }),
      });
      new Notice(measurementNoticeText(record), 0);
      return record;
    } finally {
      this.measuring = false;
    }
  }

  /** The installed plugin file, where Obsidian put this plugin. */
  private installedBuildPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/main.js`;
  }

  /** Open a key-management dialog. A dialog shows its own failures; this says why none opened, and reports an error thrown before one could. */
  private async showKeyAction(open: () => Promise<KeyActionStart>): Promise<void> {
    try {
      const start = await open();
      if (start === "busy") new Notice(busyNotice(this.syncLock.holder()), NOTICE_MS);
      else if (start === "no-vault") new Notice(NO_VAULT_NOTICE, NOTICE_MS);
    } catch (error) {
      new Notice(`IPFS Sync: ${describeDialogError(error)}`, NOTICE_MS);
    }
  }

  async showStatus(): Promise<void> {
    try {
      const report = await collectStatus({ store: this.store, adapter: this.app.vault.adapter });
      new Notice(formatStatus(report), STATUS_NOTICE_MS);
    } catch (error) {
      new Notice(`IPFS Sync: cannot read the status: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS);
    }
  }

  /** Whether this device has a vault, read from the local key-slot copy (no request). */
  private async refreshSession(): Promise<void> {
    try {
      await this.session.refresh();
    } catch (error) {
      new Notice(`IPFS Sync: cannot check for an encrypted vault: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS);
    }
  }

  /** Keys unlocked for one MFS root are not valid for another: a changed root locks the session and looks again. */
  private async followMfsRoot(): Promise<void> {
    const root = this.store.get().mfsRoot;
    if (root === this.sessionRoot) return;
    this.sessionRoot = root;
    this.session.lock();
    await this.refreshSession();
  }

  /** A dialog shows its own failure; this adds a notice for the case where the dialog is already gone. */
  private async showDialogOutcome(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      new Notice(`IPFS Sync: ${describeDialogError(error)}`, NOTICE_MS);
    }
  }

  private showProgress(notice: Notice | undefined, update: PublishProgress): void {
    const text = update.done ? PUBLISHING : `IPFS Sync: publishing... ${update.changed} changed`;
    notice?.setMessage(text);
    this.statusEl.setText(text);
  }

  private report(outcome: PublishOutcome, quiet: boolean): void {
    if (!quiet) {
      new Notice(outcome.notice, NOTICE_MS);
      return;
    }
    if (outcome.kind !== "refused" && outcome.kind !== "failed") return;
    const reason = outcome.kind === "refused" ? outcome.reason : outcome.notice;
    if (outcome.kind === "refused" && outcome.reason === "busy") return;
    if (this.explained.has(reason)) return;
    this.explained.add(reason);
    new Notice(outcome.notice, NOTICE_MS);
  }
}
