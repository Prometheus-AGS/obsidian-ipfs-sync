import { Modal, type App } from "obsidian";
import type { MassRemovalCounts } from "../sync/publish-refusals";
import { addParagraph } from "./encryption-dialog-controls";
import { createMassRemovalModel, type MassRemovalModel, type MassRemovalView } from "./mass-removal-dialog-model";

const ID = {
  summary: "ipfs-sync-mass-removal-summary",
  lookAlike: "ipfs-sync-mass-removal-lookalike",
  exclusion: "ipfs-sync-mass-removal-exclusion",
} as const;

/**
 * The confirmation for a manual publish the engine stopped for mass removal. Cancel comes first and takes the initial focus, so an accidental
 * Enter or a stray tap on the default control cancels; the destructive button names the consequence and needs an explicit press. Any way out
 * other than that press (Cancel, Escape, closing the window) is a no, so nothing is written. Counts only are shown: no path reaches this dialog.
 * It is never opened for a timer publish.
 */
export class MassRemovalDialog extends Modal {
  private readonly model: MassRemovalModel;
  private yes = false;
  private reported = false;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    counts: MassRemovalCounts,
    /** Called once: `true` only after the explicit confirm, `false` for every other way out. */
    private readonly onFinish: (confirmed: boolean) => void,
  ) {
    super(app);
    this.model = createMassRemovalModel(counts);
  }

  onOpen(): void {
    const view = this.model.view();
    this.titleEl.setText(view.title);
    const { contentEl } = this;
    contentEl.empty();
    this.renderText(contentEl, view);
    this.renderButtons(contentEl, view);
    this.cancelButton?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.model.cancel();
    if (this.reported) return;
    this.reported = true;
    this.onFinish(this.yes);
  }

  private renderText(parent: HTMLElement, view: MassRemovalView): void {
    const summary = addParagraph(parent, view.summary);
    summary.id = ID.summary;
    summary.setCssProps({ "font-weight": "var(--font-semibold)" });
    const lookAlike = addParagraph(parent, view.lookAlike);
    lookAlike.id = ID.lookAlike;
    addParagraph(parent, view.nothingWritten);
    if (view.exclusionNote !== undefined) {
      const note = addParagraph(parent, view.exclusionNote);
      note.id = ID.exclusion;
    }
  }

  private renderButtons(parent: HTMLElement, view: MassRemovalView): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: view.cancelLabel, cls: "mod-cta" });
    this.confirmButton = row.createEl("button", { text: view.confirmLabel, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", `${ID.summary} ${ID.lookAlike}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => this.confirm());
  }

  private confirm(): void {
    if (!this.model.confirm()) return;
    this.yes = true;
    this.close();
  }
}

/** Open the dialog and wait for the answer. Resolves `true` only after the explicit confirm; this is the engine's `confirmMassRemoval` port. */
export function askMassRemoval(app: App, counts: MassRemovalCounts): Promise<boolean> {
  return new Promise((resolve) => {
    new MassRemovalDialog(app, counts, resolve).open();
  });
}
