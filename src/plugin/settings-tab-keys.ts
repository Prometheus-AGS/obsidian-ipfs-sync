import { Setting, type App } from "obsidian";
import { AdoptKeyDialog } from "./adopt-key-dialog";
import { keyReasonSentence, KEYS_COPY as COPY, SECTIONS } from "./settings-tab-copy";
import { addCode, addSection, stackControl, errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { AdoptState, KeyStateView, SettingsViewModel } from "./settings-view-model";

const FEEDBACK_ID = "ipfs-sync-adopt-feedback";
const ADOPT_LABEL = "ipfs-sync-label-adopt";
const ADOPT_DESC = "ipfs-sync-desc-adopt";

const STATE_LABEL: Readonly<Record<KeyStateView["state"], string>> = {
  absent: "Absent",
  owned: "Owned",
  foreign: "Foreign",
  unknown: "Unknown",
};

/**
 * Owned keys: the publication key's state on the node, the recorded key IDs, and the adopt control. The
 * status part is rebuilt after a refresh or an adoption; the adopt row is built once so focus stays put.
 */
export class KeysSection {
  private statusEl: HTMLElement | undefined;
  private feedbackEl: HTMLElement | undefined;
  private adoptInput: HTMLInputElement | undefined;
  private generation = 0;

  constructor(
    private readonly app: App,
    private readonly vm: SettingsViewModel,
  ) {}

  render(parent: HTMLElement): void {
    const section = addSection(parent, "ipfs-sync-section-keys", SECTIONS.keys);
    this.statusEl = section.createDiv();
    this.renderAdoptRow(section);
    void this.refresh();
  }

  /** Ask the node again and redraw the state and the owned IDs. Safe to call while a previous call is running. */
  async refresh(): Promise<void> {
    const statusEl = this.statusEl;
    if (statusEl === undefined) return;
    const generation = ++this.generation;
    this.drawStatus(statusEl, undefined);
    const view = await this.vm.keys.keyState();
    if (generation === this.generation) this.drawStatus(statusEl, view);
  }

  private drawStatus(parent: HTMLElement, view: KeyStateView | undefined): void {
    parent.empty();
    const state = new Setting(parent).setName(COPY.stateName);
    state.setDesc(view === undefined ? COPY.checking : `${STATE_LABEL[view.state]}. ${keyReasonSentence(view.detail)}`);
    state.descEl.setAttr("aria-live", "polite");
    state.addButton((button) => {
      button.setButtonText(COPY.refreshButton);
      button.buttonEl.setAttr("aria-label", `${COPY.refreshButton}: ask the node about the publication key`);
      button.onClick(() => void this.refresh());
    });
    const owned = new Setting(parent).setName(COPY.ownedName).setDesc(COPY.ownedDesc);
    if (view === undefined) return;
    if (view.ownedKeyIds.length === 0) owned.descEl.createDiv({ text: COPY.noOwned });
    const list = owned.descEl.createEl("ul");
    for (const id of view.ownedKeyIds) addCode(list.createEl("li"), id);
  }

  private renderAdoptRow(parent: HTMLElement): void {
    const setting = new Setting(parent).setName(COPY.adoptName).setDesc(COPY.adoptDesc);
    setting.nameEl.id = ADOPT_LABEL;
    setting.descEl.id = ADOPT_DESC;
    this.feedbackEl = liveRegion(setting.infoEl, FEEDBACK_ID);
    stackControl(setting);
    setting.addText((text) => {
      text.setPlaceholder(COPY.adoptPlaceholder);
      const input = text.inputEl;
      input.setCssProps({ flex: "1 1 auto", "min-width": "0" });
      input.setAttr("aria-labelledby", ADOPT_LABEL);
      input.setAttr("aria-describedby", `${ADOPT_DESC} ${FEEDBACK_ID}`);
      input.setAttr("autocapitalize", "off");
      input.setAttr("spellcheck", "false");
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") void this.submit();
      });
      this.adoptInput = input;
    });
    setting.addButton((button) => {
      button.setButtonText(COPY.adoptButton);
      button.buttonEl.setAttr("aria-describedby", ADOPT_DESC);
      button.onClick(() => void this.submit());
    });
  }

  private async submit(): Promise<void> {
    this.say("");
    const state = await this.vm.keys.submit(this.adoptInput?.value ?? "");
    if (state.step === "refused") {
      this.say(errorLine(state.reason), true);
      return;
    }
    if (state.step !== "confirming") return;
    new AdoptKeyDialog(this.app, this.vm.keys, (final) => this.finished(final)).open();
  }

  private finished(final: AdoptState): void {
    if (final.step === "recorded") {
      this.say(`Recorded key ${final.keyName} (${final.keyId}) as owned.`);
      if (this.adoptInput !== undefined) this.adoptInput.value = "";
      void this.refresh();
    } else {
      this.say("Adoption cancelled. Nothing was recorded.");
    }
    this.adoptInput?.focus();
  }

  private say(message: string, problem = false): void {
    this.feedbackEl?.setText(message);
    if (this.feedbackEl !== undefined) markProblem(this.feedbackEl, problem);
  }
}
