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
  GATEWAY_AUTH_NOTICE_ID,
  GATEWAY_AUTH_STATUS_ID,
  GATEWAY_SECRETS_NOTE_ID,
  liveRegion,
  type FieldContext,
} from "./settings-tab-controls";
import {
  AUTH_INCOMPLETE,
  AUTH_SCHEME_LABELS,
  FIXTURE_NOTICE_TITLE,
  GATEWAY_AUTH_INCOMPLETE,
  GATEWAY_AUTH_SAME_LABEL,
  SECRETS_REDIRECT_NOTE,
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
import { errorKeyOf, GATEWAY_AUTH_SAME, type EditableFieldId, type SettingsViewModel, type SettingsViewState } from "./settings-view-model";

const NODE_STATUS_ID = "ipfs-sync-node-status";
const NODE_WARNING_ID = "ipfs-sync-node-warning";
const NODE_LABEL = "Node";
const WARNING_PREFIX = "Warning";
const SECRETS_NOTE_ID = "ipfs-sync-secrets-warning";
const FIXTURE_NOTE_ID = "ipfs-sync-fixture-notice";
const REDIRECT_NOTE_ID = "ipfs-sync-redirect-note";

const RPC_CREDENTIAL_NOTICE_ID = "ipfs-sync-rpc-credential-notice";
const GATEWAY_CREDENTIAL_NOTICE_ID = "ipfs-sync-gateway-credential-notice";

/**
 * Edits that change what the node is asked about the publication key. Only the key name: it is asked of the node and credential
 * already saved. An address or credential edit never sends a request by itself; the key section says its answer is out of date
 * and "Check again" asks the node.
 */
const KEY_REFRESH_FIELDS: ReadonlySet<EditableFieldId> = new Set(["publicationKey"]);
const KEY_STALE_FIELDS: ReadonlySet<EditableFieldId> = new Set(["rpcUrl", "rpcPort", "authScheme", "authUser", "authPassword", "authToken", "authHeaderName", "authHeaderValue"]);

const SCHEME_OPTIONS: Readonly<Record<string, string>> = Object.fromEntries(AUTH_SCHEMES.map((scheme) => [scheme, AUTH_SCHEME_LABELS[scheme]]));

/** The gateway picker: the default first, then the same kinds as the node block. */
const GATEWAY_SCHEME_OPTIONS: Readonly<Record<string, string>> = { [GATEWAY_AUTH_SAME]: GATEWAY_AUTH_SAME_LABEL, ...SCHEME_OPTIONS };

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
  private redirectEl: HTMLElement | undefined;
  private nodeStatusEl: HTMLElement | undefined;
  private nodeWarningEl: HTMLElement | undefined;
  private schemeSelect: HTMLSelectElement | undefined;
  private gatewayFieldsEl: HTMLElement | undefined;
  private gatewayNoticeEl: HTMLElement | undefined;
  private gatewayStatusEl: HTMLElement | undefined;
  private rpcCredentialEl: HTMLElement | undefined;
  private gatewayCredentialEl: HTMLElement | undefined;
  private gatewaySelect: HTMLSelectElement | undefined;
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
    // Password inputs must not keep a typed secret in DOM that is no longer shown.
    this.containerEl.empty();
  }

  private renderEndpoints(root: HTMLElement): void {
    const section = addSection(root, "ipfs-sync-section-endpoints", SECTIONS.endpoints);
    this.nodeStatusEl = liveRegion(section, NODE_STATUS_ID);
    this.nodeWarningEl = liveRegion(section, NODE_WARNING_ID);
    for (const field of ["rpcUrl", "rpcPort"] as const) addTextField(section, field, this.ctx);
    this.rpcCredentialEl = liveRegion(section, RPC_CREDENTIAL_NOTICE_ID);
    for (const field of ["gatewayUrl", "gatewayPort"] as const) addTextField(section, field, this.ctx);
    this.gatewayCredentialEl = liveRegion(section, GATEWAY_CREDENTIAL_NOTICE_ID);
    this.renderGatewayAuth(section);
  }

  /**
   * The gateway's own credential, directly under the gateway URL and port: the plain-language origin line, the picker
   * (default "Same as node"), then only the fields of the picked kind, with the plain-text warning beside the secret ones.
   */
  private renderGatewayAuth(section: HTMLElement): void {
    this.gatewayNoticeEl = liveRegion(section, GATEWAY_AUTH_NOTICE_ID);
    this.gatewaySelect = addSelectField(section, "gatewayAuthScheme", GATEWAY_SCHEME_OPTIONS, this.ctx);
    this.gatewayFieldsEl = section.createDiv();
    this.slots.create("gatewayAuth", section);
    this.gatewayStatusEl = liveRegion(section, GATEWAY_AUTH_STATUS_ID);
    this.renderGatewayAuthFields();
  }

  private renderGatewayAuthFields(): void {
    const host = this.gatewayFieldsEl;
    if (host === undefined) return;
    this.slots.untrack("gatewayAuth");
    host.empty();
    const fields = this.vm.visibleGatewayAuthFields();
    // Every explicit kind but None has a secret: the warning sits beside the fields while they are shown.
    if (fields.length > 0) addNote(host, GATEWAY_SECRETS_NOTE_ID, SECRETS_WARNING_TITLE, SECRETS_WARNING);
    for (const field of fields) addTextField(host, field, this.ctx);
    if (this.gatewaySelect !== undefined) this.slots.track("gatewayAuth", this.gatewaySelect);
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
    this.redirectEl = section.createDiv();
    this.renderAuthFields();
  }

  /** The one redirect sentence: shown while the node or the gateway has a credential kind chosen, absent otherwise. */
  private showRedirectNote(state: SettingsViewState): void {
    const host = this.redirectEl;
    if (host === undefined) return;
    host.empty();
    const gatewayChosen = state.values.gatewayAuthScheme !== GATEWAY_AUTH_SAME && state.values.gatewayAuthScheme !== "none";
    if (state.values.authScheme === "none" && !gatewayChosen) return;
    host.createEl("p", { text: SECRETS_REDIRECT_NOTE, cls: "setting-item-description ipfs-sync-redirect-note", attr: { id: REDIRECT_NOTE_ID } });
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
      if (field === "gatewayAuthScheme") this.renderGatewayAuthFields();
      // An address edit that moved to another origin put the pickers back and blanked the unsaved credential fields: redraw them.
      if (this.schemeSelect !== undefined && this.schemeSelect.value !== result.state.values.authScheme) this.showClearedNode(result.state);
      if (this.gatewaySelect !== undefined && this.gatewaySelect.value !== result.state.values.gatewayAuthScheme) this.showClearedGateway(result.state);
      this.applyState(result.state);
      if (result.saved && KEY_REFRESH_FIELDS.has(field)) void this.keys.refresh();
      else if (result.saved && KEY_STALE_FIELDS.has(field)) this.keys.markStale();
    } catch (error) {
      // The store rejected the write (for example the disk is full): the setting was not saved.
      const reason = error instanceof Error ? error.message : "unknown error";
      this.slots.show(errorKeyOf(field), `The setting could not be saved: ${reason}`);
    }
  }

  /** The saved node credential was dropped with the old address: show the empty picker and fields. */
  private showClearedNode(state: SettingsViewState): void {
    if (this.schemeSelect !== undefined) this.schemeSelect.value = state.values.authScheme;
    this.renderAuthFields();
  }

  private showClearedGateway(state: SettingsViewState): void {
    if (this.gatewaySelect !== undefined) this.gatewaySelect.value = state.values.gatewayAuthScheme;
    this.renderGatewayAuthFields();
  }

  private applyState(state: SettingsViewState): void {
    this.rpcCredentialEl?.setText(state.rpcCredentialNotice);
    this.gatewayCredentialEl?.setText(state.gatewayCredentialNotice);
    this.slots.showAll(state.errors);
    this.showRedirectNote(state);
    this.pull.update(state);
    this.nodeStatusEl?.setText(`${NODE_LABEL}: ${state.node.summary}${state.node.explanation === "" ? "" : `. ${state.node.explanation}`}`);
    this.nodeWarningEl?.setText(state.node.retiredWarning === undefined ? "" : `${WARNING_PREFIX}: ${state.node.retiredWarning}`);
    this.gatewayNoticeEl?.setText(state.gatewayAuthNotice);
    const gatewayLines = state.gatewayWarnings.map((warning) => `${WARNING_PREFIX}: ${warning}`);
    if (state.gatewayAuthPending) gatewayLines.push(GATEWAY_AUTH_INCOMPLETE);
    this.gatewayStatusEl?.setText(gatewayLines.join(" "));
    const status = this.authStatusEl;
    if (status === undefined) return;
    const lines = state.warnings.map((warning) => `Warning: ${warning}`);
    if (state.authPending) lines.push(AUTH_INCOMPLETE);
    status.setText(lines.join(" "));
  }
}
