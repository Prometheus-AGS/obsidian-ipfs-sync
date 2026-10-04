import { Modal, type App } from "obsidian";
import type { KdfParams } from "../crypto";
import { CHANGE_PASSPHRASE_COPY as COPY, KEY_DIALOG_COPY, SETUP_COPY, TEST_UNLOCK_COPY } from "./encryption-copy";
import { addCheckbox, addFieldText, addParagraph, addRevealToggle, addSecretField, ProgressIndicator, showFieldError } from "./encryption-dialog-controls";
import {
  addCurrentField,
  addStatementList,
  setHidden,
  showCloseOnly,
  showCurrent,
  UNEXPECTED_ERROR_TEXT,
  type CurrentField,
} from "./key-dialog-controls";
import type { KeyDialogOutcome } from "./key-dialog-shared";
import { createChangePassphraseModel, type ChangePassphraseModel, type ChangePassphraseResult, type ChangePassphraseState } from "./change-passphrase-dialog-model";
import { addNote, errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

const ID = {
  statements: "ipfs-sync-change-statements",
  passphrase: "ipfs-sync-change-passphrase",
  consequence: "ipfs-sync-change-consequence",
  current: "ipfs-sync-change-current",
  reentry: "ipfs-sync-change-reentry",
  reentryError: "ipfs-sync-change-reentry-error",
  reveal: "ipfs-sync-change-reveal",
  acknowledge: "ipfs-sync-change-acknowledge",
  requirements: "ipfs-sync-change-requirements",
  progress: "ipfs-sync-change-progress",
  failure: "ipfs-sync-change-failure",
  result: "ipfs-sync-change-result",
} as const;

export interface ChangePassphraseDialogRequest {
  /** The generated new passphrase, with or without hyphens. The dialog only shows it in groups and compares the re-entry with it. It never generates, stores or logs it. */
  readonly passphrase: string;
  /** The cost of the current slot, which a change of passphrase keeps. */
  readonly cost: KdfParams;
  /** Local format check for the current passphrase; a failure is a probable typo and `run` is not called. */
  readonly check: PassphraseFormatCheck;
  /**
   * Called once with the current passphrase when the gating holds. The caller runs the rewrap and reports progress as a fraction from 0 to 1.
   * Its answer is the real outcome (the contract of `settleUnlock`): only `ok: true` shows the test unlock and ends the dialog as done; a wrong
   * passphrase is `retryable` and reopens the form; a failure that may have changed the node is not and locks it. A reason must not contain a passphrase.
   * The dialog empties the field as soon as this is called and keeps no copy.
   */
  readonly run: (currentPassphrase: string, onProgress: (fraction: number) => void) => Promise<ChangePassphraseResult>;
}

/**
 * Change the vault passphrase. A new passphrase is shown once in monospace in 5 groups of 5 with the note that letters are not case-sensitive,
 * and entered again before the button works; there is no field for choosing one's own and no copy control (the text is selectable). The button
 * stays disabled until the statement about old passphrases is acknowledged. After the run the dialog stays open and shows the test unlock result.
 * Closing it while the run is going does not stop the run; the outcome is reported when it ends.
 */
export class ChangePassphraseDialog extends Modal {
  private readonly model: ChangePassphraseModel;
  private settled = false;
  private closing = false;
  private current: CurrentField | undefined;
  private reentry: HTMLInputElement | undefined;
  private reentryErrorEl: HTMLElement | undefined;
  private acknowledge: HTMLInputElement | undefined;
  private requirements: HTMLElement | undefined;
  private failureEl: HTMLElement | undefined;
  private resultEl: HTMLElement | undefined;
  private progress: ProgressIndicator | undefined;
  private formEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    private readonly request: ChangePassphraseDialogRequest,
    /** Called once when the dialog is done: `done`, `stopped`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: KeyDialogOutcome) => void,
  ) {
    super(app);
    this.model = createChangePassphraseModel({ passphrase: request.passphrase, cost: request.cost, check: request.check });
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    addStatementList(contentEl, ID.statements, KEY_DIALOG_COPY.statementsHeading, this.model.state().statements);
    this.renderPassphrase(contentEl);
    addNote(contentEl, ID.consequence, COPY.noRecoveryTitle, COPY.noRecovery);
    this.formEl = contentEl.createDiv();
    this.renderCurrent(this.formEl);
    this.renderReentry(this.formEl);
    this.acknowledge = addCheckbox(this.formEl, ID.acknowledge, COPY.acknowledgeLabel, (on) => this.apply(this.model.setAcknowledged(on)));
    this.acknowledge.setAttr("aria-describedby", `${ID.statements} ${ID.consequence}`);
    this.requirements = liveRegion(contentEl, ID.requirements);
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    this.failureEl = liveRegion(contentEl, ID.failure);
    this.resultEl = liveRegion(contentEl, ID.result);
    this.renderButtons(contentEl);
    this.apply(this.model.state());
    this.current?.field.focus();
  }

  onClose(): void {
    this.model.dispose();
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish();
  }

  private renderPassphrase(parent: HTMLElement): void {
    const name = parent.createEl("strong", { text: COPY.passphraseName });
    name.id = `${ID.passphrase}-name`;
    name.setCssProps({ display: "block", "margin-top": "var(--size-4-3)" });
    const group = parent.createDiv({ attr: { role: "group", "aria-label": COPY.groupsLabel } });
    group.id = ID.passphrase;
    group.setCssProps({
      display: "flex",
      "flex-wrap": "wrap",
      gap: "var(--size-4-2) var(--size-4-1)",
      "align-items": "baseline",
      margin: "var(--size-4-2) 0",
      "font-family": "var(--font-monospace)",
      "font-size": "var(--font-ui-larger)",
      "user-select": "text",
    });
    const groups = this.model.state().groups;
    groups.forEach((symbols, index) => {
      group.createEl("code", { text: symbols }).setCssProps({ "white-space": "nowrap", "user-select": "text" });
      if (index < groups.length - 1) group.createSpan({ text: "-", attr: { "aria-hidden": "true" } });
    });
    addParagraph(parent, SETUP_COPY.caseNote);
    addParagraph(parent, SETUP_COPY.lookalikeNote);
    addParagraph(parent, SETUP_COPY.managerNote);
  }

  private renderCurrent(parent: HTMLElement): void {
    this.current = addCurrentField(parent, ID.current, {
      onInput: (text) => this.apply(this.model.setCurrent(text)),
      onTouch: () => this.apply(this.model.touchCurrent()),
      onReveal: (on) => this.apply(this.model.setCurrentRevealed(on)),
      onEnter: () => void this.submit(),
    });
  }

  private renderReentry(parent: HTMLElement): void {
    const row = parent.createDiv();
    row.setCssProps({ margin: "var(--size-4-3) 0" });
    const { labelId, descId } = addFieldText(row, ID.reentry, COPY.reentryName, COPY.reentryDesc);
    const input = addSecretField(row, ID.reentry, labelId, `${descId} ${ID.reentryError}`);
    this.reentry = input;
    this.reentryErrorEl = liveRegion(row, ID.reentryError);
    addRevealToggle(row, ID.reveal, KEY_DIALOG_COPY.revealLabel, input, (on) => this.apply(this.model.setReentryRevealed(on)));
    input.addEventListener("input", () => this.apply(this.model.setReentry(input.value)));
    input.addEventListener("change", () => this.apply(this.model.touchReentry()));
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      this.apply(this.model.touchReentry());
      void this.submit();
    });
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: KEY_DIALOG_COPY.cancel });
    this.confirmButton = row.createEl("button", { text: COPY.confirm, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", `${ID.requirements} ${ID.statements}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => void this.submit());
  }

  private apply(state: ChangePassphraseState): void {
    const form = state.phase === "form";
    if (this.current !== undefined) showCurrent(this.current, state.current);
    if (this.reentry !== undefined && this.reentryErrorEl !== undefined) showFieldError(this.reentryErrorEl, this.reentry, state.reentryError);
    this.requirements?.setText(state.requirementsText);
    if (this.confirmButton !== undefined) this.confirmButton.disabled = !state.canConfirm;
    for (const control of [this.current?.field, this.reentry, this.acknowledge]) if (control !== undefined) control.disabled = !form;
    if (this.cancelButton !== undefined) this.cancelButton.disabled = state.busy;
    setHidden(this.formEl, state.phase === "done" || state.phase === "stopped");
    if (state.busy) this.progress?.show(COPY.working, state.progress);
    else this.progress?.hide();
    this.showFailure(state);
    this.showResult(state);
    if (state.phase === "done" || state.phase === "stopped") showCloseOnly(this.cancelButton, this.confirmButton);
  }

  private showFailure(state: ChangePassphraseState): void {
    if (this.failureEl === undefined) return;
    this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.failed}: ${state.failure}`));
    markProblem(this.failureEl, state.failure !== undefined);
  }

  private showResult(state: ChangePassphraseState): void {
    if (this.resultEl === undefined) return;
    this.resultEl.empty();
    if (state.phase === "stopped") {
      this.resultEl.createEl("strong", { text: KEY_DIALOG_COPY.stoppedHeading });
      this.resultEl.createEl("p", { text: KEY_DIALOG_COPY.stopped });
    }
    if (state.phase !== "done") return;
    this.resultEl.createEl("strong", { text: COPY.doneTitle });
    this.resultEl.createEl("p", { text: `${TEST_UNLOCK_COPY.heading}: ${state.testUnlock === "verified" ? TEST_UNLOCK_COPY.verified : TEST_UNLOCK_COPY.notRun}` });
    this.resultEl.createEl("p", { text: COPY.next });
  }

  private async submit(): Promise<void> {
    const field = this.current?.field;
    if (field === undefined || this.model.state().busy) return;
    this.apply(this.model.setCurrent(field.value));
    const text = field.value;
    if (!this.model.begin()) {
      this.apply(this.model.touchCurrent());
      return;
    }
    field.value = "";
    this.apply(this.model.state());
    let result: ChangePassphraseResult;
    try {
      result = await this.request.run(text, (fraction) => this.apply(this.model.reportProgress(fraction)));
    } catch {
      result = { ok: false, reason: UNEXPECTED_ERROR_TEXT, retryable: false };
    }
    this.apply(this.model.settle(result));
    if (this.closing) this.finish();
    else if (result.ok || !result.retryable) this.cancelButton?.focus();
    else field.focus();
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    const phase = this.model.state().phase;
    this.onFinish(phase === "done" ? "done" : phase === "stopped" ? "stopped" : "cancelled");
  }
}
