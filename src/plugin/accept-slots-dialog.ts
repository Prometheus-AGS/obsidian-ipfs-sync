import { Modal, type App } from "obsidian";
import {
  createAcceptSlotsModel,
  type AcceptCheckResult,
  type AcceptCommitResult,
  type AcceptSlotsModel,
  type AcceptSlotsState,
} from "./accept-slots-dialog-model";
import { ACCEPT_SLOTS_COPY as COPY, KEY_DIALOG_COPY } from "./encryption-copy";
import { addParagraph, ProgressIndicator } from "./encryption-dialog-controls";
import { addCurrentField, addStatementList, addToggleRow, setHidden, showCurrent, UNEXPECTED_ERROR_TEXT, type CurrentField } from "./key-dialog-controls";
import type { KeyDialogOutcome } from "./key-dialog-shared";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

const ID = {
  statements: "ipfs-sync-accept-statements",
  current: "ipfs-sync-accept-current",
  review: "ipfs-sync-accept-review",
  costs: "ipfs-sync-accept-costs",
  nothing: "ipfs-sync-accept-nothing",
  downgradeQuestion: "ipfs-sync-accept-downgrade-question",
  downgrade: "ipfs-sync-accept-downgrade",
  progress: "ipfs-sync-accept-progress",
  failure: "ipfs-sync-accept-failure",
  result: "ipfs-sync-accept-result",
} as const;

export interface AcceptSlotsDialogRequest {
  /** `name`: the node's current root. `root-cid`: a root the person named; the dialog then says the copy may become an older one. */
  readonly target: "name" | "root-cid";
  readonly check: PassphraseFormatCheck;
  /**
   * Step one. Called once with the passphrase of the changed key slots when the local check passes. The caller reads both files from one root,
   * unlocks, authenticates the manifest and returns the costs, or a failure: `retryable` for a wrong passphrase or a refusal that wrote nothing.
   * Nothing is written. The dialog empties the field as soon as this is called and keeps no copy.
   */
  readonly checkSlots: (passphrase: string, onProgress: (fraction: number) => void) => Promise<AcceptCheckResult>;
  /** Step two. Called once the review is shown and, for cheaper slots, the downgrade confirmation is ticked. */
  readonly accept: (confirmation: { readonly downgradeConfirmed: boolean }) => Promise<AcceptCommitResult>;
}

/**
 * Accept the key slots another device changed. The passphrase is the one that device set. The dialog first checks the slots on the node, then shows
 * the cost of this device's copy and of the incoming slots when they differ; cheaper incoming slots need a ticked confirmation before Accept works.
 * Every cost is a number the caller computed; nothing the node supplied is shown except through text.
 */
export class AcceptSlotsDialog extends Modal {
  private readonly model: AcceptSlotsModel;
  private settled = false;
  private closing = false;
  private current: CurrentField | undefined;
  private reviewEl: HTMLElement | undefined;
  private costsEl: HTMLElement | undefined;
  private nothingEl: HTMLElement | undefined;
  private downgradeQuestionEl: HTMLElement | undefined;
  private downgradeRow: HTMLElement | undefined;
  private downgrade: HTMLInputElement | undefined;
  private progress: ProgressIndicator | undefined;
  private failureEl: HTMLElement | undefined;
  private resultEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private checkButton: HTMLButtonElement | undefined;
  private acceptButton: HTMLButtonElement | undefined;
  private costsKey = "";

