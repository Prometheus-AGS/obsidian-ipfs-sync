import { Setting } from "obsidian";
import { ENCRYPTION_COPY as COPY, ENCRYPTION_SECTION } from "./encryption-copy";
import { describeEncryption, type EncryptionStatusSource } from "./encryption-settings-model";
import { addSection } from "./settings-tab-controls";

const LOCK_DESC = "ipfs-sync-desc-encryption-lock";
const ABANDON_DESC = "ipfs-sync-desc-encryption-abandon";

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

  constructor(private readonly source: EncryptionStatusSource) {}

  render(parent: HTMLElement): void {
    const section = addSection(parent, "ipfs-sync-section-encryption", ENCRYPTION_SECTION);
    const state = new Setting(section).setName(COPY.stateName);
    state.descEl.setAttr("aria-live", "polite");
    this.statusEl = state.descEl;
    this.actionHost = state.controlEl;
    const lock = new Setting(section).setName(COPY.lockName);
    lock.descEl.id = LOCK_DESC;
    this.lockDescEl = lock.descEl;
    lock.addButton((button) => {
      button.setButtonText(COPY.lockButton);
      button.buttonEl.setAttr("aria-describedby", LOCK_DESC);
      button.onClick(() => this.lock());
      this.lockButton = button.buttonEl;
    });
    this.renderAbandon(section);
    this.update();
    this.unsubscribe?.();
    this.unsubscribe = this.source.subscribe?.(() => this.update());
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
