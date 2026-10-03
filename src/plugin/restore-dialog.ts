import { Modal, type App } from "obsidian";
import { addParagraph } from "./encryption-dialog-controls";
import { askConfirm } from "./pull-confirm-dialog";
import { RESTORE_LIST_COPY as COPY } from "./pull-dialog-copy";
import { createRestoreListModel, restoreView, type RestoreEntry, type RestoreListModel, type RestoreListState, type RestoreRequest } from "./restore-dialog-model";
import { liveRegion } from "./settings-tab-controls";

const ID = { group: "ipfs-sync-restore-list", need: "ipfs-sync-restore-list-need", legend: "ipfs-sync-restore-list-legend" } as const;

/**
 * Step 1 of Restore: choose a version from the list. The rows are native radio buttons in one labelled group, so the
 * arrow keys, Tab and a screen reader work as for any form. Every row's text is set as text; nothing is copyable.
 * Closing the dialog any way other than Continue is a no. Choosing writes nothing and loads nothing.
 */
export class RestoreListDialog extends Modal {
  private readonly model: RestoreListModel;
  private settled = false;
  private needEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private continueButton: HTMLButtonElement | undefined;
  private firstRadio: HTMLInputElement | undefined;

  constructor(
    app: App,
    private readonly entries: readonly RestoreEntry[],
    /** Called once: the chosen row, or `undefined` for every other way out. */
    private readonly onFinish: (chosen: number | undefined) => void,
  ) {
    super(app);
    this.model = createRestoreListModel(entries);
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    if (this.entries.length === 0) addParagraph(contentEl, COPY.empty);
    else this.renderChoices(contentEl);
    this.needEl = liveRegion(contentEl, ID.need);
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.continueButton = row.createEl("button", { text: COPY.continue, cls: "mod-cta" });
    this.continueButton.setAttr("aria-describedby", ID.need);
    this.cancelButton.addEventListener("click", () => this.close());
    this.continueButton.addEventListener("click", () => this.accept());
    this.apply(this.model.state());
    (this.firstRadio ?? this.cancelButton).focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(undefined);
  }

  private renderChoices(parent: HTMLElement): void {
    const group = parent.createEl("fieldset");
    group.id = ID.group;
    const legend = group.createEl("legend", { text: COPY.groupLabel, cls: "setting-item-name" });
    legend.id = ID.legend;
    this.model.labels.forEach((label, index) => {
      const rowId = `${ID.group}-${index}`;
      const row = group.createDiv();
      row.setCssProps({ display: "flex", gap: "var(--size-4-2)", "align-items": "flex-start", margin: "var(--size-4-2) 0" });
      const input = row.createEl("input", { type: "radio", attr: { id: rowId, name: ID.group } });
      input.id = rowId;
      const text = row.createEl("label", { text: label, attr: { for: rowId } });
      text.id = `${rowId}-label`;
      text.setCssProps({ "overflow-wrap": "anywhere" });
      input.setAttr("aria-labelledby", text.id);
      input.addEventListener("change", () => this.apply(this.model.choose(index)));
      this.firstRadio ??= input;
    });
  }

  private apply(state: RestoreListState): void {
    if (this.continueButton !== undefined) this.continueButton.disabled = !state.canContinue;
    this.needEl?.setText(state.needText);
  }

  private accept(): void {
    const chosen = this.model.take();
    if (chosen === undefined) return;
    this.finish(chosen);
    this.close();
  }

  private finish(chosen: number | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(chosen);
  }
}

/** Let the user choose a version. Resolves the index into `entries`, or `undefined` when the user backs out. */
export function chooseRestoreEntry(app: App, entries: readonly RestoreEntry[]): Promise<number | undefined> {
  return new Promise((resolve) => {
    new RestoreListDialog(app, entries, resolve).open();
  });
}

/**
 * Step 2 of Restore, after the runner loaded and authenticated the chosen entry: the confirmation. It shows the
 * authenticated sequence and date, states that later files are not removed, and keeps Confirm disabled when the
 * runner reports that the list label did not match the entry. `true` is the only yes; the rollback flag is passed
 * by the Restore action alone, and only after this yes.
 */
export function confirmRestore(app: App, request: RestoreRequest): Promise<boolean> {
  return askConfirm(app, restoreView(request));
}
