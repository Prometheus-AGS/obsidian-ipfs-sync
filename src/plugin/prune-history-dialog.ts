import { Modal, type App } from "obsidian";
import type { KdfParams } from "../crypto";
import { KEY_DIALOG_COPY, PRUNE_HISTORY_COPY as COPY } from "./encryption-copy";
import { addFieldText, addParagraph, ProgressIndicator, showFieldError } from "./encryption-dialog-controls";
import { addCurrentField, addStatementList, setHidden, showCurrent, UNEXPECTED_ERROR_TEXT, type CurrentField } from "./key-dialog-controls";
import type { KeyDialogOutcome } from "./key-dialog-shared";
import {
  createPruneHistoryModel,
  type PruneHistoryModel,
  type PruneHistoryState,
  type PruneOutcome,
  type PrunePreviewResult,
  type PruneRemoveResult,
} from "./prune-history-dialog-model";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

const ID = {
  statements: "ipfs-sync-prune-statements",
  keep: "ipfs-sync-prune-keep",
  keepNote: "ipfs-sync-prune-keep-note",
  keepError: "ipfs-sync-prune-keep-error",
  current: "ipfs-sync-prune-current",
  requirements: "ipfs-sync-prune-requirements",
  review: "ipfs-sync-prune-review",
  reviewList: "ipfs-sync-prune-review-list",
  question: "ipfs-sync-prune-question",
  progress: "ipfs-sync-prune-progress",
  failure: "ipfs-sync-prune-failure",
  result: "ipfs-sync-prune-result",
} as const;

export interface PruneHistoryDialogRequest {
  /** The cost of the key slot this device holds: the preview takes one derivation at this cost. */
  readonly cost: KdfParams;
  /** Local format check for the current passphrase; a failure is a probable typo and `preview` is not called. */
  readonly check: PassphraseFormatCheck;
  /**
   * Step one, a dry run. Called once with the count and the current passphrase when the gating holds. The caller opens the vault, runs every refusal of
   * the engine and returns what a prune would do as counts and fixed text, or a failure: `retryable` only for a refusal that wrote nothing and that a
   * second try can fix (a wrong passphrase, a busy lock). Nothing is written. No node name or path may be in the answer. The dialog empties the
   * passphrase field as soon as this is called and keeps no copy.
   */
  readonly preview: (input: { readonly keep: number; readonly passphrase: string }, onProgress: (fraction: number) => void) => Promise<PrunePreviewResult>;
  /**
   * Step two. Called once, only after the review is shown and the remove control is pressed. Its answer is the real outcome: only `ok: true` ends the
   * dialog as done; any failure means the node or this device may have changed.
   */
  readonly remove: () => Promise<PruneRemoveResult>;
}

/**
 * Prune the oldest history files from the node's working tree. The form asks for how many files to keep and the current passphrase and previews; the
 * preview shows counts and the engine's statements. The review is the consequence step: Cancel comes first and takes the focus, the remove control
 * names how many files it removes and needs an explicit press, and every other way out (Cancel, Escape, closing the window) removes nothing. Closing
 * while a run is going does not stop it; the outcome is reported when it ends. Everything shown is set through text (textContent), and nothing the
 * node chose can reach the dialog as markup or as a name.
 */
export class PruneHistoryDialog extends Modal {
  private readonly model: PruneHistoryModel;
  private settled = false;
  private closing = false;
  private keepField: HTMLInputElement | undefined;
  private keepNoteEl: HTMLElement | undefined;
  private keepErrorEl: HTMLElement | undefined;
  private current: CurrentField | undefined;
  private formEl: HTMLElement | undefined;
  private introEl: HTMLElement | undefined;
  private requirements: HTMLElement | undefined;
  private reviewEl: HTMLElement | undefined;
  private reviewListEl: HTMLElement | undefined;
  private questionEl: HTMLElement | undefined;
  private progress: ProgressIndicator | undefined;
  private failureEl: HTMLElement | undefined;
  private resultEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private previewButton: HTMLButtonElement | undefined;
  private removeButton: HTMLButtonElement | undefined;
  private reviewKey = "";

