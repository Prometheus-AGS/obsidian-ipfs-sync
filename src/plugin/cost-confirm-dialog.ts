import { Modal, type App } from "obsidian";
import type { KdfParams } from "../crypto";
import { costConfirmationFrom, createCostConfirmModel, type CostConfirmationPorts, type CostConfirmModel, type CostConfirmView } from "./cost-confirm-dialog-model";
import { addParagraph } from "./encryption-dialog-controls";

const ID = {
  summary: "ipfs-sync-cost-confirm-summary",
  effects: "ipfs-sync-cost-confirm-effects",
  blocked: "ipfs-sync-cost-confirm-blocked",
} as const;

/**
 * Asks whether a key slot above the default cost may be unlocked on this device (mvp-07b task 2.4). Cancel comes first and takes the initial focus, so
 * an accidental Enter says no; the confirm button names what it does and needs an explicit press. Any way out other than that press (Cancel,
 * Escape, closing the window) is a no. The costs come from the engine; every string is set through `text` / `setText` (textContent), and nothing
 * from the node reaches this dialog as text. It has no copy control and writes nothing.
 */
export class CostConfirmDialog extends Modal {
  private readonly model: CostConfirmModel;
  private yes = false;
  private reported = false;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    costs: readonly KdfParams[],
    /** Called once: `true` only after the explicit confirm, `false` for every other way out. */
    private readonly onFinish: (confirmed: boolean) => void,
  ) {
    super(app);
    this.model = createCostConfirmModel(costs);
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

  private renderText(parent: HTMLElement, view: CostConfirmView): void {
    const summary = addParagraph(parent, view.summary);
    summary.id = ID.summary;
    summary.setCssProps({ "font-weight": "var(--font-semibold)" });
    if (view.costLines.length > 1) {
      const list = parent.createEl("ul");
      for (const line of view.costLines) list.createEl("li", { text: line });
    }
    const effects = addParagraph(parent, view.effects);
    effects.id = ID.effects;
    addParagraph(parent, view.nothingWritten);
    if (view.blocked !== undefined) {
      const blocked = addParagraph(parent, view.blocked);
      blocked.id = ID.blocked;
      blocked.setAttr("role", "status");
    }
  }

  private renderButtons(parent: HTMLElement, view: CostConfirmView): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: view.cancelLabel, cls: "mod-cta" });
    this.confirmButton = row.createEl("button", { text: view.confirmLabel });
    this.confirmButton.setAttr("aria-describedby", view.blocked === undefined ? `${ID.summary} ${ID.effects}` : ID.blocked);
    this.confirmButton.disabled = !this.model.state().canConfirm;
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => this.confirm());
  }

  private confirm(): void {
    if (!this.model.confirm()) return;
    this.yes = true;
    this.close();
  }
}

/** Open the dialog and wait for the answer. Resolves `true` only after the explicit confirm. */
export function askCostConfirm(app: App, costs: readonly KdfParams[]): Promise<boolean> {
  return new Promise((resolve) => {
    new CostConfirmDialog(app, costs, resolve).open();
  });
}

/** The cost-confirm seam of the key actions (`KeyActionsDeps.costConfirmation`) over this dialog. */
export function obsidianCostConfirmation(app: App): CostConfirmationPorts {
  return costConfirmationFrom((costs) => askCostConfirm(app, costs));
}
