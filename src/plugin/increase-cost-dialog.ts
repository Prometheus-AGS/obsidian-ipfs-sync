import { Modal, type App } from "obsidian";
import type { KdfParams } from "../crypto";
import { INCREASE_COST_COPY as COPY, KEY_DIALOG_COPY, TEST_UNLOCK_COPY } from "./encryption-copy";
import { addCheckbox, addFieldText, addParagraph, ProgressIndicator } from "./encryption-dialog-controls";
import { addCurrentField, addStatementList, addToggleRow, setHidden, showCloseOnly, showCurrent, UNEXPECTED_ERROR_TEXT, type CurrentField } from "./key-dialog-controls";
import type { KeyDialogOutcome } from "./key-dialog-shared";
import {
  createIncreaseCostModel,
  type CostChoiceId,
  type IncreaseCostModel,
  type IncreaseCostResult,
  type IncreaseCostState,
} from "./increase-cost-dialog-model";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";
import type { PassphraseFormatCheck } from "./unlock-dialog-model";

const ID = {
  statements: "ipfs-sync-cost-statements",
  choice: "ipfs-sync-cost-choice",
  selection: "ipfs-sync-cost-selection",
  downgradeQuestion: "ipfs-sync-cost-downgrade-question",
  downgrade: "ipfs-sync-cost-downgrade",
  current: "ipfs-sync-cost-current",
  acknowledge: "ipfs-sync-cost-acknowledge",
  requirements: "ipfs-sync-cost-requirements",
  progress: "ipfs-sync-cost-progress",
  failure: "ipfs-sync-cost-failure",
  result: "ipfs-sync-cost-result",
} as const;

export interface IncreaseCostRun {
  /** The current passphrase: the rewrap reuses it for the new slot and derives it a second time to read the vault key. */
  readonly passphrase: string;
  readonly params: KdfParams;
  /** True only for a lower cost that the person confirmed. */
  readonly allowDowngrade: boolean;
}

export interface IncreaseCostDialogRequest {
  /** The cost of the current slot. */
  readonly current: KdfParams;
  readonly check: PassphraseFormatCheck;
  /**
   * Called once when the gating holds, with the current passphrase and the chosen cost. Its answer is the real outcome, as for the
   * change-passphrase dialog: `retryable` for a refusal that wrote nothing, otherwise the form locks. The dialog empties the field as soon as
   * this is called and keeps no copy.
   */
  readonly run: (input: IncreaseCostRun, onProgress: (fraction: number) => void) => Promise<IncreaseCostResult>;
}

/**
 * Raise (or, with a separate confirmation, lower) the key-derivation cost under the same passphrase. Only the offered costs can be chosen: native
 * radio buttons, no free field. The statements say that old passphrases and old copies keep working and that the old cheaper slot in earlier
 * roots is unaffected; the button stays disabled until they are acknowledged. After the run the dialog stays open and shows the test unlock result.
 */
