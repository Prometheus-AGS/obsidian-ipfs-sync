import { Modal, type App } from "obsidian";
import { addParagraph } from "./encryption-dialog-controls";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import { STALE_LOCK_COPY as COPY } from "./stale-lock-copy";

const ID = { consequences: "ipfs-sync-stale-lock-consequences", error: "ipfs-sync-stale-lock-error" } as const;

export type ClearLockResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/**
 * `failure` is set only when the dialog was closed after Clear lock and the action then failed: fixed, safe text (never an error
 * message). A plain Cancel has no `failure`.
 */
export type ClearLockOutcome = { readonly cleared: boolean; readonly failure?: string };

/** Shown instead of the text of an error the action threw: the console has the detail. */
const UNEXPECTED_FAILURE = "an unexpected error occurred; see the developer console for details";

export interface ClearLockDialogRequest {
  /** What the lock file looks like now: process, host and age. */
  readonly description: string;
  /** Called once when Clear lock is pressed; re-checks the age. A failure reason is shown as text. */
  readonly clear: () => Promise<ClearLockResult>;
}

/**
 * Confirmation before a stale publish lock is removed. Same shape as the adopt-key and abandon dialogs: Cancel comes
 * first and takes the initial focus, so an accidental Enter cancels; closing the dialog any other way is a cancel.
 */
export class ClearStaleLockDialog extends Modal {
  private settled = false;
  private busy = false;
  private closing = false;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;
  private failureEl: HTMLElement | undefined;

  constructor(
    app: App,
    private readonly request: ClearLockDialogRequest,
    private readonly onFinish: (outcome: ClearLockOutcome) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    addParagraph(contentEl, `${COPY.stale} ${this.request.description}.`);
    const list = contentEl.createEl("ul");
    list.id = ID.consequences;
    for (const line of COPY.consequences) list.createEl("li", { text: line });
    this.failureEl = liveRegion(contentEl, ID.error);
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.confirmButton = row.createEl("button", { text: COPY.confirm, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", ID.consequences);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => void this.confirm());
    this.cancelButton.focus();
  }

  /** Closing while the lock is being cleared does not stop it: the real result is reported when it ends, not a cancel. */
  onClose(): void {
    this.contentEl.empty();
    this.closing = true;
    if (!this.busy) this.finish({ cleared: false });
  }

  private async confirm(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (this.confirmButton !== undefined) this.confirmButton.disabled = true;
    let result: ClearLockResult;
    try {
      result = await this.request.clear();
    } catch (error) {
      result = { ok: false, reason: UNEXPECTED_FAILURE };
    }
    if (result.ok) {
      this.finish({ cleared: true });
      if (!this.closing) this.close();
      return;
    }
    this.failureEl?.setText(errorLine(`${COPY.failed}: ${result.reason}`));
    if (this.failureEl !== undefined) markProblem(this.failureEl, true);
    this.busy = false;
    if (this.closing) this.finish({ cleared: false, failure: result.reason });
    else this.cancelButton?.focus();
  }

  private finish(outcome: ClearLockOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(outcome);
  }
}
