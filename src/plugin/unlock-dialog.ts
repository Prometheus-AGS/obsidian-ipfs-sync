import { Modal, type App } from "obsidian";
import {
  addFieldText,
  addParagraph,
  addRevealToggle,
  addSecretField,
  ProgressIndicator,
  showFieldError,
} from "./encryption-dialog-controls";
import { UNLOCK_COPY as COPY, UNLOCKING_TEXT } from "./encryption-copy";
import { liveRegion } from "./settings-tab-controls";
import { createUnlockModel, type PassphraseFormatCheck, type UnlockModel, type UnlockState } from "./unlock-dialog-model";

const ID = {
  field: "ipfs-sync-unlock-passphrase",
  error: "ipfs-sync-unlock-error",
  reveal: "ipfs-sync-unlock-reveal",
  progress: "ipfs-sync-unlock-progress",
} as const;

export type UnlockResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type UnlockOutcome = "unlocked" | "cancelled";

export interface UnlockDialogRequest {
  /** Local format check; a failure is reported as a probable typo without calling `unlock`. */
  readonly check: PassphraseFormatCheck;
  /**
   * Called with the text of the field once the local check passes. The caller derives the key and reports
   * progress as a fraction from 0 to 1 when it can. A refusal reason is shown as text; it must not contain the
   * passphrase. The dialog clears the field as soon as this is called and keeps no copy.
   */
  readonly unlock: (passphrase: string, onProgress: (fraction: number) => void) => Promise<UnlockResult>;
}

/**
 * Asks for the vault passphrase. One masked field with a reveal control, a text error tied to the field, and the
 * unlocking indicator while the key is derived. Closing the dialog any other way than a successful unlock is a
 * cancel; closing it while the key is being derived does not stop the derivation, and the outcome is reported
 * when it ends.
 */
export class UnlockVaultDialog extends Modal {
  private readonly model: UnlockModel;
  private settled = false;
  private closing = false;
  private field: HTMLInputElement | undefined;
  private errorEl: HTMLElement | undefined;
  private progress: ProgressIndicator | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private unlockButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    private readonly request: UnlockDialogRequest,
    /** Called once when the dialog is done: `unlocked`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: UnlockOutcome) => void,
  ) {
    super(app);
    this.model = createUnlockModel(request.check);
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    const { labelId, descId } = addFieldText(contentEl, ID.field, COPY.fieldName, COPY.fieldDesc);
    const field = addSecretField(contentEl, ID.field, labelId, `${descId} ${ID.error}`);
    this.field = field;
    this.errorEl = liveRegion(contentEl, ID.error);
    addRevealToggle(contentEl, ID.reveal, COPY.revealLabel, field, (on) => this.apply(this.model.setRevealed(on)));
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    field.addEventListener("input", () => this.apply(this.model.edited()));
    field.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.submit();
    });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.unlockButton = row.createEl("button", { text: COPY.unlock, cls: "mod-cta" });
    this.cancelButton.addEventListener("click", () => this.close());
    this.unlockButton.addEventListener("click", () => void this.submit());
    this.apply(this.model.state());
    field.focus();
  }

  onClose(): void {
    if (this.field !== undefined) this.field.value = "";
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish("cancelled");
  }

  private apply(state: UnlockState): void {
    if (this.field !== undefined && this.errorEl !== undefined) showFieldError(this.errorEl, this.field, state.error);
    for (const control of [this.field, this.unlockButton, this.cancelButton]) if (control !== undefined) control.disabled = state.busy;
    if (state.busy) this.progress?.show(UNLOCKING_TEXT, state.progress);
    else this.progress?.hide();
  }

  private async submit(): Promise<void> {
    const field = this.field;
    if (field === undefined || this.model.state().busy) return;
    const text = field.value;
    const checked = this.model.validate(text);
    if (!checked.ok) {
      this.apply(this.model.state());
      return;
    }
    this.model.begin();
    field.value = "";
    this.apply(this.model.state());
    let result: UnlockResult;
    try {
      result = await this.request.unlock(text, (fraction) => this.apply(this.model.reportProgress(fraction)));
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
    }
    if (result.ok) {
      this.apply(this.model.succeed());
      this.finish("unlocked");
      if (!this.closing) this.close();
      return;
    }
    this.apply(this.model.fail(`${COPY.unlockFailed}: ${result.reason}`));
    if (this.closing) this.finish("cancelled");
    else this.field?.focus();
  }

  private finish(outcome: UnlockOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(outcome);
  }
}
