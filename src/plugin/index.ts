import { Notice, Plugin } from "obsidian";
import { createSyncEventBus, type SyncEventBus } from "../core/events";
import { createKuboClient } from "../kubo";
import { scheduleCatchUp } from "./catch-up";
import { flushOpenEditors } from "./editor-flush";
import { createPublishRunner, type PublishOutcome, type PublishProgress, type PublishRunner } from "./publish-runner";
import { createPullPresenter, type PullPresenter } from "./pull-presenter";
import { createPullRunner, type PullOutcome, type PullRunner } from "./pull-runner";
import { IpfsSyncSettingTab } from "./settings-tab";
import { requestUrlTransport } from "./request-url-transport";
import { openSettingsStore, type SettingsStore } from "./settings-store";
import { settingsToConfig } from "./settings-to-config";
import { createSettingsViewModel as buildSettingsViewModel, type SettingsViewModel } from "./settings-view-model";
import { collectStatus, formatStatus } from "./sync-status";
import { createSyncLock } from "./sync-lock";

const NOTICE_MS = 10_000;
const STATUS_NOTICE_MS = 20_000;
const MS_PER_MINUTE = 60_000;
const PUBLISHING = "IPFS Sync: publishing...";

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
  private declare statusEl: HTMLElement;
  private readonly bus: SyncEventBus = createSyncEventBus();
  private timer: number | undefined;
  /** Reasons already explained by an unattended (auto-publish) run, so it never repeats itself. */
  private readonly explained = new Set<string>();

  async onload(): Promise<void> {
    const { store, load } = await openSettingsStore(this);
    this.store = store;
    for (const message of load.notices) new Notice(message, NOTICE_MS);
    const adapter = this.app.vault.adapter;
    const lock = createSyncLock();
    this.runner = createPublishRunner({ store, adapter, bus: this.bus, lock });
    this.pullRunner = createPullRunner({ store, adapter, bus: this.bus, lock, flushEditors: () => flushOpenEditors(this.app.workspace, adapter) });
    this.statusEl = this.addStatusBarItem();
    this.presenter = createPullPresenter({
      createNotice: (text, durationMs) => new Notice(text, durationMs),
      setStatus: (text) => this.statusEl.setText(text),
      schedule: (callback, delayMs) => void setTimeout(callback, delayMs),
      now: () => new Date(),
    });

    this.addCommand({ id: "publish-vault", name: "Publish vault", callback: () => void this.publishVault() });
    this.addCommand({ id: "pull-vault", name: "Pull vault", callback: () => void this.pullVault() });
    this.addCommand({ id: "show-status", name: "Show status", callback: () => void this.showStatus() });
    this.addRibbonIcon("network", "IPFS Sync: publish vault", () => void this.publishVault());
    this.addRibbonIcon("download", "IPFS Sync: pull vault", () => void this.pullVault());
    this.addSettingTab(new IpfsSyncSettingTab(this.app, this, this.createSettingsViewModel()));
    this.rearmAutoPublish();
    scheduleCatchUp({
      enabled: store.get().catchUpOnLoad,
      onLayoutReady: (callback) => this.app.workspace.onLayoutReady(callback),
      pull: () => this.pullVault({ quiet: true }),
      onError: (error) => new Notice(`IPFS Sync: catch-up failed: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS),
    });
  }

  /** (Re)start the auto-publish timer from the stored interval; 0 turns it off. Call after the interval changes. */
  rearmAutoPublish(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    const minutes = this.store.get().publishIntervalMinutes;
    if (minutes <= 0) return;
    this.timer = window.setInterval(() => void this.publishVault({ quiet: true }), minutes * MS_PER_MINUTE);
    this.registerInterval(this.timer);
  }

  /** What the settings tab renders and drives. A saved change re-arms the auto-publish timer. */
  createSettingsViewModel(): SettingsViewModel {
    return buildSettingsViewModel({
      store: this.store,
      listNodeKeys: () => {
        const config = settingsToConfig(this.store.get(), new Date());
        return createKuboClient({ rpc: config.rpc, gateway: config.gateway, transport: requestUrlTransport }).keyList();
      },
      onSaved: () => this.rearmAutoPublish(),
    });
  }

  /** Publish through the shared engine. A quiet run (the timer) shows a given problem at most once per session. */
  async publishVault(options: { readonly quiet?: boolean } = {}): Promise<PublishOutcome> {
    const quiet = options.quiet === true;
    const alreadyRunning = this.runner.isRunning();
    const progress = quiet || alreadyRunning ? undefined : new Notice(PUBLISHING, 0);
    if (!alreadyRunning) this.statusEl.setText(PUBLISHING);
    try {
      const outcome = await this.runner.run({ onProgress: (update) => this.showProgress(progress, update) });
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
    if (this.pullRunner.isRunning()) {
      const busy = await this.pullRunner.run();
      if (!quiet) this.presenter.notify(busy.notice);
      return busy;
    }
    const reporter = this.presenter.begin({ quiet });
    const outcome = await this.pullRunner.run({ onProgress: reporter.onProgress });
    reporter.finish(outcome);
    return outcome;
  }

  async showStatus(): Promise<void> {
    try {
      const report = await collectStatus({ store: this.store, adapter: this.app.vault.adapter });
      new Notice(formatStatus(report), STATUS_NOTICE_MS);
    } catch (error) {
      new Notice(`IPFS Sync: cannot read the status: ${error instanceof Error ? error.message : "unknown error"}`, NOTICE_MS);
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
