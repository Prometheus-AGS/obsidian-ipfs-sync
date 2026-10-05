import { Modal, type App } from "obsidian";
import { addCheckbox, addParagraph } from "./encryption-dialog-controls";
import { createConfirmModel, type ConfirmList, type ConfirmModel, type ConfirmState, type ConfirmView } from "./pull-confirm-model";
import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";

/**
 * The one dialog behind the first-pull, restore, fork and large-pull confirmations. It renders a `ConfirmView`:
 * a title, a sentence, a list of facts, lists of statements, an optional acknowledgement and two buttons.
 *
 * Every string, including node-supplied values, is set through `text` (textContent): no element is ever built from
 * a value. There is no copy control. Cancel comes first in the tab order after the form, and any way out other than
 * Confirm (Cancel, Escape, closing the window) is a no that writes nothing.
 */

const SUFFIX = {
  facts: "facts",
  blocker: "blocker",
  need: "need",
  ack: "acknowledge",
} as const;

export class PullConfirmDialog extends Modal {
  private readonly model: ConfirmModel;
  private settled = false;
  private acknowledge: HTMLInputElement | undefined;
  private blockerEl: HTMLElement | undefined;
  private needEl: HTMLElement | undefined;
  private cancelButton: HTMLButtonElement | undefined;
  private confirmButton: HTMLButtonElement | undefined;

  constructor(
    app: App,
    private readonly view: ConfirmView,
    /** Called once: `true` only after Confirm, `false` for every other way out. */
    private readonly onFinish: (confirmed: boolean) => void,
  ) {
    super(app);
    this.model = createConfirmModel(view);
  }

  onOpen(): void {
    const { view, contentEl } = this;
    this.titleEl.setText(view.title);
    contentEl.empty();
    addParagraph(contentEl, view.intro);
    this.renderFacts(contentEl);
    view.lists.forEach((list, index) => this.renderList(contentEl, list, index));
    this.blockerEl = liveRegion(contentEl, this.id(SUFFIX.blocker));
    this.renderAcknowledgement(contentEl);
    this.needEl = liveRegion(contentEl, this.id(SUFFIX.need));
    this.renderButtons(contentEl);
    this.apply(this.model.state());
    // Cancel is the default, so an accidental Enter or Space says no; the acknowledgement is one Tab away.
    this.cancelButton?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private id(suffix: string): string {
    return `${this.view.id}-${suffix}`;
  }

  private renderFacts(parent: HTMLElement): void {
    if (this.view.facts.length === 0) return;
    const list = parent.createEl("dl");
    list.id = this.id(SUFFIX.facts);
    list.setCssProps({ margin: "var(--size-4-3) 0" });
    for (const fact of this.view.facts) {
      const name = list.createEl("dt", { text: fact.label, cls: "setting-item-name" });
      name.setCssProps({ "margin-top": "var(--size-4-2)" });
      const value = list.createEl("dd", { text: fact.value });
      value.setCssProps({ margin: "0", "overflow-wrap": "anywhere", "user-select": "text" });
    }
    if (this.view.factsNote !== undefined) addParagraph(parent, this.view.factsNote);
  }

  private renderList(parent: HTMLElement, list: ConfirmList, index: number): void {
    const headingId = this.id(`list-${index}-heading`);
    if (list.heading !== undefined) {
      const heading = parent.createEl("strong", { text: list.heading });
      heading.id = headingId;
      heading.setCssProps({ display: "block", "margin-top": "var(--size-4-3)" });
    }
    const el = parent.createEl(list.ordered === true ? "ol" : "ul");
    el.id = this.id(`list-${index}`);
    if (list.heading !== undefined) el.setAttr("aria-labelledby", headingId);
    for (const item of list.items) el.createEl("li", { text: item });
    if (list.after !== undefined) addParagraph(parent, list.after);
  }

  private renderAcknowledgement(parent: HTMLElement): void {
    const ack = this.view.acknowledgement;
    if (ack === undefined) return;
    this.acknowledge = addCheckbox(parent, this.id(SUFFIX.ack), ack.label, (on) => this.apply(this.model.setAcknowledged(on)));
  }

  private renderButtons(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: "modal-button-container" });
    this.cancelButton = row.createEl("button", { text: this.view.cancelLabel });
    this.confirmButton = row.createEl("button", { text: this.view.confirmLabel, cls: this.view.confirmStyle === "warning" ? "mod-warning" : "mod-cta" });
    this.confirmButton.setAttr("aria-describedby", `${this.id(SUFFIX.need)} ${this.id(SUFFIX.blocker)}`);
    this.cancelButton.addEventListener("click", () => this.close());
    this.confirmButton.addEventListener("click", () => this.confirm());
  }

  private apply(state: ConfirmState): void {
    if (this.confirmButton !== undefined) this.confirmButton.disabled = !state.canConfirm;
    this.needEl?.setText(state.needText);
    if (this.blockerEl !== undefined) {
      this.blockerEl.setText(state.blocker === undefined ? "" : errorLine(state.blocker));
      markProblem(this.blockerEl, state.blocker !== undefined);
    }
  }

  private confirm(): void {
    if (!this.model.confirm()) return;
    this.finish(true);
    this.close();
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.onFinish(confirmed);
  }
}

/** Open the dialog and wait for the answer. Resolves `true` only after Confirm. */
export function askConfirm(app: App, view: ConfirmView): Promise<boolean> {
  return new Promise((resolve) => {
    new PullConfirmDialog(app, view, resolve).open();
  });
}
