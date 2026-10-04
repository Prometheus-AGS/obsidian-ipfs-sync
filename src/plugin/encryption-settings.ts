import { Setting } from "obsidian";
import { ENCRYPTION_COPY as COPY, ENCRYPTION_SECTION } from "./encryption-copy";
import { describeEncryption, describeKeyActions, describePullRecord, describeSlotCost, type EncryptionStatusSource, type KeyActionId } from "./encryption-settings-model";
import { addSection } from "./settings-tab-controls";

const LOCK_DESC = "ipfs-sync-desc-encryption-lock";
const ABANDON_DESC = "ipfs-sync-desc-encryption-abandon";
const KEY_ACTION_DESC = (id: KeyActionId): string => `ipfs-sync-desc-encryption-${id}`;

/**
 * The Encryption section: the vault's state as a word (not set up, locked or unlocked), what that means, and a
 * Lock button that is enabled only while unlocked. The rows are built once and updated in place, so the state
 * text stays one polite live region and a screen reader hears a change.
 */
export class EncryptionSection {
  private unsubscribe: (() => void) | undefined;
  private statusEl: HTMLElement | undefined;
  private actionHost: HTMLElement | undefined;
  private actionButton: HTMLButtonElement | undefined;
  private lockDescEl: HTMLElement | undefined;
  private lockButton: HTMLButtonElement | undefined;
  private recordEl: HTMLElement | undefined;
  private costRow: HTMLElement | undefined;
  private costEl: HTMLElement | undefined;
  private keyRows = new Map<KeyActionId, HTMLElement>();

  constructor(private readonly source: EncryptionStatusSource) {}

  render(parent: HTMLElement): void {
    const section = addSection(parent, "ipfs-sync-section-encryption", ENCRYPTION_SECTION);
    const state = new Setting(section).setName(COPY.stateName);
    state.descEl.setAttr("aria-live", "polite");
    this.statusEl = state.descEl;
    this.actionHost = state.controlEl;
    this.recordEl = undefined;
    if (this.source.pullRecord !== undefined) {
      const record = new Setting(section).setName(COPY.recordName);
      record.descEl.setAttr("aria-live", "polite");
      this.recordEl = record.descEl;
    }
    this.renderCost(section);
    const lock = new Setting(section).setName(COPY.lockName);
    lock.descEl.id = LOCK_DESC;
    this.lockDescEl = lock.descEl;
    lock.addButton((button) => {
      button.setButtonText(COPY.lockButton);
      button.buttonEl.setAttr("aria-describedby", LOCK_DESC);
      button.onClick(() => this.lock());
      this.lockButton = button.buttonEl;
    });
    this.renderKeyActions(section);
    this.renderAbandon(section);
    this.update();
    this.unsubscribe?.();
    this.unsubscribe = this.source.subscribe?.(() => this.update());
  }

  /** The cost of this device's key slot, as a sentence in a polite live region. Present only when the source can read it. */
  private renderCost(section: HTMLElement): void {
    this.costRow = undefined;
    this.costEl = undefined;
    if (this.source.slotCost === undefined) return;
    const cost = new Setting(section).setName(COPY.slotCostName);
    cost.descEl.setAttr("aria-live", "polite");
    this.costRow = cost.settingEl;
    this.costEl = cost.descEl;
  }

  /**
   * Change passphrase, Increase cost and Accept key slots: one row each, with the sentence that says what it does (and what it does not undo)
   * as the button's description. Rows exist for the actions the source can open and are hidden until a vault exists; the dialogs, not these
   * buttons, ask for the passphrase.
   */
  private renderKeyActions(section: HTMLElement): void {
    this.keyRows = new Map();
    const open: Readonly<Record<KeyActionId, (() => void) | undefined>> = {
      "change-passphrase": this.source.openChangePassphrase?.bind(this.source),
      "increase-cost": this.source.openIncreaseCost?.bind(this.source),
      "accept-slots": this.source.openAcceptSlots?.bind(this.source),
      "prune-history": this.source.openPruneHistory?.bind(this.source),
    };
    for (const action of describeKeyActions("locked", this.source)) {
      const opener = open[action.id];
      if (opener === undefined) continue;
      const row = new Setting(section).setName(action.name).setDesc(action.desc);
      row.descEl.id = KEY_ACTION_DESC(action.id);
      row.addButton((button) => {
        button.setButtonText(action.button);
        button.buttonEl.setAttr("aria-describedby", KEY_ACTION_DESC(action.id));
        button.onClick(() => opener());
      });
      this.keyRows.set(action.id, row.settingEl);
    }
  }

  /** The Abandon row, present only when the source can open the confirmation. The dialog, not this button, asks for the typed word. */
  private renderAbandon(section: HTMLElement): void {
    const open = this.source.openAbandon?.bind(this.source);
    if (open === undefined) return;
    const row = new Setting(section).setName(COPY.abandonName).setDesc(COPY.abandonDesc);
    row.descEl.id = ABANDON_DESC;
    row.addButton((button) => {
      button.setButtonText(COPY.abandonButton);
      button.buttonEl.setAttr("aria-describedby", ABANDON_DESC);
      button.onClick(() => open());
    });
  }

  /** Stop listening for state changes. Called when the tab is hidden. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private lock(): void {
    this.source.lock();
    this.update();
    // The Lock button is disabled now and cannot keep focus; move it to the next useful control, if any.
    this.actionButton?.focus();
  }

  private update(): void {
    const view = describeEncryption(this.source.state(), this.source);
    if (this.statusEl !== undefined) {
      this.statusEl.empty();
      this.statusEl.createEl("strong", { text: view.label });
      this.statusEl.createSpan({ text: ` ${view.description}` });
    }
    this.drawAction(view.action);
    this.lockDescEl?.setText(view.lockDescription);
    if (this.lockButton !== undefined) this.lockButton.disabled = !view.canLock;
    const visible = new Set(describeKeyActions(view.state, this.source).map((action) => action.id));
    for (const [id, row] of this.keyRows) row.setCssProps({ display: visible.has(id) ? "" : "none" });
    this.costRow?.setCssProps({ display: view.state === "not-set-up" ? "none" : "" });
    void this.refreshRecord();
    void this.refreshCost(view.state !== "not-set-up");
  }

  /** Read the slot cost and show it as a sentence. Not read at all before a vault exists. An unreadable record is said in words. */
  private async refreshCost(vaultExists: boolean): Promise<void> {
    const read = this.source.slotCost?.bind(this.source);
    const target = this.costEl;
    if (read === undefined || target === undefined || !vaultExists) return;
    try {
      target.setText(describeSlotCost(await read()));
    } catch {
      target.setText(COPY.slotCostRecordUnreadable);
    }
  }

  /** Read the pull record and show it as sentences. An unreadable state file is said in words, not hidden. */
  private async refreshRecord(): Promise<void> {
    const read = this.source.pullRecord?.bind(this.source);
    const target = this.recordEl;
    if (read === undefined || target === undefined) return;
    try {
      target.setText(describePullRecord(await read()).text);
    } catch {
      target.setText(COPY.recordUnreadable);
    }
  }

  private drawAction(action: "setup" | "unlock" | undefined): void {
    this.actionHost?.empty();
    this.actionButton = undefined;
    if (action === undefined || this.actionHost === undefined) return;
    const setup = action === "setup";
    const button = this.actionHost.createEl("button", { text: setup ? COPY.setUpButton : COPY.unlockButton });
    button.addEventListener("click", () => (setup ? this.source.openSetup?.() : this.source.openUnlock?.()));
    this.actionButton = button;
  }
}