  constructor(
    app: App,
    private readonly request: AcceptSlotsDialogRequest,
    /** Called once when the dialog is done: `done`, `stopped`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: KeyDialogOutcome) => void,
  ) {
    super(app);
    this.model = createAcceptSlotsModel({ target: request.target, check: request.check });
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    const state = this.model.state();
    addParagraph(contentEl, state.intro);
    addStatementList(contentEl, ID.statements, KEY_DIALOG_COPY.statementsHeading, state.statements);
    this.current = addCurrentField(contentEl, ID.current, {
      onInput: (text) => this.apply(this.model.setCurrent(text)),
      onTouch: () => this.apply(this.model.touchCurrent()),
      onReveal: (on) => this.apply(this.model.setCurrentRevealed(on)),
      onEnter: () => void this.check(),
    });
    this.renderReview(contentEl);
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    this.failureEl = liveRegion(contentEl, ID.failure);
    this.resultEl = liveRegion(contentEl, ID.result);
    this.renderButtons(contentEl);
    this.apply(state);
    this.current.field.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish();
  }

  private renderReview(parent: HTMLElement): void {
    const review = parent.createDiv({ attr: { role: "group", "aria-labelledby": `${ID.review}-heading` } });
    review.id = ID.review;
    this.reviewEl = review;
    const heading = review.createEl("strong", { text: COPY.reviewHeading });
    heading.id = `${ID.review}-heading`;
    heading.setCssProps({ display: "block", "margin-top": "var(--size-4-3)" });
    this.costsEl = review.createEl("dl");
    this.costsEl.id = ID.costs;
    this.nothingEl = review.createEl("p", { text: COPY.nothingToAccept, cls: "setting-item-description" });
    this.nothingEl.id = ID.nothing;
    this.downgradeQuestionEl = liveRegion(review, ID.downgradeQuestion);
    const toggle = addToggleRow(review, ID.downgrade, COPY.downgradeLabel, (on) => this.apply(this.model.setDowngradeConfirmed(on)));
    this.downgradeRow = toggle.row;
    this.downgrade = toggle.input;
    this.downgrade.setAttr("aria-describedby", ID.downgradeQuestion);
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: KEY_DIALOG_COPY.cancel });
    this.checkButton = row.createEl("button", { text: COPY.checkButton, cls: "mod-cta" });
    this.acceptButton = row.createEl("button", { text: COPY.acceptButton, cls: "mod-warning" });
    this.acceptButton.setAttr("aria-describedby", `${ID.downgradeQuestion} ${ID.nothing}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.checkButton.addEventListener("click", () => void this.check());
    this.acceptButton.addEventListener("click", () => void this.acceptSlots());
  }

  private apply(state: AcceptSlotsState): void {
    const entering = state.phase === "enter" || state.phase === "checking";
    const reviewing = state.phase === "review" || state.phase === "accepting";
    const ended = state.phase === "done" || state.phase === "stopped";
    if (this.current !== undefined) {
      showCurrent(this.current, state.current);
      this.current.field.disabled = state.phase !== "enter";
      setHidden(this.current.rowEl, !entering);
    }
    setHidden(this.reviewEl, !reviewing);
    this.showCosts(state);
    setHidden(this.nothingEl, !state.nothingToAccept);
    this.downgradeQuestionEl?.setText(state.downgradeQuestion ?? "");
    setHidden(this.downgradeRow, !state.needsDowngradeConfirmation);
    if (this.downgrade !== undefined) {
      this.downgrade.checked = state.downgradeConfirmed;
      this.downgrade.disabled = state.phase !== "review";
    }
    if (this.checkButton !== undefined) {
      this.checkButton.disabled = !state.canCheck;
      setHidden(this.checkButton, !entering);
    }
    if (this.acceptButton !== undefined) {
      this.acceptButton.disabled = !state.canAccept;
      setHidden(this.acceptButton, !reviewing);
    }
    if (this.cancelButton !== undefined) {
      this.cancelButton.disabled = state.busy;
      if (ended || state.nothingToAccept) this.cancelButton.setText(KEY_DIALOG_COPY.close);
    }
    if (state.phase === "checking") this.progress?.show(COPY.checking, state.progress);
    else if (state.phase === "accepting") this.progress?.show(COPY.accepting, undefined);
    else this.progress?.hide();
    this.showOutcome(state);
  }

  /** Rebuilt only when the review changes, so a screen reader is not re-read the list on every keystroke. */
  private showCosts(state: AcceptSlotsState): void {
    const key = state.costFacts.map((fact) => `${fact.label}=${fact.value}`).join("|");
    if (this.costsEl === undefined || key === this.costsKey) return;
    this.costsKey = key;
    this.costsEl.empty();
    for (const fact of state.costFacts) {
      this.costsEl.createEl("dt", { text: fact.label, cls: "setting-item-name" });
      this.costsEl.createEl("dd", { text: fact.value }).setCssProps({ margin: "0" });
    }
  }

  private showOutcome(state: AcceptSlotsState): void {
    if (this.failureEl !== undefined) {
      this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.checkFailed}: ${state.failure}`));
      markProblem(this.failureEl, state.failure !== undefined);
    }
    if (this.resultEl === undefined) return;
    this.resultEl.empty();
    if (state.phase === "stopped") {
      this.resultEl.createEl("strong", { text: KEY_DIALOG_COPY.stoppedHeading });
      this.resultEl.createEl("p", { text: KEY_DIALOG_COPY.stopped });
    }
    if (state.phase !== "done") return;
    this.resultEl.createEl("strong", { text: COPY.doneTitle });
    this.resultEl.createEl("p", { text: state.acceptedKind === "unchanged" ? COPY.unchanged : COPY.done });
  }

  private async check(): Promise<void> {
    const field = this.current?.field;
    if (field === undefined || this.model.state().busy) return;
    this.apply(this.model.setCurrent(field.value));
    const text = field.value;
    if (!this.model.beginCheck()) {
      this.apply(this.model.touchCurrent());
      return;
    }
    field.value = "";
    this.apply(this.model.state());
    let result: AcceptCheckResult;
    try {
      result = await this.request.checkSlots(text, (fraction) => this.apply(this.model.reportProgress(fraction)));
    } catch {
      result = { ok: false, reason: UNEXPECTED_ERROR_TEXT, retryable: false };
    }
    this.apply(this.model.settleCheck(result));
    // Cancel takes the focus on the review too (Accept is one Tab away, never the default), as the prune dialog does.
    this.afterStep(result.ok || !result.retryable ? this.cancelButton : field);
  }

  private async acceptSlots(): Promise<void> {
    if (!this.model.beginAccept()) return;
    const confirmation = { downgradeConfirmed: this.model.state().downgradeConfirmed };
    this.apply(this.model.state());
    let result: AcceptCommitResult;
    try {
      result = await this.request.accept(confirmation);
    } catch {
      result = { ok: false, reason: UNEXPECTED_ERROR_TEXT, retryable: false };
    }
    this.apply(this.model.settleAccept(result));
    this.afterStep(result.ok || !result.retryable ? this.cancelButton : this.acceptButton);
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
