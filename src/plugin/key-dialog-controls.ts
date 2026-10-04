import { KEY_DIALOG_COPY } from "./encryption-copy";
import { addCheckbox, addFieldText, addRevealToggle, addSecretField, showFieldError } from "./encryption-dialog-controls";
import type { SecretEntryState } from "./key-secret-entry";
import { liveRegion } from "./settings-tab-controls";

/**
 * Rendering blocks shared by the three key dialogs. Every string goes in through `text` or `setText` (textContent): no element is built from a
 * value, so nothing that came from the node can become markup. Same rules as the other dialogs: a visible label for every control with
 * `aria-labelledby`, errors as words in a polite live region tied to the field, no state carried by colour alone, and no copy control.
 */

/** Fixed text for an error the dialog cannot describe. It never uses `error.message`, which could carry text the node supplied. */
export const UNEXPECTED_ERROR_TEXT = "an unexpected error occurred; see the developer console for details";

/** A bold heading and a list under it, joined with `aria-labelledby`. */
export function addStatementList(parent: HTMLElement, id: string, heading: string, lines: readonly string[]): HTMLElement {
  const headingEl = parent.createEl("strong", { text: heading });
  headingEl.id = `${id}-heading`;
  headingEl.setCssProps({ display: "block", "margin-top": "var(--size-4-3)" });
  const list = parent.createEl("ul");
  list.id = id;
  list.setAttr("aria-labelledby", headingEl.id);
  for (const line of lines) list.createEl("li", { text: line });
  return list;
}

export interface CurrentFieldHandlers {
  readonly onInput: (text: string) => void;
  /** The field lost focus (`change`). */
  readonly onTouch: () => void;
  readonly onReveal: (on: boolean) => void;
  /** Enter was pressed in the field. */
  readonly onEnter: () => void;
}

export interface CurrentField {
  readonly field: HTMLInputElement;
  readonly errorEl: HTMLElement;
  readonly rowEl: HTMLElement;
}

/** The masked "current passphrase" field with its description, its error slot and a reveal control. */
export function addCurrentField(parent: HTMLElement, id: string, handlers: CurrentFieldHandlers): CurrentField {
  const rowEl = parent.createDiv();
  rowEl.setCssProps({ margin: "var(--size-4-3) 0" });
  const { labelId, descId } = addFieldText(rowEl, id, KEY_DIALOG_COPY.currentName, KEY_DIALOG_COPY.currentDesc);
  const errorId = `${id}-error`;
  const field = addSecretField(rowEl, id, labelId, `${descId} ${errorId}`);
  const errorEl = liveRegion(rowEl, errorId);
  addRevealToggle(rowEl, `${id}-reveal`, KEY_DIALOG_COPY.revealLabel, field, handlers.onReveal);
  field.addEventListener("input", () => handlers.onInput(field.value));
  field.addEventListener("change", () => handlers.onTouch());
  field.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") handlers.onEnter();
  });
  return { field, errorEl, rowEl };
}

export function showCurrent(current: CurrentField, state: SecretEntryState): void {
  showFieldError(current.errorEl, current.field, state.error);
}

/** A checkbox row that can be hidden as a whole. */
export function addToggleRow(parent: HTMLElement, id: string, label: string, onChange: (on: boolean) => void): { readonly row: HTMLElement; readonly input: HTMLInputElement } {
  const row = parent.createDiv();
  const input = addCheckbox(row, id, label, onChange);
  return { row, input };
}

export function setHidden(el: HTMLElement | undefined, hidden: boolean): void {
  el?.setCssProps({ display: hidden ? "none" : "" });
}

/** Turn a pair of Cancel and confirm buttons into a lone Close once the dialog has an end state. */
export function showCloseOnly(cancel: HTMLButtonElement | undefined, confirm: HTMLButtonElement | undefined): void {
  cancel?.setText(KEY_DIALOG_COPY.close);
  setHidden(confirm, true);
}