export class IncreaseCostDialog extends Modal {
  private readonly model: IncreaseCostModel;
  private settled = false;
  private closing = false;
  private current: CurrentField | undefined;
  private radios = new Map<CostChoiceId, HTMLInputElement>();
  private selectionEl: HTMLElement | undefined;
  private downgradeQuestionEl: HTMLElement | undefined;
  private downgradeRow: HTMLElement | undefined;
  private downgrade: HTMLInputElement | undefined;
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
    private readonly request: IncreaseCostDialogRequest,
    /** Called once when the dialog is done: `done`, `stopped`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: KeyDialogOutcome) => void,
  ) {
    super(app);
    this.model = createIncreaseCostModel({ current: request.current, check: request.check });
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    addStatementList(contentEl, ID.statements, KEY_DIALOG_COPY.statementsHeading, this.model.state().statements);
    this.formEl = contentEl.createDiv();
    this.renderChoices(this.formEl);
    this.selectionEl = liveRegion(this.formEl, ID.selection);
    this.downgradeQuestionEl = liveRegion(this.formEl, ID.downgradeQuestion);
    const toggle = addToggleRow(this.formEl, ID.downgrade, COPY.downgradeLabel, (on) => this.apply(this.model.setDowngradeConfirmed(on)));
    this.downgradeRow = toggle.row;
    this.downgrade = toggle.input;
    this.downgrade.setAttr("aria-describedby", ID.downgradeQuestion);
    this.current = addCurrentField(this.formEl, ID.current, {
      onInput: (text) => this.apply(this.model.setCurrent(text)),
      onTouch: () => this.apply(this.model.touchCurrent()),
      onReveal: (on) => this.apply(this.model.setCurrentRevealed(on)),
      onEnter: () => void this.submit(),
    });
    this.acknowledge = addCheckbox(this.formEl, ID.acknowledge, COPY.acknowledgeLabel, (on) => this.apply(this.model.setAcknowledged(on)));
    this.acknowledge.setAttr("aria-describedby", ID.statements);
    this.requirements = liveRegion(contentEl, ID.requirements);
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    this.failureEl = liveRegion(contentEl, ID.failure);
    this.resultEl = liveRegion(contentEl, ID.result);
    this.renderButtons(contentEl);
    this.apply(this.model.state());
    this.radios.get(this.model.state().selected.id)?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish();
  }

  /** A native radio group: arrow keys move inside it, Tab enters and leaves it once. */
  private renderChoices(parent: HTMLElement): void {
    const group = parent.createDiv({ attr: { role: "radiogroup" } });
    group.setCssProps({ margin: "var(--size-4-3) 0" });
    const { labelId, descId } = addFieldText(group, ID.choice, COPY.choiceName, COPY.choiceDesc);
    group.setAttr("aria-labelledby", labelId);
    group.setAttr("aria-describedby", descId);
    for (const option of this.model.state().options) {
      const row = group.createDiv();
      row.setCssProps({ display: "flex", gap: "var(--size-4-2)", "align-items": "flex-start", margin: "var(--size-4-2) 0" });
      const id = `${ID.choice}-${option.id}`;
      const input = row.createEl("input", { type: "radio", attr: { id, name: ID.choice, value: option.id } });
      input.id = id;
      const label = row.createEl("label", { text: option.label, attr: { for: id } });
      label.id = `${id}-label`;
      input.setAttr("aria-labelledby", label.id);
      input.addEventListener("change", () => {
        if (input.checked) this.apply(this.model.choose(option.id));
      });
      this.radios.set(option.id, input);
    }
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: KEY_DIALOG_COPY.cancel });
    this.confirmButton = row.createEl("button", { text: COPY.confirm, cls: "mod-warning" });
    this.confirmButton.setAttr("aria-describedby", `${ID.requirements} ${ID.statements}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => void this.submit());
  }

  private apply(state: IncreaseCostState): void {
    const form = state.phase === "form";
    for (const [id, input] of this.radios) {
      input.checked = id === state.selected.id;
      input.disabled = !form;
    }
    this.selectionEl?.setText(state.selectionText);
    this.downgradeQuestionEl?.setText(state.downgradeQuestion ?? "");
    setHidden(this.downgradeRow, state.downgradeQuestion === undefined);
    if (this.downgrade !== undefined) {
      this.downgrade.checked = state.downgradeConfirmed;
      this.downgrade.disabled = !form;
    }
    if (this.current !== undefined) showCurrent(this.current, state.current);
    this.requirements?.setText(state.requirementsText);
    if (this.confirmButton !== undefined) {
      this.confirmButton.disabled = !state.canConfirm;
      this.confirmButton.setText(state.selected.relation === "lower" ? COPY.confirmLower : COPY.confirm);
    }
    for (const control of [this.current?.field, this.acknowledge]) if (control !== undefined) control.disabled = !form;
    if (this.cancelButton !== undefined) this.cancelButton.disabled = state.busy;
    setHidden(this.formEl, state.phase === "done" || state.phase === "stopped");
    if (state.busy) this.progress?.show(COPY.working, state.progress);
    else this.progress?.hide();
    this.showOutcome(state);
    if (state.phase === "done" || state.phase === "stopped") showCloseOnly(this.cancelButton, this.confirmButton);
  }

  private showOutcome(state: IncreaseCostState): void {
    if (this.failureEl !== undefined) {
      this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.failed}: ${state.failure}`));
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
    const { selected, allowDowngrade } = this.model.state();
    field.value = "";
    this.apply(this.model.state());
    let result: IncreaseCostResult;
    try {
      result = await this.request.run({ passphrase: text, params: selected.params, allowDowngrade }, (fraction) => this.apply(this.model.reportProgress(fraction)));
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