  constructor(
    app: App,
    private readonly request: PruneHistoryDialogRequest,
    /** Called once when the dialog is done: `done`, `stopped`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: KeyDialogOutcome) => void,
  ) {
    super(app);
    this.model = createPruneHistoryModel({ cost: request.cost, check: request.check });
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    const state = this.model.state();
    this.introEl = addParagraph(contentEl, COPY.intro);
    this.formEl = contentEl.createDiv();
    this.renderForm(this.formEl, state);
    this.renderReview(contentEl);
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    this.failureEl = liveRegion(contentEl, ID.failure);
    this.resultEl = liveRegion(contentEl, ID.result);
    this.renderButtons(contentEl);
    this.apply(state);
    this.keepField?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish();
  }

  private renderForm(parent: HTMLElement, state: PruneHistoryState): void {
    addStatementList(parent, ID.statements, KEY_DIALOG_COPY.statementsHeading, state.statements);
    this.renderKeep(parent);
    this.current = addCurrentField(parent, ID.current, {
      onInput: (text) => this.apply(this.model.setCurrent(text)),
      onTouch: () => this.apply(this.model.touchCurrent()),
      onReveal: (on) => this.apply(this.model.setCurrentRevealed(on)),
      onEnter: () => void this.preview(),
    });
    this.requirements = liveRegion(parent, ID.requirements);
  }

  private renderKeep(parent: HTMLElement): void {
    const row = parent.createDiv();
    row.setCssProps({ margin: "var(--size-4-3) 0" });
    const { labelId, descId } = addFieldText(row, ID.keep, COPY.keepName, COPY.keepDesc);
    const input = row.createEl("input", { type: "number", attr: { id: ID.keep } });
    input.id = ID.keep;
    input.setAttr("min", "1");
    input.setAttr("step", "1");
    input.setAttr("inputmode", "numeric");
    input.setAttr("autocomplete", "off");
    input.setAttr("aria-labelledby", labelId);
    input.setAttr("aria-describedby", `${descId} ${ID.keepNote} ${ID.keepError}`);
    input.setCssProps({ width: "100%" });
    this.keepField = input;
    this.keepNoteEl = liveRegion(row, ID.keepNote);
    this.keepErrorEl = liveRegion(row, ID.keepError);
    input.addEventListener("input", () => this.apply(this.model.setKeep(input.value)));
    input.addEventListener("change", () => this.apply(this.model.touchKeep()));
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      this.apply(this.model.touchKeep());
      void this.preview();
    });
  }

  private renderReview(parent: HTMLElement): void {
    const review = parent.createDiv({ attr: { role: "group", "aria-labelledby": `${ID.review}-heading` } });
    review.id = ID.review;
    this.reviewEl = review;
    const heading = review.createEl("strong", { text: COPY.reviewHeading });
    heading.id = `${ID.review}-heading`;
    heading.setCssProps({ display: "block", "margin-top": "var(--size-4-3)" });
    this.reviewListEl = review.createEl("ul");
    this.reviewListEl.id = ID.reviewList;
    this.reviewListEl.setAttr("aria-labelledby", heading.id);
    this.questionEl = review.createEl("p");
    this.questionEl.id = ID.question;
    this.questionEl.setCssProps({ "font-weight": "var(--font-semibold)" });
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: KEY_DIALOG_COPY.cancel });
    this.previewButton = row.createEl("button", { text: COPY.previewButton, cls: "mod-cta" });
    this.removeButton = row.createEl("button", { text: "", cls: "mod-warning" });
    this.previewButton.setAttr("aria-describedby", `${ID.requirements} ${ID.statements}`);
    this.removeButton.setAttr("aria-describedby", `${ID.question} ${ID.reviewList}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.previewButton.addEventListener("click", () => void this.preview());
    this.removeButton.addEventListener("click", () => void this.remove());
  }

  private apply(state: PruneHistoryState): void {
    const form = state.phase === "form" || state.phase === "previewing";
    const reviewing = state.phase === "review" || state.phase === "removing";
    const ended = state.phase === "done" || state.phase === "stopped";
    const editable = state.phase === "form";
    this.showKeep(state, editable);
    if (this.current !== undefined) {
      showCurrent(this.current, state.current);
      this.current.field.disabled = !editable;
    }
    setHidden(this.formEl, !form);
    setHidden(this.introEl, ended);
    this.requirements?.setText(state.requirementsText);
    this.showReview(state, reviewing);
    if (this.previewButton !== undefined) {
      this.previewButton.disabled = !state.canPreview;
      setHidden(this.previewButton, !form);
    }
    if (this.removeButton !== undefined) {
      this.removeButton.disabled = !state.canRemove;
      setHidden(this.removeButton, !reviewing || state.nothingToPrune);
      if (state.removeLabel !== undefined) this.removeButton.setText(state.removeLabel);
    }
    if (this.cancelButton !== undefined) {
      this.cancelButton.disabled = state.busy;
      this.cancelButton.setText(ended || state.nothingToPrune ? KEY_DIALOG_COPY.close : KEY_DIALOG_COPY.cancel);
    }
    if (state.phase === "previewing") this.progress?.show(COPY.working, state.progress);
    else if (state.phase === "removing") this.progress?.show(COPY.removing, undefined);
    else this.progress?.hide();
    this.showOutcome(state);
  }

  private showKeep(state: PruneHistoryState, editable: boolean): void {
    if (this.keepField === undefined || this.keepErrorEl === undefined) return;
    this.keepField.disabled = !editable;
    showFieldError(this.keepErrorEl, this.keepField, state.keep.error);
    this.keepNoteEl?.setText(state.keep.note ?? "");
  }

  /** Rebuilt only when the review changes, so a screen reader is not re-read the list on every state change. */
  private showReview(state: PruneHistoryState, reviewing: boolean): void {
    setHidden(this.reviewEl, !reviewing);
    setHidden(this.questionEl, state.question === undefined);
    this.questionEl?.setText(state.question ?? "");
    const lines = state.review?.statements ?? [];
    const key = lines.join("\n");
    if (this.reviewListEl === undefined || key === this.reviewKey) return;
    this.reviewKey = key;
    this.reviewListEl.empty();
    lines.forEach((line, index) => {
      const item = this.reviewListEl?.createEl("li", { text: line });
      if (index === 0) item?.setCssProps({ "font-weight": "var(--font-semibold)" });
    });
  }

  private showOutcome(state: PruneHistoryState): void {
    if (this.failureEl !== undefined) {
      this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.failed}: ${state.failure}`));
      markProblem(this.failureEl, state.failure !== undefined);
    }
    if (this.resultEl === undefined) return;
    this.resultEl.empty();
    if (state.phase === "stopped") {
      this.resultEl.createEl("strong", { text: KEY_DIALOG_COPY.stoppedHeading });
      this.resultEl.createEl("p", { text: state.stoppedText ?? "" });
    }
    if (state.phase === "done" && state.outcome !== undefined) {
      this.resultEl.createEl("strong", { text: COPY.doneTitle });
      this.resultEl.createEl("p", { text: doneSentence(state.outcome) });
    }
  }

  private async preview(): Promise<void> {
    const field = this.current?.field;
    if (field === undefined || this.keepField === undefined || this.model.state().busy) return;
    this.apply(this.model.setKeep(this.keepField.value));
    this.apply(this.model.setCurrent(field.value));
    const text = field.value;
    const started = this.model.beginPreview();
    if (started === undefined) {
      this.apply(this.model.touchCurrent());
      return;
    }
    field.value = "";
    this.apply(this.model.state());
    let result: PrunePreviewResult;
    try {
      result = await this.request.preview({ keep: started.keep, passphrase: text }, (fraction) => this.apply(this.model.reportProgress(fraction)));
    } catch {
      result = { ok: false, reason: UNEXPECTED_ERROR_TEXT, retryable: false };
    }
    this.apply(this.model.settlePreview(result));
    // Where the focus goes: Cancel on the review (the remove control is one Tab away, never the default), back to the field after a retryable refusal.
    this.afterStep(result.ok || !result.retryable ? this.cancelButton : field);
  }

  private async remove(): Promise<void> {
    if (!this.model.beginRemove()) return;
    this.apply(this.model.state());
    let result: PruneRemoveResult;
    try {
      result = await this.request.remove();
    } catch {
      result = { ok: false, reason: UNEXPECTED_ERROR_TEXT, retryable: false };
    }
    this.apply(this.model.settleRemove(result));
    this.afterStep(result.ok || !result.retryable ? this.cancelButton : this.removeButton);
  }

  /** Report the end if the dialog was closed meanwhile; otherwise move focus to the control the new state makes useful. */
  private afterStep(focus: HTMLElement | undefined): void {
    if (this.closing) this.finish();
    else focus?.focus();
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    const phase = this.model.state().phase;
    this.onFinish(phase === "done" ? "done" : phase === "stopped" ? "stopped" : "cancelled");
  }
}

function doneSentence(outcome: PruneOutcome): string {
  if (outcome.kind === "unchanged") return COPY.unchanged;
  const removed = outcome.removed === 1 ? "1 history file was" : `${outcome.removed} history files were`;
  return `${removed} removed from the node's working tree and the result is published; ${outcome.kept} stay. The manifest, the key slots and the sequence were not touched.`;
}
