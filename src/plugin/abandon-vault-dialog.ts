import { Modal, type App } from "obsidian";
import { ABANDON_COPY as COPY } from "./encryption-copy";
import { addFieldText, addParagraph, addPlainField } from "./encryption-dialog-controls";
import { createAbandonModel, type AbandonModel, type AbandonState } from "./abandon-dialog-model";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";

const ID = {
  field: "ipfs-sync-abandon-confirm",
  consequences: "ipfs-sync-abandon-consequences",
  error: "ipfs-sync-abandon-error",
} as const;

export type AbandonResult = { readonly ok: true; readonly backupNote?: string } | { readonly ok: false; readonly reason: string };
export type AbandonOutcome = { readonly abandoned: true; readonly backupNote?: string } | { readonly abandoned: false };

export interface AbandonDialogRequest {
  /**
   * Called once after the word is typed and the button pressed. The caller keeps the backup of the local key
   * slots copy and state, and never changes the node. `backupNote` (for example the backup location) is passed
   * on to `onFinish`. A failure reason is shown as text.
   */
  readonly abandon: () => Promise<AbandonResult>;
}

/**
 * Confirmation before this device abandons a vault whose key slots the node lost. Cancel comes first and takes the
 * initial focus, so an accidental Enter cancels. The action needs the word typed; nothing is done until then.
 */
export class AbandonVaultDialog extends Modal {
  private readonly model: AbandonModel = createAbandonModel();
  private settled = false;
  private field: HTMLInputElement | undefined;
  private failureEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    private readonly request: AbandonDialogRequest,
    /** Called once when the dialog is done. */
    private readonly onFinish: (outcome: AbandonOutcome) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    const list = contentEl.createEl("ul");
    list.id = ID.consequences;
    for (const line of COPY.consequences) list.createEl("li", { text: line });
    const { labelId, descId } = addFieldText(contentEl, ID.field, COPY.confirmName, COPY.confirmDesc);
    const field = addPlainField(contentEl, ID.field, labelId, `${descId} ${ID.error}`);
    this.field = field;
    this.failureEl = liveRegion(contentEl, ID.error);
    field.addEventListener("input", () => this.apply(this.model.setTyped(field.value)));
    field.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.confirm();
    });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.confirmButton = row.createEl("button", { text: COPY.confirm, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", `${ID.consequences} ${descId}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => void this.confirm());
    this.apply(this.model.state());
    this.cancelButton.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish({ abandoned: false });
  }

  private apply(state: AbandonState): void {
    if (this.confirmButton !== undefined) this.confirmButton.disabled = !state.canAbandon;
    for (const control of [this.field, this.cancelButton]) if (control !== undefined) control.disabled = state.busy;
    if (this.failureEl !== undefined) {
      this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.failed}: ${state.failure}`));
      markProblem(this.failureEl, state.failure !== undefined);
    }
    if (this.field !== undefined && this.failureEl !== undefined) this.field.setAttr("aria-invalid", state.failure === undefined ? null : "true");
  }

  private async confirm(): Promise<void> {
    if (!this.model.begin()) return;
    this.apply(this.model.state());
    let result: AbandonResult;
    try {
      result = await this.request.abandon();
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
    }
    if (result.ok) {
      this.finish({ abandoned: true, ...(result.backupNote === undefined ? {} : { backupNote: result.backupNote }) });
      this.close();
      return;
    }
    this.apply(this.model.fail(result.reason));
    this.cancelButton?.focus();
  }

  private finish(outcome: AbandonOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(outcome);
  }
}
