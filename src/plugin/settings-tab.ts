import { PluginSettingTab, type App, type Plugin } from "obsidian";
import { PUBLISH_SCOPE_SETTINGS_COPY } from "../sync/publish-guard";
import { AUTH_SCHEMES } from "./settings-model";
import {
  addNote,
  addSection,
  addSelectField,
  addTextField,
  AUTH_STATUS_ID,
  ErrorSlots,
  liveRegion,
  type FieldContext,
} from "./settings-tab-controls";
import {
  AUTH_INCOMPLETE,
  AUTH_SCHEME_LABELS,
  FIXTURE_NOTICE_TITLE,
  SECRETS_WARNING,
  SECRETS_WARNING_TITLE,
  SECTIONS,
} from "./settings-tab-copy";
import { EncryptionSection } from "./encryption-settings";
import type { EncryptionStatusSource } from "./encryption-settings-model";
import { ExclusionsSection } from "./settings-tab-exclusions";
import { KeysSection } from "./settings-tab-keys";
import { StaleLockSection, type StaleLockSource } from "./settings-tab-lock";
import { PullSections } from "./settings-tab-pull";
import { errorKeyOf, type EditableFieldId, type SettingsViewModel, type SettingsViewState } from "./settings-view-model";

const SECRETS_NOTE_ID = "ipfs-sync-secrets-warning";
const FIXTURE_NOTE_ID = "ipfs-sync-fixture-notice";

/** Edits that change what the node is asked about the publication key. */
const KEY_STATE_FIELDS: ReadonlySet<EditableFieldId> = new Set(["rpcUrl", "rpcPort", "publicationKey", "authScheme", "authUser", "authPassword", "authToken", "authHeaderName", "authHeaderValue"]);

const SCHEME_OPTIONS: Readonly<Record<string, string>> = Object.fromEntries(AUTH_SCHEMES.map((scheme) => [scheme, AUTH_SCHEME_LABELS[scheme]]));

/**
 * The plugin's plain settings tab: a fixture-only notice, then Endpoints, Publication, Encryption (when a status source is given), Publish lock (when a lock source is given), Authentication,
 * Exclusions, Owned keys, Pull, Memory and Last activity, in that order (which is also the keyboard order). It renders the view model and
 * forwards input to it; validation, saving and key rules all live there.
 */
export class IpfsSyncSettingTab extends PluginSettingTab {
  private readonly slots = new ErrorSlots();
  private readonly exclusions: ExclusionsSection;
  private readonly keys: KeysSection;
  private readonly pull: PullSections;
  private readonly encryption: EncryptionSection | undefined;
  private readonly staleLock: StaleLockSection | undefined;
  private authFieldsEl: HTMLElement | undefined;
  private authStatusEl: HTMLElement | undefined;
  private schemeSelect: HTMLSelectElement | undefined;
  private readonly ctx: FieldContext;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly vm: SettingsViewModel,
    /** The vault's encryption state and its Lock action. When absent the Encryption section is not shown. */
    encryption?: EncryptionStatusSource,
    /** The publish lock's state and the Clear stale lock action. When absent the Publish lock section is not shown. */
    staleLock?: StaleLockSource,
  ) {
    super(app, plugin);
    this.exclusions = new ExclusionsSection(vm);
    this.keys = new KeysSection(app, vm);
    this.pull = new PullSections();
    this.encryption = encryption === undefined ? undefined : new EncryptionSection(encryption);
    this.staleLock = staleLock === undefined ? undefined : new StaleLockSection(staleLock);
    this.ctx = {
      value: (field) => this.vm.state().values[field],
      commit: (field, text) => void this.commit(field, text),
      slots: this.slots,
      secretNoteId: SECRETS_NOTE_ID,
    };
  }

  display(): void {
    this.vm.reset();
    this.slots.clear();
    const root = this.containerEl;
    root.empty();
    addNote(root, FIXTURE_NOTE_ID, FIXTURE_NOTICE_TITLE, PUBLISH_SCOPE_SETTINGS_COPY);
    this.renderEndpoints(root);
    this.renderPublication(root);
    this.encryption?.render(root);
    this.staleLock?.render(root);
    this.renderAuthentication(root);
    this.exclusions.render(root);
    this.keys.render(root);
    this.pull.render(root, this.ctx);
    this.applyState(this.vm.state());
  }

  hide(): void {
    this.encryption?.dispose();
    this.vm.reset();
  }

  private renderEndpoints(root: HTMLElement): void {
    const section = addSection(root, "ipfs-sync-section-endpoints", SECTIONS.endpoints);
    for (const field of ["rpcUrl", "rpcPort", "gatewayUrl", "gatewayPort"] as const) addTextField(section, field, this.ctx);
  }

  private renderPublication(root: HTMLElement): void {
    const section = addSection(root, "ipfs-sync-section-publication", SECTIONS.publication);
    for (const field of ["publicationKey", "mfsRoot", "publishIntervalMinutes"] as const) addTextField(section, field, this.ctx);
  }

  private renderAuthentication(root: HTMLElement): void {
    const section = addSection(root, "ipfs-sync-section-authentication", SECTIONS.authentication);
    addNote(section, SECRETS_NOTE_ID, SECRETS_WARNING_TITLE, SECRETS_WARNING);
    this.schemeSelect = addSelectField(section, "authScheme", SCHEME_OPTIONS, this.ctx);
    // The scheme picker stays put; only the fields below it are rebuilt, so focus is not lost on a switch.
    this.authFieldsEl = section.createDiv();
    this.slots.create("auth", section);
    this.authStatusEl = liveRegion(section, AUTH_STATUS_ID);
    this.renderAuthFields();
  }

  private renderAuthFields(): void {
    const host = this.authFieldsEl;
    if (host === undefined) return;
    this.slots.untrack("auth");
    host.empty();
    for (const field of this.vm.visibleAuthFields()) addTextField(host, field, this.ctx);
    if (this.schemeSelect !== undefined) this.slots.track("auth", this.schemeSelect);
  }

  private async commit(field: EditableFieldId, text: string): Promise<void> {
    try {
      const result = await this.vm.edit(field, text);
      if (field === "authScheme") this.renderAuthFields();
      this.applyState(result.state);
      if (result.saved && KEY_STATE_FIELDS.has(field)) void this.keys.refresh();
    } catch (error) {
      // The store rejected the write (for example the disk is full): the setting was not saved.
      const reason = error instanceof Error ? error.message : "unknown error";
      this.slots.show(errorKeyOf(field), `The setting could not be saved: ${reason}`);
    }
  }

  private applyState(state: SettingsViewState): void {
    this.slots.showAll(state.errors);
    this.pull.update(state);
    const status = this.authStatusEl;
    if (status === undefined) return;
    const lines = state.warnings.map((warning) => `Warning: ${warning}`);
    if (state.authPending) lines.push(AUTH_INCOMPLETE);
    status.setText(lines.join(" "));
  }
}
