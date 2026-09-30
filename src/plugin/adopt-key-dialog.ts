import { Modal, type App } from "obsidian";
import { ADOPT_DIALOG as COPY } from "./settings-tab-copy";
import { addCode, errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import { ADOPT_CONSEQUENCES, type AdoptState } from "./settings-view-model";
import type { KeyAdoption } from "./key-adoption";

const CONSEQUENCES_ID = "ipfs-sync-adopt-consequences";
const ERROR_ID = "ipfs-sync-adopt-error";

/**
 * Confirmation before a key is recorded as owned. The dialog opens only after `keys.submit` reached the
 * `confirming` step; nothing is recorded until "Adopt key" is pressed. Cancel comes first and takes the
 * initial focus, so an accidental Enter cancels. Closing the dialog any other way (Escape, the close
 * control) is a cancel too.
 */
export class AdoptKeyDialog extends Modal {
  private settled = false;
  private confirmButton: HTMLButtonElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private errorEl: HTMLElement | undefined;

  constructor(
    app: App,
    private readonly keys: KeyAdoption,
    /** Called once when the dialog closes, with the final adoption state (`recorded`, or `idle` after any cancel). */
    private readonly onFinish: (state: AdoptState) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const pending = this.keys.state();
    if (pending.step !== "confirming") {
      this.close();
      return;
    }
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    this.renderKey(contentEl, pending.keyName, pending.keyId);
    this.renderConsequences(contentEl);
    this.errorEl = liveRegion(contentEl, ERROR_ID);
    this.renderButtons(contentEl);
    this.cancelButton?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.settled) return;
    this.settled = true;
    const final = this.keys.state();
    this.onFinish(final.step === "recorded" ? final : this.keys.cancel());
  }

  private renderKey(parent: HTMLElement, name: string, id: string): void {
    const p = parent.createEl("p");
    p.createSpan({ text: "Key name: " });
    p.createEl("strong", { text: name });
    const idLine = parent.createEl("p");
    idLine.createSpan({ text: "Key ID: " });
    addCode(idLine, id);
  }

  private renderConsequences(parent: HTMLElement): void {
    parent.createEl("p", { text: COPY.intro });
    const list = parent.createEl("ul");
    list.id = CONSEQUENCES_ID;
    for (const line of ADOPT_CONSEQUENCES) list.createEl("li", { text: line });
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.confirmButton = row.createEl("button", { text: COPY.confirm, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", CONSEQUENCES_ID);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => void this.confirm());
  }

  private async confirm(): Promise<void> {
    if (this.confirmButton === undefined) return;
    this.confirmButton.disabled = true;
    const result = await this.keys.confirm();
    if (result.step === "refused") {
      // Not recorded: stay open so the operator reads why, then cancel.
      this.errorEl?.setText(errorLine(result.reason));
      if (this.errorEl !== undefined) markProblem(this.errorEl, true);
      return;
    }
    this.close();
  }
}
