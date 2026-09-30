import { errorLine, liveRegion, markProblem } from "./settings-tab-controls";

/**
 * Building blocks shared by the setup, unlock and abandon dialogs. Same rules as the settings tab: every control
 * has a visible label and an `aria-labelledby` pointing at it, errors are words ("Error: ...") in a polite live
 * region tied to the field with `aria-describedby`, and state is never carried by colour alone.
 */

/** A native checkbox with its own visible label. Returns the input. */
export function addCheckbox(parent: HTMLElement, id: string, label: string, onChange: (checked: boolean) => void): HTMLInputElement {
  const row = parent.createDiv();
  row.setCssProps({ display: "flex", gap: "var(--size-4-2)", "align-items": "flex-start", margin: "var(--size-4-2) 0" });
  const input = row.createEl("input", { type: "checkbox", attr: { id } });
  input.id = id;
  const labelEl = row.createEl("label", { text: label, attr: { for: id } });
  labelEl.id = `${id}-label`;
  input.setAttr("aria-labelledby", labelEl.id);
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

/** The "show what I type" control for a secret field: it switches the field between masked and plain text. */
export function addRevealToggle(parent: HTMLElement, id: string, label: string, field: HTMLInputElement, onChange: (revealed: boolean) => void): void {
  addCheckbox(parent, id, label, (checked) => {
    field.type = checked ? "text" : "password";
    onChange(checked);
  });
}

/** A secret entry field: masked, no autofill, no spell-checking, no capitalisation. */
export function addSecretField(parent: HTMLElement, id: string, labelledBy: string, describedBy: string): HTMLInputElement {
  const input = parent.createEl("input", { type: "password", attr: { id } });
  input.id = id;
  input.setCssProps({ width: "100%", "font-family": "var(--font-monospace)" });
  input.setAttr("aria-labelledby", labelledBy);
  input.setAttr("aria-describedby", describedBy);
  input.setAttr("autocomplete", "off");
  input.setAttr("autocapitalize", "off");
  input.setAttr("autocorrect", "off");
  input.setAttr("spellcheck", "false");
  return input;
}

/** A plain text entry field for a typed confirmation word: no autofill, no spell-checking, no capitalisation. */
export function addPlainField(parent: HTMLElement, id: string, labelledBy: string, describedBy: string): HTMLInputElement {
  const input = parent.createEl("input", { type: "text", attr: { id } });
  input.id = id;
  input.setCssProps({ width: "100%" });
  input.setAttr("aria-labelledby", labelledBy);
  input.setAttr("aria-describedby", describedBy);
  input.setAttr("autocomplete", "off");
  input.setAttr("autocapitalize", "off");
  input.setAttr("autocorrect", "off");
  input.setAttr("spellcheck", "false");
  return input;
}

/** A visible name and description above a control; returns the ids to point `aria-labelledby` and `aria-describedby` at. */
export function addFieldText(parent: HTMLElement, id: string, name: string, desc: string): { readonly labelId: string; readonly descId: string } {
  const labelId = `${id}-name`;
  const descId = `${id}-desc`;
  const nameEl = parent.createEl("label", { text: name, cls: "setting-item-name", attr: { for: id } });
  nameEl.id = labelId;
  nameEl.setCssProps({ display: "block" });
  const descEl = parent.createDiv({ cls: "setting-item-description", text: desc });
  descEl.id = descId;
  return { labelId, descId };
}

/** Show or clear a field's error: words in a live region, `aria-invalid` on the field, the theme's error colour as a bonus. */
export function showFieldError(slot: HTMLElement, field: HTMLElement, message: string | undefined): void {
  slot.setText(message === undefined ? "" : errorLine(message));
  markProblem(slot, message !== undefined);
  field.setAttr("aria-invalid", message === undefined ? null : "true");
}

/** The status line for a running derivation: a sentence, and a native progress bar when the caller reports progress. */
export class ProgressIndicator {
  private readonly textEl: HTMLElement;
  private readonly barEl: HTMLElement;

  constructor(parent: HTMLElement, id: string) {
    const region = parent.createDiv({ cls: "setting-item-description", attr: { role: "status", "aria-live": "polite" } });
    region.id = id;
    this.textEl = region.createDiv();
    this.barEl = region.createEl("progress", { attr: { max: 1, "aria-labelledby": `${id}-text` } });
    this.textEl.id = `${id}-text`;
    this.barEl.setCssProps({ width: "100%", display: "none" });
  }

  /**
   * Show the sentence. With a fraction the bar is determinate and the percentage is also written out, in steps of
   * 25 so a screen reader is not told about every tick of the derivation.
   */
  show(sentence: string, fraction: number | undefined): void {
    const percent = fraction === undefined ? "" : ` ${Math.floor(fraction * 4) * 25} percent.`;
    this.textEl.setText(`${sentence}${percent}`);
    this.barEl.setCssProps({ display: "block" });
    if (fraction === undefined) this.barEl.setAttr("value", null);
    else this.barEl.setAttr("value", fraction);
  }

  hide(): void {
    this.textEl.setText("");
    this.barEl.setCssProps({ display: "none" });
    this.barEl.setAttr("value", null);
  }
}

/** A paragraph of description text. */
export function addParagraph(parent: HTMLElement, text: string): HTMLElement {
  return parent.createEl("p", { text, cls: "setting-item-description" });
}

export { liveRegion };
