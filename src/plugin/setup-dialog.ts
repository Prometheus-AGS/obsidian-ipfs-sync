import { Modal, type App } from "obsidian";
import {
  addCheckbox,
  addFieldText,
  addParagraph,
  addRevealToggle,
  addSecretField,
  ProgressIndicator,
  showFieldError,
} from "./encryption-dialog-controls";
import { CREATING_TEXT, SETUP_COPY as COPY } from "./encryption-copy";
import { createSetupModel, type SetupModel, type SetupState } from "./setup-dialog-model";
import { addNote, errorLine, liveRegion, markProblem } from "./settings-tab-controls";

const ID = {
  reentry: "ipfs-sync-setup-reentry",
  reentryError: "ipfs-sync-setup-reentry-error",
  reveal: "ipfs-sync-setup-reveal",
  acknowledge: "ipfs-sync-setup-acknowledge",
  requirements: "ipfs-sync-setup-requirements",
  progress: "ipfs-sync-setup-progress",
  failure: "ipfs-sync-setup-failure",
  consequence: "ipfs-sync-setup-consequence",
  passphrase: "ipfs-sync-setup-passphrase",
} as const;

export type SetupCreateResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type SetupOutcome = "created" | "cancelled";

export interface SetupDialogRequest {
  /**
   * The generated passphrase, with or without hyphens, produced by the caller. The dialog only displays it in
   * groups and compares the re-entry with it. It never generates, stores or logs it.
   */
  readonly passphrase: string;
  /**
   * Called once when Create is pressed with the gating satisfied. The caller creates the vault with the
   * passphrase it holds and reports progress of the key derivation as a fraction from 0 to 1 when it can.
   * The reason of a failure is shown as text; it must not contain the passphrase.
   */
  readonly create: (onProgress: (fraction: number) => void) => Promise<SetupCreateResult>;
}

/**
 * First-time setup of an encrypted vault. The passphrase is shown once in monospace, in 5 groups of 5; the user
 * enters it again and ticks the no-recovery acknowledgement before Create is enabled. There is no field for
 * choosing a passphrase. Closing the dialog any other way than Create is a cancel. Closing it while the vault
 * is being created does not cancel the creation; the outcome is reported when it ends.
 */
export class SetupVaultDialog extends Modal {
  private readonly model: SetupModel;
  private settled = false;
  private closing = false;
  private reentry: HTMLInputElement | undefined;
  private reentryError: HTMLElement | undefined;
  private acknowledge: HTMLInputElement | undefined;
  private requirements: HTMLElement | undefined;
  private failureEl: HTMLElement | undefined;
  private progress: ProgressIndicator | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private createButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    private readonly request: SetupDialogRequest,
    /** Called once when the dialog is done: `created`, or `cancelled` for every other way out. */
    private readonly onFinish: (outcome: SetupOutcome) => void,
  ) {
    super(app);
    this.model = createSetupModel(request.passphrase);
  }

  onOpen(): void {
    this.titleEl.setText(COPY.title);
    const { contentEl } = this;
    contentEl.empty();
    addParagraph(contentEl, COPY.intro);
    this.renderPassphrase(contentEl);
    addNote(contentEl, ID.consequence, COPY.consequenceTitle, COPY.consequence);
    this.renderReentry(contentEl);
    this.acknowledge = addCheckbox(contentEl, ID.acknowledge, COPY.acknowledgeLabel, (on) => this.apply(this.model.setAcknowledged(on)));
    this.acknowledge.setAttr("aria-describedby", ID.consequence);
    this.requirements = liveRegion(contentEl, ID.requirements);
    this.progress = new ProgressIndicator(contentEl, ID.progress);
    this.failureEl = liveRegion(contentEl, ID.failure);
    this.renderButtons(contentEl);
    this.apply(this.model.state());
    this.reentry?.focus();
  }

  onClose(): void {
    this.model.dispose();
    this.contentEl.empty();
    this.closing = true;
    if (!this.model.state().busy) this.finish("cancelled");
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
    addParagraph(parent, COPY.caseNote);
    addParagraph(parent, COPY.lookalikeNote);
    addParagraph(parent, COPY.managerNote);
  }

  private renderReentry(parent: HTMLElement): void {
    const row = parent.createDiv();
    row.setCssProps({ margin: "var(--size-4-3) 0" });
    const { labelId, descId } = addFieldText(row, ID.reentry, COPY.reentryName, COPY.reentryDesc);
    const input = addSecretField(row, ID.reentry, labelId, `${descId} ${ID.reentryError}`);
    this.reentry = input;
    this.reentryError = liveRegion(row, ID.reentryError);
    addRevealToggle(row, ID.reveal, COPY.revealLabel, input, (on) => this.apply(this.model.setRevealed(on)));
    input.addEventListener("input", () => this.apply(this.model.setReentry(input.value)));
    input.addEventListener("change", () => this.apply(this.model.touchReentry()));
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      this.apply(this.model.touchReentry());
      void this.create();
    });
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: COPY.cancel });
    this.createButton = row.createEl("button", { text: COPY.create, cls: "mod-cta" });
    this.createButton.setAttr("aria-describedby", ID.requirements);
    this.cancelButton.addEventListener("click", () => this.close());
    this.createButton.addEventListener("click", () => void this.create());
  }

  private apply(state: SetupState): void {
    if (this.reentry !== undefined && this.reentryError !== undefined) showFieldError(this.reentryError, this.reentry, state.reentryError);
    if (this.requirements !== undefined) this.requirements.setText(state.requirementsText);
    if (this.createButton !== undefined) this.createButton.disabled = !state.canCreate;
    for (const control of [this.reentry, this.acknowledge, this.cancelButton]) if (control !== undefined) control.disabled = state.busy;
    if (state.busy) this.progress?.show(CREATING_TEXT, state.progress);
    else this.progress?.hide();
    if (this.failureEl !== undefined) {
      this.failureEl.setText(state.failure === undefined ? "" : errorLine(`${COPY.createFailed}: ${state.failure}`));
      markProblem(this.failureEl, state.failure !== undefined);
    }
  }

  private async create(): Promise<void> {
    if (!this.model.begin()) return;
    this.apply(this.model.state());
    let result: SetupCreateResult;
    try {
      result = await this.request.create((fraction) => this.apply(this.model.reportProgress(fraction)));
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : "unknown error" };
    }
    if (result.ok) {
      this.apply(this.model.succeed());
      this.finish("created");
      if (!this.closing) this.close();
      return;
    }
    this.apply(this.model.fail(result.reason));
    if (this.closing) this.finish("cancelled");
    else this.reentry?.focus();
  }

  private finish(outcome: SetupOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(outcome);
  }
}
