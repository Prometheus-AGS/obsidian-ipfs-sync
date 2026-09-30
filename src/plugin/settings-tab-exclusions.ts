import { Setting } from "obsidian";
import { EXCLUSIONS_COPY as COPY, SECTIONS } from "./settings-tab-copy";
import { addCode, addSection, stackControl, errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { ExclusionChange, ExclusionsView, SettingsViewModel } from "./settings-view-model";

const ADD_MESSAGE_ID = "ipfs-sync-exclusions-message";
const ADD_INPUT_LABEL = "ipfs-sync-label-exclusion-add";
const ADD_DESC = "ipfs-sync-desc-exclusion-add";

/**
 * The exclusions editor: the effective list with its hash, the defaults (fixed) and the operator's own
 * additions (removable). The list part is rebuilt after each change; the add row is built once, so focus
 * stays where the operator is typing.
 */
export class ExclusionsSection {
  private listEl: HTMLElement | undefined;
  private messageEl: HTMLElement | undefined;
  private addInput: HTMLInputElement | undefined;
  private generation = 0;

  constructor(private readonly vm: SettingsViewModel) {}

  render(parent: HTMLElement): void {
    const section = addSection(parent, "ipfs-sync-section-exclusions", SECTIONS.exclusions);
    this.listEl = section.createDiv();
    this.renderAddRow(section);
    void this.renderList();
  }

  private async renderList(): Promise<void> {
    const listEl = this.listEl;
    if (listEl === undefined) return;
    const generation = ++this.generation;
    const view = await this.vm.exclusions();
    // A newer render started while the hash was computed: let that one draw.
    if (generation !== this.generation) return;
    listEl.empty();
    this.renderHash(listEl, view);
    this.renderDefaults(listEl, view);
    this.renderAdditions(listEl, view);
  }

  private renderHash(parent: HTMLElement, view: ExclusionsView): void {
    const setting = new Setting(parent).setName(COPY.hashName).setDesc(COPY.hashDesc);
    // In the description area, which wraps; the control area is a flex box that would squeeze the value.
    addCode(setting.descEl.createDiv(), view.excludesHash);
  }

  private renderDefaults(parent: HTMLElement, view: ExclusionsView): void {
    const setting = new Setting(parent).setName(COPY.defaultsName).setDesc(COPY.defaultsDesc);
    setting.nameEl.id = "ipfs-sync-label-exclusion-defaults";
    const list = setting.descEl.createEl("ul", { attr: { "aria-labelledby": setting.nameEl.id } });
    for (const entry of view.defaults) {
      const item = list.createEl("li");
      addCode(item, entry);
      item.createSpan({ text: ` (${COPY.defaultTag})` });
    }
  }

  private renderAdditions(parent: HTMLElement, view: ExclusionsView): void {
    const heading = new Setting(parent).setName(COPY.additionsName);
    if (view.user.length === 0) heading.setDesc(COPY.noAdditions);
    for (const entry of view.user) {
      new Setting(parent).setName(entry).addButton((button) => {
        button.setButtonText(COPY.removeButton);
        button.buttonEl.setAttr("aria-label", `${COPY.removeButton} ${entry} from your additions`);
        button.onClick(() => this.change(() => this.vm.removeExclusion(entry), `Removed "${entry}".`));
      });
    }
  }

  private renderAddRow(parent: HTMLElement): void {
    const setting = new Setting(parent).setName(COPY.addName).setDesc(COPY.addDesc);
    setting.nameEl.id = ADD_INPUT_LABEL;
    setting.descEl.id = ADD_DESC;
    this.messageEl = liveRegion(setting.infoEl, ADD_MESSAGE_ID);
    stackControl(setting);
    setting.addText((text) => {
      text.setPlaceholder(COPY.addPlaceholder);
      const input = text.inputEl;
      input.setCssProps({ flex: "1 1 auto", "min-width": "0" });
      input.setAttr("aria-labelledby", ADD_INPUT_LABEL);
      input.setAttr("aria-describedby", `${ADD_DESC} ${ADD_MESSAGE_ID}`);
      input.setAttr("autocapitalize", "off");
      input.setAttr("spellcheck", "false");
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") this.add();
      });
      this.addInput = input;
    });
    setting.addButton((button) => {
      button.setButtonText(COPY.addButton);
      button.buttonEl.setAttr("aria-describedby", ADD_DESC);
      button.onClick(() => this.add());
    });
  }

  private add(): void {
    const entry = this.addInput?.value ?? "";
    this.change(() => this.vm.addExclusion(entry), `Added "${entry.trim()}". The exclusions hash changed.`, true);
  }

  private change(run: () => Promise<ExclusionChange>, okMessage: string, clearInput = false): void {
    void run().then(
      (result) => {
        this.say(result.ok ? okMessage : `Not changed: ${result.message ?? "the list stays as it is."}`, !result.ok);
        if (result.ok && clearInput && this.addInput !== undefined) this.addInput.value = "";
        if (result.ok) void this.renderList().then(() => this.addInput?.focus());
      },
      (error: unknown) => this.say(errorLine(`The change could not be saved: ${error instanceof Error ? error.message : "unknown error"}`), true),
    );
  }

  private say(message: string, problem: boolean): void {
    this.messageEl?.setText(message);
    if (this.messageEl !== undefined) markProblem(this.messageEl, problem);
  }
}
