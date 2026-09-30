import { Setting } from "obsidian";
import { errorKeyOf, SECRET_FIELDS, type EditableFieldId, type FieldId } from "./settings-view-model";
import { FIELD_COPY } from "./settings-tab-copy";
import type { SettingsField } from "./settings-to-config";

/**
 * Building blocks of the settings tab. Every control gets a visible label (the setting's name), an
 * `aria-labelledby` pointing at it, and an `aria-describedby` pointing at its description and its error
 * text. Errors are words ("Error: ...") in a polite live region, never colour alone.
 */

export const ERROR_PREFIX = "Error: ";

export const labelId = (field: string): string => `ipfs-sync-label-${field}`;
export const descId = (field: string): string => `ipfs-sync-desc-${field}`;
export const errorId = (key: string): string => `ipfs-sync-error-${key}`;
/** Live region under the authentication fields: warnings (expired JWT) and the "not saved yet" hint. */
export const AUTH_STATUS_ID = "ipfs-sync-auth-status";
/** The line that says which IPNS name will be pulled; it also describes the pull name field. */
export const PULL_TARGET_ID = "ipfs-sync-pull-target";

export function capitalize(text: string): string {
  return text === "" ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The error line as shown: capitalised, prefixed, and ended with a full stop. */
export function errorLine(message: string): string {
  const trimmed = capitalize(message.trim());
  return `${ERROR_PREFIX}${/[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`}`;
}

/** Text-only emphasis for problems: the words carry the meaning, the theme's error colour is a bonus. */
export function markProblem(el: HTMLElement, on: boolean): void {
  el.style.color = on ? "var(--text-error)" : "";
}

/** A live region that is always present, so a screen reader announces text that appears in it. */
export function liveRegion(parent: HTMLElement, id: string): HTMLElement {
  const el = parent.createDiv({ cls: "setting-item-description", attr: { "aria-live": "polite" } });
  el.id = id;
  return el;
}

/** Inline error slots, keyed by settings field, and the inputs each one describes. */
export class ErrorSlots {
  private readonly slots = new Map<SettingsField, HTMLElement>();
  private readonly inputs = new Map<SettingsField, HTMLElement[]>();

  clear(): void {
    this.slots.clear();
    this.inputs.clear();
  }

  create(key: SettingsField, parent: HTMLElement): HTMLElement {
    const el = liveRegion(parent, errorId(key));
    this.slots.set(key, el);
    return el;
  }

  track(key: SettingsField, input: HTMLElement): void {
    this.inputs.set(key, [...(this.inputs.get(key) ?? []), input]);
  }

  /** Forget the inputs of a key whose controls are about to be rebuilt. */
  untrack(key: SettingsField): void {
    this.inputs.delete(key);
  }

  show(key: SettingsField, message: string | undefined): void {
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    slot.setText(message === undefined ? "" : errorLine(message));
    markProblem(slot, message !== undefined);
    for (const input of this.inputs.get(key) ?? []) input.setAttr("aria-invalid", message === undefined ? null : "true");
  }

  showAll(errors: Readonly<Partial<Record<SettingsField, string>>>): void {
    for (const key of this.slots.keys()) this.show(key, errors[key]);
  }
}

export interface FieldContext {
  /** The text to show for a field. */
  readonly value: (field: EditableFieldId) => string;
  /** The user finished editing a field (blur, Enter or a picker change; browsers fire `change` for all three). */
  readonly commit: (field: EditableFieldId, text: string) => void;
  readonly slots: ErrorSlots;
  /** ids added to `aria-describedby` of secret fields (the plain-text warning). */
  readonly secretNoteId: string;
}

function describedBy(field: EditableFieldId, key: SettingsField, ctx: FieldContext): string {
  const ids = [descId(field), errorId(key)];
  if (key === "auth") ids.push(AUTH_STATUS_ID);
  if (field === "pullName") ids.push(PULL_TARGET_ID);
  if (isSecret(field)) ids.push(ctx.secretNoteId);
  return ids.join(" ");
}

const isSecret = (field: EditableFieldId): boolean => (SECRET_FIELDS as readonly EditableFieldId[]).includes(field);

/** One labelled row: name, description, and for non-auth fields its own error line under the description. */
function fieldRow(parent: HTMLElement, field: EditableFieldId, ctx: FieldContext): Setting {
  const copy = FIELD_COPY[field];
  const key = errorKeyOf(field);
  const setting = new Setting(parent).setName(copy.name).setDesc(copy.desc);
  setting.nameEl.id = labelId(field);
  setting.descEl.id = descId(field);
  if (key !== "auth") ctx.slots.create(key, setting.infoEl);
  return setting;
}

function wireInput(input: HTMLInputElement | HTMLSelectElement, field: EditableFieldId, ctx: FieldContext): void {
  const key = errorKeyOf(field);
  input.setAttr("aria-labelledby", labelId(field));
  input.setAttr("aria-describedby", describedBy(field, key, ctx));
  ctx.slots.track(key, input);
}

/** Put the control on its own full-width line under the label; on a narrow row it already stacks. */
export function stackControl(setting: Setting): void {
  setting.settingEl.setCssProps({ "flex-wrap": "wrap" });
  setting.controlEl.setCssProps({ flex: "1 1 100%" });
}

/** Monospace value that wraps anywhere inside its row and stays selectable. */
export function addCode(parent: HTMLElement, text: string): HTMLElement {
  const code = parent.createEl("code", { text });
  code.setCssProps({ "overflow-wrap": "anywhere", "word-break": "break-all", "user-select": "text" });
  return code;
}

/** A text field. Secret fields are masked (`type=password`). The value is committed on `change` (blur or Enter), not per keystroke, so half-typed URLs are never saved or flagged. */
export function addTextField(parent: HTMLElement, field: EditableFieldId, ctx: FieldContext): void {
  const copy = FIELD_COPY[field];
  const secret = isSecret(field);
  const row = fieldRow(parent, field, ctx);
  if (copy.wide === true) stackControl(row);
  row.addText((text) => {
    text.setValue(ctx.value(field));
    if (copy.placeholder !== undefined) text.setPlaceholder(copy.placeholder);
    const input = text.inputEl;
    if (copy.wide === true) input.setCssProps({ width: "100%" });
    input.type = secret ? "password" : "text";
    input.setAttr("autocomplete", "off");
    input.setAttr("autocapitalize", "off");
    input.setAttr("spellcheck", "false");
    if (copy.numeric === true) input.setAttr("inputmode", "numeric");
    wireInput(input, field, ctx);
    input.addEventListener("change", () => ctx.commit(field, input.value));
  });
}

/**
 * An on/off switch, committed at once as the text "true" or "false". It is a native checkbox with the switch
 * role, so it is focusable, operated with Space, announced as on or off, and themed by Obsidian; the row's
 * name and description are its label and description.
 */
export function addToggleField(parent: HTMLElement, field: EditableFieldId, ctx: FieldContext): void {
  fieldRow(parent, field, ctx).controlEl.createEl("input", { type: "checkbox" }, (input) => {
    input.checked = ctx.value(field) === "true";
    input.setAttr("role", "switch");
    wireInput(input, field, ctx);
    input.addEventListener("change", () => ctx.commit(field, input.checked ? "true" : "false"));
  });
}

/** A dropdown over `{value: label}`; a pick is committed at once. */
export function addSelectField(
  parent: HTMLElement,
  field: FieldId,
  options: Readonly<Record<string, string>>,
  ctx: FieldContext,
): HTMLSelectElement {
  let select: HTMLSelectElement | undefined;
  fieldRow(parent, field, ctx).addDropdown((dropdown) => {
    dropdown.addOptions({ ...options });
    dropdown.setValue(ctx.value(field));
    wireInput(dropdown.selectEl, field, ctx);
    dropdown.selectEl.addEventListener("change", () => ctx.commit(field, dropdown.selectEl.value));
    select = dropdown.selectEl;
  });
  if (select === undefined) throw new Error("the dropdown was not created");
  return select;
}

/** A section: a labelled group with an accessible heading. Returns the group's element. */
export function addSection(parent: HTMLElement, id: string, title: string): HTMLElement {
  const group = parent.createDiv({ attr: { role: "group", "aria-labelledby": id } });
  const heading = new Setting(group).setName(title).setHeading();
  heading.nameEl.id = id;
  heading.nameEl.setAttr("role", "heading");
  heading.nameEl.setAttr("aria-level", 2);
  return group;
}

/**
 * A note with a visible title and text, using Obsidian's callout styling (theme variables, light and dark).
 * The title says what kind of note it is, so nothing depends on the callout's colour or icon.
 */
export function addNote(parent: HTMLElement, id: string, title: string, text: string): HTMLElement {
  const callout = parent.createDiv({ cls: "callout", attr: { "data-callout": "warning", role: "note" } });
  callout.id = id;
  const titleEl = callout.createDiv({ cls: "callout-title" });
  titleEl.createDiv({ cls: "callout-title-inner", text: title });
  callout.createDiv({ cls: "callout-content" }).createEl("p", { text });
  return callout;
}
